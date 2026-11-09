import * as Effect from "effect/Effect";
import type { CodexThreadNotificationEvent } from "../../shared/codex-thread-notification";

/** Runtime occurrences name their Session; native occurrences require the exact host/root binding. */
export const notificationSession = Effect.fn("Coordinator.notificationSession")(function* (
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

/**
 * A chat stays quiet on every channel when Nodex speaks for it: a managed chat's result and
 */
export const turnSpeaksThroughNodex = Effect.fn("Coordinator.turnSpeaksThroughNodex")(function* (
  core: CoreModules["Service"],
  notification: CodexThreadNotificationEvent,
) {
  const sessionId = yield* notificationSession(core, notification);
});
