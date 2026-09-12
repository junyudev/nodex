import type { CodexConversationRequestContext } from "./codex-conversation-request-context";
import type {
  CodexApprovalRequest,
  CodexPermissionRequest,
  CodexProtocolRequestId,
  CodexCanonicalServerRequest,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function normalizeOwnerApprovalAvailableDecisions(
  value: readonly unknown[] | null | undefined,
): string[] | null {
  if (!value || value.length === 0) return null;

  const decisions = value
    .map((decision) => {
      if (typeof decision === "string") return decision;
      const record = asRecord(decision);
      return record ? (Object.keys(record)[0] ?? "") : "";
    })
    .filter((decision) => decision.length > 0);

  return decisions.length > 0 ? decisions : null;
}

export function buildCodexCommandApprovalRequest(
  conversation: Pick<CodexConversationRequestContext, "projectId">,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexCanonicalServerRequest,
    {
      method: "item/commandExecution/requestApproval";
    }
  >["params"],
): CodexApprovalRequest {
  const command = params.command ?? "";
  const commandActions = params.commandActions ?? null;
  const commandActionCommands =
    commandActions
      ?.map((action) => action.command)
      .filter(
        (command): command is string => typeof command === "string" && command.trim().length > 0,
      ) ?? [];

  return {
    type: "approval",
    requestId,
    kind: "command",
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    approvalId: params.approvalId ?? null,
    approvalRequestId: requestId,
    callId: params.itemId,
    reason: params.reason ?? undefined,
    command: command || undefined,
    cwd: params.cwd ?? undefined,
    approvalReason: params.reason ?? undefined,
    cmd:
      commandActionCommands.length > 0
        ? commandActionCommands
        : command.trim().length > 0
          ? command.split(" ").filter((segment) => segment.trim().length > 0)
          : undefined,
    networkApprovalContext: params.networkApprovalContext
      ? {
          host: params.networkApprovalContext.host,
          protocol: params.networkApprovalContext.protocol,
        }
      : null,
    proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
    proposedNetworkPolicyAmendments:
      params.proposedNetworkPolicyAmendments?.map((amendment) => ({
        host: amendment.host,
        action: amendment.action,
      })) ?? null,
    availableDecisions: normalizeOwnerApprovalAvailableDecisions(params.availableDecisions),
    grantRoot: null,
    commandActions,
    createdAt: params.startedAtMs,
  };
}

export function buildCodexFileApprovalRequest(
  conversation: Pick<CodexConversationRequestContext, "projectId">,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexCanonicalServerRequest,
    {
      method: "item/fileChange/requestApproval";
    }
  >["params"],
): CodexApprovalRequest {
  return {
    type: "approval",
    requestId,
    kind: "file",
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    approvalRequestId: requestId,
    callId: params.itemId,
    reason: params.reason ?? undefined,
    approvalReason: params.reason ?? undefined,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
    availableDecisions: null,
    grantRoot: params.grantRoot ?? null,
    commandActions: null,
    createdAt: params.startedAtMs,
  };
}

export function buildCodexPermissionRequest(
  conversation: Pick<CodexConversationRequestContext, "projectId">,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexCanonicalServerRequest,
    {
      method: "item/permissions/requestApproval";
    }
  >["params"],
): CodexPermissionRequest {
  return {
    type: "permissionRequest",
    requestId,
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    cwd: params.cwd,
    reason: params.reason,
    permissions: params.permissions,
    response: null,
    completed: false,
    createdAt: params.startedAtMs,
  };
}

/** Derives the background control surface directly from a retained native request. */
export function projectCodexBackgroundRequest(
  conversation: Pick<CodexConversationRequestContext, "projectId">,
  request: CodexCanonicalServerRequest,
): CodexApprovalRequest | CodexPermissionRequest | null {
  switch (request.method) {
    case "item/commandExecution/requestApproval":
      return buildCodexCommandApprovalRequest(conversation, request.id, request.params);
    case "item/fileChange/requestApproval":
      return buildCodexFileApprovalRequest(conversation, request.id, request.params);
    case "item/permissions/requestApproval":
      return buildCodexPermissionRequest(conversation, request.id, request.params);
    default:
      return null;
  }
}
