import type { Agent, ClientRequest, IncomingMessage } from "node:http";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import WebSocket, { type RawData } from "ws";
import {
  DICTATION_STREAM_MAX_MESSAGE_LENGTH,
  type DictationStreamNetworkError,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";

export class DictationWebSocketError extends Schema.TaggedError<DictationWebSocketError>()(
  "DictationWebSocketError",
  {
    failureCode: Schema.Literals(["websocket-failed", "send-failed", "aborted"]),
  },
) {}

export interface DictationWebSocketHandle {
  readonly send: (data: string) => Effect.Effect<void, DictationWebSocketError>;
  readonly close: Effect.Effect<void>;
}

/** Keep transport diagnostics categorical: native messages can contain credentials or URLs. */
const networkError = (error: unknown): DictationStreamNetworkError => {
  const code =
    error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  if (typeof code !== "string") return "other";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (code === "ECONNRESET" || code === "EPIPE") return "reset";
  if (
    code.startsWith("ERR_TLS_") ||
    code.startsWith("ERR_SSL_") ||
    code.startsWith("CERT_") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN"
  ) {
    return "tls";
  }
  return "other";
};

const frameText = (data: RawData): string => {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

/** One Main-owned socket per connection Scope; authentication never crosses into the renderer. */
export const openDictationWebSocket = Effect.fn("openDictationWebSocket")(function* (options: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  readonly agent?: Agent;
  readonly onEvent: (event: DictationStreamTransportEvent) => void;
}): Effect.fn.Return<DictationWebSocketHandle, DictationWebSocketError, Scope.Scope> {
  if (options.signal.aborted) {
    return yield* new DictationWebSocketError({ failureCode: "aborted" });
  }
  const connection = yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        const socket = new WebSocket(options.url, ["chatgpt-dictation", "codex-desktop"], {
          headers: options.headers,
          maxPayload: DICTATION_STREAM_MAX_MESSAGE_LENGTH,
          followRedirects: false,
          ...(options.agent ? { agent: options.agent } : {}),
        });
        let disposed = false;
        let closed = false;
        let failureReported = false;
        const emit = (event: DictationStreamTransportEvent) => {
          if (disposed || closed) return;
          options.onEvent(event);
        };
        const fail = (event: Extract<DictationStreamTransportEvent, { type: "error" }>) => {
          if (failureReported) return;
          failureReported = true;
          emit(event);
        };
        const onOpen = () => emit({ type: "open", protocol: socket.protocol });
        const onMessage = (data: RawData, isBinary: boolean) => {
          if (disposed || closed) return;
          if (isBinary) {
            socket.close(1003);
            return;
          }
          emit({ type: "message", data: frameText(data) });
        };
        const onError = (error: Error) => {
          fail({
            type: "error",
            failureCode: "websocket-failed",
            networkError: networkError(error),
          });
        };
        const onClose = (code: number) => {
          emit({ type: "close", code });
          closed = true;
        };
        const onRejected = (_request: ClientRequest, response: IncomingMessage) => {
          const challenge = response.headers["cf-mitigated"] === "challenge";
          fail({
            type: "error",
            failureCode: challenge ? "edge-challenge" : "http-rejected",
            ...(response.statusCode === undefined ? {} : { httpStatus: response.statusCode }),
            ...(challenge ? { edgeChallenge: "cloudflare" as const } : {}),
            ...(response.statusCode === 407 ? { networkError: "proxy" as const } : {}),
          });
          // Listening to unexpected-response transfers handshake cleanup from ws to this Adapter.
          response.destroy();
          socket.terminate();
        };
        const onAbort = () => {
          fail({ type: "error", failureCode: "aborted" });
          onClose(1006);
          socket.terminate();
        };
        socket.on("open", onOpen);
        socket.on("message", onMessage);
        socket.on("error", onError);
        socket.on("close", onClose);
        socket.on("unexpected-response", onRejected);
        options.signal.addEventListener("abort", onAbort, { once: true });
        if (options.signal.aborted) onAbort();
        const close = () => {
          if (disposed) return;
          disposed = true;
          options.signal.removeEventListener("abort", onAbort);
          socket.off("open", onOpen);
          socket.off("message", onMessage);
          socket.off("error", onError);
          socket.off("close", onClose);
          socket.off("unexpected-response", onRejected);
          // A CONNECTING socket can emit an asynchronous error after terminate().
          socket.on("error", () => {});
          socket.terminate();
        };
        return { socket, close, fail, isClosed: () => disposed || closed };
      },
      catch: () => new DictationWebSocketError({ failureCode: "websocket-failed" }),
    }),
    (connection) => Effect.sync(connection.close),
  );
  const send = Effect.fn("DictationWebSocket.send")(function* (data: string) {
    if (
      typeof data !== "string" ||
      Buffer.byteLength(data, "utf8") > DICTATION_STREAM_MAX_MESSAGE_LENGTH ||
      connection.isClosed() ||
      connection.socket.readyState !== WebSocket.OPEN
    ) {
      return yield* new DictationWebSocketError({ failureCode: "send-failed" });
    }
    return yield* Effect.callback<void, DictationWebSocketError>((resume) => {
      const failed = () => {
        connection.fail({ type: "error", failureCode: "send-failed" });
        resume(Effect.fail(new DictationWebSocketError({ failureCode: "send-failed" })));
      };
      try {
        connection.socket.send(data, (error) => {
          if (error) {
            failed();
            return;
          }
          resume(Effect.void);
        });
      } catch {
        failed();
      }
    });
  });
  return { send, close: Effect.sync(connection.close) };
});
