import path from "node:path";
import type { AgentRuntimeInspection } from "../../shared/agent-runtime-api";
import type { CodexCanonicalPermissionContext } from "../../shared/types";
export interface SessionMessageFacts {
  readonly sessionId: string;
  readonly threadId: string | null;
  readonly runtimeMode: "full-access" | "auto" | "auto-accept-edits" | "approval-required";
  readonly nativeSandbox?: "readOnly" | "workspaceWrite" | "dangerFullAccess";
  readonly nativePermissions?: CodexCanonicalPermissionContext;
  readonly executionHostId?: string;
  readonly interactionMode: AgentRuntimeInspection["thread"]["interactionMode"];
  readonly modelSelection: AgentRuntimeInspection["thread"]["modelSelection"];
}
const runtimeRank = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
} as const;
const sandboxRank = { readOnly: 0, workspaceWrite: 1, dangerFullAccess: 2 } as const;
const coversRoot = (root: string, candidate: string) => {
  const windows = /^[a-z]:[\\/]|^\\\\/iu.test(root);
  const paths = windows ? path.win32 : path.posix;
  if (!paths.isAbsolute(root) || !paths.isAbsolute(candidate)) return false;
  const relative = paths.relative(root, candidate);
  return (
    relative === "" ||
    (!paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`))
  );
};
/** Concrete Native grants are compared in addition to coarse runtime mode labels. */
const nativePermissionsWiden = (caller: SessionMessageFacts, target: SessionMessageFacts) => {
  const source = caller.nativePermissions,
    destination = target.nativePermissions;
  if (!source || !destination || caller.runtimeMode === "full-access") return false;
  if (caller.executionHostId !== target.executionHostId) return true;
  if (
    caller.sessionId === target.sessionId &&
    caller.threadId === target.threadId &&
    JSON.stringify(source) === JSON.stringify(destination)
  )
    return false;
  if (source.activePermissionProfile?.extends || destination.activePermissionProfile?.extends)
    return true;
  const builtins = new Set([":read-only", ":workspace", ":danger-full-access"]);
  if (
    [source.activePermissionProfile, destination.activePermissionProfile].some(
      (profile) => profile && !builtins.has(profile.id),
    )
  )
    return true;
  if (source.approvalsReviewer !== destination.approvalsReviewer) return true;
  const approvalRank = (policy: CodexCanonicalPermissionContext["approvalPolicy"]) =>
    policy === "untrusted" ? 0 : policy === "on-request" ? 1 : policy === "never" ? 2 : null;
  const sourceApproval = approvalRank(source.approvalPolicy),
    targetApproval = approvalRank(destination.approvalPolicy);
  if (sourceApproval === null || targetApproval === null) {
    if (JSON.stringify(source.approvalPolicy) !== JSON.stringify(destination.approvalPolicy))
      return true;
  } else if (targetApproval > sourceApproval) return true;
  const a = source.sandboxPolicy,
    b = destination.sandboxPolicy;
  if (a.type === "externalSandbox" || b.type === "externalSandbox") return true;
  if (b.type === "dangerFullAccess") return a.type !== "dangerFullAccess";
  if (a.type === "dangerFullAccess") return false;
  if (!a.networkAccess && b.networkAccess) return true;
  if (b.type === "readOnly") return false;
  if (a.type !== "workspaceWrite") return true;
  if (
    (a.excludeTmpdirEnvVar && !b.excludeTmpdirEnvVar) ||
    (a.excludeSlashTmp && !b.excludeSlashTmp)
  )
    return true;
  const roots = [...a.writableRoots, ...(source.runtimeWorkspaceRoots ?? [])];
  return [...b.writableRoots, ...(destination.runtimeWorkspaceRoots ?? [])].some(
    (root) => !roots.some((allowed) => coversRoot(allowed, root)),
  );
};
/** Target settings cannot widen what the calling execution is allowed to request. */
export const sessionMessageCeilingError = (
  caller: SessionMessageFacts,
  target: SessionMessageFacts,
): string | null => {
  if (
    caller.nativeSandbox &&
    target.nativeSandbox &&
    sandboxRank[target.nativeSandbox] > sandboxRank[caller.nativeSandbox]
  )
    return "runtime_mode_escalation_denied";
  if (
    runtimeRank[target.runtimeMode] > runtimeRank[caller.runtimeMode] ||
    nativePermissionsWiden(caller, target)
  )
    return "runtime_mode_escalation_denied";
  if (caller.interactionMode === "plan" && target.interactionMode !== "plan")
    return "interaction_mode_escalation_denied";
  return null;
};
