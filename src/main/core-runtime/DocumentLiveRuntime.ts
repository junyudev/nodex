import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import type {
  CoreEventEnvelope,
  DocumentLiveBarrier,
  DocumentLiveRepair,
} from "../core-client/types";

const INGRESS_CAPACITY = 512;

export class DocumentLiveRuntimeError extends Schema.TaggedError<DocumentLiveRuntimeError>()(
  "DocumentLiveRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export const documentLiveRuntimeError = (
  operation: string,
  cause: unknown,
): DocumentLiveRuntimeError => new DocumentLiveRuntimeError({ operation, cause });

export interface DocumentLivePhysicalSubscription {
  readonly barrier: DocumentLiveBarrier;
  readonly done: Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly close: Effect.Effect<void>;
}

export interface DocumentLiveSubscriptionInput {
  readonly open: (
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    onRealtime: (event: DocumentSyncRealtimeEvent) => void,
  ) => Effect.Effect<DocumentLivePhysicalSubscription, DocumentLiveRuntimeError>;
  readonly onEvent: (event: CoreEventEnvelope) => Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly onRepair: (repair: DocumentLiveRepair) => Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly onRealtime: (
    event: DocumentSyncRealtimeEvent,
  ) => Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly onOpened: (
    barrier: DocumentLiveBarrier,
    reconnected: boolean,
  ) => Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly onInterrupted: (cause: unknown | null) => Effect.Effect<void>;
  readonly onConnectionStateChanged: (state: "connected" | "disconnected") => Effect.Effect<void>;
  readonly shouldRetry: (cause: unknown | null) => boolean;
  readonly maxInitialOpenAttempts: number;
  readonly retryDelay: Duration.Input;
  readonly maxRetryDelay: Duration.Input;
}

export interface DocumentLiveLease {
  readonly ready: Effect.Effect<DocumentLiveBarrier, DocumentLiveRuntimeError>;
  readonly done: Effect.Effect<void, DocumentLiveRuntimeError>;
  /** Returns the physical attempt identity that admitted this command. */
  readonly waitUntilConnected: Effect.Effect<number, DocumentLiveRuntimeError>;
  readonly reconnectAfterSubscriptionLoss: (
    connectionVersion: number,
  ) => Effect.Effect<void, DocumentLiveRuntimeError>;
  readonly close: Effect.Effect<void>;
}

export class DocumentLiveRuntime extends Context.Service<
  DocumentLiveRuntime,
  {
    readonly subscribe: (input: DocumentLiveSubscriptionInput) => Effect.Effect<DocumentLiveLease>;
  }
>()("nodex/main/core-runtime/DocumentLiveRuntime") {}

interface LiveState {
  readonly connectionVersion: number;
  readonly active: DocumentLivePhysicalSubscription | null;
  readonly closed: boolean;
  readonly connected: boolean;
  readonly connection: Deferred.Deferred<void, DocumentLiveRuntimeError>;
  readonly everConnected: boolean;
  readonly retryWake: Deferred.Deferred<void> | null;
  readonly terminalError: DocumentLiveRuntimeError | null;
}

type Ingress =
  | { readonly kind: "event"; readonly value: CoreEventEnvelope }
  | { readonly kind: "repair"; readonly value: DocumentLiveRepair }
  | { readonly kind: "realtime"; readonly value: DocumentSyncRealtimeEvent }
  | { readonly kind: "drain"; readonly ack: Deferred.Deferred<void> };

interface AttemptResult {
  readonly connected: boolean;
  readonly kind: "ended" | "repair";
}

const interruptedOnly = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.length > 0 && cause.reasons.every(Cause.isInterruptReason);

const durationMillis = (duration: Duration.Input): number =>
  Math.max(0, Duration.toMillis(Duration.fromInputUnsafe(duration)));

const nextRetryDelay = (current: number, maximum: number): number =>
  current === 0 ? 0 : Math.min(current * 2, maximum);

const closedError = (): DocumentLiveRuntimeError =>
  documentLiveRuntimeError(
    "subscription.closed",
    new Error("Core Document live subscription is closed"),
  );

export const make = Effect.gen(function* () {
  const fibers = yield* FiberSet.make<void, never>();

  const subscribe = Effect.fn("DocumentLiveRuntime.subscribe")(function* (
    input: DocumentLiveSubscriptionInput,
  ) {
    const ready = yield* Deferred.make<DocumentLiveBarrier, DocumentLiveRuntimeError>();
    const initialConnection = yield* Deferred.make<void, DocumentLiveRuntimeError>();
    const done = yield* Deferred.make<void, DocumentLiveRuntimeError>();
    const state = yield* Ref.make<LiveState>({
      connectionVersion: 0,
      active: null,
      closed: false,
      connected: false,
      connection: initialConnection,
      everConnected: false,
      retryWake: null,
      terminalError: null,
    });
    const transitions = yield* Semaphore.make(1);
    const initialRetryDelayMs = durationMillis(input.retryDelay);
    const maxRetryDelayMs = Math.max(initialRetryDelayMs, durationMillis(input.maxRetryDelay));

    const observeConnection = (connectionState: "connected" | "disconnected") =>
      input.onConnectionStateChanged(connectionState).pipe(Effect.ignoreCause);

    const transitionDisconnected = transitions
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (!current.connected) return false;
          const connection = yield* Deferred.make<void, DocumentLiveRuntimeError>();
          yield* Ref.set(state, { ...current, connected: false, connection });
          return true;
        }),
      )
      .pipe(
        Effect.flatMap((changed) => (changed ? observeConnection("disconnected") : Effect.void)),
      );

    const installActive = (active: DocumentLivePhysicalSubscription) =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return false;
          yield* Ref.set(state, { ...current, active });
          return true;
        }),
      );

    const clearActive = (active: DocumentLivePhysicalSubscription) =>
      transitions.withPermits(1)(
        Ref.update(state, (current) =>
          current.active === active ? { ...current, active: null } : current,
        ),
      );

    const transitionConnected = (
      barrier: DocumentLiveBarrier,
      connectedThisAttempt: Ref.Ref<boolean>,
    ) =>
      transitions
        .withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) return false;
            yield* Ref.set(state, {
              ...current,
              connected: true,
              everConnected: true,
              connectionVersion: current.connectionVersion + 1,
            });
            yield* Ref.set(connectedThisAttempt, true);
            yield* Deferred.succeed(current.connection, undefined);
            yield* Deferred.succeed(ready, barrier);
            return true;
          }),
        )
        .pipe(
          Effect.flatMap((changed) =>
            changed ? observeConnection("connected").pipe(Effect.as(true)) : Effect.succeed(false),
          ),
        );

    const failOutstanding = (error: DocumentLiveRuntimeError) =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* Ref.set(state, { ...current, terminalError: error });
          yield* Deferred.fail(ready, error);
          yield* Deferred.fail(current.connection, error);
        }),
      );

    const waitForRetry = (milliseconds: number) =>
      Effect.gen(function* () {
        const wake = yield* Deferred.make<void>();
        const admitted = yield* transitions.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) return false;
            yield* Ref.set(state, { ...current, retryWake: wake });
            return true;
          }),
        );
        if (!admitted) return yield* closedError();
        if (milliseconds > 0) {
          yield* Effect.raceFirst(
            Effect.sleep(Duration.millis(milliseconds)),
            Deferred.await(wake),
          );
        }
        yield* transitions.withPermits(1)(
          Ref.update(state, (current) =>
            current.retryWake === wake ? { ...current, retryWake: null } : current,
          ),
        );
      });

    const runAttempt = (
      reconnected: boolean,
      connectedThisAttempt: Ref.Ref<boolean>,
    ): Effect.Effect<AttemptResult, DocumentLiveRuntimeError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const ingress = yield* Queue.bounded<Ingress>(INGRESS_CAPACITY);
          const overflow = yield* Deferred.make<never, DocumentLiveRuntimeError>();
          const repairSignal = yield* Deferred.make<void>();
          const repairDelivered = yield* Deferred.make<void>();
          const deliveryFailure = yield* Deferred.make<never, DocumentLiveRuntimeError>();
          const deliveryGate = yield* Deferred.make<void>();
          let accepting = true;
          yield* Effect.addFinalizer(() => Queue.shutdown(ingress).pipe(Effect.asVoid));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              accepting = false;
            }),
          );

          const overflowIngress = (): void => {
            accepting = false;
            Deferred.doneUnsafe(
              overflow,
              Effect.fail(
                documentLiveRuntimeError(
                  "stream.ingress-overflow",
                  new Error(`Document live ingress exceeded ${INGRESS_CAPACITY} items`),
                ),
              ),
            );
          };
          const offer = (item: Ingress): boolean => {
            if (!accepting) return false;
            if (Queue.offerUnsafe(ingress, item)) return true;
            overflowIngress();
            return false;
          };
          const onRepair = (repair: DocumentLiveRepair): void => {
            if (!offer({ kind: "repair", value: repair })) return;
            accepting = false;
            Deferred.doneUnsafe(repairSignal, Effect.void);
          };

          const physical = yield* Effect.raceFirst(
            input.open(
              (event) => {
                offer({ kind: "event", value: event });
              },
              onRepair,
              (event) => {
                offer({ kind: "realtime", value: event });
              },
            ),
            Deferred.await(overflow),
          );
          yield* Effect.addFinalizer(() => physical.close);
          const installed = yield* installActive(physical);
          if (!installed) return yield* closedError();

          const deliver = Deferred.await(deliveryGate).pipe(
            Effect.andThen(
              Effect.forever(
                Queue.take(ingress).pipe(
                  Effect.flatMap((item) => {
                    switch (item.kind) {
                      case "event":
                        return input.onEvent(item.value);
                      case "realtime":
                        return input.onRealtime(item.value);
                      case "repair":
                        return transitionDisconnected.pipe(
                          Effect.andThen(physical.close),
                          Effect.andThen(input.onRepair(item.value)),
                          Effect.ensuring(Deferred.succeed(repairDelivered, undefined)),
                        );
                      case "drain":
                        return Deferred.succeed(item.ack, undefined).pipe(Effect.asVoid);
                    }
                  }),
                ),
              ),
            ),
            Effect.catch((error) => Deferred.fail(deliveryFailure, error).pipe(Effect.asVoid)),
          );
          yield* Effect.forkScoped(deliver, { startImmediately: true });

          if (yield* Deferred.isDone(repairSignal)) {
            yield* Deferred.succeed(deliveryGate, undefined);
            yield* Effect.raceFirst(
              Deferred.await(repairDelivered),
              Deferred.await(deliveryFailure),
            );
            return { connected: false, kind: "repair" } as const;
          }

          yield* input.onOpened(physical.barrier, reconnected);
          const connected = yield* transitionConnected(physical.barrier, connectedThisAttempt);
          if (!connected) return yield* closedError();
          yield* Deferred.succeed(deliveryGate, undefined);

          const outcome = yield* Effect.raceFirst(
            physical.done.pipe(Effect.as("ended" as const)),
            Effect.raceFirst(
              Deferred.await(repairSignal).pipe(Effect.as("repair" as const)),
              Effect.raceFirst(Deferred.await(overflow), Deferred.await(deliveryFailure)),
            ),
          );
          accepting = false;
          if (outcome === "repair") {
            yield* Effect.raceFirst(
              Deferred.await(repairDelivered),
              Deferred.await(deliveryFailure),
            );
            return { connected: true, kind: "repair" } as const;
          }

          const drained = yield* Deferred.make<void>();
          yield* Queue.offer(ingress, { kind: "drain", ack: drained });
          yield* Effect.raceFirst(Deferred.await(drained), Deferred.await(deliveryFailure));
          return { connected: true, kind: "ended" } as const;
        }),
      ).pipe(
        Effect.ensuring(
          Ref.get(state).pipe(
            Effect.flatMap((current) =>
              current.active === null ? Effect.void : clearActive(current.active),
            ),
          ),
        ),
      );

    const loop = (
      initialOpenAttempts: number,
      retryDelayMs: number,
    ): Effect.Effect<void, DocumentLiveRuntimeError> =>
      Effect.suspend(() =>
        Effect.gen(function* () {
          const before = yield* Ref.get(state);
          if (before.closed) return;
          const attempts = before.everConnected ? initialOpenAttempts : initialOpenAttempts + 1;
          const connectedThisAttempt = yield* Ref.make(false);
          const attempt = yield* Effect.exit(
            runAttempt(before.everConnected, connectedThisAttempt),
          );
          const connected = yield* Ref.get(connectedThisAttempt);
          yield* transitionDisconnected;
          const currentDelayMs = connected ? initialRetryDelayMs : retryDelayMs;

          if (attempt._tag === "Success") {
            if (attempt.value.kind === "repair") {
              return yield* loop(attempts, currentDelayMs);
            }
            yield* input.onInterrupted(null);
            yield* waitForRetry(currentDelayMs);
            return yield* loop(attempts, nextRetryDelay(currentDelayMs, maxRetryDelayMs));
          }

          if (interruptedOnly(attempt.cause)) return yield* Effect.interrupt;
          const failure = Cause.squash(attempt.cause);
          const error = Schema.is(DocumentLiveRuntimeError)(failure)
            ? failure
            : documentLiveRuntimeError("stream.attempt", failure);
          const latest = yield* Ref.get(state);
          if (latest.closed) return;
          const terminal =
            (!latest.everConnected && attempts >= input.maxInitialOpenAttempts) ||
            !input.shouldRetry(error.cause);
          if (terminal) {
            yield* failOutstanding(error);
            yield* input.onInterrupted(error.cause);
            return yield* error;
          }
          yield* input.onInterrupted(error.cause);
          yield* waitForRetry(currentDelayMs);
          return yield* loop(attempts, nextRetryDelay(currentDelayMs, maxRetryDelayMs));
        }),
      );

    const program = loop(0, initialRetryDelayMs).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Ref.get(state).pipe(
            Effect.flatMap((current) => {
              if (current.closed && interruptedOnly(cause)) {
                return Deferred.succeed(done, undefined).pipe(Effect.asVoid);
              }
              const failure = Cause.squash(cause);
              const error = Schema.is(DocumentLiveRuntimeError)(failure)
                ? failure
                : documentLiveRuntimeError("subscription.loop", failure);
              return failOutstanding(error).pipe(
                Effect.andThen(Deferred.fail(done, error)),
                Effect.asVoid,
              );
            }),
          ),
        onSuccess: () => Deferred.succeed(done, undefined).pipe(Effect.asVoid),
      }),
    );
    const fiber = yield* FiberSet.run(fibers, program, { startImmediately: true });

    const waitUntilConnected: Effect.Effect<number, DocumentLiveRuntimeError> = transitions
      .withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.connected) return null;
          if (current.terminalError) return yield* current.terminalError;
          if (current.closed) return yield* closedError();
          return current.connection;
        }),
      )
      .pipe(
        Effect.flatMap((connection) =>
          connection === null ? Effect.void : Deferred.await(connection),
        ),
        Effect.andThen(Ref.get(state)),
        Effect.flatMap((current) =>
          current.connected ? Effect.succeed(current.connectionVersion) : waitUntilConnected,
        ),
      );

    const reconnectAfterSubscriptionLoss = Effect.fn(
      "DocumentLiveLease.reconnectAfterSubscriptionLoss",
    )(function* (connectionVersion: number) {
      const transition = yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.terminalError) return yield* current.terminalError;
          if (current.closed) return yield* closedError();
          if (current.connected && current.connectionVersion !== connectionVersion) return null;
          if (!current.connected) {
            return {
              active: null,
              connection: current.connection,
              disconnected: false,
              wake: current.retryWake,
            };
          }
          const connection = yield* Deferred.make<void, DocumentLiveRuntimeError>();
          yield* Ref.set(state, { ...current, connected: false, connection });
          return {
            active: current.active,
            connection,
            disconnected: true,
            wake: current.retryWake,
          };
        }),
      );
      if (transition === null) return;
      if (transition.disconnected) yield* observeConnection("disconnected");
      if (transition.active) yield* transition.active.close;
      if (transition.wake) yield* Deferred.succeed(transition.wake, undefined);
      yield* Deferred.await(transition.connection);
    });

    const close = Effect.uninterruptible(
      Effect.gen(function* () {
        const closing = yield* transitions.withPermits(1)(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) return null;
            const error = closedError();
            yield* Ref.set(state, {
              ...current,
              active: null,
              closed: true,
              connected: false,
              retryWake: null,
            });
            yield* Deferred.fail(ready, error);
            yield* Deferred.fail(current.connection, error);
            return {
              active: current.active,
              disconnected: current.connected,
              wake: current.retryWake,
            };
          }),
        );
        if (!closing) return;
        if (closing.disconnected) yield* observeConnection("disconnected");
        if (closing.wake) yield* Deferred.succeed(closing.wake, undefined);
        if (closing.active) yield* closing.active.close;
        yield* Fiber.interrupt(fiber);
        yield* Deferred.succeed(done, undefined);
      }),
    );

    return {
      ready: Deferred.await(ready),
      done: Deferred.await(done),
      waitUntilConnected,
      reconnectAfterSubscriptionLoss,
      close,
    } satisfies DocumentLiveLease;
  });

  return DocumentLiveRuntime.of({ subscribe });
});

export const live: Layer.Layer<DocumentLiveRuntime> = Layer.effect(DocumentLiveRuntime, make);
