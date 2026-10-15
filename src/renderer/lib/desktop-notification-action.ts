import type { DesktopNotificationActionInvocation } from "../../shared/types";

export interface DesktopNotificationActionManager {
  asyncQuestions?: {
    open(threadId: string, questionId: string): void;
    read(threadId: string): { activeTurnId: string | null };
  };
  startTurn(conversationId: string, prompt: string): Promise<unknown>;
}

export type DesktopNotificationActionResult = "opened" | "replied" | "ignored";

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

/** Execute a native notification action after Workbench navigation settles. */
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

  return "ignored";
}
