import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Semaphore from "effect/Semaphore";

/** Snapshot admission drains borrowed requests without cancelling or serializing ordinary work. */
export const makeCodexSnapshotAdmission = Effect.fn("makeCodexSnapshotAdmission")(function* () {
  const accepting = yield* Latch.make(true);
  const drained = yield* Latch.make(true);
  const snapshots = yield* Semaphore.make(1);
  let borrowers = 0;
  let draining = false;

  const enter = (settleActiveWork: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!accepting.isOpen() && !(settleActiveWork && draining))
        return accepting.await.pipe(Effect.andThen(enter(settleActiveWork)));
      borrowers += 1;
      drained.closeUnsafe();
      return Effect.void;
    });
  const leave = Effect.sync(() => {
    borrowers -= 1;
    if (borrowers === 0) drained.openUnsafe();
  });

  return {
    request: <A, E, R>(
      operation: Effect.Effect<A, E, R>,
      settleActiveWork = false,
    ): Effect.Effect<A, E, R> =>
      Effect.scoped(
        Effect.acquireRelease(enter(settleActiveWork), () => leave, { interruptible: true }).pipe(
          Effect.andThen(operation),
        ),
      ),
    snapshot: <A, E, R>(operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.scoped(
        Effect.acquireRelease(
          Effect.sync(() => {
            draining = true;
            accepting.closeUnsafe();
          }),
          () =>
            Effect.sync(() => {
              draining = false;
              accepting.openUnsafe();
            }),
        ).pipe(Effect.andThen(drained.await), Effect.andThen(operation)),
      ).pipe(snapshots.withPermits(1)),
    seal: Effect.sync(() => {
      draining = false;
    }).pipe(Effect.andThen(drained.await)),
  };
});
