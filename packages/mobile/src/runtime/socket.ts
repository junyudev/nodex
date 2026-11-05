import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type { MobilePlatform } from "./platform";

type SocketEvent =
  | { type: "open" }
  | { type: "frame"; bytes: Uint8Array }
  | { type: "closed"; code: number };

/** A full ingress queue closes the transport so the connection owner can reconcile. */
export const openSocket = Effect.fn("MobileSocket.open")(function* (
  platform: MobilePlatform,
  route: string,
) {
  const queue = yield* Queue.dropping<SocketEvent>(128);
  const overflow = yield* Deferred.make<never, number>();
  const socket = yield* Effect.acquireRelease(
    Effect.try(() => platform.socket(route)),
    (socket) => Effect.sync(() => socket.close()),
  );
  const offer = (event: SocketEvent) => {
    if (Queue.offerUnsafe(queue, event)) return;
    Deferred.doneUnsafe(overflow, Effect.fail(1006));
    socket.close();
  };
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      socket.listen({
        open: () => offer({ type: "open" }),
        frame: (bytes) => offer({ type: "frame", bytes }),
        closed: (code) => offer({ type: "closed", code }),
        failed: () => offer({ type: "closed", code: 1006 }),
      }),
    ),
    (unlisten) => Effect.sync(unlisten),
  );
  yield* Effect.addFinalizer(() => Queue.shutdown(queue));
  return {
    take: Effect.raceFirst(Queue.take(queue), Deferred.await(overflow)),
    send: (bytes: Uint8Array) =>
      Effect.try(() => socket.send(bytes)).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            offer({ type: "closed", code: 1006 });
            socket.close();
          }),
        ),
      ),
  };
});
