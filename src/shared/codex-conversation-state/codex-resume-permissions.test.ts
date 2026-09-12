import { expect, test } from "vite-plus/test";
import { produce } from "immer";
import { replaceCanonicalHistoryDraft } from "./codex-canonical-history-loader";
import { canonicalResumeOverrides } from "./codex-resume-permissions";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalTurnState,
} from "./codex-conversation-state";
import { buildAgentActivityV2CorpusThread } from "./test-fixtures/agent-activity-v2-corpus-provenance";

const permissions = {
  approvalPolicy: "on-request" as const,
  approvalsReviewer: "user" as const,
  sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
  activePermissionProfile: null,
  runtimeWorkspaceRoots: ["/retained"],
};
const workspace = { cwd: "/workspace", permissions };
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

test("explicit local profile retains workspace roots and takes precedence over inferred defaults", () => {
  const canonical = state();
  const latest = {
    ...canonical.turns[0]!,
    permissionParamsSource: undefined,
    params: {
      ...canonical.turns[0]!.params,
      permissions: ":danger-full-access",
      runtimeWorkspaceRoots: [],
      useAppServerPermissionDefault: false as const,
      attachments: [],
      sandboxPolicy: permissions.sandboxPolicy,
      approvalPolicy: "never" as const,
    },
  };
  const request = canonicalResumeOverrides({ ...canonical, turns: [latest] }, workspace);
  expect(request).toMatchObject({
    approvalPolicy: "never",
    permissions: ":danger-full-access",
    runtimeWorkspaceRoots: ["/retained", canonical.cwd],
  });
  expect(request).not.toHaveProperty("sandbox");
});

test("explicit settings can clear a profile and carry sandbox policy fields through configuration", () => {
  const canonical = state();
  const request = canonicalResumeOverrides(
    {
      ...canonical,
      latestThreadSettings: {
        model: "model",
        effort: null,
        collaborationMode: canonical.latestCollaborationMode,
        activePermissionProfile: null,
        approvalPolicy: "never",
        approvalsReviewer: "guardian_subagent",
        sandboxPolicy: {
          type: "workspaceWrite",
          writableRoots: ["/configured"],
          networkAccess: true,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: false,
        },
        serviceTier: null,
      },
    },
    workspace,
  );
  expect(request).toMatchObject({
    sandbox: "workspace-write",
    approvalPolicy: "never",
    approvalsReviewer: "guardian_subagent",
    serviceTier: null,
    config: {
      sandbox_workspace_write: {
        writable_roots: ["/configured", "/retained"],
        network_access: true,
        exclude_tmpdir_env_var: true,
        exclude_slash_tmp: false,
      },
    },
  });
  expect(request).not.toHaveProperty("permissions");
});

test.each(["same-id", "later-id"])(
  "resume permissions come from resident history despite a %s presentation overlay",
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
        useAppServerPermissionDefault: false,
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
      permissions: "resident-profile",
      approvalPolicy: "never",
      serviceTier: "priority",
    });
  },
);

test.each([
  {
    label: "replacement profile",
    previousProfile: "previous",
    nextProfile: "next",
    fixedRoots: ["/granted"],
    nextFixedRoots: ["/granted"],
    savedRoots: ["/granted"],
    expectedRoots: ["/workspace/project", "/granted"],
  },
  {
    label: "same profile with newer settings",
    previousProfile: "same",
    nextProfile: "same",
    fixedRoots: ["/granted"],
    nextFixedRoots: ["/newly-configured"],
    savedRoots: ["/granted", "/newly-configured"],
    expectedRoots: ["/workspace/project", "/newly-configured"],
  },
])(
  "resume distinguishes fixed roots from grants for $label",
  ({ previousProfile, nextProfile, fixedRoots, nextFixedRoots, savedRoots, expectedRoots }) => {
    const canonical = state();
    const policy = {
      type: "workspaceWrite" as const,
      writableRoots: fixedRoots,
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    };
    const request = canonicalResumeOverrides(
      {
        ...canonical,
        currentPermissions: {
          ...permissions,
          activePermissionProfile: { id: previousProfile, extends: null },
          runtimeWorkspaceRoots: [],
          sandboxPolicy: policy,
        },
        latestThreadSettings: {
          model: "model",
          effort: null,
          collaborationMode: canonical.latestCollaborationMode,
          activePermissionProfile: { id: nextProfile, extends: null },
          sandboxPolicy: { ...policy, writableRoots: nextFixedRoots },
        },
      },
      { cwd: canonical.cwd, permissions: { ...permissions, runtimeWorkspaceRoots: savedRoots } },
    );
    expect(request.permissions).toBe(nextProfile);
    expect(request.runtimeWorkspaceRoots).toEqual(expectedRoots);
  },
);

test("resume excludes equivalent fixed Windows roots and roots from another path family", () => {
  const canonical = state();
  const current = {
    ...permissions,
    activePermissionProfile: { id: "same", extends: null },
    runtimeWorkspaceRoots: [],
    sandboxPolicy: {
      type: "workspaceWrite" as const,
      writableRoots: ["C:\\Repo\\Shared"],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
  const request = canonicalResumeOverrides(
    {
      ...canonical,
      cwd: "C:\\Repo\\Project",
      currentPermissions: current,
      latestThreadSettings: {
        model: "model",
        effort: null,
        collaborationMode: canonical.latestCollaborationMode,
        activePermissionProfile: current.activePermissionProfile,
      },
    },
    {
      cwd: canonical.cwd,
      permissions: {
        ...permissions,
        runtimeWorkspaceRoots: ["c:/repo/shared/", "C:\\Repo\\Extra", "/foreign-root", "relative"],
      },
    },
  );
  expect(request.runtimeWorkspaceRoots).toEqual(["C:\\Repo\\Project", "C:\\Repo\\Extra"]);
});
