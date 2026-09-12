/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise -- This Node socket adapter owns wire request deadlines and reconnect timers; its owning application Scope disposes the adapter and settles every pending request. */
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
  acceptsCodexPeerRequestVersion,
  codexPeerMethodVersion,
  codexPeerRequestVersion,
  type CodexPeerBroadcast,
  type CodexPeerMessage,
  type CodexPeerRequest,
  type CodexPeerResponse,
} from "../../../shared/codex-peer-protocol";
import {
  CODEX_PEER_MAX_FRAME_BYTES,
  createCodexPeerFrameReader,
  encodeCodexPeerFrame,
  encodeCodexPeerJson,
} from "./CodexPeerFraming";

interface PendingResponse {
  resolve: (response: CodexPeerResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
interface InitializationWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}
interface RequestHandler {
  canHandle(params: unknown, request: CodexPeerRequest): boolean | Promise<boolean>;
  handle(request: CodexPeerRequest): unknown | Promise<unknown>;
}
type BroadcastHandler = (broadcast: CodexPeerBroadcast) => void | Promise<void>;
const INITIALIZING_CLIENT = "initializing-client";

/** One socket peer per manager service, including each renderer's Main-side service. */
export class CodexPeerClient {
  private socket: Socket | null = null;
  private clientId = INITIALIZING_CLIENT;
  private disposed = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly responses = new Map<string, PendingResponse>();
  private readonly initialization = new Set<InitializationWaiter>();
  private readonly requests = new Map<string, RequestHandler>();
  private readonly broadcasts = new Map<string, BroadcastHandler>();
  private readonly anyBroadcasts = new Set<BroadcastHandler>();

  constructor(
    private readonly getEndpoint: () => Promise<string>,
    private readonly onError: (error: unknown) => void,
    private readonly clientType = "desktop",
  ) {
    void this.connect();
  }

  getClientId(): string {
    return this.clientId;
  }

  async sendBroadcast(
    method: string,
    params: unknown,
    options: { targetClientIds?: readonly string[] } = {},
  ): Promise<void> {
    if (!this.socket?.writable) throw new Error("not-connected");
    if (options.targetClientIds?.length === 0) return;
    const message: CodexPeerBroadcast = {
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      targetClientIds: options.targetClientIds,
      params,
      version: codexPeerMethodVersion(method),
    };
    const json = JSON.stringify(message);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes > CODEX_PEER_MAX_FRAME_BYTES) {
      this.onError(new Error(`Dropping broadcast: payload too large (${bytes} bytes)`));
      return;
    }
    this.socket.write(encodeCodexPeerJson(json));
  }

  sendRequest(
    method: string,
    params: unknown,
    options: { targetClientId?: string; hostId?: string; timeoutMs?: number } = {},
  ): Promise<CodexPeerResponse> {
    const socket = this.socket;
    if (!socket?.writable) return Promise.reject(new Error("not-connected"));
    if (this.clientId === INITIALIZING_CLIENT && method !== "initialize")
      return Promise.reject(new Error("not-initialized"));
    const request: CodexPeerRequest = {
      type: "request",
      requestId: randomUUID(),
      sourceClientId: this.clientId,
      method,
      params,
      version: codexPeerRequestVersion(method, params, options.hostId),
      ...options,
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.responses.delete(request.requestId);
        reject(new Error("timeout"));
      }, options.timeoutMs ?? 5_000);
      this.responses.set(request.requestId, { resolve, reject, timer });
      socket.write(encodeCodexPeerFrame(request));
    });
  }

  addRequestHandler(
    method: string,
    canHandle: RequestHandler["canHandle"],
    handle: RequestHandler["handle"],
  ): () => void {
    this.requests.set(method, { canHandle, handle });
    return () => {
      this.requests.delete(method);
    };
  }

  addBroadcastHandler(method: string, handler: BroadcastHandler): () => void {
    this.broadcasts.set(method, handler);
    return () => {
      this.broadcasts.delete(method);
    };
  }

  addAnyBroadcastHandler(handler: BroadcastHandler): () => void {
    this.anyBroadcasts.add(handler);
    return () => {
      this.anyBroadcasts.delete(handler);
    };
  }

  waitUntilInitialized({ timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("disposed"));
    if (this.clientId !== INITIALIZING_CLIENT) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: InitializationWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      this.initialization.add(waiter);
      if (timeoutMs === undefined) return;
      timer = setTimeout(() => {
        this.initialization.delete(waiter);
        reject(new Error("initialization-timeout"));
      }, timeoutMs);
    });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    for (const waiter of this.initialization) waiter.reject(new Error("disposed"));
    this.initialization.clear();
    this.rejectPending("disposed");
    this.socket?.destroy();
  }

  private async connect(): Promise<void> {
    if (this.disposed) return;
    let endpoint: string;
    try {
      endpoint = await this.getEndpoint();
    } catch (error) {
      this.onError(error);
      this.scheduleReconnect();
      return;
    }
    if (this.disposed) return;
    const socket = connect(endpoint, () => {
      if (this.disposed) {
        socket.destroy();
        return;
      }
      this.socket = socket;
      const read = createCodexPeerFrameReader((message) => this.receive(message));
      socket.on("data", (data) => {
        try {
          read(data);
        } catch (error) {
          this.onError(error);
          socket.destroy();
        }
      });
      void this.sendRequest("initialize", { clientType: this.clientType }).catch(
        (error: unknown) => {
          this.onError(error);
          socket.destroy();
        },
      );
    });
    socket.on("error", this.onError);
    socket.on("close", () => {
      if (this.clientId !== INITIALIZING_CLIENT)
        this.emitLocalBroadcast("ipc-connection-reset", {});
      this.clientId = INITIALIZING_CLIENT;
      this.rejectPending("connection-closed");
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1_000);
  }

  private receive(message: CodexPeerMessage): void {
    switch (message.type) {
      case "broadcast":
        void this.broadcast(message).catch(this.onError);
        return;
      case "request":
        void this.request(message);
        return;
      case "client-discovery-request":
        void this.discover(message);
        return;
      case "client-discovery-response":
        return;
      case "response":
        this.response(message);
        return;
    }
  }

  private response(message: CodexPeerResponse): void {
    const pending = this.responses.get(message.requestId);
    if (!pending) return;
    this.responses.delete(message.requestId);
    clearTimeout(pending.timer);
    if (message.resultType === "success" && message.method === "initialize") {
      this.clientId = (message.result as { clientId: string }).clientId;
      for (const waiter of this.initialization) waiter.resolve();
      this.initialization.clear();
      this.emitLocalBroadcast("client-status-changed", {
        clientId: this.clientId,
        clientType: this.clientType,
        isSelf: true,
        status: "connected",
      });
    }
    pending.resolve(message);
  }

  private async broadcast(message: CodexPeerBroadcast): Promise<void> {
    if (message.targetClientIds && !message.targetClientIds.includes(this.clientId)) return;
    const handler = this.broadcasts.get(message.method);
    if (this.anyBroadcasts.size > 0)
      await Promise.all([...this.anyBroadcasts].map((handler) => handler(message)));
    await handler?.(message);
  }

  private async discover(
    message: Extract<CodexPeerMessage, { type: "client-discovery-request" }>,
  ): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    let canHandle = false;
    try {
      const request = message.request;
      const handler = this.requests.get(request.method);
      canHandle =
        acceptsCodexPeerRequestVersion(request) &&
        handler !== undefined &&
        (await handler.canHandle(request.params, request));
    } catch {
      /* Discovery failure is a negative capability response. */
    }
    socket.write(
      encodeCodexPeerFrame({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle },
      }),
    );
  }

  private async request(request: CodexPeerRequest): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    try {
      if (!acceptsCodexPeerRequestVersion(request)) throw new Error("request-version-mismatch");
      const handler = this.requests.get(request.method);
      if (!handler) throw new Error("no-handler-for-request");
      const result = await handler.handle(request);
      socket.write(
        encodeCodexPeerFrame({
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          method: request.method,
          handledByClientId: this.clientId,
          result,
        }),
      );
    } catch (error) {
      socket.write(
        encodeCodexPeerFrame({
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: error instanceof Error ? error.message : "error-handling-request",
        }),
      );
    }
  }

  private emitLocalBroadcast(method: string, params: unknown): void {
    void this.broadcast({
      type: "broadcast",
      method,
      sourceClientId: this.clientId,
      version: codexPeerMethodVersion(method),
      params,
    }).catch(this.onError);
  }

  private rejectPending(message: string): void {
    for (const pending of this.responses.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.responses.clear();
  }
}
