import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import {
  ChatSearchEngineUnavailable,
  makeChatSearchEngine,
  type SessionSearchPage,
} from "../chat-search/ChatSearchEngine";
import {
  isChatSearchWorkerHostMessage,
  type ChatSearchWorkerCall,
  type ChatSearchWorkerHostMessage,
  type ChatSearchWorkerThreadMessage,
} from "./chat-search-worker-protocol";

export class ChatSearchWorkerProtocolError extends Data.TaggedError(
  "ChatSearchWorkerProtocolError",
)<{ readonly message: string }> {}

/** Main sends a message per query, cancel or history answer; far more means the protocol broke.
 * The worker then exits, and Main's next search starts another one. */
const INBOX_CAPACITY = 1_024;

export interface ChatSearchWorkerPort {
  readonly post: (message: ChatSearchWorkerThreadMessage) => void;
  readonly listen: (listener: (message: unknown) => void) => () => void;
}

const errorMessage = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error ? error.message : String(error);
};

/** Serves one Main connection until it asks the worker to shut down. */
export const serveChatSearchWorker = (port: ChatSearchWorkerPort, epoch: number) =>
  Effect.scoped(
    Effect.gen(function* () {
      const histories = new Map<
        number,
        Deferred.Deferred<SessionSearchPage, ChatSearchEngineUnavailable>
      >();
      let nextHistory = 1;
      const engine = yield* makeChatSearchEngine((request) =>
        Effect.suspend(() => {
          const id = nextHistory++;
          const reply = Deferred.makeUnsafe<SessionSearchPage, ChatSearchEngineUnavailable>();
          histories.set(id, reply);
          port.post({ type: "history", id, request });
          return Deferred.await(reply).pipe(
            Effect.ensuring(Effect.sync(() => histories.delete(id))),
          );
        }),
      );
      const invoke = (call: ChatSearchWorkerCall): Effect.Effect<unknown, unknown> => {
        switch (call.method) {
          case "search":
            return engine.search(call.request);
          case "searchMessages":
            return engine.searchMessages(call.request);
          case "rankSessionIds":
            return engine.rankSessionIds(call.request);
        }
      };
      const calls = yield* FiberMap.make<number>();
      const inbox = yield* Queue.bounded<
        ChatSearchWorkerHostMessage,
        ChatSearchWorkerProtocolError
      >(INBOX_CAPACITY);
      const reject = (message: string) =>
        Queue.failCauseUnsafe(inbox, Cause.fail(new ChatSearchWorkerProtocolError({ message })));
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          port.listen((raw) => {
            if (!isChatSearchWorkerHostMessage(raw))
              reject("Chat search worker received an invalid host message");
            else if (!Queue.offerUnsafe(inbox, raw)) reject("Chat search worker inbox overflowed");
          }),
        ),
        (release) => Effect.sync(release),
      );
      port.post({ type: "ready", epoch });
      // One consumer applies catalogs and starts calls in the order Main sent them.
      while (true) {
        const message = yield* Queue.take(inbox);
        if (message.type === "shutdown") return;
        if (message.type === "publish") yield* engine.publish(message.entries);
        else if (message.type === "cancel") yield* FiberMap.remove(calls, message.id);
        else if (message.type === "history") {
          const reply = histories.get(message.id);
          if (reply)
            yield* Deferred.done(
              reply,
              message.outcome.ok
                ? Exit.succeed(message.outcome.value)
                : Exit.fail(new ChatSearchEngineUnavailable({ message: message.outcome.message })),
            );
        } else {
          const { id } = message;
          yield* FiberMap.run(
            calls,
            id,
            invoke(message.call).pipe(
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.sync(() =>
                  port.post({
                    type: "result",
                    id,
                    outcome: Exit.isSuccess(exit)
                      ? { ok: true, value: exit.value }
                      : { ok: false, message: errorMessage(exit.cause) },
                  }),
                ),
              ),
            ),
          );
        }
      }
    }),
  );
