import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import type { CodexPeerMessage } from "../../../shared/codex-peer-protocol";
import {
  createCodexPeerFrameReader,
  encodeCodexPeerFrame,
  encodeCodexPeerJson,
} from "./CodexPeerFraming";
import { CodexPeerMetrics, codexPeerMetrics, writeCodexPeerFrame } from "./CodexPeerMetrics";

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
    for (let offset = 8; offset < frame.length; offset++) read(frame.subarray(offset, offset + 1));
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
    expect(after.main_ipc_router_tx_pending_frames).toBe(before.main_ipc_router_tx_pending_frames);
    expect(after.main_ipc_router_tx_write_failures_total).toBe(
      before.main_ipc_router_tx_write_failures_total! + 1,
    );
    receive.close();
    write.mockRestore();
    socket.destroy();
  });
});
