import { createServer as createHttpServer } from "node:http";
import { connect, createServer as createTcpServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import { WebSocketServer } from "ws";
import { makeDictationNetwork, parseDictationProxyRoute } from "./DictationNetwork";
import { openDictationWebSocket } from "../node/DictationWebSocket";
import type { DictationStreamTransportEvent } from "../../../shared/dictation-stream-transport";

vi.mock("electron", () => ({ app: {}, session: {} }));

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeOrigin = Effect.fn("makeOrigin")(function* () {
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
  if (!address || typeof address === "string") throw new Error("Missing origin port");
  return { server, port: address.port };
});

const closeServer = (
  server: ReturnType<typeof createHttpServer> | ReturnType<typeof createTcpServer>,
) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

const connected = Effect.fn("connected")(function* (
  agent: ReturnType<typeof makeDictationNetwork>,
  url: string,
  onEvent: (event: DictationStreamTransportEvent) => void = () => {},
) {
  const opened = yield* Deferred.make<void>();
  const route = yield* agent.prepare(url);
  const connection = yield* openDictationWebSocket({
    url,
    headers: { Authorization: "Bearer private-token" },
    signal: yield* Effect.abortSignal,
    agent: route.agent,
    onEvent: (event) => {
      onEvent(event);
      if (event.type === "open") Deferred.doneUnsafe(opened, Effect.void);
    },
  });
  yield* Deferred.await(opened);
  return { connection, route };
});

it("honors the first PAC route and preserves SOCKS DNS semantics", () => {
  expect(parseDictationProxyRoute("DIRECT; PROXY unused:7897")).toEqual({ proxyMode: "direct" });
  for (const [pac, mode, protocol] of [
    ["PROXY 127.0.0.1:7897; DIRECT", "http", "http:"],
    ["HTTPS proxy.test:443", "https", "https:"],
    ["SOCKS localhost:1080", "socks", "socks4:"],
    ["SOCKS4 [::1]:1080", "socks", "socks4:"],
    ["SOCKS5 proxy.test:1080", "socks", "socks5h:"],
  ] as const) {
    const route = parseDictationProxyRoute(pac);
    expect(route.proxyMode).toBe(mode);
    if (route.proxyMode === "direct") throw new Error("Expected a proxy");
    expect(route.url.protocol).toBe(protocol);
  }
  for (const invalid of [
    "",
    "QUIC proxy.test:443; DIRECT",
    "PROXY proxy.test",
    "PROXY user:secret@proxy.test:80",
    "PROXY proxy.test:0",
    "PROXY proxy.test:65536",
    "PROXY proxy.test:80/path",
    "PROXY :7897",
  ]) {
    expect(() => parseDictationProxyRoute(invalid)).toThrow();
  }
});

it.effect("resolves the routed WSS destination and keeps proxy failures credential-free", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const network = makeDictationNetwork({
      acceptLanguage: "zh-SG",
      resolveProxy: (url) => {
        urls.push(url);
        return Promise.resolve("DIRECT");
      },
    });
    const url = "wss://workspace.example.test/dictation/stream?dictation_surface=global";
    expect(yield* network.prepare(url)).toEqual({ proxyMode: "direct" });
    expect(urls).toEqual([url]);
    expect(network.acceptLanguage).toBe("zh-SG");
    const failing = makeDictationNetwork({
      acceptLanguage: undefined,
      resolveProxy: () => Promise.reject(new Error("private-token")),
    });
    const error = yield* failing.prepare(url).pipe(Effect.flip);
    expect(error.operation).toBe("resolve-proxy");
    expect(encodeJson(error)).not.toContain("private-token");
  }).pipe(Effect.scoped),
);

it.effect("tunnels native WebSocket upgrades through the resolved HTTP proxy", () =>
  Effect.gen(function* () {
    const origin = yield* makeOrigin();
    const requests: { destination: string | undefined; authorization: string | undefined }[] = [];
    const sockets = new Set<Duplex>();
    const proxy = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createHttpServer>>((resume) => {
        const server = createHttpServer();
        server.on("connect", (request, socket, head) => {
          requests.push({ destination: request.url, authorization: request.headers.authorization });
          sockets.add(socket);
          const upstream = connect(origin.port, "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream);
            upstream.pipe(socket);
          });
          sockets.add(upstream);
          socket.on("error", () => {});
          upstream.on("error", () => {});
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.gen(function* () {
          for (const socket of sockets) socket.destroy();
          yield* closeServer(server);
        }),
    );
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    const network = makeDictationNetwork({
      acceptLanguage: undefined,
      resolveProxy: () => Promise.resolve(`PROXY 127.0.0.1:${address.port}; DIRECT`),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const { connection, route } = yield* connected(network, `ws://127.0.0.1:${origin.port}`);
        expect(route.proxyMode).toBe("http");
        yield* connection.send('{"type":"session.start"}');
      }),
    );
    expect(requests).toEqual([
      {
        destination: `127.0.0.1:${origin.port}`,
        authorization: undefined,
      },
    ]);
  }).pipe(Effect.scoped),
);

it.effect("SOCKS5 keeps destination hostname resolution at the proxy", () =>
  Effect.gen(function* () {
    const origin = yield* makeOrigin();
    const sockets = new Set<Socket>();
    const destinations: string[] = [];
    const proxy = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createTcpServer>>((resume) => {
        const server = createTcpServer((socket) => {
          sockets.add(socket);
          let greeted = false;
          let buffer = Buffer.alloc(0);
          const read = (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);
            if (!greeted) {
              if (buffer.length < 2 || buffer.length < 2 + buffer[1]!) return;
              buffer = buffer.subarray(2 + buffer[1]!);
              greeted = true;
              socket.write(Buffer.from([5, 0]));
            }
            if (buffer.length < 5 || buffer.length < 7 + buffer[4]!) return;
            expect(buffer.subarray(0, 4)).toEqual(Buffer.from([5, 1, 0, 3]));
            destinations.push(buffer.subarray(5, 5 + buffer[4]!).toString("utf8"));
            expect(buffer.readUInt16BE(5 + buffer[4]!)).toBe(origin.port);
            socket.off("data", read);
            const pending = buffer.subarray(7 + buffer[4]!);
            const upstream = connect(origin.port, "127.0.0.1", () => {
              socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
              if (pending.length) upstream.write(pending);
              socket.pipe(upstream);
              upstream.pipe(socket);
            });
            sockets.add(upstream);
            upstream.on("error", () => {});
          };
          socket.on("data", read);
          socket.on("error", () => {});
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.gen(function* () {
          for (const socket of sockets) socket.destroy();
          yield* closeServer(server);
        }),
    );
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    const network = makeDictationNetwork({
      acceptLanguage: undefined,
      resolveProxy: () => Promise.resolve(`SOCKS5 127.0.0.1:${address.port}`),
    });
    const { route } = yield* connected(network, `ws://socket-origin.example.test:${origin.port}`);
    expect(route.proxyMode).toBe("socks");
    expect(destinations).toEqual(["socket-origin.example.test"]);
  }).pipe(Effect.scoped),
);

it.effect("Scope release aborts a stalled HTTP CONNECT before the Agent owns the socket", () =>
  Effect.gen(function* () {
    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<void>();
    const proxy = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createHttpServer>>((resume) => {
        const server = createHttpServer();
        server.on("connect", (_request, socket) => {
          Deferred.doneUnsafe(connected, Effect.void);
          socket.on("end", () => socket.end());
          socket.on("close", () => Deferred.doneUnsafe(disconnected, Effect.void));
          socket.on("error", () => {});
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      closeServer,
    );
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing proxy port");
    const scope = yield* Scope.make();
    const events: DictationStreamTransportEvent[] = [];
    const network = makeDictationNetwork({
      acceptLanguage: undefined,
      resolveProxy: () => Promise.resolve(`PROXY 127.0.0.1:${address.port}`),
    });
    yield* Effect.gen(function* () {
      const route = yield* network.prepare("wss://workspace.example.test/dictation/stream");
      yield* openDictationWebSocket({
        url: "wss://workspace.example.test/dictation/stream",
        headers: {},
        signal: yield* Effect.abortSignal,
        agent: route.agent,
        onEvent: (event) => events.push(event),
      });
    }).pipe(Scope.provide(scope));
    yield* Deferred.await(connected);
    yield* Scope.close(scope, Exit.void);
    yield* Deferred.await(disconnected);
    expect(events).toEqual([]);
  }).pipe(Effect.scoped),
);
