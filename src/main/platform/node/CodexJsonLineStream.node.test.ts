import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { make as makeClient } from "@nodex/effect-codex-app-server/client";
import type { CodexAppServerRequestMetrics } from "@nodex/effect-codex-app-server/protocol";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { getCodexHostSourceLineBytes } from "../../../shared/codex-host-chunked-message";
import type { CodexHostMessagePart } from "../../../shared/codex-host-chunked-message";
import { CodexHostChunkedMessageSender } from "../../host-runtime/CodexHostChunkedMessageSender";
import { codexJsonLineMessages, codexJsonLineTransport } from "./CodexJsonLineStream";

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
        encodeJson({ method: "custom/later", params: { text: "x".repeat(1024 * 1024) } }) + "\n",
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
      yield* Deferred.succeed(rest, Buffer.concat([notification.subarray(8192), response, later]));
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

it.effect("retains physical line bytes on the decoded envelope and result or params object", () =>
  Effect.gen(function* () {
    const responseLine = '{"id":1,"result":{"value":"ok"}}\n';
    const notificationLine = '{"method":"turn/updated","params":{"threadId":"t"}}\n';
    const values = yield* codexJsonLineMessages(
      Stream.make(Buffer.from(responseLine + notificationLine)),
    ).pipe(Stream.runCollect);

    const response = values[0]!.value as { result: object };
    const notification = values[1]!.value as { params: object };
    expect(getCodexHostSourceLineBytes(response)).toBe(Buffer.byteLength(responseLine));
    expect(getCodexHostSourceLineBytes(response.result)).toBe(Buffer.byteLength(responseLine));
    expect(getCodexHostSourceLineBytes(notification)).toBe(Buffer.byteLength(notificationLine));
    expect(getCodexHostSourceLineBytes(notification.params)).toBe(
      Buffer.byteLength(notificationLine),
    );
  }),
);
