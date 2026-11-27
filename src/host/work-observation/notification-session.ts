import { readDecisionRun } from "../nodex-decisions/decision-run-role";
import * as Effect from "effect/Effect";
import type { CodexThreadNotificationEvent } from "../../shared/codex-thread-notification";
import { readCodexLinkedRootSession } from "../../main/codex-application/CodexLinkedRootSession";
import type { CoreModules } from "../../main/core-runtime/CoreModules";

/** Runtime occurrences name their Session; native occurrences require the exact host/root binding. */
export const notificationSession = Effect.fn("ChatNotification.session")(function* (
  core: CoreModules["Service"],
  event: CodexThreadNotificationEvent,
) {
  if ("conversation" in event && event.conversation.runtimeSessionId)
    return event.conversation.runtimeSessionId;
  const conversationId =
    "conversation" in event ? event.conversation.conversationId : event.conversationId;
  if (conversationId.startsWith("session:")) return conversationId.slice("session:".length);
  return (
    (yield* readCodexLinkedRootSession(core, { hostId: event.hostId, threadId: conversationId }))
      ?.id ?? null
  );
});

export const isManagedChat = Effect.fn("ChatNotification.isManaged")(function* (
  core: CoreModules["Service"],
  sessionId: string,
) {
  const membership = yield* core.workspace.read({ kind: "managed_chat", session_id: sessionId });
  return membership.value.kind === "managed_chat" && !!membership.value.managed;
});

/** Page Turns own attention for managed chats. Decision runs stay out of chat attention. */
export const chatNotificationRole = Effect.fn("ChatNotification.role")(function* (
  core: CoreModules["Service"],
  sessionId: string | null,
) {
  if (!sessionId) return "chat";
  if (yield* readDecisionRun(core, sessionId)) return "decision";
  return (yield* isManagedChat(core, sessionId)) ? "managed" : "chat";
});
