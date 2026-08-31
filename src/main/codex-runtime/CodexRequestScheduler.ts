import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  admitCodexCoalescedWaiter,
  admitCodexScheduledRequest,
  codexRequestBackgroundLane,
  codexRequestCoalescingKey,
  codexRequestQueueExpiryMs,
  codexScheduledRequestBytes,
  defaultCodexRequestPriority,
  emptyCodexRequestSelectionState,
  selectNextCodexScheduledRequest,
  type CodexRequestSchedulingOptions,
  type CodexRequestSchedulingSource,
  type CodexRequestSelectionState,
  type CodexScheduledRequestDescriptor,
} from "./CodexRequestSchedulerPolicy";
import { codexRuntimeError, type CodexRuntimeError } from "./CodexRuntimeError";

export interface CodexRequestScheduleOptions extends CodexRequestSchedulingOptions {
  readonly conversationId?: string | null;
  readonly widgetId?: string | null;
  readonly coalesce?: boolean;
  readonly queuedBytes?: number;
  /** Mutations can time out after the server accepted them, so retry is not automatically safe. */
  readonly outcomeOnTimeout?: "not-applied" | "unknown";
}

export interface CodexRequestScheduleInput<A> {
  readonly hostId: string;
  readonly generation: number;
  readonly method: string;
  readonly params: unknown;
  readonly dispatch: Effect.Effect<A, CodexRuntimeError>;
  readonly options?: CodexRequestScheduleOptions;
}

interface PriorityCounts {
  readonly background: number;
  readonly critical: number;
  readonly interactive: number;
}

export interface CodexRequestSchedulerSnapshot {
  readonly current: {
    readonly generations: number;
    readonly queued: number;
    readonly queuedBytes: number;
    readonly inFlight: number;
    readonly queuedByPriority: PriorityCounts;
    readonly inFlightByPriority: PriorityCounts;
  };
  readonly highWater: {
    readonly queued: number;
    readonly queuedBytes: number;
    readonly inFlight: number;
  };
  readonly totals: {
    readonly logicalScheduled: number;
    readonly physicalQueued: number;
    readonly physicalDispatched: number;
    readonly coalesced: number;
    readonly rejected: number;
    readonly queueExpired: number;
    readonly executionTimedOut: number;
    readonly outcomeUnknown: number;
    readonly callerDetached: number;
    readonly cancelledBeforeDispatch: number;
    readonly completed: number;
    readonly failed: number;
    readonly generationsRetired: number;
    readonly lateCompletions: number;
  };
}

interface MutablePriorityCounts {
  background: number;
  critical: number;
  interactive: number;
}

interface MutableMetrics {
  generations: number;
  queued: number;
  queuedBytes: number;
  inFlight: number;
  queuedByPriority: MutablePriorityCounts;
  inFlightByPriority: MutablePriorityCounts;
  highQueued: number;
  highQueuedBytes: number;
  highInFlight: number;
  logicalScheduled: number;
  physicalQueued: number;
  physicalDispatched: number;
  coalesced: number;
  rejected: number;
  queueExpired: number;
  executionTimedOut: number;
  outcomeUnknown: number;
  callerDetached: number;
  cancelledBeforeDispatch: number;
  completed: number;
  failed: number;
  generationsRetired: number;
  lateCompletions: number;
}

interface LogicalWaiter {
  readonly id: number;
  readonly deferred: Deferred.Deferred<unknown, CodexRuntimeError>;
  active: boolean;
}

interface PhysicalRequest {
  readonly descriptor: CodexScheduledRequestDescriptor;
  readonly dispatch: Effect.Effect<unknown, CodexRuntimeError>;
  readonly coalescingKey: string | null;
  readonly expiresAfterMs: number | null;
  readonly outcomeOnTimeout: "not-applied" | "unknown";
  readonly waiters: LogicalWaiter[];
  phase: "queued" | "in-flight";
}

interface GenerationState {
  readonly key: string;
  readonly hostId: string;
  readonly generation: number;
  readonly fibers: FiberMap.FiberMap<string, void, never>;
  readonly queued: PhysicalRequest[];
  readonly inFlight: Map<string, PhysicalRequest>;
  readonly coalesced: Map<string, PhysicalRequest>;
  selection: CodexRequestSelectionState;
  retired: boolean;
}

export class CodexRequestScheduler extends Context.Service<
  CodexRequestScheduler,
  {
    readonly openGeneration: (
      hostId: string,
      generation: number,
    ) => Effect.Effect<void, CodexRuntimeError, Scope.Scope>;
    readonly schedule: <A>(
      input: CodexRequestScheduleInput<A>,
    ) => Effect.Effect<A, CodexRuntimeError>;
    readonly retireGeneration: (hostId: string, generation: number) => Effect.Effect<void>;
    readonly snapshot: Effect.Effect<CodexRequestSchedulerSnapshot>;
  }
>()("nodex/main/codex-runtime/CodexRequestScheduler") {}

const emptyPriorityCounts = (): MutablePriorityCounts => ({
  background: 0,
  critical: 0,
  interactive: 0,
});

const generationKey = (hostId: string, generation: number): string => `${hostId}\0${generation}`;

const timerKey = (requestId: string): string => `expiry:${requestId}`;

const dispatchKey = (requestId: string): string => `dispatch:${requestId}`;

const unavailableGeneration = (hostId: string, generation: number, method?: string) =>
  codexRuntimeError({
    operation: "scheduler.generation",
    reason: "session-lost",
    retryable: true,
    hostId,
    generation,
    ...(method === undefined ? {} : { method }),
  });

const pressureError = (
  request: Pick<CodexScheduledRequestDescriptor, "hostId" | "generation" | "method">,
  cause: unknown,
) =>
  codexRuntimeError({
    operation: "scheduler.admission",
    reason: "pressure",
    retryable: true,
    hostId: request.hostId,
    generation: request.generation,
    method: request.method,
    cause,
  });

const timeoutError = (
  request: PhysicalRequest,
  operation: "scheduler.execution" | "scheduler.queue",
) => {
  const outcomeUnknown =
    operation === "scheduler.execution" && request.outcomeOnTimeout === "unknown";
  return codexRuntimeError({
    operation,
    reason: outcomeUnknown ? "outcome-unknown" : "timeout",
    retryable: !outcomeUnknown,
    hostId: request.descriptor.hostId,
    generation: request.descriptor.generation,
    method: request.descriptor.method,
  });
};

const asDescriptors = (requests: Iterable<PhysicalRequest>) =>
  Array.from(requests, (request) => request.descriptor);

export const live: Layer.Layer<CodexRequestScheduler> = Layer.effect(
  CodexRequestScheduler,
  Effect.gen(function* () {
    const mutationLock = yield* Semaphore.make(1);
    const generations = new Map<string, GenerationState>();
    const metrics: MutableMetrics = {
      generations: 0,
      queued: 0,
      queuedBytes: 0,
      inFlight: 0,
      queuedByPriority: emptyPriorityCounts(),
      inFlightByPriority: emptyPriorityCounts(),
      highQueued: 0,
      highQueuedBytes: 0,
      highInFlight: 0,
      logicalScheduled: 0,
      physicalQueued: 0,
      physicalDispatched: 0,
      coalesced: 0,
      rejected: 0,
      queueExpired: 0,
      executionTimedOut: 0,
      outcomeUnknown: 0,
      callerDetached: 0,
      cancelledBeforeDispatch: 0,
      completed: 0,
      failed: 0,
      generationsRetired: 0,
      lateCompletions: 0,
    };
    let nextRequestId = 1;
    let nextWaiterId = 1;

    const updateHighWater = () => {
      metrics.highQueued = Math.max(metrics.highQueued, metrics.queued);
      metrics.highQueuedBytes = Math.max(metrics.highQueuedBytes, metrics.queuedBytes);
      metrics.highInFlight = Math.max(metrics.highInFlight, metrics.inFlight);
    };

    const removeQueuedMetrics = (request: PhysicalRequest) => {
      metrics.queued -= 1;
      metrics.queuedBytes -= request.descriptor.queuedBytes;
      metrics.queuedByPriority[request.descriptor.priority] -= 1;
    };

    const removeInFlightMetrics = (request: PhysicalRequest) => {
      metrics.inFlight -= 1;
      metrics.inFlightByPriority[request.descriptor.priority] -= 1;
    };

    const settleWaiters = (
      request: PhysicalRequest,
      result: Effect.Effect<unknown, CodexRuntimeError>,
    ) => {
      const waiters = request.waiters.splice(0);
      return Effect.forEach(
        waiters,
        (waiter) => {
          if (!waiter.active) return Effect.void;
          waiter.active = false;
          return Deferred.complete(waiter.deferred, result).pipe(Effect.asVoid);
        },
        { discard: true },
      );
    };

    let pumpLocked: (state: GenerationState) => Effect.Effect<void>;

    const completePhysical = (
      state: GenerationState,
      request: PhysicalRequest,
      exit: Exit.Exit<unknown, CodexRuntimeError>,
    ) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = generations.get(state.key);
          if (
            current !== state ||
            state.retired ||
            state.inFlight.get(request.descriptor.requestId) !== request
          ) {
            metrics.lateCompletions += 1;
            return;
          }
          state.inFlight.delete(request.descriptor.requestId);
          if (
            request.coalescingKey !== null &&
            state.coalesced.get(request.coalescingKey) === request
          ) {
            state.coalesced.delete(request.coalescingKey);
          }
          removeInFlightMetrics(request);
          if (Exit.isSuccess(exit)) metrics.completed += 1;
          else metrics.failed += 1;
          yield* settleWaiters(
            request,
            Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause),
          );
          yield* pumpLocked(state);
        }),
      );

    const runPhysical = (state: GenerationState, request: PhysicalRequest) => {
      const timed =
        request.descriptor.timeoutMs === null
          ? request.dispatch
          : request.dispatch.pipe(
              Effect.timeoutOption(request.descriptor.timeoutMs),
              Effect.flatMap(
                Option.match({
                  onNone: () => {
                    metrics.executionTimedOut += 1;
                    if (request.outcomeOnTimeout === "unknown") metrics.outcomeUnknown += 1;
                    return Effect.fail(timeoutError(request, "scheduler.execution"));
                  },
                  onSome: Effect.succeed,
                }),
              ),
            );
      return Effect.exit(timed).pipe(
        Effect.flatMap((exit) => completePhysical(state, request, exit)),
        Effect.asVoid,
        Effect.ignoreCause,
      );
    };

    pumpLocked = (state) =>
      Effect.gen(function* () {
        while (!state.retired) {
          const selection = selectNextCodexScheduledRequest({
            queued: state.queued.map((request) => request.descriptor),
            inFlight: asDescriptors(state.inFlight.values()),
            state: state.selection,
          });
          if (selection === null) return;
          const request = state.queued.splice(selection.index, 1)[0];
          if (request === undefined) return;
          state.selection = selection.nextState;
          request.phase = "in-flight";
          state.inFlight.set(request.descriptor.requestId, request);
          removeQueuedMetrics(request);
          metrics.inFlight += 1;
          metrics.inFlightByPriority[request.descriptor.priority] += 1;
          metrics.physicalDispatched += 1;
          updateHighWater();
          yield* FiberMap.remove(state.fibers, timerKey(request.descriptor.requestId));
          yield* FiberMap.run(
            state.fibers,
            dispatchKey(request.descriptor.requestId),
            runPhysical(state, request),
            { startImmediately: true },
          );
        }
      });

    const expireQueued = (state: GenerationState, request: PhysicalRequest) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (generations.get(state.key) !== state || state.retired || request.phase !== "queued")
            return;
          const index = state.queued.indexOf(request);
          if (index === -1) return;
          state.queued.splice(index, 1);
          if (
            request.coalescingKey !== null &&
            state.coalesced.get(request.coalescingKey) === request
          ) {
            state.coalesced.delete(request.coalescingKey);
          }
          removeQueuedMetrics(request);
          metrics.queueExpired += 1;
          metrics.failed += 1;
          yield* settleWaiters(request, Effect.fail(timeoutError(request, "scheduler.queue")));
          yield* pumpLocked(state);
        }),
      );

    const retireGeneration = (hostId: string, generation: number) => {
      const key = generationKey(hostId, generation);
      return Effect.gen(function* () {
        const state = yield* mutationLock.withPermits(1)(
          Effect.gen(function* () {
            const current = generations.get(key);
            if (current === undefined) return null;
            generations.delete(key);
            current.retired = true;
            metrics.generations -= 1;
            metrics.generationsRetired += 1;
            for (const request of current.queued) {
              removeQueuedMetrics(request);
              yield* settleWaiters(
                request,
                Effect.fail(unavailableGeneration(hostId, generation, request.descriptor.method)),
              );
            }
            for (const request of current.inFlight.values()) {
              removeInFlightMetrics(request);
              yield* settleWaiters(
                request,
                Effect.fail(unavailableGeneration(hostId, generation, request.descriptor.method)),
              );
            }
            current.queued.length = 0;
            current.inFlight.clear();
            current.coalesced.clear();
            return current;
          }),
        );
        if (state === null) return;
        yield* FiberMap.clear(state.fibers);
      });
    };

    const openGeneration = (hostId: string, generation: number) =>
      Effect.gen(function* () {
        const normalizedHostId = hostId.trim();
        if (normalizedHostId.length === 0 || !Number.isSafeInteger(generation) || generation < 1) {
          return yield* codexRuntimeError({
            operation: "scheduler.open-generation",
            reason: "host-unavailable",
            retryable: false,
            hostId: normalizedHostId,
            generation,
          });
        }
        const fibers = yield* FiberMap.make<string, void, never>();
        const key = generationKey(normalizedHostId, generation);
        const state: GenerationState = {
          key,
          hostId: normalizedHostId,
          generation,
          fibers,
          queued: [],
          inFlight: new Map(),
          coalesced: new Map(),
          selection: emptyCodexRequestSelectionState(),
          retired: false,
        };
        yield* mutationLock.withPermits(1)(
          Effect.gen(function* () {
            if (generations.has(key)) {
              return yield* codexRuntimeError({
                operation: "scheduler.open-generation",
                reason: "host-unavailable",
                retryable: false,
                hostId: normalizedHostId,
                generation,
                cause: new Error(`Codex scheduler generation '${key}' is already open`),
              });
            }
            generations.set(key, state);
            metrics.generations += 1;
          }),
        );
        yield* Effect.addFinalizer(() => retireGeneration(normalizedHostId, generation));
      });

    const detachWaiter = (
      state: GenerationState,
      request: PhysicalRequest,
      waiter: LogicalWaiter,
    ) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (!waiter.active) return;
          waiter.active = false;
          const waiterIndex = request.waiters.indexOf(waiter);
          if (waiterIndex !== -1) request.waiters.splice(waiterIndex, 1);
          metrics.callerDetached += 1;
          if (request.phase !== "queued" || request.waiters.length > 0) return;
          const index = state.queued.indexOf(request);
          if (index === -1) return;
          state.queued.splice(index, 1);
          if (
            request.coalescingKey !== null &&
            state.coalesced.get(request.coalescingKey) === request
          ) {
            state.coalesced.delete(request.coalescingKey);
          }
          removeQueuedMetrics(request);
          metrics.cancelledBeforeDispatch += 1;
          yield* FiberMap.remove(state.fibers, timerKey(request.descriptor.requestId));
          yield* pumpLocked(state);
        }),
      );

    const schedule = <A>(
      input: CodexRequestScheduleInput<A>,
    ): Effect.Effect<A, CodexRuntimeError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const waiter: LogicalWaiter = {
            id: nextWaiterId++,
            deferred: yield* Deferred.make<unknown, CodexRuntimeError>(),
            active: true,
          };
          const acquired = yield* mutationLock.withPermits(1)(
            Effect.gen(function* () {
              const hostId = input.hostId.trim();
              const state = generations.get(generationKey(hostId, input.generation));
              if (state === undefined || state.retired) {
                return yield* unavailableGeneration(hostId, input.generation, input.method);
              }
              metrics.logicalScheduled += 1;
              const priority = defaultCodexRequestPriority(input.method, input.options?.priority);
              const source: CodexRequestSchedulingSource | null = input.options?.source ?? null;
              const queuedBytes =
                input.options?.queuedBytes ??
                codexScheduledRequestBytes(input.method, input.params) ??
                -1;
              const timeoutMs =
                input.options?.timeoutMs !== undefined &&
                input.options.timeoutMs !== null &&
                Number.isFinite(input.options.timeoutMs) &&
                input.options.timeoutMs >= 0
                  ? input.options.timeoutMs
                  : null;
              const descriptor: CodexScheduledRequestDescriptor = {
                requestId: String(nextRequestId++),
                hostId,
                generation: input.generation,
                method: input.method,
                params: input.params,
                priority,
                source,
                backgroundLane: codexRequestBackgroundLane(priority, source),
                conversationId: input.options?.conversationId ?? null,
                widgetId: input.options?.widgetId ?? null,
                timeoutMs,
                queuedBytes,
              };
              const coalescingKey = codexRequestCoalescingKey(descriptor, {
                coalesce: input.options?.coalesce,
              });
              const shared =
                coalescingKey === null ? undefined : state.coalesced.get(coalescingKey);
              if (shared !== undefined) {
                const admission = admitCodexCoalescedWaiter(shared.waiters.length);
                if (!admission.accepted) {
                  metrics.rejected += 1;
                  return yield* pressureError(descriptor, admission.rejection);
                }
                shared.waiters.push(waiter);
                metrics.coalesced += 1;
                return { state, request: shared };
              }
              const admission = admitCodexScheduledRequest({
                request: descriptor,
                queued: state.queued.map((request) => request.descriptor),
              });
              if (!admission.accepted) {
                metrics.rejected += 1;
                return yield* pressureError(descriptor, admission.rejection);
              }
              const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
              const request: PhysicalRequest = {
                descriptor,
                dispatch: input.dispatch,
                coalescingKey,
                expiresAfterMs: codexRequestQueueExpiryMs({
                  priority,
                  source,
                  timeoutMs,
                  expiresAtMs: input.options?.expiresAtMs,
                  nowMs,
                }),
                outcomeOnTimeout: input.options?.outcomeOnTimeout ?? "not-applied",
                waiters: [waiter],
                phase: "queued",
              };
              state.queued.push(request);
              if (coalescingKey !== null) state.coalesced.set(coalescingKey, request);
              metrics.queued += 1;
              metrics.queuedBytes += descriptor.queuedBytes;
              metrics.queuedByPriority[priority] += 1;
              metrics.physicalQueued += 1;
              updateHighWater();
              if (request.expiresAfterMs === 0) {
                state.queued.pop();
                if (coalescingKey !== null) state.coalesced.delete(coalescingKey);
                removeQueuedMetrics(request);
                metrics.queueExpired += 1;
                metrics.failed += 1;
                yield* settleWaiters(
                  request,
                  Effect.fail(timeoutError(request, "scheduler.queue")),
                );
                return { state, request };
              }
              if (request.expiresAfterMs !== null) {
                yield* FiberMap.run(
                  state.fibers,
                  timerKey(descriptor.requestId),
                  Effect.sleep(request.expiresAfterMs).pipe(
                    Effect.andThen(expireQueued(state, request)),
                    Effect.ignoreCause,
                  ),
                  { startImmediately: true },
                );
              }
              yield* pumpLocked(state);
              return { state, request };
            }),
          );
          return (yield* restore(Deferred.await(waiter.deferred)).pipe(
            Effect.onInterrupt(() => detachWaiter(acquired.state, acquired.request, waiter)),
          )) as A;
        }),
      );

    const snapshot = mutationLock.withPermits(1)(
      Effect.sync((): CodexRequestSchedulerSnapshot => ({
        current: {
          generations: metrics.generations,
          queued: metrics.queued,
          queuedBytes: metrics.queuedBytes,
          inFlight: metrics.inFlight,
          queuedByPriority: { ...metrics.queuedByPriority },
          inFlightByPriority: { ...metrics.inFlightByPriority },
        },
        highWater: {
          queued: metrics.highQueued,
          queuedBytes: metrics.highQueuedBytes,
          inFlight: metrics.highInFlight,
        },
        totals: {
          logicalScheduled: metrics.logicalScheduled,
          physicalQueued: metrics.physicalQueued,
          physicalDispatched: metrics.physicalDispatched,
          coalesced: metrics.coalesced,
          rejected: metrics.rejected,
          queueExpired: metrics.queueExpired,
          executionTimedOut: metrics.executionTimedOut,
          outcomeUnknown: metrics.outcomeUnknown,
          callerDetached: metrics.callerDetached,
          cancelledBeforeDispatch: metrics.cancelledBeforeDispatch,
          completed: metrics.completed,
          failed: metrics.failed,
          generationsRetired: metrics.generationsRetired,
          lateCompletions: metrics.lateCompletions,
        },
      })),
    );

    return CodexRequestScheduler.of({ openGeneration, schedule, retireGeneration, snapshot });
  }),
);
