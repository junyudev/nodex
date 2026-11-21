import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

export interface ManagedOperation {
  readonly operationId: string;
  readonly phase: "running" | "succeeded" | "failed" | "cancelled";
  readonly revision: number;
  readonly cancellable: boolean;
  readonly result: unknown;
  readonly error: unknown;
  readonly progress?: unknown;
}

/** Owns bounded request-independent work, progress revisions, idempotency and cancellation. */
export const makeManagedOperations = Effect.fn("ManagedOperations.make")(function* <
  State extends ManagedOperation,
  Failure,
>(options: {
  readonly failure: (
    reason: "invalid_request" | "operation_expired" | "busy",
    message: string,
  ) => Failure;
  readonly mapError: (error: unknown) => State["error"];
  readonly conflicts?: (active: State, next: State) => boolean;
}) {
  const scope = yield* Effect.scope;
  const lane = yield* Semaphore.make(1);
  const records = yield* Ref.make(
    new Map<string, { key: string; state: State; fiber?: Fiber.Fiber<void> }>(),
  );
  const read = Effect.fn("ManagedOperations.read")(function* (id: string) {
    const record = (yield* Ref.get(records)).get(id);
    if (!record)
      return yield* Effect.fail(
        options.failure("operation_expired", "This operation has expired. Start a new operation."),
      );
    return record.state;
  });
  const change = (
    id: string,
    patch: Partial<Pick<State, "phase" | "result" | "error" | "progress">>,
  ) =>
    Ref.update(records, (all) => {
      const record = all.get(id);
      if (!record || record.state.phase !== "running") return all;
      const phase = patch.phase ?? record.state.phase;
      return new Map(all).set(id, {
        ...record,
        state: {
          ...record.state,
          ...patch,
          revision: record.state.revision + 1,
          cancellable: phase === "running" && record.state.cancellable,
        },
      });
    });
  return {
    read,
    active: Ref.get(records).pipe(
      Effect.map(
        (all) => [...all.values()].filter(({ state }) => state.phase === "running").length,
      ),
    ),
    withInactive: <A, E, R>(predicate: (state: State) => boolean, task: Effect.Effect<A, E, R>) =>
      lane.withPermit(
        Effect.gen(function* () {
          if (
            [...(yield* Ref.get(records)).values()].some(
              ({ state }) => state.phase === "running" && predicate(state),
            )
          ) {
            return yield* Effect.fail(
              options.failure("busy", "Wait for the active installation operation to finish."),
            );
          }
          return yield* task;
        }),
      ),
    progress: (id: string, progress: State["progress"]) =>
      change(id, { progress } as Partial<Pick<State, "progress">>),
    start: <E, R>(state: State, key: string, task: Effect.Effect<State["result"], E, R>) =>
      lane.withPermit(
        Effect.gen(function* () {
          const all = yield* Ref.get(records);
          const previous = all.get(state.operationId);
          if (previous) {
            if (previous.key !== key)
              return yield* Effect.fail(
                options.failure("invalid_request", "This operation ID belongs to another request."),
              );
            return previous.state;
          }
          const running = [...all.values()].filter(({ state }) => state.phase === "running");
          const shared = running.find((record) => record.key === key);
          if (shared) return shared.state;
          if (running.some(({ state: active }) => options.conflicts?.(active, state)))
            return yield* Effect.fail(
              options.failure("busy", "Wait for the active installation operation to finish."),
            );
          if (running.length >= 8)
            return yield* Effect.fail(
              options.failure("busy", "Too many operations are running. Wait or cancel one."),
            );
          const next = new Map(all);
          while (next.size >= 64) {
            const expired = [...next].find(([, record]) => record.state.phase !== "running");
            if (!expired) break;
            next.delete(expired[0]);
          }
          next.set(state.operationId, { key, state });
          yield* Ref.set(records, next);
          const fiber = yield* Effect.interruptible(task).pipe(
            Effect.tap((result) =>
              change(state.operationId, { phase: "succeeded", result } as Partial<
                Pick<State, "phase" | "result">
              >),
            ),
            Effect.catchCause((cause) =>
              change(
                state.operationId,
                Cause.hasInterruptsOnly(cause)
                  ? ({ phase: "cancelled" } as Partial<Pick<State, "phase">>)
                  : ({ phase: "failed", error: options.mapError(Cause.squash(cause)) } as Partial<
                      Pick<State, "phase" | "error">
                    >),
              ),
            ),
            Effect.onInterrupt(() =>
              change(state.operationId, { phase: "cancelled" } as Partial<Pick<State, "phase">>),
            ),
            Effect.asVoid,
            Effect.forkIn(scope),
          );
          yield* Ref.update(records, (current) => {
            const record = current.get(state.operationId)!;
            return new Map(current).set(state.operationId, { ...record, fiber });
          });
          return yield* read(state.operationId);
        }).pipe(Effect.uninterruptible),
      ),
    cancel: Effect.fn("ManagedOperations.cancel")(function* (id: string) {
      const record = yield* lane.withPermit(
        Effect.gen(function* () {
          const record = (yield* Ref.get(records)).get(id);
          if (!record)
            return yield* Effect.fail(
              options.failure("operation_expired", "This operation has expired."),
            );
          return record;
        }),
      );
      if (record.state.phase === "running" && record.state.cancellable && record.fiber)
        yield* Fiber.interrupt(record.fiber);
      return yield* read(id);
    }),
  };
});
