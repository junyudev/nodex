import type { ApprovalsReviewer, AskForApproval } from "@nodex/codex-app-server-protocol/v2";
import type { CodexAgentMode } from "./types";

export type CodexPermissionAgentMode = Exclude<CodexAgentMode, "custom">;

export const CODEX_GRANULAR_APPROVAL_POLICY = {
  granular: {
    sandbox_approval: false,
    rules: false,
    skill_approval: false,
    request_permissions: true,
    mcp_elicitations: false,
  },
} as const satisfies AskForApproval;

interface CodexPermissionCatalogEntry {
  readonly permissionProfileId: string;
  readonly approvalPolicy: AskForApproval;
  readonly approvalsReviewer: ApprovalsReviewer;
}

export const CODEX_PERMISSION_CATALOG: Readonly<
  Record<CodexPermissionAgentMode, CodexPermissionCatalogEntry>
> = {
  "read-only": {
    permissionProfileId: ":read-only",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  auto: {
    permissionProfileId: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
  },
  granular: {
    permissionProfileId: ":workspace",
    approvalPolicy: CODEX_GRANULAR_APPROVAL_POLICY,
    approvalsReviewer: "user",
  },
  "guardian-approvals": {
    permissionProfileId: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
  },
  "full-access": {
    permissionProfileId: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
  },
};
