import {
  mobileEvents,
  mobileMethods,
  type MobileEnvelope,
  type MobileEvent,
  type MobileEventData,
  type MobileMethod,
  type MobileParams,
  type MobileResult,
  type RpcError,
} from "@nodex/mobile-protocol";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

type FailureCode = RpcError["code"] | "disconnected" | "deadline" | "invalid_result";
export class RpcFailure extends Error {
  readonly _tag = "RpcFailure";
  constructor(
    readonly code: FailureCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "RpcFailure";
  }
}
export const disconnected = () =>
  new RpcFailure("disconnected", "Connect to your desktop and try again.", true);
type Response = Extract<MobileEnvelope, { t: "res" }>;
type Event = { [K in MobileEvent]: { event: K; data: MobileEventData<K> } }[MobileEvent];
type Send = (envelope: MobileEnvelope) => Effect.Effect<void, RpcFailure>;

export const makeRpcClient = Effect.gen(function* () {
  const pending = new Map<number, Deferred.Deferred<Response, RpcFailure>>();
  // Overflow forces transport reconciliation; protocol events are never silently dropped.
  const events = yield* PubSub.dropping<Event>(128);
  yield* Effect.addFinalizer(() => PubSub.shutdown(events));
  let nextId = 0;
  let send: Send | null = null;
  let droppedEvents = 0;
  const disconnect = Effect.gen(function* () {
    send = null;
    for (const completion of pending.values()) yield* Deferred.fail(completion, disconnected());
    pending.clear();
  });
  yield* Effect.addFinalizer(() => disconnect);
  return {
    attach: (transport: Send) =>
      disconnect.pipe(
        Effect.andThen(
          Effect.sync(() => {
            send = transport;
          }),
        ),
      ),
    disconnect,
    get droppedEvents() {
      return droppedEvents;
    },
    dropEvent: Effect.sync(() => {
      droppedEvents++;
    }),
    request: Effect.fn("MobileRpc.request")(function* <M extends MobileMethod>(
      method: M,
      params: MobileParams<M>,
    ): Effect.fn.Return<MobileResult<M>, RpcFailure> {
      const definition = Object.hasOwn(mobileMethods, method) ? mobileMethods[method] : null;
      if (!definition)
        return yield* Effect.fail(
          new RpcFailure("unknown_method", "This request is unavailable.", false),
        );
      const parsed = definition.params.safeParse(params);
      if (!parsed.success)
        return yield* Effect.fail(
          new RpcFailure("invalid_params", "This request has invalid details.", false),
        );
      const transport = send;
      if (!transport) return yield* Effect.fail(disconnected());
      const id = ++nextId;
      const completion = yield* Deferred.make<Response, RpcFailure>();
      const response = yield* Effect.acquireUseRelease(
        Effect.sync(() => {
          pending.set(id, completion);
        }),
        () =>
          transport({ t: "req", id, m: method, p: parsed.data }).pipe(
            Effect.andThen(Deferred.await(completion)),
          ),
        () =>
          Effect.sync(() => {
            pending.delete(id);
          }),
      ).pipe(
        Effect.timeoutOrElse({
          duration: 30_000,
          orElse: () =>
            Effect.fail(new RpcFailure("deadline", "Your desktop took too long to respond.", true)),
        }),
      );
      if (!response.ok)
        return yield* Effect.fail(
          new RpcFailure(response.e.code, response.e.message, response.e.retryable),
        );
      const result = definition.result.safeParse(response.r);
      if (!result.success)
        return yield* Effect.fail(
          new RpcFailure(
            "invalid_result",
            "Your desktop sent a reply this version can't read.",
            false,
          ),
        );
      return result.data as MobileResult<M>;
    }),
    receive: Effect.fnUntraced(function* (envelope: MobileEnvelope) {
      if (envelope.t === "res") {
        const completion = pending.get(envelope.id);
        if (completion) yield* Deferred.succeed(completion, envelope);
        return;
      }
      if (envelope.t !== "evt") return;
      const event = envelope.k as MobileEvent;
      const definition = Object.hasOwn(mobileEvents, event) ? mobileEvents[event] : null;
      const parsed = definition?.safeParse(envelope.d);
      if (!parsed?.success) {
        droppedEvents++;
        return;
      }
      const admitted = yield* PubSub.publish(events, { event, data: parsed.data } as Event);
      if (!admitted) return yield* Effect.fail(disconnected());
    }),
    notifications: Stream.fromPubSub(events),
    events: <K extends MobileEvent>(event: K) =>
      Stream.fromPubSub(events).pipe(
        Stream.filter((entry) => entry.event === event),
        Stream.map((entry) => entry.data as MobileEventData<K>),
      ),
  };
});
export type MobileRpc = Effect.Success<typeof makeRpcClient>;
export class RpcClient extends Context.Service<RpcClient, MobileRpc>()("nodex/mobile/RpcClient") {}
