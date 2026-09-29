import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ClaudeDiscoveryRequestError extends Schema.TaggedError<ClaudeDiscoveryRequestError>()(
  "ClaudeDiscoveryRequestError",
  { message: Schema.String },
) {}

/** Each viewer owns its requests, including cancellation that arrives before query registration. */
export const makeClaudeDiscoveryRequests = Effect.gen(function* () {
  const pending = new Map<
    string,
    { ownerId: number; cancel: Deferred.Deferred<void>; done: Deferred.Deferred<void> }
  >();
  const cancelled = new Map<string, number>();
  let closed = false;
  const key = (ownerId: number, requestId: string) => `${ownerId}:${requestId}`;
  const purge = (now: number) => {
    for (const [id, expires] of cancelled) if (expires <= now) cancelled.delete(id);
  };
  const close = Effect.gen(function* () {
    closed = true;
    const entries = [...pending.values()];
    yield* Effect.forEach(entries, (entry) => Deferred.succeed(entry.cancel, undefined), {
      discard: true,
    });
    yield* Effect.forEach(entries, (entry) => Deferred.await(entry.done), {
      discard: true,
      concurrency: "unbounded",
    });
    cancelled.clear();
  });
  yield* Effect.addFinalizer(() => close);
  return {
    run: <A, E, R>(ownerId: number, requestId: string, evaluate: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const requestKey = key(ownerId, requestId);
          purge(yield* Clock.currentTimeMillis);
          if (closed)
            return yield* new ClaudeDiscoveryRequestError({
              message: "Claude discovery is closing",
            });
          if (cancelled.delete(requestKey)) return yield* Effect.interrupt;
          const cancel = yield* Deferred.make<void>();
          const done = yield* Deferred.make<void>();
          if (pending.has(requestKey))
            return yield* new ClaudeDiscoveryRequestError({
              message: "This discovery request is already running",
            });
          if (
            pending.size >= 32 ||
            [...pending.values()].filter((entry) => entry.ownerId === ownerId).length >= 8
          )
            return yield* new ClaudeDiscoveryRequestError({
              message: "Too many Claude discovery requests",
            });
          const entry = { ownerId, cancel, done };
          pending.set(requestKey, entry);
          return yield* restore(
            Effect.raceFirst(
              Effect.scoped(evaluate),
              Deferred.await(cancel).pipe(Effect.andThen(Effect.interrupt)),
            ),
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (pending.get(requestKey) === entry) pending.delete(requestKey);
              }).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
            ),
          );
        }),
      ),
    cancel: (ownerId: number, requestId: string) =>
      Effect.gen(function* () {
        const requestKey = key(ownerId, requestId);
        const entry = pending.get(requestKey);
        if (entry) {
          yield* Deferred.succeed(entry.cancel, undefined);
          yield* Deferred.await(entry.done);
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        purge(now);
        if (cancelled.size >= 64) {
          const oldest = cancelled.keys().next().value;
          if (oldest) cancelled.delete(oldest);
        }
        cancelled.set(requestKey, now + 60_000);
      }),
  };
});
