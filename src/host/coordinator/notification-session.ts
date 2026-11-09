import * as Effect from "effect/Effect";
import type { CodexThreadNotificationEvent } from "../../shared/codex-thread-notification";
import { readCodexLinkedRootSession } from "../../main/codex-application/CodexLinkedRootSession";
import type { CoreModules } from "../../main/core-runtime/CoreModules";

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

/** Nodex speaks for this chat: it is the Coordinator, or a chat the Coordinator manages. */
export const sessionSpeaksThroughNodex = Effect.fn("Coordinator.sessionSpeaksThroughNodex")(
  function* (core: CoreModules["Service"], sessionId: string) {
    const coordinator = yield* core.workspace.read({ kind: "read_coordinator" }, undefined, null);
    if (coordinator.value.kind === "read_coordinator" && coordinator.value.session_id === sessionId)
      return true;
    const membership = yield* core.workspace.read(
      { kind: "read_managed_session", session_id: sessionId },
      undefined,
      null,
    );
    return membership.value.kind === "read_managed_session" && !!membership.value.managed;
  },
);

/**
 * A chat stays quiet on every channel when Nodex speaks for it: a managed chat's result and
 * requests reach the person as Nodex posts and Page Turns, and Nodex itself speaks only through
 * its posts.
 */
export const turnSpeaksThroughNodex = Effect.fn("Coordinator.turnSpeaksThroughNodex")(function* (
  core: CoreModules["Service"],
  notification: CodexThreadNotificationEvent,
) {
  const sessionId = yield* notificationSession(core, notification);
  return sessionId ? yield* sessionSpeaksThroughNodex(core, sessionId) : false;
});
