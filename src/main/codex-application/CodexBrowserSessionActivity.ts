import { CodexGateway } from "../codex-runtime/CodexGateway";
import { parseCodexAppServerMessage } from "../codex/codex-app-server-message-parser";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";
import { BrowserUseRuntime } from "../host-runtime/BrowserUseRuntime";

/** Stop browser control immediately when interruption starts, before the native turn settles. */
export const install = Effect.gen(function* () {
  const events = yield* CodexApplicationEventHub;
  const browser = yield* BrowserUseRuntime;
  const gateway = yield* CodexGateway;
  yield* events.events.pipe(Stream.runForEach((event) => {
    if (event.kind !== "conversationTurnInterruptStarted") return Effect.void;
    return browser.endSessionActivity(event.value).pipe(Effect.catch((cause) => Effect.logWarning("Browser activity release failed", cause)));
  }), Effect.forkScoped({ startImmediately: true }));
  yield* gateway.events.pipe(Stream.runForEach((event) => Effect.gen(function* () {
    if (event.kind === "connection" || event.value.method !== "thread/status/changed") return;
    const parsed = parseCodexAppServerMessage(event.value);
    if (!parsed.success || parsed.data.kind !== "notification" || parsed.data.notification.method !== "thread/status/changed" || parsed.data.notification.params.status.type !== "idle") return;
    const connection = yield* gateway.connection(event.hostId);
    if (connection.kind !== "ready" || connection.generation !== event.generation) return;
    yield* browser.endSessionActivity(parsed.data.notification.params.threadId);
  }).pipe(Effect.catch((cause) => Effect.logWarning("Browser idle activity release failed", cause)))), Effect.forkScoped({ startImmediately: true }));

});
