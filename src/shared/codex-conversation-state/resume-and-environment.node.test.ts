import { expect, test, describe } from "vite-plus/test";
import type { Thread, TurnEnvironmentParams } from "@nodex/codex-app-server-protocol/v2";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";
import {
  acceptCodexPreparedEnvironmentSelection,
  mergeCodexThreadEnvironmentSelection,
  resolveCodexAcceptedThreadEnvironmentSelection,
} from "./codex-environment-selection";
import { produce, castDraft } from "immer";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import {
  canonicalResumeOverrides,
  canonicalResumePreparation,
  resolveConversationResumePermissions,
  type ConversationResumePermissionContext,
} from "./codex-resume-permissions";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalTurnState,
  type CodexCanonicalHydratedPermissionContext,
} from "./codex-conversation-state";
import {
  buildConversationResumeRequest,
  prepareConversationResumePermissionContext,
  type ConversationResumePreparationOptions,
} from "./codex-resume-request";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  refreshResumedConversationTurnParams,
  resumedConversationCollaborationMode,
} from "./codex-history-resume";
import { residentConversationTurns } from "./codex-turn-mutation";

describe("codex environment selection", () => {
  const environment = (environmentId: string, cwd: string): TurnEnvironmentParams => ({
    environmentId,
    cwd,
    runtimeWorkspaceRoots: [cwd],
  });

  const threadWithEnvironment = (
    environmentValue: TurnEnvironmentParams,
    updatedAt: number,
  ): Thread =>
    ({
      ...buildAgentActivityV2CorpusThread([]),
      updatedAt,
      environments: [environmentValue],
    }) as Thread;

  test("stored environment metadata cannot overwrite a live selection", () => {
    const live = environment("live", "/live");
    const result = mergeCodexThreadEnvironmentSelection(
      threadWithEnvironment(environment("stored", "/stored"), 20),
      {
        environments: [live],
        environmentSelectionEvidence: { source: "live", updatedAt: 10 },
      },
      "stored",
    );

    expect(result.environments).toEqual([live]);
    expect(result.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 10 });
  });

  test("accepted turn environments commit only when the dispatch selection is still current", () => {
    const captured = { source: "live" as const, updatedAt: 10 };
    const prepared = environment("prepared", "/prepared");
    const accepted = acceptCodexPreparedEnvironmentSelection(
      {
        environments: [environment("old", "/old")],
        environmentSelectionEvidence: captured,
      },
      [prepared],
      captured,
      11,
    );
    expect(accepted.environments).toEqual([prepared]);
    expect(accepted.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 11 });

    const newer = environment("newer", "/newer");
    const rejected = acceptCodexPreparedEnvironmentSelection(
      {
        environments: [newer],
        environmentSelectionEvidence: { source: "live", updatedAt: 12 },
      },
      [prepared],
      captured,
      13,
    );
    expect(rejected.environments).toEqual([newer]);
    expect(rejected.environmentSelectionEvidence).toEqual({ source: "live", updatedAt: 12 });
  });

  test("resume response environments obey the same live-selection race fence", () => {
    const captured = { source: "live" as const, updatedAt: 10 };
    const newer = environment("newer", "/newer");
    const current = {
      environments: [newer],
      environmentSelectionEvidence: { source: "live" as const, updatedAt: 12 },
    };
    const responseThread = threadWithEnvironment(environment("resume", "/resume"), 11);

    expect(
      resolveCodexAcceptedThreadEnvironmentSelection(responseThread, current, captured),
    ).toEqual(current);
  });
});

describe("codex resume permissions", () => {
  const permissions = {
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: ["/retained"],
  };
  const workspace = { cwd: "/workspace", runtimeWorkspaceRoots: permissions.runtimeWorkspaceRoots };
  const state = () =>
    createCodexCanonicalHydratedConversationState(buildAgentActivityV2CorpusThread([]), {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/workspace",
      ...permissions,
    });

  test("hydrated turn permission defaults do not become explicit resume overrides", () => {
    const canonical = state();
    expect(canonical.turns[0]?.permissionParamsSource).toBe("inferred");
    const request = canonicalResumeOverrides(canonical, workspace);
    expect(request).not.toHaveProperty("approvalPolicy");
    expect(request).not.toHaveProperty("sandbox");
    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("approvalsReviewer");
  });

  test("historical native profiles retain workspace placement without becoming execution overrides", () => {
    const canonical = state();
    const latest = {
      ...canonical.turns[0]!,
      permissionParamsSource: undefined,
      params: {
        ...canonical.turns[0]!.params,
        permissions: "historical-profile",
        runtimeWorkspaceRoots: ["/historical"],
        attachments: [],
        sandboxPolicy: permissions.sandboxPolicy,
        approvalPolicy: "on-request" as const,
      },
    };
    const request = canonicalResumeOverrides({ ...canonical, turns: [latest] }, workspace);
    expect(request.cwd).toBe(canonical.cwd);
    expect(request.runtimeWorkspaceRoots).toEqual([canonical.cwd, "/retained"]);
    expect(request).not.toHaveProperty("permissions");
    expect(request).not.toHaveProperty("approvalPolicy");
    expect(request).not.toHaveProperty("sandbox");
  });

  test("resident nonpermission settings survive resume while historical policy remains diagnostic", () => {
    const canonical = state();
    const history = {
      ...canonical,
      latestThreadSettings: {
        model: "model",
        effort: null,
        collaborationMode: canonical.latestCollaborationMode,
        activePermissionProfile: null,
        approvalPolicy: "on-request" as const,
        approvalsReviewer: "guardian_subagent" as const,
        sandboxPolicy: permissions.sandboxPolicy,
        serviceTier: null,
        personality: "pragmatic" as const,
      },
    };
    const before = structuredClone(history.latestThreadSettings);
    const request = canonicalResumeOverrides(history, workspace);
    expect(request).toMatchObject({ serviceTier: null, personality: "pragmatic" });
    expect(Object.keys(request).sort()).toEqual([
      "cwd",
      "personality",
      "runtimeWorkspaceRoots",
      "serviceTier",
    ]);
    expect(history.latestThreadSettings).toEqual(before);
  });

  test.each(["same-id", "later-id"])(
    "resume service tier comes from resident history despite a %s presentation overlay",
    (overlayKind) => {
      const canonical = state();
      const resident = {
        ...canonical.turns[0]!,
        permissionParamsSource: undefined,
        params: {
          ...canonical.turns[0]!.params,
          permissions: "resident-profile",
          runtimeWorkspaceRoots: ["/workspace"],
          sandboxPolicy: permissions.sandboxPolicy,

          attachments: [],
          approvalPolicy: "never" as const,
          serviceTier: "priority" as const,
        },
      } satisfies CodexCanonicalTurnState;
      const history = produce(canonical, (draft) => {
        replaceCanonicalHistoryDraft(
          draft,
          [resident, { ...resident, turnId: null, status: "inProgress" }],
          true,
          null,
        );
      });
      const overlay = {
        ...resident,
        turnId: overlayKind === "same-id" ? resident.turnId : "presentation-only",
        params: {
          ...resident.params,
          permissions: "stale-profile",
          approvalPolicy: "on-request" as const,
          serviceTier: null,
        },
      };
      expect(canonicalResumeOverrides({ ...history, turns: [overlay] }, workspace)).toMatchObject({
        serviceTier: "priority",
      });
    },
  );

  test("resume normalizes physical Windows roots without replaying historical profile grants", () => {
    const canonical = state();
    const request = canonicalResumeOverrides(
      { ...canonical, cwd: "C:\\Repo\\Project" },
      {
        cwd: canonical.cwd,
        runtimeWorkspaceRoots: ["c:/repo/project/", "C:\\Repo\\Extra", "/foreign-root", "relative"],
      },
    );
    expect(request.runtimeWorkspaceRoots).toEqual(["C:\\Repo\\Project", "C:\\Repo\\Extra"]);
  });
});

describe("codex resume request", () => {
  const input = () => ({
    hostId: "local",
    threadId: "thread",
    metadata: {
      ...buildAgentActivityV2CorpusThread([]),
      id: "thread",
      status: { type: "idle" as const },
      historyMode: "paginated" as const,
    },
    supportsPaginatedHistory: true,
    overrides: { cwd: "/workspace" },
    config: { "features.thread_tools": true },
    baseInstructions: "base",
    developerInstructions: "developer",
  });

  test("preserving durable server configuration still uses fixed full native execution", () => {
    expect(
      buildConversationResumeRequest({
        ...input(),
        hostId: "durable",
        preserveServerConfiguration: true,
        serviceTier: "priority",
      }),
    ).toEqual({
      threadId: "thread",
      excludeTurns: false,
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
    expect(
      buildConversationResumeRequest({
        ...input(),
        preserveServerConfiguration: true,
      }).cwd,
    ).toBe("/workspace");
  });

  test.each([false, true])(
    "durable resume retains inline history with paging capability %s",
    (supportsPaginatedHistory) => {
      for (const historyMode of ["legacy", "paginated"] as const) {
        const initial = input();
        const request = buildConversationResumeRequest({
          ...initial,
          hostId: "durable",
          supportsPaginatedHistory,
          metadata: { ...initial.metadata, historyMode },
        });
        expect(request.excludeTurns).toBe(false);
        expect(request).not.toHaveProperty("initialTurnsPage");
      }
    },
  );

  test("idle resume reapplies product-owned static feature configuration and instructions", () => {
    const result = buildConversationResumeRequest(input());
    expect(result).toMatchObject({
      threadId: "thread",
      history: null,
      model: null,
      cwd: "/workspace",
      config: { "features.thread_tools": true },
      baseInstructions: "base",
      developerInstructions: "developer",
      excludeTurns: true,
    });
    expect(result).not.toHaveProperty("initialTurnsPage");
  });

  test.each([undefined, null, "priority"])(
    "caller service tier controls idle configuration reuse: %s",
    (serviceTier) => {
      const result = buildConversationResumeRequest({ ...input(), serviceTier });
      expect(result.serviceTier).toBe(serviceTier);
      expect(Object.hasOwn(result, "serviceTier")).toBe(serviceTier !== undefined);
      expect(result.config).toEqual(input().config);
      expect(result.developerInstructions).toBe("developer");
    },
  );

  test.each([null, "flex"])(
    "resident tier %s wins while an explicit caller tier still prevents idle reuse",
    (serviceTier) => {
      const result = buildConversationResumeRequest({
        ...input(),
        serviceTier: "priority",
        overrides: { ...input().overrides, serviceTier },
      });
      expect(result.serviceTier).toBe(serviceTier);
      expect(result.config).toEqual(input().config);
      expect(result.developerInstructions).toBe("developer");
    },
  );

  test.each([
    { "features.thread_tools": false },
    { "features.unknown": true },
    { "mcp_servers.app.enabled_tools": ["read"] },
    { profiles: { custom: { model: "model" } } },
  ])("configuration changes require a full idle resume: %j", (config) => {
    const result = buildConversationResumeRequest({ ...input(), config });
    expect(result.config).toEqual(config);
    expect(result.baseInstructions).toBe("base");
    expect(result.developerInstructions).toBe("developer");
  });

  test.each([{}, { profiles: {} }, { unused: null }, { unused: undefined }])(
    "empty configuration does not force an idle reload: %j",
    (config) => {
      expect(buildConversationResumeRequest({ ...input(), config })).not.toHaveProperty("config");
    },
  );

  test("native resume ignores historical policy overrides while preserving physical and model preferences", () => {
    const overrides = {
      cwd: "/workspace",
      permissions: "custom",
      approvalPolicy: "on-request" as const,
      approvalsReviewer: "guardian_subagent" as const,
      sandbox: "read-only" as const,
      config: { sandbox_workspace_write: { writable_roots: ["/restricted"] } },
      runtimeWorkspaceRoots: ["/one", "/two"],
      serviceTier: null,
      personality: "pragmatic" as const,
    };
    const result = buildConversationResumeRequest({ ...input(), overrides });
    expect(result).toMatchObject({
      permissions: ":danger-full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      runtimeWorkspaceRoots: ["/one", "/two"],
      serviceTier: null,
      personality: "pragmatic",
      config: input().config,
    });
    expect(result).not.toHaveProperty("sandbox");
    expect(overrides.permissions).toBe("custom");
  });

  test("an unloaded thread receives configuration even when all features match defaults", () => {
    const result = buildConversationResumeRequest({
      ...input(),
      metadata: null,
      rolloutPath: "/rollout",
      historyMode: "paginated",
    });
    expect(result).toMatchObject({
      path: "/rollout",
      config: input().config,
      developerInstructions: "developer",
    });
    expect(result).not.toHaveProperty("initialTurnsPage");
  });

  test.each([false, true])(
    "legacy metadata requests a five-turn full page regardless of capability: %s",
    (supportsPaginatedHistory) => {
      const initial = input();
      const result = buildConversationResumeRequest({
        ...initial,
        supportsPaginatedHistory,
        metadata: { ...initial.metadata, historyMode: "legacy" },
        historyMode: "paginated",
      });
      expect(result.initialTurnsPage).toEqual({
        limit: 5,
        itemsView: "full",
        sortDirection: "desc",
      });
    },
  );

  test("explicit static feature config is sent instead of being treated as a remote default", () => {
    const result = buildConversationResumeRequest({
      ...input(),
      config: { "features.custom": { one: true, two: [1, 2] } },
    });
    expect(result.config).toEqual({ "features.custom": { one: true, two: [1, 2] } });
  });
});

describe("codex resume response", () => {
  const selected: CodexCanonicalHydratedPermissionContext = {
    activePermissionProfile: { id: "selected", extends: null },
    runtimeWorkspaceRoots: ["/workspace", "/selected", "/not-granted"],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
  };
  const response = () =>
    ({
      activePermissionProfile: { id: "server", extends: null },
      runtimeWorkspaceRoots: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: {
        type: "workspaceWrite",
        writableRoots: ["/workspace", "/selected"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
    }) satisfies Pick<
      ThreadResumeResponse,
      | "activePermissionProfile"
      | "runtimeWorkspaceRoots"
      | "approvalPolicy"
      | "approvalsReviewer"
      | "sandbox"
    >;

  function capture(
    hostId: string,
    status: "idle" | "active",
    options: ConversationResumePreparationOptions,
  ): ConversationResumePermissionContext {
    const metadata = {
      ...buildAgentActivityV2CorpusThread([]),
      cwd: "/workspace",
      status:
        status === "idle"
          ? { type: "idle" as const }
          : { type: "active" as const, activeFlags: [] },
    };
    const preparation = canonicalResumePreparation(null, {
      cwd: "/workspace",
      runtimeWorkspaceRoots: ["/workspace"],
    });
    const request = buildConversationResumeRequest({
      ...options,
      hostId,
      threadId: metadata.id,
      metadata,
      supportsPaginatedHistory: true,
      config: {},
      overrides: preparation.overrides,
    });
    return prepareConversationResumePermissionContext({
      preparation,
      request,
      hostId,
      status: metadata.status,
      options,
    });
  }

  test.each([
    { status: "active" as const, roots: ["/workspace"] },
    { status: "idle" as const, roots: ["/workspace"] },
  ])("implicit durable resume respects the pre-request $status state", ({ status, roots }) => {
    expect(
      resolveConversationResumePermissions(response(), capture("durable", status, {}))
        .runtimeWorkspaceRoots,
    ).toEqual(roots);
  });

  test("preserving durable configuration disables inference and retains no prepared runtime grants", () => {
    const context = capture("durable", "idle", {
      preserveServerConfiguration: true,
    });
    expect(context.requestedPermissions.runtimeWorkspaceRoots).toEqual([]);
    expect(context.runtimeWorkspaceRootCandidates).toBeNull();
    expect(resolveConversationResumePermissions(response(), context).runtimeWorkspaceRoots).toEqual(
      [],
    );
  });

  test.each(["selected", ":workspace", ":danger-full-access"])(
    "missing server profile preserves only permitted provenance from %s",
    (id) => {
      const requestedPermissions = { ...selected, activePermissionProfile: { id, extends: null } };
      const raw = {
        ...response(),
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/server"],
      };
      const before = structuredClone(raw);
      const result = resolveConversationResumePermissions(raw, {
        requestedPermissions,
        runtimeWorkspaceRootCandidates: ["/workspace"],
      });
      if (id === ":danger-full-access") expect(result).toEqual(requestedPermissions);
      else {
        expect(result.activePermissionProfile).toEqual(
          id === "selected" ? requestedPermissions.activePermissionProfile : null,
        );
        expect(result.runtimeWorkspaceRoots).toEqual(["/server"]);
        expect(result.approvalPolicy).toBe("on-request");
      }
      expect(raw).toEqual(before);
    },
  );

  test("a recovered named profile does not authorize inference when the response profile is absent", () => {
    const result = resolveConversationResumePermissions(
      { ...response(), activePermissionProfile: null },
      {
        requestedPermissions: selected,
        runtimeWorkspaceRootCandidates: ["/workspace"],
      },
    );
    expect(result.activePermissionProfile).toEqual(selected.activePermissionProfile);
    expect(result.runtimeWorkspaceRoots).toEqual([]);
  });

  test("nonempty server roots remain authoritative", () => {
    const result = resolveConversationResumePermissions(
      { ...response(), runtimeWorkspaceRoots: ["/server-only"] },
      {
        requestedPermissions: selected,
        runtimeWorkspaceRootCandidates: ["/workspace"],
      },
    );
    expect(result.runtimeWorkspaceRoots).toEqual(["/server-only"]);
  });

  test("inferred roots use exact path equivalence without granting descendants or changing spelling", () => {
    const raw = response();
    raw.sandbox.writableRoots = ["/mnt/c/repo/shared", "/Linux/Case"];
    const result = resolveConversationResumePermissions(raw, {
      requestedPermissions: selected,
      runtimeWorkspaceRootCandidates: [
        "C:\\Repo\\Shared",
        "C:\\Repo\\Shared\\child",
        "/linux/case",
        "/Linux/Case",
      ],
    });
    expect(result.runtimeWorkspaceRoots).toEqual(["C:\\Repo\\Shared", "/Linux/Case"]);
  });

  test("projectless resume keeps empty runtime roots when the old cwd has no reusable workspace", () => {
    const thread = { ...buildAgentActivityV2CorpusThread([]), cwd: "/projectless-old" };
    const base = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/projectless-old",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    });
    const state = produce(base, (draft) => {
      draft.workspaceKind = "projectless";
      draft.workspaceBrowserRoot = null;
    });

    const preparation = canonicalResumePreparation(state, {
      cwd: "/projectless-old",
      metadataCwd: "/projectless-old",
      runtimeWorkspaceRoots: [],
    });

    expect(preparation.overrides.cwd).toBe("/projectless-old");
    expect(preparation.overrides.runtimeWorkspaceRoots).toEqual(["/projectless-old"]);
    expect(preparation.resumeWorkspaceRoots).toEqual(["/projectless-old"]);
  });

  test("projectless resume prefers the workspace browser root over an obsolete cwd", () => {
    const thread = { ...buildAgentActivityV2CorpusThread([]), cwd: "/projectless-old" };
    const base = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/projectless-old",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: [],
    });
    const state = produce(base, (draft) => {
      draft.workspaceKind = "projectless";
      draft.workspaceBrowserRoot = "/workspace/browser";
    });

    const preparation = canonicalResumePreparation(state, {
      cwd: "/projectless-old",
      metadataCwd: "/projectless-old",
      runtimeWorkspaceRoots: [],
    });

    expect(preparation.overrides.cwd).toBe("/workspace/browser");
    expect(preparation.overrides.runtimeWorkspaceRoots).toEqual(["/workspace/browser"]);
    expect(preparation.resumeWorkspaceRoots).toEqual(["/workspace/browser"]);
  });

  test("an applied workspace stays authoritative while a projectless move is still pending", () => {
    const thread = { ...buildAgentActivityV2CorpusThread([]), cwd: "/old-project" };
    const base = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/new-projectless",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/old-project"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/old-project"],
    });
    const state = produce(base, (draft) => {
      draft.workspaceKind = "projectless";
      draft.workspaceBrowserRoot = "/new-projectless";
      draft.cwd = "/new-projectless";
    });

    const preparation = canonicalResumePreparation(state, {
      cwd: "/new-projectless",
      metadataCwd: "/new-projectless",
      resumeWorkspaceRoots: ["/new-projectless"],
      runtimeWorkspaceRoots: ["/old-project"],
      appliedWorkspace: {
        cwd: "/old-project",
        runtimeWorkspaceRoots: ["/old-project"],
      },
    });

    expect(preparation.overrides.cwd).toBe("/old-project");
    expect(preparation.resumeWorkspaceRoots).toEqual(["/old-project"]);
    expect(preparation.overrides.runtimeWorkspaceRoots).toEqual(["/old-project"]);
  });

  test("resume refreshes resident Turn fields while keeping profile grants, output and presentation overlays separate", () => {
    const thread = buildAgentActivityV2CorpusThread([]);
    const state = createCodexCanonicalHydratedConversationState(thread, {
      hostId: "local",
      model: "before",
      reasoningEffort: null,
      cwd: "/workspace",
      ...selected,
      runtimeWorkspaceRoots: [...selected.runtimeWorkspaceRoots],
    });
    const resident = state.turns[0]!;
    const overlay = { ...resident, turnId: "presentation-only" };
    const canonical = produce(state, (draft) => {
      replaceCanonicalHistoryDraft(draft, [resident], true, null);
      draft.turns = castDraft([overlay]);
    });
    const collaborationMode = {
      mode: "plan" as const,
      settings: {
        model: "server-model",
        reasoning_effort: "high" as const,
        developer_instructions: "Plan first",
      },
    };
    const raw = {
      ...response(),
      model: "server-model",
      reasoningEffort: "high" as const,
      collaborationMode,
    };
    const resumed = produce(canonical, (draft) =>
      refreshResumedConversationTurnParams(draft, raw, "/workspace/subdir"),
    );
    const turn = residentConversationTurns(resumed)[0]!;
    expect(turn.params).toMatchObject({
      approvalPolicy: "on-request",
      sandboxPolicy: raw.sandbox,
      permissions: "selected",
      runtimeWorkspaceRoots: selected.runtimeWorkspaceRoots,
      model: "server-model",
      cwd: "/workspace/subdir",
      effort: "high",
      collaborationMode,
    });
    expect(turn.items).toBe(resident.items);
    expect(turn.status).toBe(resident.status);
    expect(resumed.turns[0]).toBe(overlay);
    expect(resident.params.model).toBe("before");
  });

  test("resume adopts the native collaboration mode before requested fallback settings", () => {
    const requested = {
      mode: "default" as const,
      settings: {
        model: "requested-model",
        reasoning_effort: "low" as const,
        developer_instructions: null,
      },
    };
    const effective = {
      ...requested,
      mode: "plan" as const,
      settings: { ...requested.settings, model: "native-model", reasoning_effort: "high" as const },
    };
    const response = { model: "native-model", reasoningEffort: "high" as const };
    expect(
      resumedConversationCollaborationMode(
        { ...response, collaborationMode: effective },
        requested,
      ),
    ).toBe(effective);
    expect(
      resumedConversationCollaborationMode({ ...response, collaborationMode: null }, requested),
    ).toEqual({ ...requested, settings: effective.settings });
    expect(resumedConversationCollaborationMode(response)).toBeUndefined();
  });
});
