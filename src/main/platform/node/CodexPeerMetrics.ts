import { performance } from "node:perf_hooks";
import type { Socket } from "node:net";
import type { CodexPeerMessage } from "../../../shared/codex-peer-protocol";

const roles = ["client", "router"] as const;
const categories = [
  "snapshot",
  "patches",
  "follower_coordination",
  "other_request",
  "other_response",
  "other_broadcast",
  "unknown",
] as const;
type PeerRole = (typeof roles)[number];
type FrameCategory = (typeof categories)[number];

export interface CodexPeerReceiveMetrics {
  readonly begin: (bytes: number) => void;
  readonly decode: (bytes: number) => void;
  readonly endDecode: () => void;
  readonly complete: (message: CodexPeerMessage) => void;
  readonly fail: () => void;
  readonly close: () => void;
}
interface Connection {
  readonly socket: Socket;
  readonly role: PeerRole;
  active: boolean;
  announcedBytes: number;
  receivedBytes: number;
  startedAtMs: number;
  decoding: boolean;
  decodeStartedAtMs: number;
  pendingWrites: number;
  pendingWriteBytes: number;
  closed: boolean;
}

const category = (message: CodexPeerMessage): FrameCategory => {
  if (message.type === "request") return "other_request";
  if (message.type === "response") return "other_response";
  if (message.type !== "broadcast") return "unknown";
  if (message.method === "thread-stream-state-changed") {
    const params = message.params;
    const change =
      params !== null && typeof params === "object" && "change" in params ? params.change : null;
    const type =
      change !== null && typeof change === "object" && "type" in change ? change.type : null;
    return type === "snapshot" || type === "patches" ? type : "unknown";
  }
  if (
    message.method === "thread-stream-following-changed" ||
    message.method === "thread-stream-following-status-requested"
  )
    return "follower_coordination";
  return "other_broadcast";
};

/** Incremental numeric counters retain sockets only until their close/error boundary. */
export class CodexPeerMetrics {
  private readonly connections = new Map<Socket, Connection>();
  private readonly totals: Record<string, number> = {};

  constructor(private readonly now: () => number = () => performance.now()) {
    for (const role of roles) {
      for (const field of [
        "rx_announced_frames_total",
        "rx_announced_bytes_total",
        "rx_frame_bytes_max",
        "rx_failures_total",
        "rx_abandoned_frames_total",
        "rx_decode_ms_total",
        "rx_decode_chunk_ms_max",
        "tx_frames_total",
        "tx_bytes_total",
        "tx_frame_bytes_max",
        "tx_backpressure_total",
        "tx_write_failures_total",
        "tx_abandoned_frames_total",
        "tx_abandoned_bytes_total",
        "tx_socket_pending_bytes_max",
        "tx_socket_writable_bytes_max",
      ])
        this.totals[`main_ipc_${role}_${field}`] = 0;
      for (const kind of categories) {
        for (const field of ["frames_total", "bytes_total", "bytes_max"])
          this.totals[`main_ipc_${role}_rx_${kind}_${field}`] = 0;
      }
    }
  }

  attach(socket: Socket, role: PeerRole): CodexPeerReceiveMetrics {
    const state: Connection = {
      socket,
      role,
      active: false,
      announcedBytes: 0,
      receivedBytes: 0,
      startedAtMs: 0,
      decoding: false,
      decodeStartedAtMs: 0,
      pendingWrites: 0,
      pendingWriteBytes: 0,
      closed: false,
    };
    this.connections.set(socket, state);
    const rx = `main_ipc_${role}_rx_`;
    const endDecode = () => {
      if (!state.decoding) return;
      const elapsed = Math.max(0, this.now() - state.decodeStartedAtMs);
      this.add(`${rx}decode_ms_total`, elapsed);
      this.max(`${rx}decode_chunk_ms_max`, elapsed);
      state.decoding = false;
    };
    const close = () => {
      if (state.closed) return;
      endDecode();
      if (state.active) this.add(`${rx}abandoned_frames_total`, 1);
      this.add(`main_ipc_${role}_tx_abandoned_frames_total`, state.pendingWrites);
      this.add(`main_ipc_${role}_tx_abandoned_bytes_total`, state.pendingWriteBytes);
      state.closed = true;
      this.connections.delete(socket);
      socket.off("close", close);
      socket.off("error", close);
    };
    socket.on("close", close);
    socket.on("error", close);
    return {
      begin: (bytes) => {
        if (state.closed) return;
        state.active = true;
        state.announcedBytes = bytes;
        state.receivedBytes = 0;
        state.startedAtMs = this.now();
        this.add(`${rx}announced_frames_total`, 1);
        this.add(`${rx}announced_bytes_total`, bytes);
        this.max(`${rx}frame_bytes_max`, bytes);
      },
      decode: (bytes) => {
        if (state.closed) return;
        state.receivedBytes += bytes;
        state.decoding = true;
        state.decodeStartedAtMs = this.now();
      },
      endDecode,
      complete: (message) => {
        if (state.closed) return;
        endDecode();
        const kind = category(message);
        this.add(`${rx}${kind}_frames_total`, 1);
        this.add(`${rx}${kind}_bytes_total`, state.announcedBytes);
        this.max(`${rx}${kind}_bytes_max`, state.announcedBytes);
        state.active = false;
      },
      fail: () => {
        if (state.closed) return;
        this.add(`${rx}failures_total`, 1);
        close();
      },
      close,
    };
  }

  beginWrite(socket: Socket, bytes: number): ((error?: Error | null) => void) | undefined {
    const state = this.connections.get(socket);
    if (!state) return;
    const tx = `main_ipc_${state.role}_tx_`;
    state.pendingWrites += 1;
    state.pendingWriteBytes += bytes;
    this.add(`${tx}frames_total`, 1);
    this.add(`${tx}bytes_total`, bytes);
    this.max(`${tx}frame_bytes_max`, bytes);
    this.max(`${tx}socket_pending_bytes_max`, state.pendingWriteBytes);
    let completed = false;
    return (error) => {
      if (completed || state.closed) return;
      completed = true;
      state.pendingWrites -= 1;
      state.pendingWriteBytes -= bytes;
      if (error != null) this.add(`${tx}write_failures_total`, 1);
    };
  }

  wrote(socket: Socket, accepted: boolean): void {
    const state = this.connections.get(socket);
    if (!state) return;
    const tx = `main_ipc_${state.role}_tx_`;
    if (!accepted) this.add(`${tx}backpressure_total`, 1);
    this.max(`${tx}socket_writable_bytes_max`, socket.writableLength);
  }

  /** Collection scales with live connections and never traverses conversation data. */
  snapshot(): Record<string, number> {
    const result = { ...this.totals };
    const now = this.now();
    result.main_ipc_sample_monotonic_ms = now;
    for (const role of roles) {
      for (const field of [
        "connections",
        "rx_active_frames",
        "rx_active_announced_bytes",
        "rx_active_received_bytes",
        "rx_oldest_active_ms",
        "rx_decoding_frames",
        "tx_pending_frames",
        "tx_pending_bytes",
        "tx_writable_bytes",
      ])
        result[`main_ipc_${role}_${field}`] = 0;
    }
    for (const state of this.connections.values()) {
      const prefix = `main_ipc_${state.role}_`;
      result[`${prefix}connections`]! += 1;
      if (state.active) {
        result[`${prefix}rx_active_frames`]! += 1;
        result[`${prefix}rx_active_announced_bytes`]! += state.announcedBytes;
        result[`${prefix}rx_active_received_bytes`]! += state.receivedBytes;
        result[`${prefix}rx_oldest_active_ms`] = Math.max(
          result[`${prefix}rx_oldest_active_ms`]!,
          now - state.startedAtMs,
        );
      }
      if (state.decoding) result[`${prefix}rx_decoding_frames`]! += 1;
      result[`${prefix}tx_pending_frames`]! += state.pendingWrites;
      result[`${prefix}tx_pending_bytes`]! += state.pendingWriteBytes;
      result[`${prefix}tx_writable_bytes`]! += state.socket.writableLength;
    }
    return result;
  }

  private add(key: string, value: number): void {
    this.totals[key] = (this.totals[key] ?? 0) + value;
  }
  private max(key: string, value: number): void {
    this.totals[key] = Math.max(this.totals[key] ?? 0, value);
  }
}

export const codexPeerMetrics = new CodexPeerMetrics();

/** write(false) is measured pressure; the wire adapter still relies on Node's write queue. */
export function writeCodexPeerFrame(socket: Socket, frame: Buffer): void {
  const complete = codexPeerMetrics.beginWrite(socket, frame.length);
  try {
    codexPeerMetrics.wrote(socket, socket.write(frame, complete));
  } catch (error) {
    complete?.(new Error("IPC write failed"));
    throw error;
  }
}
