import { expect, test } from "vite-plus/test";
import { castDraft, produce } from "immer";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalHydratedPermissionContext,
} from "./codex-conversation-state";
import {
  canonicalResumePreparation,
  resolveConversationResumePermissions,
  type ConversationResumePermissionContext,
} from "./codex-resume-permissions";
import {
  buildConversationResumeRequest,
  prepareConversationResumePermissionContext,
  type ConversationResumePreparationOptions,
} from "./codex-resume-request";
import { refreshResumedConversationTurnParams } from "./codex-history-resume";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { residentConversationTurns } from "./codex-turn-mutation";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";

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
      status === "idle" ? { type: "idle" as const } : { type: "active" as const, activeFlags: [] },
  };
  const preparation = canonicalResumePreparation(null, {
    cwd: "/workspace",
    permissions: {
      ...selected,
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace"],
    },
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

test.each(["local", "durable"])(
  "explicit named permissions infer only server-confirmed roots on %s",
  (hostId) => {
    const result = resolveConversationResumePermissions(
      response(),
      capture(hostId, "active", { permissions: selected }),
    );
    expect(result.runtimeWorkspaceRoots).toEqual(["/workspace", "/selected"]);
    expect(result.activePermissionProfile?.id).toBe("server");
    expect(result.approvalPolicy).toBe("on-request");
  },
);

test.each(["local", "durable"])(
  "server-default resume uses workspace candidates instead of explicit profile roots on %s",
  (hostId) => {
    const context = capture(hostId, "active", {
      permissions: selected,
      useAppServerPermissionDefault: true,
    });
    expect(context.runtimeWorkspaceRootCandidates).toEqual(["/workspace"]);
    expect(resolveConversationResumePermissions(response(), context).runtimeWorkspaceRoots).toEqual(
      ["/workspace"],
    );
  },
);

test.each([
  { status: "active" as const, roots: [] },
  { status: "idle" as const, roots: ["/workspace"] },
])("implicit durable resume respects the pre-request $status state", ({ status, roots }) => {
  expect(
    resolveConversationResumePermissions(response(), capture("durable", status, {}))
      .runtimeWorkspaceRoots,
  ).toEqual(roots);
});

test("preserving durable configuration disables inference and retains no prepared runtime grants", () => {
  const context = capture("durable", "idle", {
    permissions: selected,
    preserveServerConfiguration: true,
  });
  expect(context.requestedPermissions.runtimeWorkspaceRoots).toEqual([]);
  expect(context.runtimeWorkspaceRootCandidates).toBeNull();
  expect(resolveConversationResumePermissions(response(), context).runtimeWorkspaceRoots).toEqual(
    [],
  );
});

test("an explicitly sent legacy sandbox does not infer profile roots", () => {
  const context = capture("local", "idle", {
    permissions: { ...selected, activePermissionProfile: null },
  });
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

test("preparation captures permission evidence before caller mutations", () => {
  const permissions = { ...structuredClone(selected) };
  const context = capture("local", "idle", { permissions });
  permissions.runtimeWorkspaceRoots = ["/changed"];
  permissions.activePermissionProfile = null;
  expect(context.requestedPermissions).toEqual(selected);
  expect(context.runtimeWorkspaceRootCandidates).toEqual(selected.runtimeWorkspaceRoots);
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
    permissions: {
      activePermissionProfile: null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      runtimeWorkspaceRoots: [],
    },
  });

  expect(preparation.overrides.cwd).toBe("/projectless-old");
  expect(preparation.permissions.runtimeWorkspaceRoots).toEqual([]);
  expect(preparation.resumeWorkspaceRoots).toEqual(["/projectless-old"]);
  expect(preparation.permissionWorkspaceRoots).toEqual([]);
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
    permissions: {
      activePermissionProfile: null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      runtimeWorkspaceRoots: [],
    },
  });

  expect(preparation.overrides.cwd).toBe("/workspace/browser");
  expect(preparation.permissions.runtimeWorkspaceRoots).toEqual(["/workspace/browser"]);
  expect(preparation.resumeWorkspaceRoots).toEqual(["/workspace/browser"]);
  expect(preparation.permissionWorkspaceRoots).toEqual(["/workspace/browser"]);
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
    permissions: {
      activePermissionProfile: null,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/old-project"],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      },
      runtimeWorkspaceRoots: ["/old-project"],
    },
    appliedWorkspace: {
      cwd: "/old-project",
      runtimeWorkspaceRoots: ["/old-project"],
    },
  });

  expect(preparation.overrides.cwd).toBe("/old-project");
  expect(preparation.resumeWorkspaceRoots).toEqual(["/old-project"]);
  expect(preparation.permissionWorkspaceRoots).toEqual(["/old-project"]);
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
  const raw = { ...response(), model: "server-model", reasoningEffort: "high" as const };
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
  });
  expect(turn.items).toBe(resident.items);
  expect(turn.status).toBe(resident.status);
  expect(resumed.turns[0]).toBe(overlay);
  expect(resident.params.model).toBe("before");
});
