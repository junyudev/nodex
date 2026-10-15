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
