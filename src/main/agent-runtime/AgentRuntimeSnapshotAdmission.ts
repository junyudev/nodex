import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export class AgentRuntimeSnapshotAdmissionError extends Schema.TaggedError<AgentRuntimeSnapshotAdmissionError>()(
  "AgentRuntimeSnapshotAdmissionError",
  { message: Schema.String },
) {}

/** Covers product mutations from Core admission through execution acknowledgement. */
export const make = Effect.fn("AgentRuntimeSnapshotAdmission.make")(function* () {
  const state = yield* Ref.make<{
    readonly frozen: boolean;
    readonly writers: number;
    readonly drained: Deferred.Deferred<void> | null;
  }>({ frozen: false, writers: 0, drained: null });
  const leave = Ref.modify(state, (current) => {
    const next = { ...current, writers: current.writers - 1 };
    return [next.writers === 0 ? next.drained : null, next] as const;
  }).pipe(
    Effect.flatMap((drained) => (drained ? Deferred.succeed(drained, undefined) : Effect.void)),
  );
  return {
    withWriter: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const accepted = yield* Ref.modify(state, (current) =>
            current.frozen
              ? ([false, current] as const)
              : ([true, { ...current, writers: current.writers + 1 }] as const),
          );
          if (!accepted)
            return yield* new AgentRuntimeSnapshotAdmissionError({
              message: "A Profile snapshot is holding Session changes",
            });
          return yield* restore(operation).pipe(Effect.ensuring(leave));
        }),
      ),
    withSnapshot: <A, E, R>(operation: Effect.Effect<A, E, R>) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const drained = yield* Deferred.make<void>();
          const accepted = yield* Ref.modify(state, (current) =>
            current.frozen
              ? ([false, current] as const)
              : ([true, { ...current, frozen: true, drained }] as const),
          );
          if (!accepted)
            return yield* new AgentRuntimeSnapshotAdmissionError({
              message: "A Profile snapshot is already in progress",
            });
          return yield* restore(
            Effect.gen(function* () {
              if ((yield* Ref.get(state)).writers === 0)
                yield* Deferred.succeed(drained, undefined);
              yield* Deferred.await(drained);
              return yield* operation;
            }),
          ).pipe(
            Effect.ensuring(
              Ref.update(state, (current) => ({ ...current, frozen: false, drained: null })),
            ),
          );
        }),
      ),
  };
});
