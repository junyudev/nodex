import type { DesktopNotificationActionInvocation } from "../../shared/types";
import { nativeSideChatTabId, runtimeSideChatSessionIdFromTabId } from "../../shared/side-chat-tab";

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

function resolveNavigationThreadId(invocation: DesktopNotificationActionInvocation): string | null {
  const path = invocation.navigationPath?.trim() ?? "";
  if (path.length > 0) {
    const threadSegment = path.split("/").findLast((segment) => segment.startsWith("thread:"));
    const encodedThreadId = threadSegment?.slice("thread:".length).trim() ?? "";
    if (encodedThreadId.length > 0) return decodeNavigationSegment(encodedThreadId);
  }
  return invocation.conversationId;
}

function resolveNavigationSessionId(
  invocation: DesktopNotificationActionInvocation,
): string | null {
  const segment = (invocation.navigationPath ?? "")
    .split("/")
    .find((part) => part.startsWith("session:"));
  const encoded = segment?.slice("session:".length).trim() ?? "";
  return encoded.length > 0 ? decodeNavigationSegment(encoded) : null;
}

/**
 * Where a notification opens. A side chat never opens as its own Scene: it opens its source
 * conversation, then the side-chat tab inside it.
 */
export type DesktopNotificationTarget =
  | {
      /** A Runtime-bound Session, opened by its product Session rather than a native Thread. */
      readonly kind: "runtime";
      readonly sessionId: string;
      readonly threadId: string;
      /** The temporary side-chat Session to select inside `sessionId`, which also takes replies. */
      readonly sideChatSessionId: string | null;
    }
  | {
      readonly kind: "native";
      readonly threadId: string;
      /** The temporary native side-chat Thread to select inside `threadId`'s Session. */
      readonly sideChatThreadId: string | null;
    };

export function resolveDesktopNotificationTarget(
  invocation: DesktopNotificationActionInvocation,
): DesktopNotificationTarget | null {
  const threadId = resolveNavigationThreadId(invocation);
  if (!threadId) return null;
  // A native side chat's parent path names its Session too; the tab identity decides ownership.
  const conversationId = invocation.conversationId;
  if (conversationId && invocation.activateTabId === nativeSideChatTabId(conversationId))
    return { kind: "native", threadId, sideChatThreadId: conversationId };
  const sessionId = resolveNavigationSessionId(invocation);
  if (!sessionId) return { kind: "native", threadId, sideChatThreadId: null };
  return {
    kind: "runtime",
    sessionId,
    threadId,
    sideChatSessionId: runtimeSideChatSessionIdFromTabId(invocation.activateTabId),
  };
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

/**
 * Actions on a Runtime-bound conversation. Opening already presented the Session; a reply is
 * an ordinary follow-up through the Session's execution owner, never a native turn.
 */
export async function executeRuntimeDesktopNotificationAction(
  invocation: DesktopNotificationActionInvocation,
  sessionId: string,
  sendMessage: (input: { readonly sessionId: string; readonly text: string }) => Promise<unknown>,
): Promise<DesktopNotificationActionResult> {
  if (invocation.actionType === "open") return "opened";
  if (invocation.actionType !== "reply") return "ignored";
  const reply = invocation.reply?.trim() ?? "";
  if (reply.length === 0) return "ignored";
  await sendMessage({ sessionId, text: reply });
  return "replied";
}
