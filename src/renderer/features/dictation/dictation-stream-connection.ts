import { RpcSession } from "capnweb";
import type { DictationSurface } from "../../../shared/dictation";
import type { DictationStreamDiagnostics } from "../../../shared/dictation-diagnostics";
import {
  DICTATION_STREAM_CONNECT_MESSAGE,
  type DictationStreamConnection as MainDictationStreamConnection,
  type DictationStreamingService,
  type DictationStreamTransportEvent,
} from "../../../shared/dictation-stream-transport";
import { ConversationServicePortTransport } from "../../../shared/codex-service-port";

export const DICTATION_STREAM_CONNECTING = 0;
export const DICTATION_STREAM_OPEN = 1;
export const DICTATION_STREAM_CLOSED = 3;

export const categorizeDictationStreamProtocol = (
  protocol: string,
): NonNullable<DictationStreamDiagnostics["selectedProtocol"]> =>
  protocol === "chatgpt-dictation" || protocol === "codex-desktop"
    ? protocol
    : protocol
      ? "other"
      : "none";

export interface DictationStreamSocket extends EventTarget {
  readonly readyState: number;
  readonly protocol: string;
  readonly diagnostics?: Partial<DictationStreamDiagnostics>;
  send(data: string): void;
  close(): void;
}
export type PrepareDictationStreamConnection = () => Promise<() => DictationStreamSocket>;

interface DictationStreamRpcScope extends Disposable {
  readonly ready: Promise<MainDictationStreamConnection>;
}
export type OpenDictationStreamRpc = (
  surface: DictationSurface,
  onEvent: (event: DictationStreamTransportEvent) => void,
  onBroken: () => void,
) => DictationStreamRpcScope;

/** Acquire one Main capability on a dedicated port; disposing also cancels pending auth. */
const openMainDictationStream: OpenDictationStreamRpc = (surface, onEvent, onBroken) => {
  const { port1, port2 } = new MessageChannel();
  const transport = new ConversationServicePortTransport({
    start: () => port1.start(),
    postMessage: (message) => port1.postMessage(message),
    close: () => port1.close(),
    on: (event, listener) => {
      if (event === "message") port1.addEventListener("message", listener);
      else port1.addEventListener("messageerror", listener as () => void);
    },
  });
  const root = new RpcSession<DictationStreamingService>(transport).getRemoteMain();
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    root[Symbol.dispose]();
    transport.abort(new Error("Dictation stream connection disposed"));
    port2.close();
  };
  root.onRpcBroken(() => {
    if (!disposed) onBroken();
  });
  const ready = (async () => {
    try {
      window.postMessage(
        { type: DICTATION_STREAM_CONNECT_MESSAGE, port: port2 },
        window.location.origin,
        [port2],
      );
      return await root.connect(surface, onEvent);
    } catch (error) {
      dispose();
      throw error;
    }
  })();
  return { ready, [Symbol.dispose]: dispose };
};

/** WebSocket-shaped session transport with no renderer credentials or network access. */
export class DictationStreamConnection extends EventTarget implements DictationStreamSocket {
  readyState = DICTATION_STREAM_CONNECTING;
  protocol = "";
  readonly diagnostics: Partial<DictationStreamDiagnostics> = {};
  #connection: MainDictationStreamConnection | null = null;
  #scope: DictationStreamRpcScope | null = null;
  #events: DictationStreamTransportEvent[] = [];

  constructor(
    surface: DictationSurface,
    openRpc: OpenDictationStreamRpc = openMainDictationStream,
  ) {
    super();
    try {
      this.#scope = openRpc(
        surface,
        (event) => {
          if (this.readyState === DICTATION_STREAM_CLOSED) return;
          this.recordDiagnostics(event);
          if (!this.#connection) {
            this.#events.push(event);
            return;
          }
          this.handleEvent(event);
        },
        () => this.fail(),
      );
      void this.#scope.ready.then(
        (connection) => {
          if (this.readyState === DICTATION_STREAM_CLOSED) {
            connection[Symbol.dispose]();
            return;
          }
          this.#connection = connection;
          const pending = this.#events;
          this.#events = [];
          for (const event of pending) this.handleEvent(event);
        },
        () => this.fail(),
      );
    } catch {
      queueMicrotask(() => this.fail());
    }
  }

  send(data: string): void {
    if (this.readyState !== DICTATION_STREAM_OPEN || !this.#connection) return;
    try {
      void Promise.resolve(this.#connection.send(data)).catch(() => {
        this.diagnostics.failureCode ??= "send-failed";
        this.fail();
      });
    } catch {
      this.diagnostics.failureCode ??= "send-failed";
      this.fail();
    }
  }

  close(): void {
    if (this.readyState === DICTATION_STREAM_CLOSED) return;
    this.readyState = DICTATION_STREAM_CLOSED;
    this.dispose();
    queueMicrotask(() =>
      this.dispatchEvent(new CloseEvent("close", { code: this.diagnostics.closeCode ?? 0 })),
    );
  }

  private fail(): void {
    if (this.readyState === DICTATION_STREAM_CLOSED) return;
    this.diagnostics.failureCode ??= "websocket-failed";
    this.dispatchEvent(new Event("error"));
    this.close();
  }

  private dispose(): void {
    this.#events = [];
    this.#connection?.[Symbol.dispose]();
    this.#connection = null;
    this.#scope?.[Symbol.dispose]();
    this.#scope = null;
  }

  private handleEvent(event: DictationStreamTransportEvent): void {
    if (this.readyState === DICTATION_STREAM_CLOSED) return;
    switch (event.type) {
      case "prepared":
        return;
      case "open":
        this.protocol = event.protocol;
        this.readyState = DICTATION_STREAM_OPEN;
        this.dispatchEvent(new Event("open"));
        return;
      case "message":
        this.dispatchEvent(new MessageEvent("message", { data: event.data }));
        return;
      case "error":
        this.dispatchEvent(new Event("error"));
        return;
      case "close":
        this.readyState = DICTATION_STREAM_CLOSED;
        this.dispose();
        this.dispatchEvent(new CloseEvent("close", { code: event.code }));
    }
  }

  /** Preparation can fail before the send capability arrives; retain only selected evidence. */
  private recordDiagnostics(event: DictationStreamTransportEvent): void {
    switch (event.type) {
      case "prepared":
        this.diagnostics.headers = event.headers;
        this.diagnostics.proxyMode = event.proxyMode;
        return;
      case "open":
        this.diagnostics.opened = true;
        this.diagnostics.selectedProtocol = categorizeDictationStreamProtocol(event.protocol);
        return;
      case "error":
        this.diagnostics.failureCode = event.failureCode;
        this.diagnostics.httpStatus = event.httpStatus;
        this.diagnostics.edgeChallenge = event.edgeChallenge;
        this.diagnostics.networkError = event.networkError;
        return;
      case "close":
        this.diagnostics.closeCode = event.code;
    }
  }
}

export const prepareDictationStreamConnection =
  (surface: DictationSurface): PrepareDictationStreamConnection =>
  async () =>
  () =>
    new DictationStreamConnection(surface);
