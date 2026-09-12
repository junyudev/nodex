import type {
  ActivePermissionProfile,
  AskForApproval,
  ApprovalsReviewer,
  ConfigReadResponse,
  SandboxPolicy,
  SandboxWorkspaceWrite,
  TurnStartParams,
} from "@nodex/codex-app-server-protocol/v2";
import { CODEX_GRANULAR_APPROVAL_POLICY } from "../codex-permission-catalog";

export type CanonicalPermissionConfig = Partial<
  Pick<
    ConfigReadResponse["config"],
    "sandbox_mode" | "sandbox_workspace_write" | "approval_policy" | "approvals_reviewer"
  >
> & { readonly features?: unknown; readonly "features.guardian_approval"?: unknown };

export interface CanonicalNativePermissions {
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly sandboxPolicy: SandboxPolicy;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
}
const readOnly = (
  approval: AskForApproval | null | undefined = "on-request",
  reviewer: ApprovalsReviewer = "user",
  profile: ActivePermissionProfile | null = { id: ":read-only", extends: null },
): CanonicalNativePermissions => ({
  activePermissionProfile: profile,
  sandboxPolicy: { type: "readOnly", networkAccess: false },
  approvalPolicy: approval ?? "on-request",
  approvalsReviewer: reviewer,
});
const fullAccess = (
  approval: AskForApproval | null | undefined = "never",
  reviewer: ApprovalsReviewer = "user",
  profile: ActivePermissionProfile | null = { id: ":danger-full-access", extends: null },
): CanonicalNativePermissions => ({
  activePermissionProfile: profile,
  sandboxPolicy: { type: "dangerFullAccess" },
  approvalPolicy: approval ?? "never",
  approvalsReviewer: reviewer,
});
const workspace = (
  roots: readonly string[],
  config?: SandboxWorkspaceWrite | null,
  approval?: AskForApproval | null,
  reviewer: ApprovalsReviewer = "user",
  profile: ActivePermissionProfile | null = config == null
    ? { id: ":workspace", extends: null }
    : null,
): CanonicalNativePermissions => ({
  activePermissionProfile: profile,
  runtimeWorkspaceRoots: roots,
  sandboxPolicy: {
    type: "workspaceWrite",
    writableRoots: [...roots, ...(config?.writable_roots ?? [])],
    excludeSlashTmp: config?.exclude_slash_tmp ?? false,
    excludeTmpdirEnvVar: config?.exclude_tmpdir_env_var ?? false,
    networkAccess: config?.network_access ?? false,
  },
  approvalPolicy: approval ?? "on-request",
  approvalsReviewer: reviewer,
});

/** Materializes explicit permission selection after the operation's actual working directory is known. */
export function canonicalPermissionsForMode(
  mode: unknown,
  roots: readonly string[],
  config: CanonicalPermissionConfig,
): CanonicalNativePermissions | null {
  switch (mode) {
    case "read-only":
      return { ...readOnly(), runtimeWorkspaceRoots: roots };
    case "full-access":
      return { ...fullAccess(), runtimeWorkspaceRoots: roots };
    case "auto":
      return workspace(roots);
    case "granular":
      return workspace(roots, undefined, CODEX_GRANULAR_APPROVAL_POLICY);
    case "guardian-approvals": {
      const defaultApproval =
        config.approval_policy === "on-request" || config.approval_policy == null;
      if (config.sandbox_mode === "read-only" && defaultApproval)
        return { ...readOnly(undefined, "guardian_subagent"), runtimeWorkspaceRoots: roots };
      if (config.sandbox_mode === "workspace-write" && defaultApproval)
        return workspace(
          roots,
          config.sandbox_workspace_write,
          undefined,
          "guardian_subagent",
          null,
        );
      return workspace(roots, undefined, undefined, "guardian_subagent");
    }
    case "custom": {
      const record = config as Record<string, unknown>;
      const features = record.features;
      const feature =
        typeof record["features.guardian_approval"] === "boolean"
          ? record["features.guardian_approval"]
          : features && typeof features === "object"
            ? Object.getOwnPropertyDescriptor(features, "guardian_approval")?.value
            : undefined;
      const requested = config.approvals_reviewer;
      const reviewer =
        requested === "auto_review" || (requested === "guardian_subagent" && feature !== false)
          ? requested
          : "user";
      if (config.sandbox_mode === "danger-full-access")
        return fullAccess(config.approval_policy, reviewer, null);
      if (config.sandbox_mode === "workspace-write")
        return workspace(
          roots,
          config.sandbox_workspace_write,
          config.approval_policy,
          reviewer,
          null,
        );
      if (config.sandbox_mode == null || config.sandbox_mode === "read-only")
        return readOnly(config.approval_policy, reviewer, null);
      return null;
    }
    default:
      return null;
  }
}

export function nativePermissionRequestFields(
  permissions: CanonicalNativePermissions,
): Pick<
  TurnStartParams,
  "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "permissions" | "runtimeWorkspaceRoots"
> {
  return {
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    ...(permissions.activePermissionProfile == null
      ? { sandboxPolicy: permissions.sandboxPolicy }
      : {
          permissions: permissions.activePermissionProfile.id,
          runtimeWorkspaceRoots: [...(permissions.runtimeWorkspaceRoots ?? [])],
        }),
  };
}
