import { createServer } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import { CHANNEL_CLOSE } from "@nodex/mobile-protocol";
import { WebSocket, WebSocketServer } from "ws";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";

export class MobileSocketError extends Data.TaggedError("MobileSocketError")<{
  readonly reason: "address-in-use" | "listen" | "closed" | "send";
}> {}

export interface MobileSocket {
  readonly take: Effect.Effect<Uint8Array, MobileSocketError>;
  readonly closed: Effect.Effect<void>;
  readonly send: (bytes: Uint8Array) => Effect.Effect<void, MobileSocketError>;
  readonly close: (code: number) => void;
}

const FRAME_LIMIT = 65_535;
const FRAME_QUEUE = 32;
const WRITE_BUDGET = 8 * 1024 * 1024;
const TCP_LIMIT = 40;
const PENDING_LIMIT = 8;
const bareNotFound = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

export const listenMobileSocket = Effect.fn("MobileSocket.listen")(function* (
  port: number,
  allowPeer: (address: string | undefined) => boolean,
) {
  const scope = yield* Scope.Scope;
  const incoming = yield* Queue.dropping<WebSocket>(PENDING_LIMIT);
  const sockets = new Set<Duplex>();
  const server = createServer(
    { headersTimeout: 10_000, requestTimeout: 10_000, maxHeaderSize: 4096 },
    (_, response) => {
      response.sendDate = false;
      response.writeHead(404, { Connection: "close", "Content-Length": 0 });
      response.end();
    },
  );
  const websocket = new WebSocketServer({
    noServer: true,
    autoPong: false,
    maxPayload: FRAME_LIMIT,
    perMessageDeflate: false,
  });

  yield* Scope.addFinalizer(
    scope,
    Effect.sync(() => {
      for (const socket of sockets) socket.destroy();
      websocket.close();
      server.close();
    }).pipe(Effect.andThen(Queue.shutdown(incoming))),
  );

  server.prependListener("connection", (socket: Socket) => {
    if (!allowPeer(socket.remoteAddress) || sockets.size >= TCP_LIMIT) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(10_000, () => socket.destroy());
  });
  server.on("clientError", (_, socket) => {
    if (sockets.has(socket) && socket.writable) socket.end(bareNotFound);
    else socket.destroy();
  });
  websocket.on("wsClientError", (_, socket) => {
    socket.end(bareNotFound);
  });
  server.on("upgrade", (request, socket, head) => {
    if (!sockets.has(socket)) return socket.destroy();
    if (request.url !== "/mobile" || request.method !== "GET") {
      socket.end(bareNotFound);
      return;
    }
    websocket.handleUpgrade(request, socket, head, (ws) => {
      // The WebSocket lifetime supersedes HTTP's deadline.
      (socket as Socket).setTimeout(0);
      ws.on("error", () => ws.terminate());
      // Do not admit frame callbacks until the scoped consumer has a bounded queue.
      ws.pause();
      if (!Queue.offerUnsafe(incoming, ws)) {
        ws.resume();
        ws.close(CHANNEL_CLOSE.overloaded);
      }
    });
  });
  server.on("error", () => {});
  const bound = yield* Effect.callback<number, MobileSocketError>((resume) => {
    const failed = (error: NodeJS.ErrnoException) => {
      server.off("listening", listening);
      resume(
        Effect.fail(
          new MobileSocketError({
            reason: error.code === "EADDRINUSE" ? "address-in-use" : "listen",
          }),
        ),
      );
    };
    const listening = () => {
      server.off("error", failed);
      const address = server.address();
      resume(
        typeof address === "object" && address !== null
          ? Effect.succeed(address.port)
          : Effect.fail(new MobileSocketError({ reason: "listen" })),
      );
    };
    server.once("error", failed);
    server.once("listening", listening);
    server.listen(port, "0.0.0.0");
  });
  const accept: Effect.Effect<MobileSocket> = Effect.gen(function* () {
    const ws = yield* Queue.take(incoming);
    const frames = yield* Queue.dropping<Uint8Array>(FRAME_QUEUE);
    const closed = yield* Deferred.make<void>();
    const markClosed = () => Deferred.doneUnsafe(closed, Effect.void);
    const close = (code: number) => {
      ws.close(code);
      markClosed();
    };
    if (ws.readyState === WebSocket.CLOSED) markClosed();
    else ws.once("close", markClosed);
    ws.on("message", (data, binary) => {
      if (!binary || !Buffer.isBuffer(data)) return close(1003);
      if (!Queue.offerUnsafe(frames, data)) close(CHANNEL_CLOSE.overloaded);
    });
    const send = (bytes: Uint8Array) =>
      Effect.callback<void, MobileSocketError>((resume) => {
        if (ws.readyState !== WebSocket.OPEN) {
          resume(Effect.fail(new MobileSocketError({ reason: "closed" })));
          return;
        }
        if (ws.bufferedAmount + bytes.byteLength > WRITE_BUDGET) {
          ws.terminate();
          resume(Effect.fail(new MobileSocketError({ reason: "send" })));
          return;
        }
        ws.send(bytes, { binary: true }, (error) =>
          resume(error ? Effect.fail(new MobileSocketError({ reason: "send" })) : Effect.void),
        );
      });
    ws.resume();
    return { take: Queue.take(frames), closed: Deferred.await(closed), send, close };
  });
  return { port: bound, accept };
});
