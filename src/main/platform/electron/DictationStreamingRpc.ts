/* oxlint-disable effecttsgo/async-function -- Cap'n Web RPC adapts a Main-owned scoped socket. */
import { RpcSession, RpcTarget, type RpcStub } from "capnweb";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { z } from "zod";
import type { DictationSurface } from "../../../shared/dictation";
import {
  DICTATION_STREAM_MAX_MESSAGE_LENGTH,
  type DictationStreamConnection,
  type DictationStreamingService,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";
import {
  ConversationServicePortTransport,
  type ConversationServicePort,
} from "../../../shared/codex-service-port";
import type { ScopedCallbackRuntime } from "../../app/ScopedCallbackRuntime";
import type { CodexMedia } from "../../codex-application/CodexMedia";
import type { DictationWebSocketHandle } from "../node/DictationWebSocket";

const Surface = z.enum(["composer", "global"]);
const Frame = z
  .string()
  .max(DICTATION_STREAM_MAX_MESSAGE_LENGTH)
  .refine(
    (data) => Buffer.byteLength(data, "utf8") <= DICTATION_STREAM_MAX_MESSAGE_LENGTH,
    "Dictation frame exceeds its byte budget",
  );
const RPC_ENVELOPE_LIMIT = DICTATION_STREAM_MAX_MESSAGE_LENGTH + 4096;

class StreamingConnection extends RpcTarget implements DictationStreamConnection {
  constructor(
    private readonly socket: DictationWebSocketHandle,
    private readonly callbacks: ScopedCallbackRuntime["Service"],
    private readonly isClosed: () => boolean,
    private readonly release: () => void,
  ) {
    super();
  }
  send(data: string): Promise<void> {
    if (this.isClosed()) return Promise.reject(new Error("Dictation stream is closed"));
    const frame = Frame.parse(data);
    return this.callbacks.runPromise(this.socket.send(frame));
  }
  [Symbol.dispose](): void {
    this.release();
  }
}

/** One transferred port grants one socket attempt; Main alone selects credentials and endpoint. */
class DictationStreamingRpc extends RpcTarget implements DictationStreamingService {
  private connected = false;
  private disposed = false;
  private releaseConnection: (() => void) | undefined;

  constructor(
    private readonly media: Pick<CodexMedia["Service"], "openStreaming">,
    private readonly callbacks: ScopedCallbackRuntime["Service"],
    private readonly scope: Scope.Scope,
    private readonly allowedSurface: DictationSurface,
  ) {
    super();
  }
  async connect(
    surface: DictationSurface,
    listener: RpcStub<(event: DictationStreamTransportEvent) => void>,
  ): Promise<DictationStreamConnection> {
    if (this.disposed || this.connected) throw new Error("Dictation stream attempt is unavailable");
    if (Surface.parse(surface) !== this.allowedSurface)
      throw new Error("Dictation stream surface does not belong to this renderer");
    if (typeof listener !== "function") throw new Error("Dictation stream requires a callback");
    this.connected = true;
    const callback = listener.dup();
    let child: Scope.Closeable | undefined;
    let closed = false;
    const release = (): void => {
      if (closed) return;
      closed = true;
      callback[Symbol.dispose]();
      if (child) this.callbacks.fork(Scope.close(child, Exit.void));
    };
    this.releaseConnection = release;
    callback.onRpcBroken(release);
    try {
      child = await this.callbacks.runPromise(Scope.fork(this.scope, "sequential"));
      await this.callbacks.runPromise(Scope.addFinalizer(child, Effect.sync(release)));
      if (closed || this.disposed) {
        await this.callbacks.runPromise(Scope.close(child, Exit.void));
        throw new Error("Dictation stream attempt was cancelled");
      }
      const opening = await this.callbacks.runPromise(
        this.media
          .openStreaming(surface, (event) => {
            if (closed) return;
            const pending = callback(event);
            pending[Symbol.dispose]();
            if (event.type === "close") release();
          })
          .pipe(Effect.provideService(Scope.Scope, child), Effect.forkIn(child)),
      );
      const socket = await this.callbacks.runPromise(Fiber.join(opening));
      if (closed || this.disposed) throw new Error("Dictation stream attempt was cancelled");
      return new StreamingConnection(socket, this.callbacks, () => closed, release);
    } catch (error) {
      release();
      throw error;
    }
  }
  [Symbol.dispose](): void {
    if (this.disposed) return;
    this.disposed = true;
    this.releaseConnection?.();
  }
}

/** Bounds structured-clone RPC envelopes before Cap'n Web evaluates them. */
function boundedPort(port: ConversationServicePort): ConversationServicePort {
  return {
    start: () => port.start(),
    close: () => port.close(),
    postMessage: (message) => port.postMessage(message),
    on: (
      event: "message" | "close",
      listener: ((event: { data: unknown }) => void) | (() => void),
    ) => {
      if (event === "close") return port.on("close", listener as () => void);
      return port.on("message", ({ data }) => {
        try {
          const encoded = JSON.stringify(data);
          if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > RPC_ENVELOPE_LIMIT)
            throw new Error();
        } catch {
          port.close();
          return;
        }
        (listener as (event: { data: unknown }) => void)({ data });
      });
    },
  };
}

export const connectDictationStreamingRpc = (
  port: ConversationServicePort,
  media: Pick<CodexMedia["Service"], "openStreaming">,
  callbacks: ScopedCallbackRuntime["Service"],
  scope: Scope.Scope,
  surface: DictationSurface,
): { readonly dispose: () => void } => {
  const transport = new ConversationServicePortTransport(boundedPort(port));
  const root = new DictationStreamingRpc(media, callbacks, scope, surface);
  new RpcSession(transport, root, {
    limits: { maxDepth: 24, maxMessageSize: RPC_ENVELOPE_LIMIT },
    // Backend errors can contain credentials or routing URLs; safe diagnostics use typed events.
    onSendError: () => new Error("Dictation stream operation failed"),
  })
    .getRemoteMain()
    .onRpcBroken(() => root[Symbol.dispose]());
  return {
    dispose: () => {
      root[Symbol.dispose]();
      transport.abort(new Error("Dictation stream was disposed"));
    },
  };
};
