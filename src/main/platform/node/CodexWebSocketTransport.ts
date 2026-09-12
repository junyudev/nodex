import * as Clock from "effect/Clock";
import * as PlatformError from "effect/PlatformError";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import WebSocket, { type RawData } from "ws";
import { make as makeClient } from "@nodex/effect-codex-app-server/client";
import { createCodexAppServerReceiveMetrics } from "@nodex/effect-codex-app-server/protocol";
import { makeCodexIncomingMessages } from "./CodexIncomingMessages";
import { CodexHostRequestMetrics } from "../../codex-runtime/CodexHostRequestMetrics";
import {
  classifyCodexClientError,
  codexRuntimeError,
  type CodexRuntimeError,
} from "../../codex-runtime/CodexRuntimeError";
import type { CodexSessionTransportHandle } from "./CodexSessionTransport";

/** Each WebSocket callback admits a batch of JSON lines into the scoped host queue. */
export const openCodexWebSocket = Effect.fn("openCodexWebSocket")(function* (options: {
  readonly hostId: string;
  readonly generation: number;
  readonly createSocket: () => WebSocket;
  readonly openTimeoutMs?: number;
}): Effect.fn.Return<CodexSessionTransportHandle, CodexRuntimeError, Scope.Scope> {
  const clock = yield* Clock.Clock;
  const incoming = yield* makeCodexIncomingMessages();
  const hostMetrics = yield* CodexHostRequestMetrics;
  const receiveMetrics = createCodexAppServerReceiveMetrics({
    transportKind: "websocket",
    hostKind: hostMetrics?.hostKind,
    state: hostMetrics?.receiveState,
    getIncomingQueueDepth: incoming.depth,
  });
  if (hostMetrics) hostMetrics.receiver = receiveMetrics;
  const fail = (operation: string, cause: unknown) =>
    incoming.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "WebSocket",
        method: operation,
        cause,
      }),
    );
  const socket = yield* Effect.acquireRelease(
    Effect.try({
      try: options.createSocket,
      catch: (cause) =>
        codexRuntimeError({
          operation: "session.websocket-create",
          reason: "spawn",
          retryable: true,
          hostId: options.hostId,
          generation: options.generation,
          cause,
        }),
    }),
    (socket) =>
      Effect.sync(() => {
        socket.on("error", () => {});
        socket.terminate();
      }),
  );
  const onMessage = (data: RawData) => {
    const receivedAtMs = clock.currentTimeMillisUnsafe();
    incoming.offerData(data, receivedAtMs);
  };
  const onError = (error: Error) => {
    fail("websocket-error", error);
  };
  const onClose = (code: number, reason: Buffer) => {
    incoming.end(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "WebSocket",
        method: "websocket-close",
        cause: new Error(`WebSocket closed (${code}): ${reason.toString()}`),
      }),
    );
  };
  socket.on("message", onMessage);
  socket.on("error", onError);
  socket.on("close", onClose);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    }),
  );
  yield* Effect.callback<void, CodexRuntimeError>((resume) => {
    if (socket.readyState === WebSocket.OPEN) {
      resume(Effect.void);
      return;
    }
    const opened = () => {
      resume(Effect.void);
    };
    const failed = (cause: unknown) => {
      resume(
        Effect.fail(
          codexRuntimeError({
            operation: "session.websocket-open",
            reason: "session-lost",
            retryable: true,
            hostId: options.hostId,
            generation: options.generation,
            cause,
          }),
        ),
      );
    };
    socket.once("open", opened);
    socket.once("error", failed);
    socket.once("close", failed);
    return Effect.sync(() => {
      socket.off("open", opened);
      socket.off("error", failed);
      socket.off("close", failed);
    });
  }).pipe(
    Effect.timeout(options.openTimeoutMs ?? 30_000),
    Effect.mapError((cause) =>
      codexRuntimeError({
        operation: "session.websocket-open",
        reason: "session-lost",
        retryable: true,
        hostId: options.hostId,
        generation: options.generation,
        cause,
      }),
    ),
  );
  let lastPong = clock.currentTimeMillisUnsafe();
  const pong = () => {
    lastPong = clock.currentTimeMillisUnsafe();
  };
  socket.on("pong", pong);
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.off("pong", pong);
    }),
  );
  yield* Effect.gen(function* () {
    while (socket.readyState === WebSocket.OPEN) {
      yield* Effect.sleep("10 seconds");
      if (socket.readyState !== WebSocket.OPEN) return;
      const now = yield* Effect.clockWith((clock) => clock.currentTimeMillis);
      if (now - lastPong > 60_000) {
        socket.terminate();
        return;
      }
      socket.ping();
    }
  }).pipe(Effect.forkScoped);
  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.empty,
    stdout: () =>
      Sink.forEach((frame: string | Uint8Array) =>
        Effect.try({
          try: () => {
            if (socket.readyState !== WebSocket.OPEN)
              throw new Error("Codex app-server websocket is not open");
            socket.send(frame);
          },
          catch: (cause) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "WebSocket",
              method: "send",
              cause,
            }),
        }),
      ),
    stderr: () => Sink.drain,
  });
  const client = yield* makeClient(stdio, {
    framing: "message",
    receiveMetrics,
    decodedMessages: incoming.messages,
  });
  return {
    pid: 0,
    transportKind: "websocket",
    client,
    termination: client.termination.pipe(
      Effect.mapError((cause) =>
        classifyCodexClientError({
          operation: "session.websocket",
          cause,
          hostId: options.hostId,
          generation: options.generation,
        }),
      ),
    ),
  };
});
