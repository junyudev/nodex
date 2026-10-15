import type { CodexCanonicalPermissionContext } from "../../shared/codex-conversation-state/codex-conversation-state";
import {
  selectCanonicalThreadSettingsControlPatch,
  type CanonicalThreadSettingsControlPatch,
} from "../../shared/codex-conversation-state/codex-thread-settings-update";
import {
  areWorkspacePathsEquivalent,
  workspaceRootsForCwd,
} from "../../shared/codex-workspace-paths";

export interface CodexTurnWorkspaceTransition {
  readonly appliedRoots: readonly string[];
  readonly pendingRoots: readonly string[];
}

/** Workspace placement is retained independently of the native execution policy. */
export function fullAccessTurnExecution(input: {
  readonly cwd: string | null;
  readonly workspaceRoots: readonly string[];
  readonly runtimeWorkspaceRoots?: readonly string[] | null;
  readonly workspaceTransition?: CodexTurnWorkspaceTransition;
}) {
  const transition = input.workspaceTransition;
  const roots = transition
    ? [
        ...input.workspaceRoots.filter(
          (root) =>
            !transition.appliedRoots.some((applied) => areWorkspacePathsEquivalent(root, applied)),
        ),
        ...transition.pendingRoots,
      ]
    : input.workspaceRoots;
  const runtimeWorkspaceRoots = workspaceRootsForCwd(input.cwd, [
    ...new Set([...(input.runtimeWorkspaceRoots ?? []), ...roots]),
  ]);
  const policy = {
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    permissions: ":danger-full-access",
    runtimeWorkspaceRoots,
  };
  const permissions: CodexCanonicalPermissionContext = {
    activePermissionProfile: { id: ":danger-full-access", extends: null },
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" },
    runtimeWorkspaceRoots,
  };
  return {
    request: policy,
    params: { ...policy, sandboxPolicy: permissions.sandboxPolicy },
    permissions,
    workspaceCommitRoots: workspaceRootsForCwd(input.cwd, roots),
  };
}

/** Every native execution entry uses the Profile's fixed full-access policy. */
export function fullAccessExecutionParams(method: string, params: unknown): unknown {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return params;
  if (method === "thread/settings/update")
    return {
      threadId: (params as Record<string, unknown>).threadId,
      ...selectCanonicalThreadSettingsControlPatch(params as CanonicalThreadSettingsControlPatch),
    };
  if (!["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method))
    return params;
  const native: Record<string, unknown> = { ...params };
  delete native.sandbox;
  delete native.sandboxPolicy;
  native.permissions = ":danger-full-access";
  native.approvalPolicy = "never";
  native.approvalsReviewer = "user";
  return native;
}
