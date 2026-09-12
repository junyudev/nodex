import { once } from "node:events";
import * as Effect from "effect/Effect";
import WebSocket, { WebSocketServer } from "ws";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import type { CodexAppServerRequestMetrics } from "@nodex/effect-codex-app-server/protocol";
import { openCodexWebSocket } from "./CodexWebSocketTransport";

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
