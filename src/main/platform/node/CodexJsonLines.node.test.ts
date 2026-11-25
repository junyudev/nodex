import { describe, expect, test, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { it, assert } from "@effect/vitest";
import { codexIncomingLines, makeCodexIncomingMessages } from "./CodexIncomingMessages";
import * as Schema from "effect/Schema";
import type {
  CodexAppServerReceiveTiming,
  CodexAppServerRequestMetrics,
} from "@nodex/effect-codex-app-server/protocol";
import {
  CodexChunkedArray,
  CodexJsonLineReader,
  materializeCodexJson,
} from "./CodexJsonLineReader";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import { make as makeClient } from "@nodex/effect-codex-app-server/client";
import {
  getCodexHostSourceLineBytes,
  type CodexHostMessagePart,
} from "../../../shared/codex-host-chunked-message";
import { CodexHostChunkedMessageSender } from "../../host-runtime/CodexHostChunkedMessageSender";
import { codexJsonLineMessages, codexJsonLineTransport } from "./CodexJsonLineStream";
import {
  HostShellEnvironment,
  inheritedHostShellEnvironment,
} from "../../host-runtime/HostShellEnvironment";
import { CodexSessionTransport, nodeLive } from "./CodexSessionTransport";
import { ASYNC_WAIT_TIMEOUT_MS } from "../../../../config/test-timeouts";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SubscriptionRef from "effect/SubscriptionRef";
import WebSocket from "ws";
import { WebSocketServer } from "ws";
import { openCodexLocalDaemon, canUseCodexLocalDaemon } from "./CodexLocalDaemon";
import { live as sessionLive } from "../../codex-runtime/CodexAppServerSession";
import { CodexEndpoint, live as endpointLive } from "../../codex-runtime/CodexEndpoint";
import { live as eventHubLive } from "../../codex-runtime/CodexEventHub";
import { live as schedulerLive } from "../../codex-runtime/CodexRequestScheduler";
import {
  CodexApplicationRequestInbox,
  make as makeInbox,
} from "../../codex-runtime/CodexApplicationRequestInbox";
import {
  isSupportedCodexAppServerVersion,
  parseCodexCliVersion,
} from "../../../shared/codex-app-server-version";
import { once, EventEmitter } from "node:events";
import { openCodexWebSocket } from "./CodexWebSocketTransport";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import {
  codexRemoteLoginCommand,
  codexSshConnectionArguments,
  createCodexSshProxy,
} from "./CodexSshProxy";
import { codexSshProxyDependency } from "./CodexSshProxyDependency";
import { codexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { makeCodexSshSessionRuntime, type CodexSshSessionConfig } from "./CodexSshSession";
import { Socket } from "node:net";
import { it as itCodexPeerMetrics } from "vitest";
import type { CodexPeerMessage } from "../../../shared/codex-peer-protocol";
import {
  createCodexPeerFrameReader,
  encodeCodexPeerFrame,
  encodeCodexPeerJson,
} from "./CodexPeerFraming";
import { CodexPeerMetrics, codexPeerMetrics, writeCodexPeerFrame } from "./CodexPeerMetrics";

describe("CodexJsonLines", () => {
  describe("CodexIncomingMessages", () => {
    test("frame decoding respects view offsets, CRLF and blank lines", () => {
      const bytes = Buffer.from('skip{"id":1}\r\n \n{"id":2}tail');
      expect(codexIncomingLines(bytes.subarray(4, -4))).toEqual(['{"id":1}', '{"id":2}']);
      expect(codexIncomingLines(new TextEncoder().encode('{"id":3}').buffer)).toEqual(['{"id":3}']);
      expect(codexIncomingLines([bytes])).toEqual([]);
      expect(codexIncomingLines(null)).toEqual([]);
    });

    it.effect(
      "malformed and partial frames cannot consume later responses or alter receipt time",
      () =>
        Effect.gen(function* () {
          const input = yield* makeCodexIncomingMessages();
          input.offerData('{"id":1,', 10);
          input.offerData('"result":false}\n{bad}\n  {"id":2,"result":"中文"} \n', 20);
          const messages = yield* input.messages.pipe(Stream.take(1), Stream.runCollect);
          expect(messages).toEqual([
            {
              value: { id: 2, result: "中文" },
              bytes: Buffer.byteLength('{"id":2,"result":"中文"}'),
              receivedAtMs: 20,
            },
          ]);
          expect(input.depth()).toBe(0);
        }),
    );

    it.effect("a 19999-line batch is admitted but a 20000-line batch overflows inclusively", () =>
      Effect.gen(function* () {
        const input = yield* makeCodexIncomingMessages();
        input.offerData('{"id":1}\n'.repeat(19_999), 0);
        expect(input.depth()).toBe(19_999);
        input.offerData('{"id":2}', 0);
        const result = yield* input.messages.pipe(Stream.runCollect, Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
        if (Exit.isFailure(result))
          expect(Cause.pretty(result.cause)).toContain("Incoming line queue overflow");
        expect(input.depth()).toBe(0);
      }),
    );

    it.effect(
      "draining yields after 200 lines without moving the queue depth ahead of dispatch",
      () =>
        Effect.gen(function* () {
          const input = yield* makeCodexIncomingMessages();
          input.offerData(
            Array.from({ length: 450 }, (_, id) => JSON.stringify({ id })).join("\n"),
            0,
          );
          let count = 0;
          let countAtYield = 0;
          const messages = yield* input.messages.pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                count += 1;
                expect(input.depth()).toBe(450 - count);
                if (count === 1)
                  setImmediate(() => {
                    countAtYield = count;
                  });
              }),
            ),
            Stream.take(450),
            Stream.runCollect,
          );
          expect(messages.map(({ value }) => value)).toEqual(
            Array.from({ length: 450 }, (_, id) => ({ id })),
          );
          expect(countAtYield).toBeGreaterThan(0);
          expect(countAtYield).toBeLessThanOrEqual(200);
        }),
    );

    it.effect(
      "the elapsed-time budget yields before the count limit and close flushes pending lines",
      () =>
        Effect.gen(function* () {
          const input = yield* makeCodexIncomingMessages();
          input.offerData('{"id":1}\n{"id":2}\n{"id":3}', 10);
          let yielded = false;
          const messages = yield* input.messages.pipe(
            Stream.tap(({ value }) =>
              Effect.gen(function* () {
                const id = (value as { id: number }).id;
                if (id === 1) {
                  setImmediate(() => {
                    yielded = true;
                  });
                  yield* TestClock.adjust(8);
                }
                if (id === 2) {
                  expect(yielded).toBe(true);
                  input.end();
                }
              }),
            ),
            Stream.runCollect,
          );
          expect(messages.map(({ value }) => value)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
        }),
    );

    it.effect("retiring the queue wakes a pending consumer and rejects later input", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const input = yield* makeCodexIncomingMessages().pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const reader = yield* input.messages.pipe(Stream.runCollect, Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* Scope.close(scope, Exit.void);
        input.offerData('{"id":1}', 1);
        expect(yield* Fiber.join(reader)).toEqual([]);
        expect(input.depth()).toBe(0);
      }),
    );
  });

  describe("CodexJsonLineReader", () => {
    const read = (chunks: readonly Buffer[], threshold = 32, chunkBytes = 80) =>
      Effect.callback<
        { values: { message: Record<string, unknown>; bytes: number }[]; errors: string[] },
        Error
      >((resume) => {
        const values: { message: Record<string, unknown>; bytes: number }[] = [];
        const errors: string[] = [];
        const reader = new CodexJsonLineReader({
          maxBufferedLineBytes: threshold,
          arrayChunkBytes: chunkBytes,
          onMessage: (message, bytes) => values.push({ message, bytes }),
          onParseError: (error) => errors.push(error.message),
        });
        reader.once("error", (error: Error) => resume(Effect.fail(error)));
        reader.once("finish", () => resume(Effect.succeed({ values, errors })));
        for (const chunk of chunks) reader.write(chunk);
        reader.end();
        return Effect.sync(() => {
          reader.destroy();
        });
      });

    it.effect(
      "live progress retains its identity through split UTF-8, delimiter receipt and final EOF",
      () =>
        Effect.gen(function* () {
          for (const threshold of [1, 1024]) {
            let now = 10;
            const delivered: { bytes: number; timing: CodexAppServerReceiveTiming }[] = [];
            const reader = yield* Effect.acquireRelease(
              Effect.sync(
                () =>
                  new CodexJsonLineReader({
                    maxBufferedLineBytes: threshold,
                    now: () => now,
                    onMessage: (_message, bytes, timing) => {
                      delivered.push({ bytes, timing });
                    },
                    onParseError: (error) => {
                      throw error;
                    },
                  }),
              ),
              (reader) =>
                Effect.sync(() => {
                  reader.destroy();
                }),
            );
            const write = (bytes: Buffer) =>
              Effect.callback<void, Error>((resume) => {
                reader.write(bytes, (error) => resume(error ? Effect.fail(error) : Effect.void));
              });
            const bytes = Buffer.from('{"id":1,"result":"中文"}\r\n');
            const splitAt = bytes.indexOf(Buffer.from("中")) + 1;
            yield* write(bytes.subarray(0, splitAt));
            const progress = reader.getCurrentLineProgress();
            expect(progress).toEqual({ startedAtMs: 10, bytesReceived: splitAt });
            now = 25;
            yield* write(bytes.subarray(splitAt, -1));
            expect(reader.getCurrentLineProgress()).toBe(progress);
            expect(progress?.bytesReceived).toBe(bytes.length - 1);
            now = 30;
            yield* write(bytes.subarray(-1));
            expect(progress).toEqual({
              startedAtMs: 10,
              bytesReceived: bytes.length,
              receivedAtMs: 30,
            });
            expect(reader.getCurrentLineProgress()).toBeNull();
            now = 40;
            const final = Buffer.from('{"id":2,"result":null}');
            yield* write(final);
            now = 50;
            yield* Effect.callback<void>((resume) => {
              reader.end(() => resume(Effect.void));
            });
            expect(delivered).toEqual([
              { bytes: bytes.length, timing: { receiveStartedAtMs: 10, receivedAtMs: 30 } },
              { bytes: final.length, timing: { receiveStartedAtMs: 40, receivedAtMs: 50 } },
            ]);
          }
        }),
    );

    it.effect("streams oversized arrays across UTF-8 chunk boundaries", () =>
      Effect.gen(function* () {
        const value = {
          id: "1",
          result: { items: Array.from({ length: 20 }, (_, i) => ({ text: `中文-${i}` })) },
        };
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(value);
        const bytes = Buffer.from(`${encoded}\n`);
        const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1));
        const result = yield* read(chunks);
        expect(result.errors).toEqual([]);
        expect(result.values[0]!.bytes).toBe(bytes.length);
        expect((result.values[0]!.message.result as { items: unknown }).items).toBeInstanceOf(
          CodexChunkedArray,
        );
        expect(materializeCodexJson(result.values[0]!.message)).toEqual(value);
      }),
    );

    it.effect("a malformed streamed line does not prevent the next complete object", () =>
      Effect.gen(function* () {
        const result = yield* read([
          Buffer.from(
            '{"padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",bad}\n{"id":2,"result":{}}\n',
          ),
        ]);
        expect(result.errors).toHaveLength(1);
        expect(result.values.map(({ message }) => materializeCodexJson(message))).toEqual([
          { id: 2, result: {} },
        ]);
      }),
    );

    it.effect(
      "rejects multiple values and array roots while accepting the final unterminated line",
      () =>
        Effect.gen(function* () {
          const result = yield* read([Buffer.from('{} {}\n[]\n{"id":3,"result":true}')], 1);
          expect(result.errors).toHaveLength(2);
          expect(result.values.map(({ message }) => materializeCodexJson(message))).toEqual([
            { id: 3, result: true },
          ]);
        }),
    );

    it.effect("both parsing paths preserve JSON own keys without inherited authority", () =>
      Effect.gen(function* () {
        const line =
          '{"__proto__":{"id":"forged"},"method":"notification","params":{' +
          '"__proto__":null,"constructor":{"prototype":{"isAdmin":true}},' +
          '"items":[{"__proto__":{"isAdmin":true}},{"__proto__":null}],' +
          '"duplicate":{"__proto__":{"isAdmin":true},"__proto__":null}}}\n';
        for (const threshold of [1, 1024]) {
          const result = yield* read(
            Array.from(Buffer.from(line), (byte) => Buffer.from([byte])),
            threshold,
            1,
          );
          expect(result.errors).toEqual([]);
          expect(result.values).toHaveLength(1);
          const message = result.values[0]!.message;
          const params = message.params as Record<string, unknown>;
          const items = params.items;
          const entries = items instanceof CodexChunkedArray ? items.chunks.flat() : items;
          expect(Array.isArray(entries)).toBe(true);
          expect(items instanceof CodexChunkedArray).toBe(threshold === 1);
          for (const object of [
            message,
            params,
            ...(entries as Record<string, unknown>[]),
            params.duplicate as Record<string, unknown>,
          ]) {
            expect(Object.getPrototypeOf(object)).toBe(Object.prototype);
            expect(Object.getOwnPropertyDescriptor(object, "__proto__")).toMatchObject({
              configurable: true,
              enumerable: true,
              writable: true,
            });
            expect(object.isAdmin).toBeUndefined();
          }
          expect(message.id).toBeUndefined();
          expect(params["__proto__"]).toBeNull();
          expect((params.duplicate as Record<string, unknown>)["__proto__"]).toBeNull();
          expect(materializeCodexJson(message)).toEqual(JSON.parse(line));
        }
      }),
    );

    it.effect("drains many buffered lines without recursive stack growth", () =>
      Effect.gen(function* () {
        const result = yield* read([Buffer.from('{"id":1}\n'.repeat(20_000))], 1000);
        expect(result.errors).toEqual([]);
        expect(result.values).toHaveLength(20_000);
      }),
    );
  });

  describe("CodexJsonLineStream", () => {
    const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

    it.effect(
      "physical response bytes select ACK-gated chunks even when the parsed result is small",
      () =>
        Effect.gen(function* () {
          const line = '{"id":1,"result":{"ok":true}' + " ".repeat(2048) + "}\n";
          const values = yield* codexJsonLineMessages(Stream.make(Buffer.from(line))).pipe(
            Stream.runCollect,
          );
          const response = values[0]!.value as { id: number; result: object };
          const target = {};
          const deliveries: { message: object; part: CodexHostMessagePart | null }[] = [];
          const sender = new CodexHostChunkedMessageSender<object, object>({
            batchTargetBytes: 1024,
            inlineThresholdBytes: 512,
            getPayload: (message) => message,
            deliver: (_target, message, part) => {
              deliveries.push({ message, part });
            },
            onSendError: (_target, error) => {
              throw error;
            },
          });
          yield* Effect.addFinalizer(() => Effect.sync(() => sender.dispose(target)));
          const first = { message: { id: response.id, result: response.result } };
          const queued = { message: { id: 2, result: true } };
          sender.send(target, first);
          sender.send(target, queued);
          expect(deliveries).toHaveLength(1);
          expect(deliveries[0]!.part?.kind).toBe("start");
          for (let step = 0; step < 10; step += 1) {
            const part = deliveries.at(-1)!.part;
            if (!part) break;
            sender.acknowledge(target, part.transferId, part.sequence);
          }
          expect(deliveries.at(-1)).toEqual({ message: queued, part: null });
          expect(deliveries.filter(({ part }) => part?.kind === "end")).toHaveLength(1);
          const ordinaryTarget = {};
          sender.send(ordinaryTarget, { message: { id: 3, result: { ok: true } } });
          expect(deliveries.at(-1)!.part).toBeNull();
        }),
    );

    it.effect(
      "request consumers receive physical overlap metrics without attributing later queued traffic",
      () =>
        Effect.gen(function* () {
          const firstRead = yield* Deferred.make<void>();
          const rest = yield* Deferred.make<Buffer>();
          const output = yield* Queue.unbounded<string>();
          const notification = Buffer.from(
            encodeJson({ method: "custom/bulk", params: { text: "x".repeat(256 * 1024) } }) + "\n",
          );
          const response = Buffer.from('{"id":"measured","result":{"ok":true}}\n');
          const later = Buffer.from(
            encodeJson({ method: "custom/later", params: { text: "x".repeat(1024 * 1024) } }) +
              "\n",
          );
          const transport = codexJsonLineTransport(
            Stream.concat(
              Stream.make(notification.subarray(0, 8192)),
              Stream.fromEffect(
                Deferred.succeed(firstRead, undefined).pipe(Effect.andThen(Deferred.await(rest))),
              ),
            ),
          );
          const client = yield* makeClient(
            Stdio.make({
              args: Effect.succeed([]),
              stdin: Stream.empty,
              stdout: () =>
                Sink.forEach((wire: string | Uint8Array) =>
                  Queue.offer(output, String(wire)).pipe(Effect.asVoid),
                ),
              stderr: () => Sink.drain,
            }),
            transport,
          );
          yield* Deferred.await(firstRead);
          yield* TestClock.adjust(10);
          const measured: CodexAppServerRequestMetrics[] = [];
          const pending = yield* client.raw
            .request(
              "custom/read",
              { text: "中文" },
              {
                requestId: "measured",
                onMetrics: (metrics) =>
                  Effect.sync(() => {
                    measured.push(metrics);
                  }),
              },
            )
            .pipe(Effect.forkScoped);
          const wire = yield* Queue.take(output);
          yield* TestClock.adjust(20);
          yield* Deferred.succeed(
            rest,
            Buffer.concat([notification.subarray(8192), response, later]),
          );
          expect(yield* Fiber.join(pending)).toEqual({ ok: true });
          expect(measured).toHaveLength(1);
          expect(measured[0]).toMatchObject({
            transportKind: "stdio",
            requestBytes: Buffer.byteLength(wire) - 1,
            responseBytes: response.length,
            hostRoundTripDurationMs: 20,
            largeInboundCompletedMessageBytesWhilePending: notification.length,
            largeInboundMessageThresholdBytesWhilePending: 256 * 1024,
            largeInboundMessageOverlapMs: 20,
            largeInboundBytesReceivedWhilePending: notification.length - 8192,
          });
          expect(transport.receiveMetrics.snapshot().counts).toEqual([2, 2, 1]);
        }),
    );

    it.effect("decoded line stream drains complete objects after malformed input", () =>
      Effect.gen(function* () {
        const input = Stream.make(
          Buffer.from('{"broken":}\n{"id":1,"result":{"ok":true}}\n{"id":2,"result":null}'),
        );
        const values = yield* codexJsonLineMessages(input).pipe(Stream.runCollect);
        expect(values.map(({ value }) => value)).toEqual([
          { id: 1, result: { ok: true } },
          { id: 2, result: null },
        ]);
      }),
    );

    it.effect("a long native response burst yields the event loop without losing its order", () =>
      Effect.gen(function* () {
        const input = Stream.make(
          Buffer.from(
            Array.from({ length: 450 }, (_, id) => JSON.stringify({ id, result: id })).join("\n") +
              "\n",
          ),
        );
        let seen = 0;
        let observed = 0;
        const values = yield* codexJsonLineMessages(input).pipe(
          Stream.tap(() =>
            Effect.sync(() => {
              seen += 1;
              if (seen === 1)
                setImmediate(() => {
                  observed = seen;
                });
            }),
          ),
          Stream.runCollect,
        );
        expect(values.map(({ value }) => (value as { id: number }).id)).toEqual(
          Array.from({ length: 450 }, (_, id) => id),
        );
        expect(observed).toBeGreaterThan(0);
        expect(observed).toBeLessThanOrEqual(200);
      }),
    );

    it.effect(
      "retains physical line bytes on the decoded envelope and result or params object",
      () =>
        Effect.gen(function* () {
          const responseLine = '{"id":1,"result":{"value":"ok"}}\n';
          const notificationLine = '{"method":"turn/updated","params":{"threadId":"t"}}\n';
          const values = yield* codexJsonLineMessages(
            Stream.make(Buffer.from(responseLine + notificationLine)),
          ).pipe(Stream.runCollect);

          const response = values[0]!.value as { result: object };
          const notification = values[1]!.value as { params: object };
          expect(getCodexHostSourceLineBytes(response)).toBe(Buffer.byteLength(responseLine));
          expect(getCodexHostSourceLineBytes(response.result)).toBe(
            Buffer.byteLength(responseLine),
          );
          expect(getCodexHostSourceLineBytes(notification)).toBe(
            Buffer.byteLength(notificationLine),
          );
          expect(getCodexHostSourceLineBytes(notification.params)).toBe(
            Buffer.byteLength(notificationLine),
          );
        }),
    );
  });
});

describe("CodexSessionTransport", () => {
  describe("CodexSessionTransport", () => {
    it.effect(
      "configured local daemon reports stdio when the physical opener falls back to a child",
      () =>
        Effect.gen(function* () {
          const transport = yield* CodexSessionTransport;
          const handle = yield* transport.open({
            hostId: "local",
            generation: 1,
            command: process.execPath,
            args: ["configured-argument"],
            env: { ELECTRON_RUN_AS_NODE: "1" },
            resolveLaunch: (pending) =>
              Effect.succeed({
                ...pending,
                args: [
                  "-e",
                  `
        require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({ id: request.id, result: { selected: "stdio", argument: process.argv[1], marker: process.env.NODEX_FIXTURE } }) + "\\n");
        });
      `,
                  ...pending.args,
                ],
                env: { ...pending.env, NODEX_FIXTURE: "resolved" },
              }),
            localDaemon: { codexHome: "/unused", platform: "darwin", configOverrides: [] },
            forceTermination: "1 second",
          });
          assert.strictEqual(handle.transportKind, "stdio");
          assert.isAbove(handle.pid, 0);
          assert.deepEqual(yield* handle.client.raw.request("test/transport", {}), {
            selected: "stdio",
            argument: "configured-argument",
            marker: "resolved",
          });
        }).pipe(
          Effect.provide(nodeLive),
          Effect.provideService(HostShellEnvironment, inheritedHostShellEnvironment({})),
        ),
    );
  });

  describe("CodexLocalDaemon", () => {
    // The local daemon publishes a Unix socket; Windows uses the stdio session transport.
    it.live.skipIf(process.platform === "win32")(
      "a physical Unix WebSocket reconnect rejects old requests and reinitializes the stable Endpoint",
      () =>
        Effect.gen(function* () {
          const home = yield* Effect.acquireRelease(
            Effect.sync(() => mkdtempSync("/tmp/nodex-daemon-")),
            (home) => Effect.sync(() => rmSync(home, { recursive: true, force: true })),
          );
          mkdirSync(join(home, "app-server-control"));
          const command = join(home, "codex");
          writeFileSync(
            command,
            "#!/bin/sh\nprintf '%s\\n' '{\"appServerVersion\":\"0.153.4\"}'\n",
            {
              mode: 0o755,
            },
          );
          const server = yield* Effect.acquireRelease(
            Effect.sync(() => createServer()),
            (server) =>
              Effect.callback<void>((resume) => {
                server.close(() => resume(Effect.void));
              }),
          );
          const peers = yield* Effect.acquireRelease(
            Effect.sync(() => new WebSocketServer({ server })),
            (peers) =>
              Effect.sync(() => {
                for (const peer of peers.clients) peer.terminate();
                peers.close();
              }),
          );
          let connections = 0;
          const methods: string[] = [];
          const pendingObserved = yield* Deferred.make<void>();
          peers.on("connection", (peer) => {
            const generation = ++connections;
            peer.on("message", (data) => {
              const request = JSON.parse(String(data)) as { id?: string; method: string };
              methods.push(request.method);
              if (request.method === "test/pending") {
                Deferred.doneUnsafe(pendingObserved, Effect.void);
                return;
              }
              if (request.id === undefined) return;
              const result =
                request.method === "initialize"
                  ? {
                      codexHome: home,
                      platformFamily: "unix",
                      platformOs: "macos",
                      userAgent: "physical-daemon",
                    }
                  : { connected: true, generation };
              peer.send(JSON.stringify({ id: request.id, result }));
            });
          });
          yield* Effect.callback<void>((resume) => {
            server.once("error", (error) => resume(Effect.die(error)));
            server.listen(join(home, "app-server-control", "app-server-control.sock"), () =>
              resume(Effect.void),
            );
          });
          const endpointScope = yield* Scope.make();
          yield* Effect.addFinalizer(() => Scope.close(endpointScope, Exit.void));
          const context = yield* Layer.buildWithScope(
            endpointLive({
              hostId: "local",
              retryBase: "5 millis",
              retryCap: "5 millis",
              jitter: false,
              sessionLayer: (generation) =>
                sessionLive({
                  hostId: "local",
                  generation,
                  command,
                  args: ["app-server"],
                  localDaemon: { codexHome: home, platform: "darwin", configOverrides: [] },
                  env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
                  forceTermination: "1 second",
                  initializeTimeout: "5 seconds",
                  expectedCodexHome: home,
                  initializeParams: {
                    clientInfo: { name: "nodex", title: "Nodex", version: "test" },
                    capabilities: { experimentalApi: true },
                  },
                }),
            }).pipe(
              Layer.provideMerge(
                Layer.mergeAll(
                  nodeLive.pipe(
                    Layer.provide(
                      Layer.succeed(HostShellEnvironment, inheritedHostShellEnvironment({})),
                    ),
                  ),
                  eventHubLive,
                  schedulerLive,
                  Layer.effect(CodexApplicationRequestInbox, makeInbox),
                ),
              ),
            ),
            endpointScope,
          );
          const endpoint = Context.get(context, CodexEndpoint);
          const first = yield* endpoint.session.pipe(Effect.timeout(ASYNC_WAIT_TIMEOUT_MS));
          expect(first.transportKind).toBe("websocket");
          expect(yield* first.client.raw.request("test/native", {})).toEqual({
            connected: true,
            generation: 1,
          });
          const source = (yield* SubscriptionRef.get(endpoint.state)).source;
          const pending = yield* first.client.raw
            .request("test/pending", {})
            .pipe(Effect.exit, Effect.forkScoped);
          yield* Deferred.await(pendingObserved).pipe(Effect.timeout(ASYNC_WAIT_TIMEOUT_MS));
          yield* Effect.sync(() => {
            for (const peer of peers.clients) peer.terminate();
          });
          expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
          yield* SubscriptionRef.changes(endpoint.state).pipe(
            Stream.filter((state) => state.kind === "ready" && state.generation > first.generation),
            Stream.runHead,
            Effect.timeout(ASYNC_WAIT_TIMEOUT_MS),
          );
          const second = yield* endpoint.session;
          expect(second.generation).toBe(first.generation + 1);
          expect(second.transportKind).toBe("websocket");
          expect((yield* SubscriptionRef.get(endpoint.state)).source).toEqual(source);
          expect(yield* second.client.raw.request("test/native", {})).toEqual({
            connected: true,
            generation: 2,
          });
          expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
          expect(methods.filter((method) => method === "initialized")).toHaveLength(2);
          yield* Scope.close(endpointScope, Exit.void);
          expect((yield* SubscriptionRef.get(endpoint.state)).kind).toBe("stopped");
          expect(connections).toBe(2);
        }),
    );

    it.effect(
      "local daemon eligibility honors overrides and probe failures fall back without opening a socket",
      () =>
        Effect.gen(function* () {
          const config = { codexHome: "/unused", platform: "darwin", configOverrides: [] };
          expect(canUseCodexLocalDaemon(config, {})).toBe(false);
          expect(
            canUseCodexLocalDaemon(
              { ...config, platform: "win32" },
              {
                CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1",
              },
            ),
          ).toBe(false);
          expect(canUseCodexLocalDaemon(config, { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" })).toBe(
            true,
          );
          expect(
            canUseCodexLocalDaemon(
              { ...config, configOverrides: ["-c", "model=x"] },
              { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
            ),
          ).toBe(false);
          expect(
            canUseCodexLocalDaemon(config, {
              CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1",
              CODEX_APP_SERVER_FORCE_CLI: "1",
            }),
          ).toBe(false);
          expect(
            canUseCodexLocalDaemon(config, {
              CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1",
              CODEX_APP_SERVER_CHATGPT_BASE_URL: "https://custom.example",
            }),
          ).toBe(false);
          const result = yield* openCodexLocalDaemon({
            config,
            command: "codex",
            env: { CODEX_APP_SERVER_USE_LOCAL_DAEMON: "1" },
            hostId: "local",
            generation: 1,
            probe: () => Effect.succeed({ appServerVersion: "0.140.9" }),
          });
          expect(result).toBeUndefined();
          expect(parseCodexCliVersion("codex-cli 0.141.0-alpha.1\n")).toBe("0.141.0-alpha.1");
          expect(isSupportedCodexAppServerVersion("0.141.0-alpha.1")).toBe(false);
          expect(isSupportedCodexAppServerVersion("0.0.0")).toBe(true);
        }),
    );
  });

  describe("CodexWebSocketTransport", () => {
    it.effect("native WebSocket routes lines in a frame and closes with its session scope", () =>
      Effect.gen(function* () {
        const server = yield* Effect.acquireRelease(
          Effect.sync(() => new WebSocketServer({ port: 0 })),
          (server) =>
            Effect.callback<void>((resume) => {
              for (const peer of server.clients) peer.terminate();
              server.close(() => resume(Effect.void));
            }),
        );
        yield* Effect.promise(() => once(server, "listening"));
        const address = server.address();
        if (typeof address === "string" || !address) throw new Error("Missing server address");
        let closed: Promise<unknown> | undefined;
        const wires: string[] = [];
        const measured: CodexAppServerRequestMetrics[] = [];
        let responseBytes = 0;
        server.on("connection", (peer) => {
          closed = once(peer, "close");
          peer.on("message", (frame) => {
            const text = String(frame);
            wires.push(text);
            const request = JSON.parse(text) as { id: string };
            const response = JSON.stringify({ id: request.id, result: { value: "line\nbreak" } });
            responseBytes = Buffer.byteLength(response);
            peer.send(
              [
                JSON.stringify({ method: "custom/event", emittedAtMs: 100 }),
                "{broken}",
                "  ",
                `  ${response}  `,
              ].join("\r\n"),
            );
          });
        });
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const transport = yield* openCodexWebSocket({
              hostId: "remote",
              generation: 1,
              createSocket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
            });
            return yield* transport.client.raw.request(
              "custom/read",
              {},
              {
                requestId: "native-frame",
                onMetrics: (metrics) =>
                  Effect.sync(() => {
                    measured.push(metrics);
                  }),
              },
            );
          }),
        );
        expect(result).toEqual({ value: "line\nbreak" });
        expect(wires).toEqual(['{"id":"native-frame","method":"custom/read","params":{}}']);
        expect(measured).toHaveLength(1);
        expect(measured[0]).toMatchObject({
          transportKind: "websocket",
          requestBytes: Buffer.byteLength(wires[0]!),
          responseBytes,
          serverNotificationDeliveryLagMs: -100,
          serverNotificationClockSkewBaselineMs: -100,
        });
        if (closed) yield* Effect.promise(() => closed!);
      }),
    );
  });
});

describe("CodexSshProxy", () => {
  describe("CodexSshProxy", () => {
    // This executes the remote POSIX login-shell payload; Windows exercises the proxy framing below.
    test.skipIf(process.platform === "win32")(
      "login wrapper preserves binary marker, payload quoting and explicit Codex home",
      () => {
        const marker = Buffer.from([0, 255, 39, 92, 10, 13, 65, 128]);
        const command = codexRemoteLoginCommand('printf "%s" "value with spaces"', marker);
        const result = execFileSync("/bin/sh", ["-c", command], {
          env: { ...process.env, SHELL: "/bin/sh" },
          stdio: ["ignore", "pipe", "ignore"],
        });
        expect(result).toEqual(Buffer.concat([marker, Buffer.from("value with spaces")]));
      },
    );

    test("alias selection takes precedence over direct SSH connection fields", () => {
      const args = codexSshConnectionArguments(
        { alias: " saved-host ", host: "ignored", identity: "key", port: 99 },
        20,
      );
      expect(args.slice(-1)).toEqual(["saved-host"]);
      expect(args).not.toContain("key");
      expect(
        codexSshConnectionArguments({ host: "example", identity: " key ", port: 22 }).slice(-5),
      ).toEqual(["-i", "key", "-p", "22", "example"]);
    });

    it.effect("proxy strips split login marker and preserves handshake bytes", () =>
      Effect.gen(function* () {
        const marker = Buffer.from("12345678");
        const proxy = createCodexSshProxy({
          connection: { host: "unused" },
          sentinel: marker,
          spawnProcess: () =>
            spawn(
              process.execPath,
              [
                "-e",
                'process.stdout.write("login noise1234"); setTimeout(()=>{process.stdout.write("5678HTTP/1.1 101\\r\\n");process.stdout.end();},10)',
              ],
              { stdio: ["pipe", "pipe", "pipe"] },
            ),
        });
        const chunks: Buffer[] = [];
        proxy.on("data", (chunk: Buffer) => chunks.push(chunk));
        try {
          yield* Effect.promise(() => once(proxy, "end"));
          expect(Buffer.concat(chunks).toString()).toBe("HTTP/1.1 101\r\n");
        } finally {
          proxy.destroy();
        }
      }),
    );

    test("proxy drops late output after its readable side has reached EOF", async () => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: vi.fn(),
      });
      const proxy = createCodexSshProxy({
        connection: { host: "unused" },
        sentinel: Buffer.from("marker"),
        spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
      });
      const output: Buffer[] = [];
      proxy.on("data", (chunk: Buffer) => output.push(chunk));
      try {
        const ended = once(proxy, "end");
        child.stdout.emit("data", Buffer.from("markerresponse"));
        child.stdout.emit("end");
        child.stdout.emit("data", Buffer.from("late"));
        await ended;
        expect(Buffer.concat(output).toString()).toBe("response");
      } finally {
        proxy.destroy();
      }
    });
  });

  describe("CodexSshProxyDependency", () => {
    const inspect = (command: string) =>
      codexSshProxyDependency(
        `ProxyCommand ${command}`,
        "/bin:/usr/bin",
        (command) => command === "known",
      );

    test("only unresolved bare executables wait for shell PATH", () => {
      expect(inspect("known %h").needsShellEnv).toBe(false);
      expect(inspect("missing %h").needsShellEnv).toBe(true);
      expect(inspect("/absolute/proxy %h").needsShellEnv).toBe(false);
      expect(inspect("NONE").needsShellEnv).toBe(false);
    });

    test("unwraps assignments and nested login shells with bounded recursion", () => {
      expect(inspect(`bash -lic 'env A=b exec known'`).commandName).toBe("known");
      expect(inspect(`sh -c 'sh -c "sh -c known"'`).commandName).toBe("sh");
    });

    test("rejects shell operators and incomplete quoting but keeps quoted literals", () => {
      expect(inspect("proxy | another").reason).toBe("proxy_command_unparsed");
      expect(inspect("'unterminated").reason).toBe("proxy_command_unparsed");
      expect(inspect("'proxy;literal'").commandName).toBe("proxy;literal");
      expect(inspect("$'kn\\157wn'").commandName).toBe("known");
    });

    test("uses the final proxy command in the resolved SSH configuration", () => {
      expect(
        codexSshProxyDependency("proxycommand missing\nProxyCommand none", null, () => false)
          .reason,
      ).toBe("proxy_command_none");
    });
  });

  describe("CodexSshSession", () => {
    const server = Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ port: 0 })),
      (server) =>
        Effect.callback<void>((resume) => {
          for (const peer of server.clients) peer.terminate();
          server.close(() => resume(Effect.void));
        }),
    );
    const url = (server: WebSocketServer) => {
      const address = server.address();
      if (typeof address === "string" || !address) throw new Error("missing listener");
      return `ws://127.0.0.1:${address.port}`;
    };
    const config: CodexSshSessionConfig = { connection: { alias: "dev", host: "dev" } };
    it.effect(
      "SSH reconnect reuses the persistent server; failed reconnect closes its attempt before bootstrap and initialization failure resets reuse",
      () =>
        Effect.gen(function* () {
          const listener = yield* server;
          const commands: string[] = [];
          let attempts = 0;
          let failedAttemptClosed = false;
          const runtime = makeCodexSshSessionRuntime({
            prepareEnvironment: () => Effect.succeed({}),
            runCommand: (_, command) =>
              Effect.sync(() => {
                commands.push(command);
                if (attempts === 3) expect(failedAttemptClosed).toBe(true);
                return { code: 0, stdout: "codex-cli 0.151.0", stderr: "" };
              }),
            connect: (_, hostId, generation) =>
              Effect.gen(function* () {
                attempts += 1;
                if (attempts === 3) {
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      failedAttemptClosed = true;
                    }),
                  );
                  return yield* codexRuntimeError({
                    operation: "test.connect",
                    reason: "session-lost",
                    retryable: true,
                  });
                }
                return yield* openCodexWebSocket({
                  hostId,
                  generation,
                  createSocket: () => new WebSocket(url(listener)),
                });
              }),
          });
          const firstScope = yield* Scope.fork(yield* Effect.scope);
          yield* runtime
            .open(config, "remote", 1)
            .pipe(Effect.provideService(Scope.Scope, firstScope));
          expect(commands).toHaveLength(3);
          yield* Scope.close(firstScope, Exit.void);
          yield* runtime.open(config, "remote", 2);
          expect(commands).toHaveLength(3);
          const recovered = yield* runtime.open(config, "remote", 3);
          expect(commands).toHaveLength(6);
          recovered.onInitializationFailed();
          yield* runtime.open(config, "remote", 4);
          expect(commands).toHaveLength(9);
        }),
    );

    it.effect(
      "SSH startup commands and handshakes serialize across endpoints sharing an alias",
      () =>
        Effect.gen(function* () {
          const listener = yield* server;
          let active = 0;
          let maximum = 0;
          let calls = 0;
          const runtime = makeCodexSshSessionRuntime({
            prepareEnvironment: () => Effect.succeed({}),
            runCommand: () =>
              Effect.gen(function* () {
                active += 1;
                maximum = Math.max(maximum, active);
                yield* Effect.yieldNow;
                active -= 1;
                calls += 1;
                return { code: 0, stdout: "codex-cli 0.151.0", stderr: "" };
              }),
            connect: (_, hostId, generation) =>
              openCodexWebSocket({
                hostId,
                generation,
                createSocket: () => new WebSocket(url(listener)),
              }),
          });
          yield* Effect.all(
            [
              runtime.open({ connection: { alias: "shared", host: "one" } }, "one", 1),
              runtime.open({ connection: { alias: "shared", host: "two" } }, "two", 1),
            ],
            { concurrency: "unbounded" },
          );
          expect(maximum).toBe(1);
          expect(calls).toBe(6);
        }),
    );

    it.effect(
      "unsupported remote Codex versions fail before bootstrap and leave the startup gate reusable",
      () =>
        Effect.gen(function* () {
          let version = "codex-cli 0.140.9";
          let commands = 0;
          let connections = 0;
          const runtime = makeCodexSshSessionRuntime({
            prepareEnvironment: () => Effect.succeed({}),
            runCommand: (_, command) =>
              Effect.sync(() => {
                commands += 1;
                return {
                  code: 0,
                  stdout: command.endsWith("--version") ? version : "",
                  stderr: "",
                };
              }),
            connect: () =>
              Effect.gen(function* () {
                connections += 1;
                return yield* codexRuntimeError({
                  operation: "test.connect",
                  reason: "session-lost",
                  retryable: true,
                });
              }),
          });
          const rejected = yield* Effect.exit(runtime.open(config, "remote", 1));
          expect(Exit.isFailure(rejected)).toBe(true);
          expect(commands).toBe(2);
          expect(connections).toBe(0);
          version = "codex-cli 0.0.0";
          yield* Effect.exit(runtime.open(config, "remote", 2));
          expect(commands).toBe(5);
          expect(connections).toBe(1);
        }),
    );
  });
});

describe("CodexPeerMetrics", () => {
  const it = itCodexPeerMetrics;
  const message = (type: "snapshot" | "patches"): CodexPeerMessage => ({
    type: "broadcast",
    method: "thread-stream-state-changed",
    sourceClientId: "a",
    version: 11,
    params: { change: { type, privateContent: "汉字 😀" } },
  });

  describe("Codex peer numeric metrics", () => {
    it("measures fragmented decoding and frame categories without retaining content", () => {
      let now = 0;
      const metrics = new CodexPeerMetrics(() => now++);
      const socket = new Socket();
      const receiver = metrics.attach(socket, "client");
      const received: CodexPeerMessage[] = [];
      const read = createCodexPeerFrameReader((value) => received.push(value), receiver);
      const frame = encodeCodexPeerFrame(message("snapshot"));
      read(frame.subarray(0, 2));
      expect(metrics.snapshot().main_ipc_client_rx_announced_frames_total).toBe(0);
      read(frame.subarray(2, 8));
      const partial = metrics.snapshot();
      expect(partial.main_ipc_client_rx_active_announced_bytes).toBe(frame.length - 4);
      expect(partial.main_ipc_client_rx_active_received_bytes).toBe(4);
      expect(partial.main_ipc_client_rx_decoding_frames).toBe(0);
      for (let offset = 8; offset < frame.length; offset++)
        read(frame.subarray(offset, offset + 1));
      read(encodeCodexPeerFrame(message("patches")));
      expect(received).toEqual([message("snapshot"), message("patches")]);
      const complete = metrics.snapshot();
      expect(complete.main_ipc_client_rx_snapshot_frames_total).toBe(1);
      expect(complete.main_ipc_client_rx_patches_frames_total).toBe(1);
      expect(complete.main_ipc_client_rx_active_frames).toBe(0);
      expect(complete.main_ipc_client_rx_decode_ms_total).toBeGreaterThan(0);
      expect(Object.values(complete).every((value) => typeof value === "number")).toBe(true);
      expect(JSON.stringify(complete)).not.toContain("privateContent");
      receiver.close();
      expect(metrics.snapshot().main_ipc_client_connections).toBe(0);
      socket.destroy();
    });

    it("counts a failed JSON frame once and detaches its incomplete input", () => {
      const metrics = new CodexPeerMetrics();
      const socket = new Socket();
      const receiver = metrics.attach(socket, "router");
      const read = createCodexPeerFrameReader(() => {}, receiver);
      expect(() => read(encodeCodexPeerJson("{"))).toThrow();
      receiver.fail();
      receiver.close();
      const snapshot = metrics.snapshot();
      expect(snapshot.main_ipc_router_rx_failures_total).toBe(1);
      expect(snapshot.main_ipc_router_rx_abandoned_frames_total).toBe(1);
      expect(snapshot.main_ipc_router_connections).toBe(0);
      expect(snapshot.main_ipc_router_rx_active_frames).toBe(0);
      socket.destroy();
    });

    it("settles write callbacks exactly once and abandons pending work on close", () => {
      const metrics = new CodexPeerMetrics();
      const socket = new Socket();
      const receive = metrics.attach(socket, "client");
      const accepted = metrics.beginWrite(socket, 20);
      const failed = metrics.beginWrite(socket, 40);
      const abandoned = metrics.beginWrite(socket, 60);
      metrics.wrote(socket, false);
      expect(metrics.snapshot().main_ipc_client_tx_pending_bytes).toBe(120);
      accepted?.();
      accepted?.(new Error("duplicate callback"));
      failed?.(new Error("write failed"));
      failed?.();
      receive.begin(10);
      receive.decode(4);
      socket.emit("close");
      abandoned?.();
      receive.close();
      const snapshot = metrics.snapshot();
      expect(snapshot.main_ipc_client_tx_frames_total).toBe(3);
      expect(snapshot.main_ipc_client_tx_backpressure_total).toBe(1);
      expect(snapshot.main_ipc_client_tx_write_failures_total).toBe(1);
      expect(snapshot.main_ipc_client_tx_abandoned_frames_total).toBe(1);
      expect(snapshot.main_ipc_client_tx_abandoned_bytes_total).toBe(60);
      expect(snapshot.main_ipc_client_tx_socket_pending_bytes_max).toBe(120);
      expect(snapshot.main_ipc_client_tx_pending_frames).toBe(0);
      expect(snapshot.main_ipc_client_tx_pending_bytes).toBe(0);
      expect(snapshot.main_ipc_client_rx_abandoned_frames_total).toBe(1);
      expect(snapshot.main_ipc_client_connections).toBe(0);
      socket.destroy();
    });

    it("records write(false) and synchronous failure at the actual socket boundary", () => {
      const socket = new Socket();
      const receive = codexPeerMetrics.attach(socket, "router");
      const before = codexPeerMetrics.snapshot();
      const frame = encodeCodexPeerFrame(message("patches"));
      const write = vi.spyOn(socket, "write").mockReturnValueOnce(false);
      writeCodexPeerFrame(socket, frame);
      expect(codexPeerMetrics.snapshot().main_ipc_router_tx_backpressure_total).toBe(
        before.main_ipc_router_tx_backpressure_total! + 1,
      );
      const callback: unknown = write.mock.calls[0]?.[1];
      if (typeof callback !== "function") throw new Error("Missing native write callback");
      callback();
      callback();
      write.mockImplementationOnce(() => {
        throw new Error("native write failed");
      });
      expect(() => writeCodexPeerFrame(socket, frame)).toThrow("native write failed");
      const after = codexPeerMetrics.snapshot();
      expect(after.main_ipc_router_tx_pending_frames).toBe(
        before.main_ipc_router_tx_pending_frames,
      );
      expect(after.main_ipc_router_tx_write_failures_total).toBe(
        before.main_ipc_router_tx_write_failures_total! + 1,
      );
      receive.close();
      write.mockRestore();
      socket.destroy();
    });
  });
});
