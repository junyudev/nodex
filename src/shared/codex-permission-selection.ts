import type { TurnStartParams } from "@nodex/codex-app-server-protocol/v2";
import {
  canonicalPermissionsForMode,
  nativePermissionRequestFields,
  type CanonicalPermissionConfig,
} from "./codex-conversation-state/codex-native-permissions";
import {
  CODEX_PERMISSION_CATALOG,
  type CodexPermissionAgentMode,
} from "./codex-permission-catalog";

export type CodexPermissionSelection =
  | { readonly kind: "agent-mode"; readonly agentMode: CodexPermissionAgentMode }
  | { readonly kind: "profile"; readonly profileId: string }
  | { readonly kind: "custom" }
  | { readonly kind: "server-default" };

export type CodexPermissionSelectionRequestFields = Partial<
  Pick<TurnStartParams, "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy" | "permissions">
>;

/** Materializes the captured modern permission selection after its workspace is resolved. */
export function materializeCodexPermissionSelection(
  selection: CodexPermissionSelection,
  runtimeWorkspaceRoots: readonly string[],
  config: CanonicalPermissionConfig | null,
): CodexPermissionSelectionRequestFields | null {
  if (selection.kind === "server-default") return null;
  if (selection.kind === "profile") {
    return { permissions: selection.profileId };
  }
  if (selection.kind === "agent-mode") {
    const entry = CODEX_PERMISSION_CATALOG[selection.agentMode];
    return {
      permissions: entry.permissionProfileId,
      approvalPolicy: entry.approvalPolicy,
      approvalsReviewer: entry.approvalsReviewer,
    };
  }
  if (config === null) throw new Error("Custom permission selection requires config");
  const permissions = canonicalPermissionsForMode("custom", runtimeWorkspaceRoots, config);
  if (permissions === null)
    throw new Error("Custom permission selection could not be materialized");
  const fields = nativePermissionRequestFields(permissions);
  return {
    approvalPolicy: fields.approvalPolicy,
    approvalsReviewer: fields.approvalsReviewer,
    ...(fields.permissions === undefined
      ? { sandboxPolicy: fields.sandboxPolicy }
      : { permissions: fields.permissions }),
  };
}
