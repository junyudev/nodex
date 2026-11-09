import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type {
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreEventSubscription,
  CoreStreamCheckpoint,
} from "../core-client/types";
import { CoreRateLimitError } from "../core-client/local-http";
import { CoreAuthority, CoreSessionAccess } from "./CoreAuthority";
import {
  classifyCoreOperationFailure,
  coreRuntimeError,
  type CoreRuntimeError,
} from "./CoreRuntimeError";

export interface CoreEventDeliveryService {
  readonly event: (event: CoreEventEnvelope) => Effect.Effect<void, CoreRuntimeError>;
  readonly checkpoint: (checkpoint: CoreStreamCheckpoint) => Effect.Effect<void, CoreRuntimeError>;
  readonly resync: (boundary: CoreEventReplayRequired) => Effect.Effect<void, CoreRuntimeError>;
}

export class CoreEventDelivery extends Context.Service<
  CoreEventDelivery,
  CoreEventDeliveryService
>()("nodex/main/core-runtime/CoreEventDelivery") {}

export const deliveryFrom = (delivery: CoreEventDeliveryService): Layer.Layer<CoreEventDelivery> =>
  Layer.succeed(CoreEventDelivery, CoreEventDelivery.of(delivery));

export type CoreEventConnectionState =
  | { readonly kind: "connecting"; readonly attempt: number }
  | { readonly kind: "ready"; readonly generation: string }
  | { readonly kind: "backing-off"; readonly attempt: number; readonly error: CoreRuntimeError }
  | { readonly kind: "failed"; readonly error: CoreRuntimeError }
  | { readonly kind: "stopped" };

export interface CoreEventHubService {
  readonly connection: SubscriptionRef.SubscriptionRef<CoreEventConnectionState>;
  readonly cursor: Effect.Effect<number>;
}

export class CoreEventHub extends Context.Service<CoreEventHub, CoreEventHubService>()(
  "nodex/main/core-runtime/CoreEventHub",
) {}

export interface CoreEventHubOptions {
  readonly initialAfter?: number;
  readonly retryBase?: Duration.Input;
  readonly retryCap?: Duration.Input;
  readonly jitter?: boolean;
  readonly inboundCapacity?: number;
}

type InboundEvent =
  | { readonly kind: "event"; readonly value: CoreEventEnvelope }
  | { readonly kind: "checkpoint"; readonly value: CoreStreamCheckpoint }
  | { readonly kind: "resync"; readonly value: CoreEventReplayRequired }
  | { readonly kind: "flush"; readonly ack: Deferred.Deferred<void> };

const eventRetrySchedule = (options: CoreEventHubOptions) => {
  const capped = Schedule.min([
    Schedule.exponential(options.retryBase ?? "250 millis"),
    Schedule.spaced(options.retryCap ?? "5 seconds"),
  ]);
  return options.jitter === false ? capped : capped.pipe(Schedule.jittered);
};

const isOpeningFailure = (error: CoreRuntimeError): boolean =>
  error.retryable &&
  (error.operation === "events.open" ||
    error.operation === "launch" ||
    error.operation === "health" ||
    error.operation === "authority.recover");

export const live = (
  options: CoreEventHubOptions,
): Layer.Layer<
  CoreEventHub,
  CoreRuntimeError,
  CoreAuthority | CoreSessionAccess | CoreEventDelivery
> =>
  Layer.effect(
    CoreEventHub,
    Effect.gen(function* () {
      const access = yield* CoreSessionAccess;
      const authority = yield* CoreAuthority;
      const delivery = yield* CoreEventDelivery;
      const handshake = yield* access.handshake;
      const cursor = yield* Ref.make(options.initialAfter ?? handshake.commit_head);
      const connection = yield* SubscriptionRef.make<CoreEventConnectionState>({
        kind: "connecting",
        attempt: 1,
      });
      const inboundCapacity = Math.max(1, Math.floor(options.inboundCapacity ?? 2_048));
      const callbackRuntime = yield* FiberSet.makeRuntime<never, void, never>();
      const connectionAttempt = yield* Ref.make(0);

      yield* Effect.addFinalizer(() => SubscriptionRef.set(connection, { kind: "stopped" }));

      const runPhysical = Effect.fn("CoreEventHub.runPhysical")(() =>
        Effect.scoped(
          Effect.gen(function* () {
            const inbound = yield* Queue.dropping<InboundEvent>(inboundCapacity);
            const deliveryFailure = yield* Deferred.make<never, CoreRuntimeError>();
            const overflowFailure = yield* Deferred.make<never, CoreRuntimeError>();
            const opened = yield* Deferred.make<CoreEventSubscription>();
            const resyncRequested = yield* Ref.make(false);
            yield* Effect.addFinalizer(() => Queue.shutdown(inbound).pipe(Effect.asVoid));

            const failDelivery = (cause: CoreRuntimeError) =>
              Deferred.fail(deliveryFailure, cause).pipe(Effect.asVoid);
            const inboundOverflowError = () =>
              coreRuntimeError({
                operation: "events.inbound-capacity",
                reason: "delivery",
                retryable: true,
                cause: new Error(`Core event ingress exceeded ${inboundCapacity} entries`),
              });
            const processInbound = Effect.fn("CoreEventHub.processInbound")(function* (
              item: InboundEvent,
            ) {
              if (item.kind === "flush") {
                yield* Deferred.succeed(item.ack, undefined);
                return;
              }
              if (item.kind === "event") {
                yield* delivery.event(item.value);
                return;
              }
              if (item.kind === "checkpoint") {
                yield* delivery.checkpoint(item.value);
                yield* Ref.update(cursor, (value) =>
                  Math.max(value, item.value.scanned_through_seq),
                );
                return;
              }
              yield* delivery.resync(item.value);
              yield* Ref.set(cursor, item.value.commit_head);
              yield* Ref.set(resyncRequested, true);
              const subscription = yield* Deferred.await(opened);
              yield* Effect.sync(() => subscription.close());
            });
            const deliveryWorker = Effect.forever(
              Queue.take(inbound).pipe(
                Effect.flatMap(processInbound),
                Effect.catch((error) => failDelivery(error)),
              ),
            );
            yield* Effect.forkScoped(deliveryWorker);

            const enqueue = (event: InboundEvent): void => {
              void callbackRuntime(
                Queue.offer(inbound, event).pipe(
                  Effect.flatMap((accepted) =>
                    accepted
                      ? Effect.void
                      : Deferred.fail(overflowFailure, inboundOverflowError()).pipe(Effect.asVoid),
                  ),
                ),
              );
            };
            const after = yield* Ref.get(cursor);
            const subscription = yield* Effect.acquireRelease(
              access.use("events.open", (client, signal) =>
                client.openEventStream(
                  after,
                  (event) => enqueue({ kind: "event", value: event }),
                  (checkpoint) => enqueue({ kind: "checkpoint", value: checkpoint }),
                  (boundary) => enqueue({ kind: "resync", value: boundary }),
                  signal,
                ),
              ),
              (active) => Effect.sync(() => active.close()),
              { interruptible: true },
            );
            yield* Deferred.succeed(opened, subscription);
            const handshake = yield* access.handshake;
            yield* Ref.set(connectionAttempt, 0);
            yield* SubscriptionRef.set(connection, {
              kind: "ready",
              generation: handshake.generation.start_nonce,
            });

            const streamDone = Effect.tryPromise({
              try: () => subscription.done,
              catch: (cause) =>
                classifyCoreOperationFailure(
                  "events.read",
                  cause,
                  handshake.generation.start_nonce,
                ),
            });
            yield* Effect.raceFirst(
              streamDone,
              Effect.raceFirst(Deferred.await(deliveryFailure), Deferred.await(overflowFailure)),
            );
            const flush = yield* Deferred.make<void>();
            const flushAccepted = yield* Queue.offer(inbound, { kind: "flush", ack: flush });
            if (!flushAccepted) return yield* inboundOverflowError();
            yield* Effect.raceFirst(
              Deferred.await(flush),
              Effect.raceFirst(Deferred.await(deliveryFailure), Deferred.await(overflowFailure)),
            );
            if (yield* Ref.get(resyncRequested)) return;
            return yield* coreRuntimeError({
              operation: "events.read",
              reason: "stream-ended",
              retryable: true,
              generation: handshake.generation.start_nonce,
            });
          }),
        ),
      );

      const openingPolicy = eventRetrySchedule(options).pipe(
        Schedule.setInputType<CoreRuntimeError>(),
        Schedule.while(({ input }) => isOpeningFailure(input)),
        Schedule.tap(({ input }) =>
          (input.cause instanceof CoreRateLimitError
            ? Effect.sleep(input.cause.retryAfterMs)
            : Effect.void
          ).pipe(
            Effect.andThen(
              Ref.updateAndGet(connectionAttempt, (attempt) => attempt + 1).pipe(
                Effect.flatMap((attempt) =>
                  SubscriptionRef.set(connection, { kind: "backing-off", attempt, error: input }),
                ),
              ),
            ),
          ),
        ),
      );
      const retryDelay = Duration.fromInputUnsafe(options.retryBase ?? "250 millis");
      const cycle = runPhysical().pipe(
        Effect.retry(openingPolicy),
        Effect.catch((error) => {
          if (!error.retryable) return Effect.fail(error);
          return Ref.updateAndGet(connectionAttempt, (attempt) => attempt + 1).pipe(
            Effect.flatMap((attempt) =>
              SubscriptionRef.set(connection, { kind: "backing-off", attempt, error }),
            ),
            Effect.andThen(
              Effect.sleep(
                error.cause instanceof CoreRateLimitError ? error.cause.retryAfterMs : retryDelay,
              ),
            ),
          );
        }),
      );
      const supervisor = Effect.forever(cycle).pipe(
        Effect.catch((error) =>
          SubscriptionRef.set(connection, { kind: "failed", error }).pipe(
            Effect.andThen(authority.failApplication(error)),
            Effect.asVoid,
          ),
        ),
      );
      yield* Effect.forkScoped(supervisor);

      return CoreEventHub.of({ connection, cursor: Ref.get(cursor) });
    }),
  );
