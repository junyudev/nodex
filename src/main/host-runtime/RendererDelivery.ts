import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import {
  RENDERER_DELIVERY_WIRE_VERSION,
  advanceRendererDeliveryAcknowledgment,
  encodeRendererDelivery,
  type RendererDeliveryAcknowledgmentState,
  type RendererDeliveryDataEnvelope,
  type RendererDeliveryDispatch,
  type RendererDeliveryJsonValue,
  type RendererDeliveryTarget,
  type RendererDeliveryTransferAbortEnvelope,
  type RendererDeliveryTransferAckEnvelope,
} from "../../shared/renderer-delivery-transport";

const DEFAULT_ACK_TIMEOUT = "1 second";
const DEFAULT_RETRY_DELAY = "50 millis";
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_PENDING_PER_TARGET = 32;
const DEFAULT_MAX_PENDING_PROCESS = 256;
// One target may admit one worst-case bounded recovery snapshot. Other targets still share a
// separate process ceiling, so a slow renderer cannot turn recovery into an unbounded queue.
const DEFAULT_MAX_PENDING_BYTES_PER_TARGET = 64 * 1024 * 1024;
const DEFAULT_MAX_PENDING_BYTES_PROCESS = 256 * 1024 * 1024;

export class RendererDeliveryAdapterError extends Schema.TaggedError<RendererDeliveryAdapterError>()(
  "RendererDeliveryAdapterError",
  {
    operation: Schema.String,
    reason: Schema.Literals(["unavailable", "destroyed", "send-failed"]),
    cause: Schema.Defect(),
  },
) {}

export interface RendererDeliveryAdapterService {
  /**
   * Sends one wire frame. Transfer data frames resolve with the renderer's ACK;
   * inline and abort frames resolve with null.
   */
  readonly deliver: (
    envelope: RendererDeliveryDataEnvelope | RendererDeliveryTransferAbortEnvelope,
  ) => Effect.Effect<RendererDeliveryTransferAckEnvelope | null, RendererDeliveryAdapterError>;
}

export class RendererDeliveryAdapter extends Context.Service<
  RendererDeliveryAdapter,
  RendererDeliveryAdapterService
>()("nodex/main/host-runtime/RendererDeliveryAdapter") {}

export type RendererDeliveryErrorReason =
  | "closed"
  | "encoding"
  | "target-capacity"
  | "process-capacity"
  | "send-failed"
  | "destroyed"
  | "ack-timeout"
  | "ack-mismatch"
  | "released";

export class RendererDeliveryError extends Schema.TaggedError<RendererDeliveryError>()(
  "RendererDeliveryError",
  {
    operation: Schema.String,
    reason: Schema.Literals([
      "closed",
      "encoding",
      "target-capacity",
      "process-capacity",
      "send-failed",
      "destroyed",
      "ack-timeout",
      "ack-mismatch",
      "released",
    ]),
    targetId: Schema.String,
    generation: Schema.Number,
    deliveryId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface RendererDeliveryCompletion {
  readonly deliveryId: string;
  readonly target: RendererDeliveryTarget;
  readonly attempts: number;
  readonly encodedBytes: number;
}

export interface RendererDeliveryReceipt {
  readonly deliveryId: string;
  readonly target: RendererDeliveryTarget;
  readonly encodedBytes: number;
  readonly frameCount: number;
  readonly completion: Effect.Effect<RendererDeliveryCompletion, RendererDeliveryError>;
}

export interface RendererDeliveryMetrics {
  readonly activeTargets: number;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly peakPendingCount: number;
  readonly peakPendingBytes: number;
  readonly admitted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly rejected: number;
  readonly sentFrames: number;
  readonly acknowledgedFrames: number;
  readonly retries: number;
  readonly timeouts: number;
  readonly wrongAcknowledgments: number;
  readonly aborts: number;
}

export interface RendererDeliveryOptions {
  readonly ackTimeout?: Duration.Input;
  readonly retryDelay?: Duration.Input;
  readonly maxAttempts?: number;
  readonly maxPendingPerTarget?: number;
  readonly maxPendingProcess?: number;
  readonly maxPendingBytesPerTarget?: number;
  readonly maxPendingBytesProcess?: number;
  readonly deliveryIdFactory?: () => string;
}

export class RendererDelivery extends Context.Service<
  RendererDelivery,
  {
    readonly enqueue: (
      target: RendererDeliveryTarget,
      payload: RendererDeliveryJsonValue,
    ) => Effect.Effect<RendererDeliveryReceipt, RendererDeliveryError>;
    readonly releaseTarget: (target: RendererDeliveryTarget) => Effect.Effect<void>;
    readonly metrics: Effect.Effect<RendererDeliveryMetrics>;
  }
>()("nodex/main/host-runtime/RendererDelivery") {}

interface QueuedDelivery {
  readonly deliveryId: string;
  readonly target: RendererDeliveryTarget;
  readonly dispatch: RendererDeliveryDispatch;
  readonly encodedBytes: number;
  readonly completion: Deferred.Deferred<RendererDeliveryCompletion, RendererDeliveryError>;
  readonly laneToken: number;
}

interface DeliveryLane {
  readonly token: number;
  readonly workerKey: string;
  readonly target: RendererDeliveryTarget;
  readonly queue: Queue.Queue<QueuedDelivery>;
  readonly items: ReadonlyMap<string, QueuedDelivery>;
  readonly pendingCount: number;
  readonly pendingBytes: number;
}

interface DeliveryState {
  readonly closed: boolean;
  readonly nextLaneToken: number;
  readonly lanes: ReadonlyMap<string, DeliveryLane>;
  readonly pendingCount: number;
  readonly pendingBytes: number;
  readonly peakPendingCount: number;
  readonly peakPendingBytes: number;
}

interface DeliveryCounters {
  readonly admitted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly rejected: number;
  readonly sentFrames: number;
  readonly acknowledgedFrames: number;
  readonly retries: number;
  readonly timeouts: number;
  readonly wrongAcknowledgments: number;
  readonly aborts: number;
}

const initialState: DeliveryState = {
  closed: false,
  nextLaneToken: 1,
  lanes: new Map(),
  pendingCount: 0,
  pendingBytes: 0,
  peakPendingCount: 0,
  peakPendingBytes: 0,
};

const initialCounters: DeliveryCounters = {
  admitted: 0,
  delivered: 0,
  failed: 0,
  rejected: 0,
  sentFrames: 0,
  acknowledgedFrames: 0,
  retries: 0,
  timeouts: 0,
  wrongAcknowledgments: 0,
  aborts: 0,
};

const targetKey = (target: RendererDeliveryTarget): string =>
  JSON.stringify([target.targetId, target.generation]);

const createDeliveryId = (): string => `renderer-delivery:${randomUUID()}`;

const encodedBytesOf = (dispatch: RendererDeliveryDispatch): number => {
  if (dispatch.kind === "inline") return dispatch.envelopes[0].encodedBytes;
  const first = dispatch.envelopes[0];
  if (first?.kind === "transferStart") return first.encodedBytes;
  throw new Error("Renderer transfer dispatch is missing its start frame");
};

const deliveryError = (input: {
  readonly operation: string;
  readonly reason: RendererDeliveryErrorReason;
  readonly target: RendererDeliveryTarget;
  readonly deliveryId: string;
  readonly cause: unknown;
}): RendererDeliveryError =>
  new RendererDeliveryError({
    operation: input.operation,
    reason: input.reason,
    targetId: input.target.targetId,
    generation: input.target.generation,
    deliveryId: input.deliveryId,
    cause: input.cause,
  });

const abortEnvelope = (
  delivery: QueuedDelivery,
  reason: string,
): RendererDeliveryTransferAbortEnvelope | null => {
  if (delivery.dispatch.kind !== "transfer") return null;
  return {
    version: RENDERER_DELIVERY_WIRE_VERSION,
    kind: "transferAbort",
    targetId: delivery.target.targetId,
    generation: delivery.target.generation,
    transferId: delivery.deliveryId,
    reason: reason.slice(0, 256),
  };
};

const isDestroyedAdapterError = (error: RendererDeliveryAdapterError): boolean =>
  error.reason === "destroyed";

const failureFromCause = (
  delivery: QueuedDelivery,
  cause: Cause.Cause<RendererDeliveryError>,
): RendererDeliveryError => {
  const failure = Option.getOrUndefined(Cause.findErrorOption(cause));
  if (failure instanceof RendererDeliveryError) return failure;
  return deliveryError({
    operation: "deliver.internal",
    reason: "send-failed",
    target: delivery.target,
    deliveryId: delivery.deliveryId,
    cause: Cause.squash(cause),
  });
};

/**
 * Owns bounded renderer publication independently from projection production.
 * Enqueue admits and returns a completion handle; one scoped worker per target
 * performs the potentially slow renderer handshake in FIFO order.
 */
export const make = (
  options: RendererDeliveryOptions = {},
): Effect.Effect<RendererDelivery["Service"], never, RendererDeliveryAdapter | Scope.Scope> =>
  Effect.gen(function* () {
    const adapter = yield* RendererDeliveryAdapter;
    const state = yield* Ref.make(initialState);
    const counters = yield* Ref.make(initialCounters);
    const transitions = yield* Semaphore.make(1);
    const workers = yield* FiberMap.make<string, void, never>();
    const ackTimeout = Duration.millis(
      Math.max(1, Math.floor(Duration.toMillis(options.ackTimeout ?? DEFAULT_ACK_TIMEOUT))),
    );
    const retryDelay = Duration.millis(
      Math.max(0, Math.floor(Duration.toMillis(options.retryDelay ?? DEFAULT_RETRY_DELAY))),
    );
    const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    const maxPendingPerTarget = Math.max(
      1,
      Math.floor(options.maxPendingPerTarget ?? DEFAULT_MAX_PENDING_PER_TARGET),
    );
    const maxPendingProcess = Math.max(
      1,
      Math.floor(options.maxPendingProcess ?? DEFAULT_MAX_PENDING_PROCESS),
    );
    const maxPendingBytesPerTarget = Math.max(
      1,
      Math.floor(options.maxPendingBytesPerTarget ?? DEFAULT_MAX_PENDING_BYTES_PER_TARGET),
    );
    const maxPendingBytesProcess = Math.max(
      1,
      Math.floor(options.maxPendingBytesProcess ?? DEFAULT_MAX_PENDING_BYTES_PROCESS),
    );
    const deliveryIdFactory = options.deliveryIdFactory ?? createDeliveryId;

    const updateCounters = (patch: Partial<DeliveryCounters>): Effect.Effect<void> =>
      Ref.update(counters, (current) => {
        const next = { ...current };
        for (const [key, value] of Object.entries(patch)) {
          next[key as keyof DeliveryCounters] =
            current[key as keyof DeliveryCounters] + (value ?? 0);
        }
        return next;
      });

    const recordAttemptFailure = (error: RendererDeliveryError): Effect.Effect<void> => {
      if (error.reason === "ack-timeout") return updateCounters({ timeouts: 1 });
      if (error.reason === "ack-mismatch") {
        return updateCounters({ wrongAcknowledgments: 1 });
      }
      return Effect.void;
    };

    const deliverWithDeadline = (
      delivery: QueuedDelivery,
      envelope: RendererDeliveryDataEnvelope,
    ): Effect.Effect<RendererDeliveryTransferAckEnvelope | null, RendererDeliveryError> =>
      Effect.gen(function* () {
        yield* updateCounters({ sentFrames: 1 });
        return yield* adapter.deliver(envelope).pipe(
          Effect.mapError((cause) =>
            deliveryError({
              operation: `deliver.${envelope.kind}`,
              reason: isDestroyedAdapterError(cause) ? "destroyed" : "send-failed",
              target: delivery.target,
              deliveryId: delivery.deliveryId,
              cause,
            }),
          ),
          Effect.timeoutOrElse({
            duration: ackTimeout,
            orElse: () =>
              Effect.fail(
                deliveryError({
                  operation: `deliver.${envelope.kind}`,
                  reason: "ack-timeout",
                  target: delivery.target,
                  deliveryId: delivery.deliveryId,
                  cause: new Error("Renderer delivery frame exceeded its deadline"),
                }),
              ),
          }),
        );
      });

    const sendAbort = (delivery: QueuedDelivery, reason: string): Effect.Effect<void> => {
      const envelope = abortEnvelope(delivery, reason);
      if (!envelope) return Effect.void;
      return Effect.gen(function* () {
        yield* updateCounters({ aborts: 1, sentFrames: 1 });
        yield* adapter
          .deliver(envelope)
          .pipe(
            Effect.timeoutOrElse({ duration: ackTimeout, orElse: () => Effect.void }),
            Effect.exit,
          );
      });
    };

    const executeAttempt = (delivery: QueuedDelivery): Effect.Effect<void, RendererDeliveryError> =>
      Effect.gen(function* () {
        if (delivery.dispatch.kind === "inline") {
          const acknowledgment = yield* deliverWithDeadline(
            delivery,
            delivery.dispatch.envelopes[0],
          );
          if (acknowledgment !== null) {
            return yield* deliveryError({
              operation: "ack.inline",
              reason: "ack-mismatch",
              target: delivery.target,
              deliveryId: delivery.deliveryId,
              cause: new Error("Inline renderer delivery must not return a transfer ACK"),
            });
          }
          return;
        }

        let acknowledgmentState: RendererDeliveryAcknowledgmentState | null =
          delivery.dispatch.acknowledgment;
        for (const envelope of delivery.dispatch.envelopes) {
          const acknowledgment = yield* deliverWithDeadline(delivery, envelope);
          if (!acknowledgmentState || !acknowledgment) {
            return yield* deliveryError({
              operation: `ack.${envelope.kind}`,
              reason: "ack-mismatch",
              target: delivery.target,
              deliveryId: delivery.deliveryId,
              cause: new Error("Chunked renderer delivery requires one exact ACK per frame"),
            });
          }
          const expectedState: RendererDeliveryAcknowledgmentState = acknowledgmentState;
          const advanced: {
            readonly state: RendererDeliveryAcknowledgmentState | null;
            readonly complete: boolean;
          } = yield* Effect.try({
            try: () => advanceRendererDeliveryAcknowledgment(expectedState, acknowledgment),
            catch: (cause) =>
              deliveryError({
                operation: `ack.${envelope.kind}`,
                reason: "ack-mismatch",
                target: delivery.target,
                deliveryId: delivery.deliveryId,
                cause,
              }),
          });
          yield* updateCounters({ acknowledgedFrames: 1 });
          acknowledgmentState = advanced.state;
        }
        if (acknowledgmentState !== null) {
          return yield* deliveryError({
            operation: "ack.complete",
            reason: "ack-mismatch",
            target: delivery.target,
            deliveryId: delivery.deliveryId,
            cause: new Error("Renderer transfer ended before its final ACK"),
          });
        }
      });

    const executeRetried = (
      delivery: QueuedDelivery,
      attempt = 1,
    ): Effect.Effect<number, RendererDeliveryError> =>
      Effect.exit(executeAttempt(delivery)).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return Effect.succeed(attempt);
          if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
          const error = failureFromCause(delivery, exit.cause);
          return recordAttemptFailure(error).pipe(
            Effect.andThen(sendAbort(delivery, error.reason)),
            Effect.andThen(
              attempt < maxAttempts && error.reason !== "destroyed"
                ? updateCounters({ retries: 1 }).pipe(
                    Effect.andThen(Effect.sleep(retryDelay)),
                    Effect.andThen(executeRetried(delivery, attempt + 1)),
                  )
                : Effect.fail(error),
            ),
          );
        }),
      );

    const execute = (delivery: QueuedDelivery): Effect.Effect<number, RendererDeliveryError> =>
      executeRetried(delivery).pipe(Effect.onInterrupt(() => sendAbort(delivery, "interrupted")));

    const settle = (
      delivery: QueuedDelivery,
      result: Exit.Exit<number, RendererDeliveryError>,
    ): Effect.Effect<boolean> =>
      transitions.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            const key = targetKey(delivery.target);
            const lane = current.lanes.get(key);
            if (
              !lane ||
              lane.token !== delivery.laneToken ||
              !lane.items.has(delivery.deliveryId)
            ) {
              return true;
            }

            const items = new Map(lane.items);
            items.delete(delivery.deliveryId);
            const pendingCount = lane.pendingCount - 1;
            const lanes = new Map(current.lanes);
            if (pendingCount === 0) lanes.delete(key);
            else {
              lanes.set(key, {
                ...lane,
                items,
                pendingCount,
                pendingBytes: lane.pendingBytes - delivery.encodedBytes,
              });
            }
            yield* Ref.set(state, {
              ...current,
              lanes,
              pendingCount: current.pendingCount - 1,
              pendingBytes: current.pendingBytes - delivery.encodedBytes,
            });
            yield* updateCounters(Exit.isSuccess(result) ? { delivered: 1 } : { failed: 1 });
            if (Exit.isSuccess(result)) {
              yield* Deferred.succeed(delivery.completion, {
                deliveryId: delivery.deliveryId,
                target: delivery.target,
                attempts: result.value,
                encodedBytes: delivery.encodedBytes,
              });
            } else {
              yield* Deferred.fail(delivery.completion, failureFromCause(delivery, result.cause));
            }
            return pendingCount === 0;
          }),
        ),
      );

    const runLane = (lane: DeliveryLane): Effect.Effect<void> => {
      const loop: Effect.Effect<void> = Queue.take(lane.queue).pipe(
        Effect.flatMap((delivery) =>
          Effect.exit(execute(delivery)).pipe(
            Effect.flatMap((result) => settle(delivery, result)),
            Effect.flatMap((empty) => {
              if (empty) return Queue.shutdown(lane.queue).pipe(Effect.asVoid);
              return Effect.suspend(() => loop);
            }),
          ),
        ),
      );
      return loop;
    };

    const enqueue = (
      target: RendererDeliveryTarget,
      payload: RendererDeliveryJsonValue,
    ): Effect.Effect<RendererDeliveryReceipt, RendererDeliveryError> =>
      Effect.gen(function* () {
        const deliveryId = deliveryIdFactory();
        const completion = yield* Deferred.make<
          RendererDeliveryCompletion,
          RendererDeliveryError
        >();
        return yield* transitions.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              const key = targetKey(target);
              const currentLane = current.lanes.get(key);
              const reject = (reason: RendererDeliveryErrorReason, cause: unknown) =>
                updateCounters({ rejected: 1 }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      deliveryError({
                        operation: "enqueue.admit",
                        reason,
                        target,
                        deliveryId,
                        cause,
                      }),
                    ),
                  ),
                );
              if (current.closed) {
                return yield* reject("closed", new Error("Renderer delivery runtime is closed"));
              }
              if ((currentLane?.pendingCount ?? 0) + 1 > maxPendingPerTarget) {
                return yield* reject(
                  "target-capacity",
                  new Error("Renderer delivery target count capacity is exhausted"),
                );
              }
              if (current.pendingCount + 1 > maxPendingProcess) {
                return yield* reject(
                  "process-capacity",
                  new Error("Renderer delivery process count capacity is exhausted"),
                );
              }

              // Serialize the expensive stringify/UTF-8/chunk allocation behind admission's
              // transition lock. Count-saturated targets reject before encoding, and byte-based
              // rejections can transiently allocate at most one payload process-wide.
              const dispatch = yield* Effect.try({
                try: () => encodeRendererDelivery({ target, transferId: deliveryId, payload }),
                catch: (cause) =>
                  deliveryError({
                    operation: "enqueue.encode",
                    reason: "encoding",
                    target,
                    deliveryId,
                    cause,
                  }),
              });
              const encodedBytes = encodedBytesOf(dispatch);
              if ((currentLane?.pendingBytes ?? 0) + encodedBytes > maxPendingBytesPerTarget) {
                return yield* reject(
                  "target-capacity",
                  new Error("Renderer delivery target byte capacity is exhausted"),
                );
              }
              if (current.pendingBytes + encodedBytes > maxPendingBytesProcess) {
                return yield* reject(
                  "process-capacity",
                  new Error("Renderer delivery process byte capacity is exhausted"),
                );
              }

              const lanes = new Map(current.lanes);
              const created = !currentLane;
              const token = currentLane?.token ?? current.nextLaneToken;
              const queue =
                currentLane?.queue ?? (yield* Queue.bounded<QueuedDelivery>(maxPendingPerTarget));
              const workerKey = currentLane?.workerKey ?? `${key}:${token}`;
              const delivery: QueuedDelivery = {
                deliveryId,
                target,
                dispatch,
                encodedBytes,
                completion,
                laneToken: token,
              };
              const items = new Map(currentLane?.items ?? []);
              items.set(deliveryId, delivery);
              const lane: DeliveryLane = {
                token,
                workerKey,
                target,
                queue,
                items,
                pendingCount: (currentLane?.pendingCount ?? 0) + 1,
                pendingBytes: (currentLane?.pendingBytes ?? 0) + encodedBytes,
              };
              lanes.set(key, lane);
              const pendingCount = current.pendingCount + 1;
              const pendingBytes = current.pendingBytes + encodedBytes;
              yield* Ref.set(state, {
                ...current,
                nextLaneToken: created ? current.nextLaneToken + 1 : current.nextLaneToken,
                lanes,
                pendingCount,
                pendingBytes,
                peakPendingCount: Math.max(current.peakPendingCount, pendingCount),
                peakPendingBytes: Math.max(current.peakPendingBytes, pendingBytes),
              });
              yield* updateCounters({ admitted: 1 });
              if (!(yield* Queue.offer(queue, delivery))) {
                return yield* Effect.die(
                  new Error("Open renderer delivery lane rejected admission"),
                );
              }
              if (created) {
                yield* FiberMap.run(workers, workerKey, runLane(lane), { startImmediately: true });
              }
              return {
                deliveryId,
                target,
                encodedBytes,
                frameCount: dispatch.envelopes.length,
                completion: Deferred.await(completion),
              };
            }),
          ),
        );
      });

    const releaseTarget = (target: RendererDeliveryTarget): Effect.Effect<void> =>
      Effect.gen(function* () {
        const released = yield* transitions.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              const key = targetKey(target);
              const lane = current.lanes.get(key);
              if (!lane) return null;
              const lanes = new Map(current.lanes);
              lanes.delete(key);
              yield* Ref.set(state, {
                ...current,
                lanes,
                pendingCount: current.pendingCount - lane.pendingCount,
                pendingBytes: current.pendingBytes - lane.pendingBytes,
              });
              yield* updateCounters({ failed: lane.pendingCount });
              for (const delivery of lane.items.values()) {
                yield* Deferred.fail(
                  delivery.completion,
                  deliveryError({
                    operation: "releaseTarget",
                    reason: "released",
                    target,
                    deliveryId: delivery.deliveryId,
                    cause: new Error("Renderer delivery target was released"),
                  }),
                );
              }
              return lane;
            }),
          ),
        );
        if (!released) return;
        yield* Queue.shutdown(released.queue);
        yield* FiberMap.remove(workers, released.workerKey);
      });

    const metrics: Effect.Effect<RendererDeliveryMetrics> = Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const totals = yield* Ref.get(counters);
      return {
        activeTargets: current.lanes.size,
        pendingCount: current.pendingCount,
        pendingBytes: current.pendingBytes,
        peakPendingCount: current.peakPendingCount,
        peakPendingBytes: current.peakPendingBytes,
        ...totals,
      };
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const lanes = yield* transitions.withPermits(1)(
          Effect.uninterruptible(
            Effect.gen(function* () {
              const current = yield* Ref.get(state);
              if (current.closed) return [] as const;
              yield* Ref.set(state, {
                ...current,
                closed: true,
                lanes: new Map(),
                pendingCount: 0,
                pendingBytes: 0,
              });
              yield* updateCounters({ failed: current.pendingCount });
              for (const lane of current.lanes.values()) {
                for (const delivery of lane.items.values()) {
                  yield* Deferred.fail(
                    delivery.completion,
                    deliveryError({
                      operation: "close",
                      reason: "closed",
                      target: delivery.target,
                      deliveryId: delivery.deliveryId,
                      cause: new Error("Renderer delivery runtime closed"),
                    }),
                  );
                }
              }
              return [...current.lanes.values()];
            }),
          ),
        );
        yield* Effect.forEach(lanes, (lane) => Queue.shutdown(lane.queue), {
          discard: true,
        });
        yield* FiberMap.clear(workers);
      }),
    );

    return RendererDelivery.of({ enqueue, releaseTarget, metrics });
  });

export const live = (
  options: RendererDeliveryOptions = {},
): Layer.Layer<RendererDelivery, never, RendererDeliveryAdapter> =>
  Layer.effect(RendererDelivery, make(options));
