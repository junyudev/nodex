import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
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
import {
  CodexTurnDeliveryError,
  type CodexTurnDelivery,
} from "../../shared/codex-conversation-state/codex-turn-delivery";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";
import { CodexRetainedRequestTimeout } from "./CodexRendererRequestLifetimes";
import { codexRequestCanRetainOutcome } from "../../shared/codex-renderer-request";
import {
  beginCodexClientRequest,
  type CodexAppServerHostConcurrency,
  type CodexAppServerRequestTrace,
  type CodexAppServerRequestMetrics,
} from "@nodex/effect-codex-app-server/protocol";
import {
  CodexScheduledRequestTrace,
  type CodexHostRequestMetricsState,
} from "./CodexHostRequestMetrics";
import type { CodexDetachedPhysicalResponse } from "./CodexRendererRequestOrigin";

export interface CodexRequestScheduleOptions extends CodexRequestSchedulingOptions {
  /** The same identity is passed to the native transport and reported in delivery failures. */
  readonly requestId?: string;
  readonly retainResponse?: boolean;
  readonly onOutcomeUnknown?: (delivery: CodexTurnDelivery) => Effect.Effect<void>;
  /** Observes the transport write boundary, including a caller joining an already sent request. */
  readonly onNativeDispatch?: () => void;
  readonly onRendererCoalescedRoleBound?: (isFollower: boolean) => void;
  readonly onDetachedPhysicalResponse?: (
    response: CodexDetachedPhysicalResponse,
  ) => Effect.Effect<void>;
  readonly hostMetrics?: CodexHostRequestMetricsState;
  readonly onResponseMetrics?: (metrics: CodexAppServerRequestMetrics) => Effect.Effect<void>;
  readonly onPhysicalResponse?: (receivedAtMs: number) => void;
  readonly onWireTrace?: (
    trace: import("../../shared/codex-request-lifecycle").CodexRequestTraceContext,
  ) => void;
  readonly responseTimeoutOwner?: "main" | "caller";
  readonly rendererCaller?: {
    readonly destinationId: string;
    readonly abandonment?: () => "timeout" | "disposed" | undefined;
  };
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
  readonly input: CodexRequestScheduleInput<unknown>;
  readonly queuedAtMs: number;
  descriptor?: CodexScheduledRequestDescriptor;
  request?: PhysicalRequest;
  active: boolean;
  readonly trace: CodexAppServerRequestTrace;
  concurrency?: CodexAppServerHostConcurrency;
  reconnectAttemptAtEnqueue?: number;
  responseMetrics?: CodexAppServerRequestMetrics;
  metricsReleased?: boolean;
  metricsReported?: boolean;
}

interface PhysicalRequest {
  readonly trace: CodexAppServerRequestTrace;
  metricsOwnerId?: number;
  readonly responseTimeoutOwner: "main" | "caller";
  readonly retainResponse: boolean;
  readonly responseDeadlineAtMs: number | null;
  readonly descriptor: CodexScheduledRequestDescriptor;
  readonly dispatch: Effect.Effect<unknown, CodexRuntimeError>;
  readonly coalescingKey: string | null;
  readonly expiresAfterMs: number | null;
  readonly outcomeOnTimeout: "not-applied" | "unknown";
  readonly onDetachedPhysicalResponse?: (
    response: CodexDetachedPhysicalResponse,
  ) => Effect.Effect<void>;
  readonly waiters: LogicalWaiter[];
  readonly leaderWaiterId: number;
  phase: "queued" | "in-flight";
}

interface GenerationState {
  readonly key: string;
  readonly hostId: string;
  readonly generation: number;
  readonly fibers: FiberMap.FiberMap<string, void, never>;
  readonly queued: PhysicalRequest[];
  readonly inFlight: Map<string, PhysicalRequest>;
  /** Responses still owned by this generation after their dispatch admission has been released. */
  readonly retained: Map<string, PhysicalRequest>;
  readonly coalesced: Map<string, PhysicalRequest>;
  readonly detachedPluginRequestIds: Set<string>;
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
  request: Pick<PhysicalRequest, "descriptor" | "outcomeOnTimeout"> &
    Partial<Pick<PhysicalRequest, "trace">>,
  operation: "scheduler.execution" | "scheduler.queue",
) => {
  const dispatched = request.trace?.startedAtMs !== undefined;
  const outcomeUnknown =
    operation === "scheduler.execution" && dispatched && request.outcomeOnTimeout === "unknown";
  return codexRuntimeError({
    operation,
    reason: outcomeUnknown ? "outcome-unknown" : "timeout",
    retryable: !outcomeUnknown,
    hostId: request.descriptor.hostId,
    generation: request.descriptor.generation,
    method: request.descriptor.method,
    cause: new CodexTurnDeliveryError(
      dispatched
        ? "App server request timed out after dispatch"
        : "App server request timed out while queued",
      {
        requestId: request.descriptor.requestId,
        method: request.descriptor.method,
        stage: dispatched ? "outcome-unknown" : "not-sent",
      },
    ),
  });
};

const physicalRequestFailure = (
  request: PhysicalRequest,
  error: CodexRuntimeError,
): CodexRuntimeError => {
  if (error.reason === "request" || encodeCodexNativeRequestFailure(error).delivery) return error;
  return codexRuntimeError({
    operation: error.operation,
    reason: error.reason,
    retryable: error.retryable,
    hostId: error.hostId,
    generation: error.generation,
    pid: error.pid,
    method: error.method,
    cause: new CodexTurnDeliveryError(
      encodeCodexNativeRequestFailure(error).message,
      {
        requestId: request.descriptor.requestId,
        method: request.descriptor.method,
        stage: request.trace.startedAtMs === undefined ? "not-sent" : "outcome-unknown",
      },
      { cause: error },
    ),
  });
};

const asDescriptors = (requests: Iterable<PhysicalRequest>) =>
  Array.from(requests, (request) => request.descriptor);

export const live: Layer.Layer<CodexRequestScheduler> = Layer.effect(
  CodexRequestScheduler,
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
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

    const releaseWaiterMetrics = (waiter: LogicalWaiter) => {
      if (waiter.metricsReleased || !waiter.concurrency) return;
      waiter.metricsReleased = true;
      const state = waiter.input.options?.hostMetrics?.receiveState;
      if (state) state.pendingClientRequests = Math.max(0, state.pendingClientRequests - 1);
    };

    const collectWaiterMetrics = (waiter: LogicalWaiter, request?: PhysicalRequest) => {
      const host = waiter.input.options?.hostMetrics;
      if (!host || waiter.responseMetrics) return;
      const physical = request?.trace;
      const trace = request?.metricsOwnerId === waiter.id ? physical! : waiter.trace;
      waiter.responseMetrics = (physical?.receiver ?? host.receiver).finishRequest({
        ...trace,
        completedAtMs: physical?.completedAtMs ?? clock.currentTimeMillisUnsafe(),
        responseBytes: physical?.responseBytes,
        queuedAtMs: waiter.queuedAtMs,
        hostRequestConcurrency: waiter.concurrency,
        reconnectAttemptAtEnqueue: waiter.reconnectAttemptAtEnqueue,
      });
    };

    const reportWaiterMetrics = (waiter: LogicalWaiter, request?: PhysicalRequest) =>
      Effect.suspend(() => {
        if (waiter.metricsReported) return Effect.void;
        waiter.metricsReported = true;
        collectWaiterMetrics(waiter, request);
        releaseWaiterMetrics(waiter);
        return waiter.responseMetrics && waiter.input.options?.onResponseMetrics
          ? waiter.input.options.onResponseMetrics(waiter.responseMetrics)
          : Effect.void;
      });

    const markCoalescedDispatch = (waiter: LogicalWaiter, trace: CodexAppServerRequestTrace) => {
      if (trace.startedAtMs === undefined) return;
      waiter.trace.startedAtMs = clock.currentTimeMillisUnsafe();
      waiter.trace.requestBytes = trace.requestBytes;
      waiter.input.options?.onNativeDispatch?.();
    };

    const bindRendererCoalescing = (request: PhysicalRequest, waiter: LogicalWaiter) => {
      waiter.input.options?.onRendererCoalescedRoleBound?.(waiter.id !== request.leaderWaiterId);
    };

    const bindRequestMetrics = (request: PhysicalRequest) => {
      request.trace.onWireTrace = (wireTrace) => {
        for (const waiter of request.waiters)
          if (waiter.active) waiter.input.options?.onWireTrace?.(wireTrace);
      };
      request.trace.onDispatched = () => {
        request.metricsOwnerId = request.waiters.find((waiter) => waiter.active)?.id;
        for (const waiter of request.waiters)
          if (waiter.active) markCoalescedDispatch(waiter, request.trace);
      };
      request.trace.onResponse = (receipt) => {
        for (const waiter of request.waiters)
          if (waiter.active)
            waiter.input.options?.onPhysicalResponse?.(receipt.timing.receivedAtMs);
        for (const waiter of request.waiters)
          if (waiter.active) collectWaiterMetrics(waiter, request);
        for (const waiter of request.waiters) releaseWaiterMetrics(waiter);
      };
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
          return reportWaiterMetrics(waiter, request).pipe(
            Effect.andThen(Deferred.complete(waiter.deferred, result)),
            Effect.asVoid,
          );
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
          state.detachedPluginRequestIds.delete(request.descriptor.requestId);
          const current = generations.get(state.key);
          const retained = state.retained.get(request.descriptor.requestId) === request;
          const completion: Effect.Effect<unknown, CodexRuntimeError> = Exit.isSuccess(exit)
            ? Effect.succeed(exit.value)
            : Effect.failCause(exit.cause).pipe(
                Effect.mapError((error) => physicalRequestFailure(request, error)),
              );
          const deliverDetachedResponse =
            request.waiters.length === 0 && request.onDetachedPhysicalResponse
              ? completion.pipe(
                  Effect.matchEffect({
                    onSuccess: (result) =>
                      request.onDetachedPhysicalResponse!({ type: "result", result }),
                    onFailure: (error) =>
                      request.onDetachedPhysicalResponse!({ type: "error", error }),
                  }),
                )
              : Effect.void;
          if (current !== state || state.retired) {
            metrics.lateCompletions += 1;
            return;
          }
          if (!retained && state.inFlight.get(request.descriptor.requestId) !== request) {
            metrics.lateCompletions += 1;
            yield* deliverDetachedResponse;
            return;
          }
          state.retained.delete(request.descriptor.requestId);
          state.inFlight.delete(request.descriptor.requestId);
          if (
            request.coalescingKey !== null &&
            state.coalesced.get(request.coalescingKey) === request
          ) {
            state.coalesced.delete(request.coalescingKey);
          }
          if (!retained) removeInFlightMetrics(request);
          if (Exit.isSuccess(exit)) metrics.completed += 1;
          else metrics.failed += 1;
          yield* deliverDetachedResponse;
          yield* settleWaiters(request, completion);
          yield* pumpLocked(state);
        }),
      );

    const runPhysical = (state: GenerationState, request: PhysicalRequest) =>
      Effect.exit(
        request.dispatch.pipe(Effect.provideService(CodexScheduledRequestTrace, request.trace)),
      ).pipe(
        Effect.flatMap((exit) => completePhysical(state, request, exit)),
        Effect.asVoid,
        Effect.ignoreCause,
      );

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
                Effect.fail(
                  physicalRequestFailure(
                    request,
                    unavailableGeneration(hostId, generation, request.descriptor.method),
                  ),
                ),
              );
            }
            for (const request of current.inFlight.values()) {
              removeInFlightMetrics(request);
              yield* settleWaiters(
                request,
                Effect.fail(
                  physicalRequestFailure(
                    request,
                    unavailableGeneration(hostId, generation, request.descriptor.method),
                  ),
                ),
              );
            }
            for (const request of current.retained.values()) {
              yield* settleWaiters(
                request,
                Effect.fail(
                  physicalRequestFailure(
                    request,
                    unavailableGeneration(hostId, generation, request.descriptor.method),
                  ),
                ),
              );
            }
            current.queued.length = 0;
            current.inFlight.clear();
            current.retained.clear();
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
          retained: new Map(),
          coalesced: new Map(),
          detachedPluginRequestIds: new Set(),
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

    const requeuePluginWaiter = (state: GenerationState, waiter: LogicalWaiter) =>
      Effect.gen(function* () {
        const descriptor = waiter.descriptor;
        if (!descriptor) return;
        const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
        const options = waiter.input.options;
        const absoluteDeadline =
          options?.expiresAtMs ??
          (descriptor.timeoutMs !== null && descriptor.timeoutMs > 0
            ? waiter.queuedAtMs + descriptor.timeoutMs
            : null);
        const reject = (error: CodexRuntimeError) => {
          waiter.active = false;
          return reportWaiterMetrics(waiter).pipe(
            Effect.andThen(Deferred.fail(waiter.deferred, error)),
            Effect.asVoid,
          );
        };
        if (absoluteDeadline !== null && absoluteDeadline <= now)
          return yield* reject(
            timeoutError({ descriptor, outcomeOnTimeout: "not-applied" }, "scheduler.queue"),
          );
        if (state.detachedPluginRequestIds.size >= 2)
          return yield* reject(
            codexRuntimeError({
              operation: "scheduler.plugin-detached",
              reason: "host-unavailable",
              retryable: true,
              hostId: state.hostId,
              method: descriptor.method,
            }),
          );
        const coalescingKey = codexRequestCoalescingKey(descriptor, {
          coalesce: options?.coalesce,
        });
        const shared = coalescingKey === null ? undefined : state.coalesced.get(coalescingKey);
        if (shared) {
          const admission = admitCodexCoalescedWaiter(
            shared.waiters.filter((entry) => entry.id !== shared.leaderWaiterId).length,
          );
          if (!admission.accepted)
            return yield* reject(pressureError(descriptor, admission.rejection));
          waiter.request = shared;
          shared.waiters.push(waiter);
          bindRendererCoalescing(shared, waiter);
          markCoalescedDispatch(waiter, shared.trace);
          metrics.coalesced++;
          return;
        }
        const admission = admitCodexScheduledRequest({
          inFlightCount: state.inFlight.size,
          request: descriptor,
          queued: state.queued.map((queued) => queued.descriptor),
        });
        if (!admission.accepted) {
          metrics.rejected++;
          return yield* reject(
            codexRuntimeError({
              operation: "scheduler.plugin-requeue",
              reason: "host-unavailable",
              retryable: true,
              hostId: state.hostId,
              method: descriptor.method,
              cause: admission.rejection,
            }),
          );
        }
        const request: PhysicalRequest = {
          trace: {},
          responseTimeoutOwner: options?.responseTimeoutOwner ?? "main",
          retainResponse: false,
          responseDeadlineAtMs: absoluteDeadline,
          descriptor,
          dispatch: waiter.input.dispatch,
          coalescingKey,
          expiresAfterMs: codexRequestQueueExpiryMs({
            priority: descriptor.priority,
            source: descriptor.source,
            timeoutMs: descriptor.timeoutMs,
            expiresAtMs: absoluteDeadline,
            nowMs: now,
          }),
          outcomeOnTimeout: options?.outcomeOnTimeout ?? "not-applied",
          onDetachedPhysicalResponse: options?.onDetachedPhysicalResponse,
          waiters: [waiter],
          leaderWaiterId: waiter.id,
          phase: "queued",
        };
        bindRequestMetrics(request);
        waiter.request = request;
        bindRendererCoalescing(request, waiter);
        state.queued.push(request);
        if (coalescingKey !== null) state.coalesced.set(coalescingKey, request);
        metrics.queued++;
        metrics.queuedBytes += descriptor.queuedBytes;
        metrics.queuedByPriority[descriptor.priority]++;
        metrics.physicalQueued++;
        updateHighWater();
        if (request.expiresAfterMs !== null)
          yield* FiberMap.run(
            state.fibers,
            timerKey(descriptor.requestId),
            Effect.sleep(request.expiresAfterMs).pipe(
              Effect.andThen(expireQueued(state, request)),
              Effect.ignoreCause,
            ),
            { startImmediately: true },
          );
      });

    const detachPluginRequest = (
      state: GenerationState,
      request: PhysicalRequest,
      abandoned: LogicalWaiter,
      timedOut = abandoned.input.options?.rendererCaller?.abandonment?.() === "timeout",
    ) =>
      Effect.gen(function* () {
        const destinationId = abandoned.input.options?.rendererCaller?.destinationId;
        const waiters = request.waiters.splice(0);
        state.inFlight.delete(request.descriptor.requestId);
        if (
          request.coalescingKey !== null &&
          state.coalesced.get(request.coalescingKey) === request
        )
          state.coalesced.delete(request.coalescingKey);
        if (state.detachedPluginRequestIds.size < 2)
          state.detachedPluginRequestIds.add(request.descriptor.requestId);
        removeInFlightMetrics(request);
        for (const waiter of waiters) {
          if (
            waiter === abandoned ||
            (!timedOut && waiter.input.options?.rendererCaller?.destinationId === destinationId)
          ) {
            waiter.active = false;
            releaseWaiterMetrics(waiter);
            metrics.callerDetached++;
            if (waiter !== abandoned)
              yield* Deferred.fail(
                waiter.deferred,
                codexRuntimeError({
                  operation: "scheduler.destination-closed",
                  reason: "closing",
                  retryable: false,
                  hostId: state.hostId,
                  method: request.descriptor.method,
                }),
              );
            continue;
          }
          yield* requeuePluginWaiter(state, waiter);
        }
        yield* pumpLocked(state);
      });

    const detachWaiter = (
      state: GenerationState,
      request: PhysicalRequest,
      waiter: LogicalWaiter,
    ) =>
      mutationLock.withPermits(1)(
        Effect.gen(function* () {
          if (!waiter.active) return;
          if (
            request.phase === "in-flight" &&
            request.descriptor.method === "plugin/list" &&
            waiter.input.options?.rendererCaller &&
            state.inFlight.get(request.descriptor.requestId) === request
          ) {
            const activeLeader = request.waiters.some(
              (candidate) => candidate.active && candidate.id === request.leaderWaiterId,
            );
            const otherActiveWaiters = request.waiters.some(
              (candidate) => candidate !== waiter && candidate.active,
            );
            if (waiter.id === request.leaderWaiterId || (!activeLeader && !otherActiveWaiters))
              return yield* detachPluginRequest(state, request, waiter);
          }
          waiter.active = false;
          if (waiter.input.options?.rendererCaller?.abandonment?.() === "timeout")
            yield* reportWaiterMetrics(waiter, request);
          else releaseWaiterMetrics(waiter);
          const waiterIndex = request.waiters.indexOf(waiter);
          if (waiterIndex !== -1) request.waiters.splice(waiterIndex, 1);
          metrics.callerDetached += 1;
          if (request.waiters.length > 0) return;
          if (request.phase === "in-flight") {
            // Resume abandonment frees admission immediately; its eventual reply is still observed.
            if (
              request.descriptor.method !== "thread/resume" ||
              state.inFlight.get(request.descriptor.requestId) !== request
            )
              return;
            state.inFlight.delete(request.descriptor.requestId);
            removeInFlightMetrics(request);
            yield* pumpLocked(state);
            return;
          }
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

    const timeoutWaiter = (
      state: GenerationState,
      waiter: LogicalWaiter,
      retainResponse: boolean,
    ) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          let delivery: CodexTurnDelivery | null = null;
          const cancelDispatch = yield* mutationLock.withPermits(1)(
            Effect.gen(function* () {
              const request = waiter.request;
              if (
                !request ||
                !waiter.active ||
                state.retired ||
                generations.get(state.key) !== state
              )
                return null;
              const id = request.descriptor.requestId;
              if (request.trace.startedAtMs !== undefined) {
                if (!retainResponse) {
                  const error = timeoutError(request, "scheduler.execution");
                  metrics.executionTimedOut += 1;
                  if (error.reason === "outcome-unknown") metrics.outcomeUnknown += 1;
                  yield* reportWaiterMetrics(waiter, request);
                  if (
                    request.descriptor.method === "plugin/list" &&
                    state.inFlight.get(id) === request
                  ) {
                    yield* detachPluginRequest(state, request, waiter, true);
                  } else {
                    waiter.active = false;
                    const index = request.waiters.indexOf(waiter);
                    if (index !== -1) request.waiters.splice(index, 1);
                    if (
                      request.waiters.length === 0 &&
                      request.descriptor.method === "thread/resume" &&
                      state.inFlight.get(id) === request
                    ) {
                      state.inFlight.delete(id);
                      removeInFlightMetrics(request);
                      yield* pumpLocked(state);
                    }
                  }
                  yield* Deferred.fail(waiter.deferred, error);
                  return null;
                }
                if (state.inFlight.get(id) !== request) return null;
                state.inFlight.delete(id);
                state.retained.set(id, request);
                if (
                  request.coalescingKey !== null &&
                  state.coalesced.get(request.coalescingKey) === request
                )
                  state.coalesced.delete(request.coalescingKey);
                removeInFlightMetrics(request);
                metrics.outcomeUnknown += 1;
                delivery = {
                  requestId: id,
                  method: request.descriptor.method,
                  stage: "outcome-unknown",
                };
                yield* pumpLocked(state);
                return null;
              }

              waiter.active = false;
              const index = request.waiters.indexOf(waiter);
              if (index !== -1) request.waiters.splice(index, 1);
              yield* reportWaiterMetrics(waiter);
              yield* Deferred.fail(
                waiter.deferred,
                timeoutError(
                  { descriptor: request.descriptor, outcomeOnTimeout: "not-applied" },
                  "scheduler.queue",
                ),
              );
              if (request.waiters.length > 0) return null;
              if (
                request.coalescingKey !== null &&
                state.coalesced.get(request.coalescingKey) === request
              )
                state.coalesced.delete(request.coalescingKey);
              const queuedIndex = state.queued.indexOf(request);
              if (queuedIndex !== -1) {
                state.queued.splice(queuedIndex, 1);
                removeQueuedMetrics(request);
                yield* FiberMap.remove(state.fibers, timerKey(id));
              }
              const waitingForReady = state.inFlight.get(id) === request;
              if (waitingForReady) {
                state.inFlight.delete(id);
                removeInFlightMetrics(request);
              }
              metrics.cancelledBeforeDispatch += 1;
              yield* pumpLocked(state);
              return waitingForReady ? dispatchKey(id) : null;
            }),
          );
          // A dispatch finalizer acquires the same lock, so interrupt it only after releasing the lock.
          if (cancelDispatch !== null) yield* FiberMap.remove(state.fibers, cancelDispatch);
          if (delivery && waiter.input.options?.onOutcomeUnknown)
            yield* waiter.input.options.onOutcomeUnknown(delivery).pipe(Effect.ignoreCause);
        }),
      );

    const schedule = <A>(
      input: CodexRequestScheduleInput<A>,
    ): Effect.Effect<A, CodexRuntimeError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const retainedTimeout = yield* CodexRetainedRequestTimeout;
          const waiter: LogicalWaiter = {
            trace: {},
            id: nextWaiterId++,
            deferred: yield* Deferred.make<unknown, CodexRuntimeError>(),
            input,
            queuedAtMs: yield* Effect.clockWith((clock) => clock.currentTimeMillis),
            active: true,
          };
          const acquired = yield* mutationLock
            .withPermits(1)(
              Effect.gen(function* () {
                const hostId = input.hostId.trim();
                const state = generations.get(generationKey(hostId, input.generation));
                if (state === undefined || state.retired) {
                  return yield* unavailableGeneration(hostId, input.generation, input.method);
                }
                const host = input.options?.hostMetrics;
                if (host) {
                  waiter.concurrency = beginCodexClientRequest(host.receiveState);
                  waiter.reconnectAttemptAtEnqueue = host.reconnectAttempt;
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
                  Number.isFinite(input.options.timeoutMs)
                    ? input.options.timeoutMs
                    : null;
                const descriptor: CodexScheduledRequestDescriptor = {
                  requestId: input.options?.requestId ?? String(nextRequestId++),
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
                waiter.descriptor = descriptor;
                if (
                  state.inFlight.has(descriptor.requestId) ||
                  state.retained.has(descriptor.requestId) ||
                  state.queued.some(
                    (request) => request.descriptor.requestId === descriptor.requestId,
                  )
                )
                  return yield* pressureError(descriptor, "Request identity is already pending");
                if (
                  input.options?.rendererCaller &&
                  input.method === "plugin/list" &&
                  state.detachedPluginRequestIds.size >= 2
                ) {
                  return yield* pressureError(descriptor, "Too many detached plugin list requests");
                }
                const coalescingKey = codexRequestCoalescingKey(descriptor, {
                  coalesce: input.options?.coalesce,
                });
                const shared =
                  coalescingKey === null ? undefined : state.coalesced.get(coalescingKey);
                if (shared !== undefined) {
                  const admission = admitCodexCoalescedWaiter(
                    shared.waiters.filter((waiter) => waiter.id !== shared.leaderWaiterId).length,
                  );
                  if (!admission.accepted) {
                    metrics.rejected += 1;
                    return yield* pressureError(descriptor, admission.rejection);
                  }
                  shared.waiters.push(waiter);
                  bindRendererCoalescing(shared, waiter);
                  markCoalescedDispatch(waiter, shared.trace);
                  waiter.request = shared;
                  metrics.coalesced += 1;
                  return { state, request: shared };
                }
                const admission = admitCodexScheduledRequest({
                  inFlightCount: state.inFlight.size,
                  request: descriptor,
                  queued: state.queued.map((request) => request.descriptor),
                });
                if (!admission.accepted) {
                  metrics.rejected += 1;
                  return yield* pressureError(descriptor, admission.rejection);
                }
                const nowMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
                const request: PhysicalRequest = {
                  trace: {},
                  responseTimeoutOwner: input.options?.responseTimeoutOwner ?? "main",
                  retainResponse:
                    input.options?.retainResponse === true &&
                    codexRequestCanRetainOutcome(input.method),
                  responseDeadlineAtMs:
                    input.options?.expiresAtMs ??
                    (timeoutMs !== null && timeoutMs > 0 ? waiter.queuedAtMs + timeoutMs : null),
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
                  onDetachedPhysicalResponse: input.options?.onDetachedPhysicalResponse,
                  waiters: [waiter],
                  leaderWaiterId: waiter.id,
                  phase: "queued",
                };
                bindRequestMetrics(request);
                waiter.request = request;
                bindRendererCoalescing(request, waiter);
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
            )
            .pipe(Effect.tapError(() => reportWaiterMetrics(waiter)));
          const response = Deferred.await(waiter.deferred);
          const timeoutSignal =
            input.options?.responseTimeoutOwner === "caller"
              ? retainedTimeout
              : acquired.request.responseDeadlineAtMs !== null
                ? Effect.sleep(
                    Math.max(
                      0,
                      acquired.request.responseDeadlineAtMs - (yield* Clock.currentTimeMillis),
                    ),
                  )
                : null;
          const awaitResponse = timeoutSignal
            ? Effect.raceFirst(
                response,
                timeoutSignal.pipe(
                  Effect.andThen(
                    timeoutWaiter(
                      acquired.state,
                      waiter,
                      input.options?.responseTimeoutOwner === "caller" ||
                        acquired.request.retainResponse,
                    ),
                  ),
                  Effect.andThen(Effect.never),
                ),
              )
            : response;
          return (yield* restore(awaitResponse).pipe(
            Effect.onInterrupt(() =>
              detachWaiter(acquired.state, waiter.request ?? acquired.request, waiter),
            ),
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
