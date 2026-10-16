import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberMap from "effect/FiberMap";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { projectionScopeKey, type ProjectionScope } from "../../shared/projection-stream";
import type {
  CoreEventEnvelope,
  ProjectionLiveBarrier,
  ProjectionLiveRepair,
} from "../core-client/types";

const MAX_SCOPES = 200;
const INGRESS_CAPACITY = 512;

export class ProjectionLiveRuntimeError extends Schema.TaggedError<ProjectionLiveRuntimeError>()(
  "ProjectionLiveRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ProjectionLiveSubscription {
  readonly barrier: ProjectionLiveBarrier;
  readonly done: Effect.Effect<void, ProjectionLiveRuntimeError>;
  readonly close: Effect.Effect<void>;
}

export interface ProjectionLiveRuntimeOptions {
  readonly open: (
    scopes: readonly ProjectionScope[],
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: ProjectionLiveRepair) => void,
  ) => Effect.Effect<ProjectionLiveSubscription, ProjectionLiveRuntimeError>;
  readonly onPacket: (event: CoreEventEnvelope) => Effect.Effect<void, ProjectionLiveRuntimeError>;
  readonly onBarrier: (
    barrier: ProjectionLiveBarrier,
    scopes: readonly ProjectionScope[],
    resetScopes: readonly ProjectionScope[],
    checkpointScopes: readonly ProjectionScope[],
  ) => Effect.Effect<void, ProjectionLiveRuntimeError>;
  readonly onRepair: (
    repair: ProjectionLiveRepair,
  ) => Effect.Effect<void, ProjectionLiveRuntimeError>;
  readonly retryDelay?: Duration.Input;
}

export interface ProjectionLiveDiagnostics {
  readonly activeScopes: number;
  readonly connected: boolean;
  readonly generation: number;
}

export class ProjectionLiveRuntime extends Context.Service<
  ProjectionLiveRuntime,
  {
    readonly setScopes: (
      scopes: readonly ProjectionScope[],
    ) => Effect.Effect<void, ProjectionLiveRuntimeError>;
    readonly diagnostics: Effect.Effect<ProjectionLiveDiagnostics>;
  }
>()("nodex/main/core-runtime/ProjectionLiveRuntime") {}

interface ActiveLease {
  readonly generation: number;
  readonly id: number;
  readonly scope: Scope.Closeable;
  readonly scopes: readonly ProjectionScope[];
}

interface ProjectionLiveState {
  readonly active: ActiveLease | null;
  readonly closed: boolean;
  readonly desiredScopes: readonly ProjectionScope[];
  readonly generation: number;
  readonly nextLeaseId: number;
  readonly recoveryScopes: readonly ProjectionScope[];
}

type Ingress =
  | { readonly kind: "packet"; readonly value: CoreEventEnvelope }
  | { readonly kind: "repair"; readonly value: ProjectionLiveRepair };

const initialState: ProjectionLiveState = {
  active: null,
  closed: false,
  desiredScopes: [],
  generation: 0,
  nextLeaseId: 1,
  recoveryScopes: [],
};

const runtimeError = (operation: string, cause: unknown): ProjectionLiveRuntimeError =>
  new ProjectionLiveRuntimeError({ operation, cause });

const canonicalScopes = (
  scopes: readonly ProjectionScope[],
): Effect.Effect<readonly ProjectionScope[], ProjectionLiveRuntimeError> =>
  Effect.try({
    try: () => {
      const canonical = [
        ...new Map(scopes.map((scope) => [projectionScopeKey(scope), scope])).entries(),
      ]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([, scope]) => scope);
      if (canonical.length > MAX_SCOPES) {
        throw new RangeError(`Projection live supports at most ${MAX_SCOPES} scopes`);
      }
      return canonical;
    },
    catch: (cause) => runtimeError("scopes.canonicalize", cause),
  });

const sameScopes = (left: readonly ProjectionScope[], right: readonly ProjectionScope[]): boolean =>
  left.length === right.length &&
  left.every((scope, index) => projectionScopeKey(scope) === projectionScopeKey(right[index]!));

const isInterruptedOnly = (cause: Cause.Cause<ProjectionLiveRuntimeError>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

export const make = (
  options: ProjectionLiveRuntimeOptions,
): Effect.Effect<ProjectionLiveRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);
    const transitions = yield* Semaphore.make(1);
    const connecting = yield* FiberHandle.make<void, never>();
    const watchers = yield* FiberMap.make<number, void, never>();
    const retryDelay = options.retryDelay ?? "250 millis";
    const retrySchedule = Schedule.spaced(retryDelay);

    const closeLease = Effect.fn("ProjectionLiveRuntime.closeLease")(function* (
      lease: ActiveLease,
      interruptWatcher: boolean,
    ) {
      if (interruptWatcher) yield* FiberMap.remove(watchers, lease.id);
      yield* Scope.close(lease.scope, Exit.void);
    });

    function startConnecting(
      generation: number,
      scopes: readonly ProjectionScope[],
      backoff = false,
    ): Effect.Effect<void> {
      const connect = openAndInstall(generation, scopes).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Scoped Projection live broker interrupted").pipe(
            Effect.annotateLogs({
              operation: error.operation,
              error: error.cause instanceof Error ? error.cause.message : String(error.cause),
            }),
          ),
        ),
        Effect.retry(retrySchedule),
      );
      const program = (
        backoff ? Effect.sleep(retryDelay).pipe(Effect.andThen(connect)) : connect
      ).pipe(
        Effect.catchCause((cause) =>
          isInterruptedOnly(cause) ? Effect.void : Effect.logError(cause),
        ),
      );
      return FiberHandle.run(connecting, program, { startImmediately: true }).pipe(Effect.asVoid);
    }

    function handleLeaseEnded(
      leaseId: number,
      error: ProjectionLiveRuntimeError | null,
    ): Effect.Effect<void> {
      return transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const lease = current.active;
          if (!lease || lease.id !== leaseId) return;
          yield* Ref.set(state, { ...current, active: null, recoveryScopes: lease.scopes });
          yield* closeLease(lease, false);
          if (error) {
            yield* Effect.logWarning("Scoped Projection live lease ended").pipe(
              Effect.annotateLogs({
                operation: error.operation,
                error: error.cause instanceof Error ? error.cause.message : String(error.cause),
              }),
            );
          }
          const latest = yield* Ref.get(state);
          if (
            latest.closed ||
            latest.desiredScopes.length === 0 ||
            lease.generation !== latest.generation
          ) {
            return;
          }
          yield* startConnecting(latest.generation, latest.desiredScopes, true);
        }),
      );
    }

    function openAndInstall(
      generation: number,
      scopes: readonly ProjectionScope[],
    ): Effect.Effect<void, ProjectionLiveRuntimeError> {
      return Effect.acquireUseRelease(
        Scope.make(),
        (childScope) =>
          Effect.gen(function* () {
            const ingress = yield* Queue.dropping<Ingress>(INGRESS_CAPACITY);
            const overflow = yield* Deferred.make<never, ProjectionLiveRuntimeError>();
            const deliveryFailure = yield* Deferred.make<never, ProjectionLiveRuntimeError>();
            yield* Scope.addFinalizer(childScope, Queue.shutdown(ingress).pipe(Effect.asVoid));

            const enqueue = (item: Ingress): void => {
              if (Queue.offerUnsafe(ingress, item)) return;
              Deferred.doneUnsafe(
                overflow,
                Effect.fail(
                  runtimeError(
                    "stream.ingress-overflow",
                    new Error("Projection live ingress exceeded its bound"),
                  ),
                ),
              );
            };

            const subscription = yield* Effect.raceFirst(
              options.open(
                scopes,
                (event) => enqueue({ kind: "packet", value: event }),
                (repair) => enqueue({ kind: "repair", value: repair }),
              ),
              Deferred.await(overflow),
            );
            yield* Scope.addFinalizer(childScope, subscription.close);

            return yield* transitions.withPermits(1)(
              Effect.gen(function* () {
                const current = yield* Ref.get(state);
                if (
                  current.closed ||
                  current.generation !== generation ||
                  !sameScopes(current.desiredScopes, scopes)
                ) {
                  return false;
                }

                const previous = current.active;
                const recovering = new Set(current.recoveryScopes.map(projectionScopeKey));
                const resetScopes = scopes.filter((scope) =>
                  recovering.has(projectionScopeKey(scope)),
                );
                // Closing the old lease can discard queued packets. Every retained
                // scope must cover the new barrier before ordinary delivery resumes.
                const checkpointScopes = scopes.filter(
                  (scope) => !recovering.has(projectionScopeKey(scope)),
                );
                if (previous) {
                  // Await the old consumer before changing epoch/grant authority.
                  // The new stream is already open and buffering behind its barrier.
                  yield* closeLease(previous, true);
                  yield* Ref.set(state, {
                    ...current,
                    active: null,
                    recoveryScopes: previous.scopes,
                  });
                }
                yield* options.onBarrier(
                  subscription.barrier,
                  scopes,
                  resetScopes,
                  checkpointScopes,
                );
                const lease: ActiveLease = {
                  generation,
                  id: current.nextLeaseId,
                  scope: childScope,
                  scopes,
                };
                yield* Ref.set(state, {
                  ...current,
                  active: lease,
                  nextLeaseId: current.nextLeaseId + 1,
                  recoveryScopes: [],
                });

                const consume = Effect.forever(
                  Queue.take(ingress).pipe(
                    Effect.flatMap((item) =>
                      item.kind === "packet"
                        ? options.onPacket(item.value)
                        : options.onRepair(item.value),
                    ),
                  ),
                ).pipe(
                  Effect.catch((error) =>
                    Deferred.fail(deliveryFailure, error).pipe(Effect.asVoid),
                  ),
                );
                yield* Effect.forkIn(childScope, { startImmediately: true })(consume);

                const watch = Effect.raceFirst(
                  subscription.done,
                  Effect.raceFirst(Deferred.await(overflow), Deferred.await(deliveryFailure)),
                ).pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => {
                      if (isInterruptedOnly(cause)) return Effect.void;
                      const error = Cause.squash(cause);
                      return handleLeaseEnded(
                        lease.id,
                        Schema.is(ProjectionLiveRuntimeError)(error)
                          ? error
                          : runtimeError("stream.done", error),
                      );
                    },
                    onSuccess: () => handleLeaseEnded(lease.id, null),
                  }),
                );
                yield* FiberMap.run(watchers, lease.id, watch, { startImmediately: true });
                return true;
              }),
            );
          }),
        (childScope, exit) =>
          Exit.isSuccess(exit) && exit.value
            ? Effect.void
            : Scope.close(childScope, exit).pipe(Effect.asVoid),
      ).pipe(Effect.asVoid);
    }

    const setScopes = Effect.fn("ProjectionLiveRuntime.setScopes")(function* (
      requested: readonly ProjectionScope[],
    ) {
      const scopes = yield* canonicalScopes(requested);
      yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) {
            return yield* runtimeError(
              "scopes.closed",
              new Error("Projection live runtime is closed"),
            );
          }
          if (sameScopes(current.desiredScopes, scopes)) return;

          const generation = current.generation + 1;
          const active = current.active;
          yield* Ref.set(state, { ...current, desiredScopes: scopes, generation });
          yield* FiberHandle.clear(connecting);
          if (scopes.length === 0) {
            yield* Ref.update(state, (latest) => ({ ...latest, recoveryScopes: [] }));
            if (active) {
              yield* Ref.update(state, (latest) => ({ ...latest, active: null }));
              yield* closeLease(active, true);
            }
            return;
          }
          if (active && sameScopes(active.scopes, scopes)) {
            yield* Ref.update(state, (latest) => ({
              ...latest,
              active: { ...active, generation },
            }));
            return;
          }
          yield* startConnecting(generation, scopes);
        }),
      );
    });

    yield* Effect.addFinalizer(() =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* Ref.set(state, {
            ...current,
            active: null,
            closed: true,
            desiredScopes: [],
            generation: current.generation + 1,
          });
          yield* FiberHandle.clear(connecting);
          if (current.active) yield* closeLease(current.active, true);
        }),
      ),
    );

    return ProjectionLiveRuntime.of({
      setScopes,
      diagnostics: Ref.get(state).pipe(
        Effect.map((current) => ({
          activeScopes: current.desiredScopes.length,
          connected: current.active !== null,
          generation: current.generation,
        })),
      ),
    });
  });
