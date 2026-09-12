/* oxlint-disable effecttsgo/async-function, effecttsgo/global-timers, effecttsgo/new-promise -- This Node socket adapter owns wire request deadlines and reconnect timers; its owning application Scope disposes the adapter and settles every pending request. */
import { randomUUID } from "node:crypto";
import type { Server, Socket } from "node:net";
import {
  codexPeerMethodVersion,
  type CodexPeerBroadcast,
  type CodexPeerMessage,
  type CodexPeerRequest,
  type CodexPeerResponse,
} from "../../../shared/codex-peer-protocol";
import { createCodexPeerFrameReader, encodeCodexPeerFrame } from "./CodexPeerFraming";

interface Peer {
  id: string;
  type: string;
  socket: Socket;
}
interface PendingRequest {
  sourceClientId: string;
  sourceSocket: Socket;
  targetClientId: string;
  timeout: ReturnType<typeof setTimeout>;
}
interface PendingDiscovery {
  clientId: string;
  resolve: (peer: Peer) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/** Socket protocol adapter. Conversation state and ownership remain in connected managers. */
export class CodexPeerRouter {
  private readonly clients = new Map<Socket, Peer>();
  private readonly clientsById = new Map<string, Peer>();
  private readonly requests = new Map<string, PendingRequest>();
  private readonly discoveries = new Map<string, PendingDiscovery>();
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly server: Server,
    private readonly onError: (error: unknown) => void,
  ) {
    server.on("connection", this.connect);
    server.on("close", this.closed);
  }

  dispose(): void {
    this.server.off("connection", this.connect);
    this.server.off("close", this.closed);
    this.closed();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }

  private readonly closed = (): void => {
    this.clients.clear();
    this.clientsById.clear();
    for (const [requestId, request] of this.requests) {
      clearTimeout(request.timeout);
      this.respondError(request.sourceSocket, requestId, "server-closed");
    }
    this.requests.clear();
    for (const discovery of this.discoveries.values()) {
      clearTimeout(discovery.timeout);
      discovery.reject(new Error("server-closed"));
    }
    this.discoveries.clear();
  };

  private readonly connect = (socket: Socket): void => {
    this.sockets.add(socket);
    const read = createCodexPeerFrameReader((message) => this.receive(socket, message));
    socket.on("data", (data) => {
      try {
        read(data);
      } catch (error) {
        this.onError(error);
        socket.destroy();
      }
    });
    socket.on("error", this.onError);
    socket.on("end", () => this.unregister(socket));
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.unregister(socket);
    });
  };

  private receive(socket: Socket, message: CodexPeerMessage): void {
    switch (message.type) {
      case "broadcast":
        this.broadcast(socket, message);
        return;
      case "request":
        void this.request(socket, message);
        return;
      case "response":
        this.response(message);
        return;
      case "client-discovery-response":
        this.discoveryResponse(message);
        return;
      case "client-discovery-request":
        return;
    }
  }

  private broadcast(source: Socket, message: CodexPeerBroadcast): void {
    const targets = message.targetClientIds === undefined ? null : new Set(message.targetClientIds);
    const recipients = [...this.clients.values()].filter(
      (peer) =>
        peer.socket !== source &&
        peer.socket.writable &&
        (targets === null || targets.has(peer.id)),
    );
    if (recipients.length === 0) return;
    const frame = encodeCodexPeerFrame({
      ...message,
      sourceClientId: this.clients.get(source)?.id ?? message.sourceClientId,
    });
    try {
      for (const peer of recipients) peer.socket.write(frame);
    } catch (error) {
      this.onError(error);
    }
  }

  private async request(source: Socket, message: CodexPeerRequest): Promise<void> {
    if (message.method === "initialize") {
      this.register(source, message);
      return;
    }
    try {
      const target = await this.findTarget(source, message);
      this.forwardRequest(source, target, message);
    } catch {
      this.respondError(source, message.requestId, "no-client-found");
    }
  }

  private async findTarget(source: Socket, request: CodexPeerRequest): Promise<Peer> {
    if (request.targetClientId) {
      const target = this.clientsById.get(request.targetClientId);
      if (!target || target.socket === source) throw new Error("client-not-found");
      return this.discover(target, request);
    }
    return Promise.any(
      [...this.clients.values()]
        .filter((peer) => peer.socket !== source)
        .map((peer) => this.discover(peer, request)),
    );
  }

  private discover(peer: Peer, request: CodexPeerRequest): Promise<Peer> {
    const requestId = randomUUID();
    const result = new Promise<Peer>((resolve, reject) => {
      this.discoveries.set(requestId, {
        clientId: peer.id,
        resolve,
        reject,
        timeout: setTimeout(() => {
          this.discoveries.delete(requestId);
          reject(new Error("timeout"));
        }, 10_000),
      });
    });
    peer.socket.write(
      encodeCodexPeerFrame({ type: "client-discovery-request", requestId, request }),
    );
    return result;
  }

  private discoveryResponse(
    message: Extract<CodexPeerMessage, { type: "client-discovery-response" }>,
  ): void {
    const discovery = this.discoveries.get(message.requestId);
    if (!discovery) return;
    this.discoveries.delete(message.requestId);
    clearTimeout(discovery.timeout);
    const peer = this.clientsById.get(discovery.clientId);
    if (message.response?.canHandle === true && peer) {
      discovery.resolve(peer);
      return;
    }
    discovery.reject(
      new Error(
        message.response?.canHandle ? "client-disconnected" : "client-cannot-handle-request",
      ),
    );
  }

  private forwardRequest(source: Socket, peer: Peer, request: CodexPeerRequest): void {
    this.requests.set(request.requestId, {
      sourceClientId: request.sourceClientId,
      sourceSocket: source,
      targetClientId: peer.id,
      timeout: setTimeout(() => {
        if (!this.requests.delete(request.requestId)) return;
        this.respondError(source, request.requestId, "request-timeout");
      }, request.timeoutMs ?? 10_000),
    });
    peer.socket.write(encodeCodexPeerFrame(request));
  }

  private response(response: CodexPeerResponse): void {
    const request = this.requests.get(response.requestId);
    if (!request) return;
    clearTimeout(request.timeout);
    this.requests.delete(response.requestId);
    if (request.sourceSocket.writable) request.sourceSocket.write(encodeCodexPeerFrame(response));
  }

  private register(socket: Socket, request: CodexPeerRequest): void {
    const params = request.params as { clientType: string };
    let peer = this.clients.get(socket);
    if (!peer) {
      peer = { id: randomUUID(), type: params.clientType, socket };
      this.clients.set(socket, peer);
      this.clientsById.set(peer.id, peer);
      this.broadcastStatus(peer, "connected");
    }
    socket.write(
      encodeCodexPeerFrame({
        type: "response",
        requestId: request.requestId,
        resultType: "success",
        method: "initialize",
        handledByClientId: peer.id,
        result: { clientId: peer.id },
      }),
    );
  }

  private unregister(socket: Socket): void {
    const peer = this.clients.get(socket);
    if (!peer) return;
    this.clients.delete(socket);
    this.clientsById.delete(peer.id);
    this.broadcastStatus(peer, "disconnected");
    for (const [id, request] of this.requests) {
      if (request.sourceClientId !== peer.id && request.targetClientId !== peer.id) continue;
      clearTimeout(request.timeout);
      this.requests.delete(id);
      if (request.sourceClientId !== peer.id)
        this.respondError(request.sourceSocket, id, "client-disconnected");
    }
    for (const [id, discovery] of this.discoveries) {
      if (discovery.clientId !== peer.id) continue;
      clearTimeout(discovery.timeout);
      this.discoveries.delete(id);
      discovery.reject(new Error("client-disconnected"));
    }
  }

  private broadcastStatus(peer: Peer, status: "connected" | "disconnected"): void {
    const frame = encodeCodexPeerFrame({
      type: "broadcast",
      method: "client-status-changed",
      sourceClientId: peer.id,
      version: codexPeerMethodVersion("client-status-changed"),
      params: { clientId: peer.id, clientType: peer.type, status },
    });
    for (const recipient of this.clients.values()) {
      if (recipient.id !== peer.id) recipient.socket.write(frame);
    }
  }

  private respondError(socket: Socket, requestId: string, error: string): void {
    if (socket.writable)
      socket.write(
        encodeCodexPeerFrame({ type: "response", requestId, resultType: "error", error }),
      );
  }
}
