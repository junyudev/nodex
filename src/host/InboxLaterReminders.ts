import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { CoreModules } from "../main/core-runtime/CoreModules";
import { createOperationId } from "../main/core-runtime/operation-identity";

/** The Host wakes at the earliest deadline; only Core decides what is due. */
export const makeInboxLaterReminders = Effect.fn("InboxLaterReminders.make")(function* (options: {
  readonly next: Effect.Effect<string | null, unknown>;
  readonly publishDue: (wakeAt: string) => Effect.Effect<unknown, unknown>;
  readonly changes: Stream.Stream<unknown>;
}) {
  const wakes = yield* Queue.sliding<void>(1);
  const wake = Queue.offer(wakes, undefined).pipe(Effect.asVoid);
  const wait = (delay: number) =>
    Effect.timeoutOrElse(Queue.take(wakes), {
      duration: Math.min(delay, 2_147_483_647),
      orElse: () => Effect.void,
    });
  yield* options.changes.pipe(
    Stream.runForEach(() => wake),
    Effect.forkScoped({ startImmediately: true }),
  );
  const step = Effect.gen(function* () {
    const next = yield* options.next;
    if (next === null) {
      yield* Queue.take(wakes);
      return;
    }
    const deadline = Date.parse(next);
    const delay = deadline - (yield* Clock.currentTimeMillis);
    // Core accepts sub-millisecond instants, while timers and SQLite's clock use milliseconds.
    if (delay >= 0) {
      yield* wait(delay + 1);
      if (deadline >= (yield* Clock.currentTimeMillis)) return;
    }
    yield* options.publishDue(next);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Inbox reminder delivery failed", cause).pipe(Effect.andThen(wait(30_000))),
    ),
  );
  yield* Effect.forever(step).pipe(Effect.forkScoped);
  return { wake };
});

export const inboxLaterClock = Effect.fn("InboxLaterReminders.clock")(function* (
  ready: Effect.Effect<boolean>,
  changes: Stream.Stream<unknown>,
) {
  const core = yield* CoreModules;
  return yield* makeInboxLaterReminders({
    changes,
    next: Effect.gen(function* () {
      if (!(yield* ready)) return null;
      const snapshot = yield* core.workspace.read({ kind: "next_inbox_later" }, undefined, null);
      return snapshot.value.kind === "next_inbox_later" ? (snapshot.value.remind_at ?? null) : null;
    }),
    publishDue: (wakeAt) =>
      core.workspace.apply(
        {
          operationId: createOperationId("inbox.later.due"),
          intent: { kind: "publish_due_inbox_later", wake_at: wakeAt },
        },
        undefined,
        null,
      ),
  });
});
