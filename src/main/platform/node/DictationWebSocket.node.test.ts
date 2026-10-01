import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { WebSocketServer } from "ws";
import { openDictationWebSocket } from "./DictationWebSocket";
import {
  DICTATION_STREAM_MAX_MESSAGE_LENGTH,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const makeExternalAuth = () => new AbortController();

const makeEvents = () => {
  const events: DictationStreamTransportEvent[] = [];
  const waiters = new Set<(event: DictationStreamTransportEvent) => void>();
  return {
    events,
    onEvent: (event: DictationStreamTransportEvent) => {
      events.push(event);
      for (const waiter of waiters) waiter(event);
    },
    wait: <T extends DictationStreamTransportEvent["type"]>(type: T) =>
      Effect.callback<Extract<DictationStreamTransportEvent, { type: T }>>((resume) => {
        const accept = (event: DictationStreamTransportEvent) => {
          if (event.type !== type) return;
          resume(Effect.succeed(event as Extract<DictationStreamTransportEvent, { type: T }>));
        };
        const received = events.find((event) => event.type === type);
        if (received) {
          accept(received);
          return;
        }
        waiters.add(accept);
        return Effect.sync(() => waiters.delete(accept));
      }),
  };
};

const makeWebSocketServer = Effect.fn("makeWebSocketServer")(function* () {
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocketServer({ port: 0 })),
    (server) =>
      Effect.callback<void>((resume) => {
        for (const peer of server.clients) peer.terminate();
        server.close(() => resume(Effect.void));
      }),
  );
  yield* Effect.callback<void>((resume) => {
    server.once("listening", () => resume(Effect.void));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return {
    server,
    url: `ws://127.0.0.1:${address.port}/dictation/stream?dictation_surface=global`,
  };
});

const makeHttpServer = Effect.fn("makeHttpServer")(function* (
  handle: (request: IncomingMessage, response: ServerResponse) => void,
) {
  const server = yield* Effect.acquireRelease(
    Effect.callback<ReturnType<typeof createServer>>((resume) => {
      const server = createServer(handle);
      server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return { server, url: `ws://127.0.0.1:${address.port}/dictation/stream` };
});

it.effect("sends desktop authentication in headers and owns the native socket with its Scope", () =>
  Effect.gen(function* () {
    const { server, url } = yield* makeWebSocketServer();
    const request = yield* Deferred.make<IncomingMessage>();
    const peerClosed = yield* Deferred.make<number>();
    let received = "";
    server.on("connection", (peer, incoming) => {
      Deferred.doneUnsafe(request, Effect.succeed(incoming));
      peer.on("message", (data, binary) => {
        expect(binary).toBe(false);
        received = data.toString();
        peer.send('{"type":"session.started"}');
      });
      peer.on("close", (code) => Deferred.doneUnsafe(peerClosed, Effect.succeed(code)));
    });
    const events = makeEvents();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* openDictationWebSocket({
          url,
          headers: {
            Authorization: "Bearer private-token",
            "ChatGPT-Account-Id": "private-account",
            originator: "Codex Desktop",
            "User-Agent": "Codex Desktop/1 (Mac OS; arm64)",
            "Accept-Language": "en-SG",
          },
          signal: yield* Effect.abortSignal,
          onEvent: events.onEvent,
        });
        expect(yield* events.wait("open")).toEqual({ type: "open", protocol: "chatgpt-dictation" });
        const incoming = yield* Deferred.await(request);
        expect(incoming.url).toBe("/dictation/stream?dictation_surface=global");
        expect(incoming.headers.authorization).toBe("Bearer private-token");
        expect(incoming.headers["chatgpt-account-id"]).toBe("private-account");
        expect(incoming.headers.originator).toBe("Codex Desktop");
        expect(incoming.headers["user-agent"]).toBe("Codex Desktop/1 (Mac OS; arm64)");
        expect(incoming.headers["accept-language"]).toBe("en-SG");
        expect(incoming.headers["sec-websocket-protocol"]).toBe("chatgpt-dictation,codex-desktop");
        expect(incoming.headers["sec-websocket-extensions"]).toBe(
          "permessage-deflate; client_max_window_bits",
        );
        expect(incoming.headers.origin).toBeUndefined();
        expect(incoming.headers.cookie).toBeUndefined();
        yield* connection.send('{"type":"session.start"}');
        expect(yield* events.wait("message")).toEqual({
          type: "message",
          data: '{"type":"session.started"}',
        });
        expect(received).toBe('{"type":"session.start"}');
        expect(
          yield* connection
            .send("x".repeat(DICTATION_STREAM_MAX_MESSAGE_LENGTH + 1))
            .pipe(Effect.flip),
        ).toMatchObject({ failureCode: "send-failed" });
        const multibyte = "界".repeat(Math.floor(DICTATION_STREAM_MAX_MESSAGE_LENGTH / 3) + 1);
        expect(multibyte.length).toBeLessThan(DICTATION_STREAM_MAX_MESSAGE_LENGTH);
        expect(Buffer.byteLength(multibyte, "utf8")).toBeGreaterThan(
          DICTATION_STREAM_MAX_MESSAGE_LENGTH,
        );
        expect(yield* connection.send(multibyte).pipe(Effect.flip)).toMatchObject({
          failureCode: "send-failed",
        });
        expect(received).toBe('{"type":"session.start"}');
      }),
    );
    expect(yield* Deferred.await(peerClosed)).toBe(1006);
    expect(events.events.filter((event) => event.type === "close")).toHaveLength(0);
    expect(encodeJson(events.events)).not.toContain("private-token");
    expect(encodeJson(events.events)).not.toContain("private-account");
  }).pipe(Effect.scoped),
);

it.effect(
  "distinguishes HTTP rejection, edge challenge and redirect without leaking response data",
  () =>
    Effect.gen(function* () {
      let redirected = 0;
      const destination = yield* makeHttpServer((_request, response) => {
        redirected += 1;
        response.end();
      });
      for (const fixture of [
        { status: 403, headers: { "cf-mitigated": "challenge" }, failureCode: "edge-challenge" },
        { status: 401, headers: {}, failureCode: "http-rejected" },
        { status: 302, headers: { location: destination.url }, failureCode: "http-rejected" },
      ]) {
        const { url } = yield* makeHttpServer((_request, response) => {
          response.writeHead(fixture.status, fixture.headers);
          response.end("private-response-token");
        });
        const events = makeEvents();
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* openDictationWebSocket({
              url,
              headers: { Authorization: "Bearer private-request-token" },
              signal: yield* Effect.abortSignal,
              onEvent: events.onEvent,
            });
            const error = yield* events.wait("error");
            expect(error.failureCode).toBe(fixture.failureCode);
            expect(error.httpStatus).toBe(fixture.status);
            expect(error.edgeChallenge).toBe(fixture.status === 403 ? "cloudflare" : undefined);
            expect(yield* events.wait("close")).toEqual({ type: "close", code: 1006 });
            expect(events.events.filter((event) => event.type === "error")).toHaveLength(1);
            expect(encodeJson(events.events)).not.toContain("private-");
          }),
        );
      }
      expect(redirected).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("revokes authentication with one synthetic close and no later socket events", () =>
  Effect.gen(function* () {
    const { server, url } = yield* makeWebSocketServer();
    const peerClosed = yield* Deferred.make<void>();
    server.on("connection", (peer) => {
      peer.on("close", () => Deferred.doneUnsafe(peerClosed, Effect.void));
    });
    const controller = makeExternalAuth();
    const events = makeEvents();
    const connection = yield* openDictationWebSocket({
      url,
      headers: {},
      signal: controller.signal,
      onEvent: events.onEvent,
    });
    yield* events.wait("open");
    controller.abort();
    expect(yield* events.wait("error")).toEqual({ type: "error", failureCode: "aborted" });
    expect(yield* events.wait("close")).toEqual({ type: "close", code: 1006 });
    yield* Deferred.await(peerClosed);
    expect(events.events.map((event) => event.type)).toEqual(["open", "error", "close"]);
    expect(yield* connection.send("late").pipe(Effect.flip)).toMatchObject({
      failureCode: "send-failed",
    });
  }).pipe(Effect.scoped),
);

it.effect("rejects binary frames with close 1003", () =>
  Effect.gen(function* () {
    const { server, url } = yield* makeWebSocketServer();
    const peerClosed = yield* Deferred.make<number>();
    server.on("connection", (peer) => {
      peer.on("close", (code) => Deferred.doneUnsafe(peerClosed, Effect.succeed(code)));
      peer.send(Buffer.from([1, 2, 3]));
    });
    const events = makeEvents();
    yield* openDictationWebSocket({
      url,
      headers: {},
      signal: yield* Effect.abortSignal,
      onEvent: events.onEvent,
    });
    expect(yield* events.wait("close")).toEqual({ type: "close", code: 1003 });
    expect(yield* Deferred.await(peerClosed)).toBe(1003);
    expect(events.events.some((event) => event.type === "message")).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("rejects inbound messages beyond the desktop transport limit", () =>
  Effect.gen(function* () {
    const { server, url } = yield* makeWebSocketServer();
    const peerClosed = yield* Deferred.make<number>();
    server.on("connection", (peer) => {
      peer.on("close", (code) => Deferred.doneUnsafe(peerClosed, Effect.succeed(code)));
      peer.send("x".repeat(DICTATION_STREAM_MAX_MESSAGE_LENGTH + 1));
    });
    const events = makeEvents();
    yield* openDictationWebSocket({
      url,
      headers: {},
      signal: yield* Effect.abortSignal,
      onEvent: events.onEvent,
    });
    expect(yield* events.wait("error")).toEqual({
      type: "error",
      failureCode: "websocket-failed",
      networkError: "other",
    });
    expect(yield* Deferred.await(peerClosed)).toBe(1009);
    expect(yield* events.wait("close")).toEqual({ type: "close", code: 1006 });
    expect(events.events.some((event) => event.type === "message")).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("closing the connection Scope cancels a stalled upgrade", () =>
  Effect.gen(function* () {
    const { server, url } = yield* makeHttpServer(() => {});
    const requested = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<void>();
    server.on("upgrade", (_request, socket) => {
      Deferred.doneUnsafe(requested, Effect.void);
      socket.on("close", () => Deferred.doneUnsafe(disconnected, Effect.void));
      socket.on("end", () => socket.end());
    });
    const scope = yield* Scope.make();
    const events = makeEvents();
    yield* openDictationWebSocket({
      url,
      headers: {},
      signal: yield* Effect.abortSignal,
      onEvent: events.onEvent,
    }).pipe(Scope.provide(scope));
    yield* Deferred.await(requested);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(disconnected);
    expect(events.events).toEqual([]);
  }).pipe(Effect.scoped),
);
