import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
/** Core policy is reconciled after reconnect and on every hold invalidation, including CLI writes. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const runtime = yield* AgentRuntimeApplication;
    const notifier = yield* DatabaseNotifierRuntime;
    const reconcile = runtime.reconcileExecutionHolds.pipe(
      Effect.repeat({
        while: (result) => result.requested,
        schedule: Schedule.spaced("250 millis"),
      }),
      Effect.timeout("30 seconds"),
      Effect.catchCause((cause) =>
        Effect.logWarning("Execution holds await reconciliation", { cause }),
      ),
    );
    yield* Stream.mergeAll(
      [
        notifier.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("30 seconds")),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => reconcile),
      Effect.forkScoped,
    );
    yield* reconcile.pipe(Effect.forkScoped);
  }),
);
