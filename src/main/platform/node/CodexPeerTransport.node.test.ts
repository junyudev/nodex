/* oxlint-disable effecttsgo/async-function, effecttsgo/new-promise -- These tests exercise real Node sockets and their native completion callbacks. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexPeerMessage } from "../../../shared/codex-peer-protocol";
import { CodexPeerClient } from "./CodexPeerClient";
import { CodexPeerRouter } from "./CodexPeerRouter";
import {
  CODEX_PEER_MAX_FRAME_BYTES,
  createCodexPeerFrameReader,
  encodeCodexPeerFrame,
} from "./CodexPeerFraming";

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function network() {
  const directory = await mkdtemp(join(tmpdir(), "nodex-peer-"));
  const endpoint = join(directory, "ipc.sock");
  const server = createServer();
  const errors = vi.fn();
  const router = new CodexPeerRouter(server, errors);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(endpoint, resolve);
  });
  cleanup.push(async () => {
    router.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const createClient = () => {
    const client = new CodexPeerClient(() => Promise.resolve(endpoint), errors);
    cleanup.push(() => client.dispose());
    return client;
  };
  return { createClient, errors, server };
}

describe("peer socket framing", () => {
  it("decodes split headers, every UTF-8 byte boundary and coalesced frames", () => {
    const message: CodexPeerMessage = {
      type: "broadcast",
      method: "test",
      sourceClientId: "a",
      version: 0,
      params: "汉字 😀",
    };
    const frame = encodeCodexPeerFrame(message);
    expect(frame.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(message)));
    for (let boundary = 1; boundary < frame.length; boundary += 1) {
      const received: CodexPeerMessage[] = [];
      const read = createCodexPeerFrameReader((value) => {
        received.push(value);
      });
      read(frame.subarray(0, boundary));
      read(Buffer.concat([frame.subarray(boundary), frame]));
      expect(received).toEqual([message, message]);
    }
  });

  it("rejects zero and oversized announced payloads before allocating their contents", () => {
    for (const length of [0, CODEX_PEER_MAX_FRAME_BYTES + 1]) {
      const read = createCodexPeerFrameReader(() => {});
      const header = Buffer.alloc(4);
      header.writeUInt32LE(length);
      expect(() => read(header)).toThrow("Invalid frame length");
    }
  });

  it("compacts heavily fragmented UTF-8 text without truncating a surrogate pair", () => {
    const message: CodexPeerMessage = {
      type: "broadcast",
      method: "test",
      sourceClientId: "a",
      version: 0,
      params: "😀汉".repeat(400),
    };
    const frame = encodeCodexPeerFrame(message);
    const received: CodexPeerMessage[] = [];
    const read = createCodexPeerFrameReader((value) => {
      received.push(value);
    });
    for (let i = 0; i < frame.length; i += 1) read(frame.subarray(i, i + 1));
    expect(received).toEqual([message]);
  });
});

describe("peer routing", () => {
  it("retries failed initialization without resetting an identity that was never established", async () => {
    const { createClient, server } = await network();
    server.prependOnceListener("connection", (socket) => socket.destroy());
    let connected: Socket | undefined;
    server.on("connection", (socket) => {
      connected = socket;
    });
    const client = createClient();
    const reset = vi.fn();
    client.addBroadcastHandler("ipc-connection-reset", reset);
    await client.waitUntilInitialized({ timeoutMs: 2500 });
    expect(reset).not.toHaveBeenCalled();
    const id = client.getClientId();
    connected?.destroy();
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ sourceClientId: id }));
  });

  it("fans out by registered client identity, excludes the sender and respects explicit empty targets", async () => {
    const { createClient } = await network();
    const a = createClient(),
      b = createClient(),
      c = createClient();
    const aMessages = vi.fn(),
      bMessages = vi.fn(),
      cMessages = vi.fn();
    a.addBroadcastHandler("thread-stream-state-changed", aMessages);
    b.addBroadcastHandler("thread-stream-state-changed", bMessages);
    c.addBroadcastHandler("thread-stream-state-changed", cMessages);
    await Promise.all([a, b, c].map((client) => client.waitUntilInitialized({ timeoutMs: 1000 })));
    await a.sendBroadcast("thread-stream-state-changed", { revision: 1 }, { targetClientIds: [] });
    await a.sendBroadcast(
      "thread-stream-state-changed",
      { revision: 2 },
      { targetClientIds: [a.getClientId(), b.getClientId()] },
    );
    await vi.waitFor(() => expect(bMessages).toHaveBeenCalledOnce());
    expect(bMessages.mock.calls[0]?.[0]).toMatchObject({
      sourceClientId: a.getClientId(),
      version: 11,
      params: { revision: 2 },
    });
    expect(aMessages).not.toHaveBeenCalled();
    expect(cMessages).not.toHaveBeenCalled();
  });

  it("replaces a disconnected peer identity without redirecting requests to its old identity", async () => {
    const { createClient, server } = await network();
    let ownerSocket: Socket | undefined;
    server.once("connection", (socket) => {
      ownerSocket = socket;
    });
    const owner = createClient();
    const handled = vi.fn(() => ({ ready: true }));
    owner.addRequestHandler("thread-owner-discovery", () => true, handled);
    await owner.waitUntilInitialized({ timeoutMs: 1000 });
    const originalId = owner.getClientId();
    const requester = createClient();
    await requester.waitUntilInitialized({ timeoutMs: 1000 });
    const reset = vi.fn();
    owner.addBroadcastHandler("ipc-connection-reset", reset);
    expect(ownerSocket).toBeDefined();
    ownerSocket?.destroy();
    await vi.waitFor(() => expect(reset).toHaveBeenCalledOnce());
    await owner.waitUntilInitialized({ timeoutMs: 2500 });
    const currentId = owner.getClientId();
    expect(currentId).not.toBe(originalId);
    expect(reset).toHaveBeenCalledWith(expect.objectContaining({ sourceClientId: originalId }));

    await expect(
      requester.sendRequest("thread-owner-discovery", {}, { targetClientId: originalId }),
    ).resolves.toMatchObject({ resultType: "error", error: "no-client-found" });
    expect(handled).not.toHaveBeenCalled();
    await expect(
      requester.sendRequest("thread-owner-discovery", {}, { targetClientId: currentId }),
    ).resolves.toMatchObject({ resultType: "success", handledByClientId: currentId });
    expect(handled).toHaveBeenCalledOnce();
  });

  it("discovers the first accepting owner and returns its identity on the response", async () => {
    const { createClient } = await network();
    const a = createClient(),
      b = createClient(),
      c = createClient();
    b.addRequestHandler(
      "thread-owner-discovery",
      () => false,
      () => {
        throw new Error("wrong owner");
      },
    );
    c.addRequestHandler(
      "thread-owner-discovery",
      () => true,
      () => ({ supportsUntrustedAppInput: true }),
    );
    await Promise.all([a, b, c].map((client) => client.waitUntilInitialized({ timeoutMs: 1000 })));
    expect(
      await a.sendRequest("thread-owner-discovery", { hostId: "local", conversationId: "t" }),
    ).toMatchObject({
      resultType: "success",
      handledByClientId: c.getClientId(),
      result: { supportsUntrustedAppInput: true },
    });
    expect(
      await a.sendRequest(
        "thread-owner-discovery",
        { hostId: "local", conversationId: "t" },
        { targetClientId: b.getClientId() },
      ),
    ).toMatchObject({ resultType: "error", error: "no-client-found" });
  });

  it("settles a routed request when its target disconnects", async () => {
    const { createClient } = await network();
    const a = createClient(),
      b = createClient();
    let entered: (() => void) | undefined;
    const admitted = new Promise<void>((resolve) => {
      entered = resolve;
    });
    b.addRequestHandler(
      "thread-follower-load-complete-history",
      () => true,
      () => {
        entered?.();
        return new Promise(() => {});
      },
    );
    await Promise.all([a, b].map((client) => client.waitUntilInitialized({ timeoutMs: 1000 })));
    const pending = a.sendRequest(
      "thread-follower-load-complete-history",
      { conversationId: "t" },
      { targetClientId: b.getClientId() },
    );
    await admitted;
    b.dispose();
    expect(await pending).toMatchObject({ resultType: "error", error: "client-disconnected" });
  });
});
