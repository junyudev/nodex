import type { CodexCanonicalServerRequest } from "../../shared/codex-conversation-state/codex-conversation-state";
import type {
  CodexApprovalKind,
  CodexProtocolRequestId,
  DesktopNotificationActionInvocation,
} from "../../shared/types";

export interface DesktopNotificationActionManager {
  asyncQuestions?: {
    open(threadId: string, questionId: string): void;
    read(threadId: string): { activeTurnId: string | null };
  };
  readConversation(conversationId: string): {
    canonicalRequests?: readonly CodexCanonicalServerRequest[];
  } | null;
  startTurn(conversationId: string, prompt: string): Promise<unknown>;
  respondApproval(
    requestId: CodexProtocolRequestId,
    response: {
      kind: CodexApprovalKind;
      decision: "accept" | "acceptForSession" | "decline";
    },
    conversationId: string,
  ): Promise<unknown>;
}

export type DesktopNotificationActionResult =
  | "opened"
  | "replied"
  | "approval-responded"
  | "ignored";

function decodeNavigationSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function resolveDesktopNotificationParentThreadId(
  invocation: DesktopNotificationActionInvocation,
): string | null {
  const path = invocation.navigationPath?.trim() ?? "";
  if (path.length > 0) {
    const threadSegment = path.split("/").findLast((segment) => segment.startsWith("thread:"));
    const encodedThreadId = threadSegment?.slice("thread:".length).trim() ?? "";
    if (encodedThreadId.length > 0) return decodeNavigationSegment(encodedThreadId);
  }
  return invocation.conversationId;
}

export function resolveDesktopNotificationSideChatThreadId(
  invocation: DesktopNotificationActionInvocation,
): string | null {
  const conversationId = invocation.conversationId;
  if (!conversationId) return null;
  if (invocation.activateTabId !== `sidechat:${conversationId}`) return null;
  return conversationId;
}

function resolveLiveApprovalKind(
  manager: DesktopNotificationActionManager,
  conversationId: string,
  requestId: CodexProtocolRequestId,
): CodexApprovalKind | null {
  const request = manager
    .readConversation(conversationId)
    ?.canonicalRequests?.find((candidate) => candidate.id === requestId);
  if (!request) return null;
  if (request.method === "item/commandExecution/requestApproval") return "command";
  if (request.method === "item/fileChange/requestApproval") return "file";
  return null;
}

/**
 * Executes a native notification action only after Workbench navigation has
 * completed. Approval intent is revalidated against live canonical request
 * state so a stale notification cannot answer a resolved or replaced request.
 */
export async function executeDesktopNotificationAction(
  invocation: DesktopNotificationActionInvocation,
  manager: DesktopNotificationActionManager,
): Promise<DesktopNotificationActionResult> {
  if (invocation.asyncQuestion) {
    if (invocation.actionType !== "open" || !invocation.conversationId) return "ignored";
    const runtime = manager.asyncQuestions;
    if (runtime?.read(invocation.conversationId).activeTurnId !== invocation.asyncQuestion.turnId)
      return "ignored";
    runtime.open(invocation.conversationId, invocation.asyncQuestion.questionId);
    return "opened";
  }
  if (invocation.actionType === "open") return "opened";

  const conversationId = invocation.conversationId;
  if (!conversationId) return "ignored";

  if (invocation.actionType === "reply") {
    const reply = invocation.reply?.trim() ?? "";
    if (reply.length === 0) return "ignored";
    await manager.startTurn(conversationId, reply);
    return "replied";
  }

  const requestId = invocation.requestId;
  if (requestId === null) return "ignored";
  const kind = resolveLiveApprovalKind(manager, conversationId, requestId);
  if (!kind) return "ignored";

  const decision =
    invocation.actionType === "approve"
      ? "accept"
      : invocation.actionType === "approve-for-session"
        ? "acceptForSession"
        : invocation.actionType === "decline"
          ? "decline"
          : null;
  if (!decision) return "ignored";

  await manager.respondApproval(requestId, { kind, decision }, conversationId);
  return "approval-responded";
}
