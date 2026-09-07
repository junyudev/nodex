import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { setImmediate } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectAppToolsPipe, listenAppToolsPipe, type AppToolsPipeDescriptor } from "./pipe";
import type { AppToolsHost } from "./server";

const barrier = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const withPipe = async (
  host: AppToolsHost,
  use: (descriptor: AppToolsPipeDescriptor, close: () => Promise<void>) => Promise<void>,
) => {
  const directory = await mkdtemp(join(tmpdir(), "nx-mcp-"));
  const descriptor = {
    path: join(directory, "host.sock"),
    token: randomUUID(),
    instanceId: randomUUID(),
  };
  const server = await listenAppToolsPipe(descriptor, host);
  try {
    await use(descriptor, server.close);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
};
const emptyHost: AppToolsHost = {
  listTools: async () => [],
  callTool: async () => ({ content: [] }),
};

const rawFrame = (value: unknown): Buffer => {
  const payload = Buffer.from(JSON.stringify(value));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  return Buffer.concat([prefix, payload]);
};
const authenticate = (descriptor: AppToolsPipeDescriptor) => ({
  jsonrpc: "2.0",
  id: 0,
  method: "nodex/authenticate",
  params: { version: 1, instanceId: descriptor.instanceId, token: descriptor.token },
});

const rawPeer = async (descriptor: AppToolsPipeDescriptor) => {
  const socket = createConnection(descriptor.path);
  socket.on("error", () => undefined);
  const replies: unknown[] = [];
  const receivers: ((value: unknown) => void)[] = [];
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 4) {
      const length = buffered.readUInt32LE(0);
      if (buffered.length < length + 4) return;
      const value: unknown = JSON.parse(buffered.subarray(4, length + 4).toString("utf8"));
      buffered = buffered.subarray(length + 4);
      const receiver = receivers.shift();
      if (receiver) receiver(value);
      else replies.push(value);
    }
  });
  await once(socket, "connect");
  return {
    socket,
    read: (): Promise<unknown> =>
      replies.length
        ? Promise.resolve(replies.shift())
        : new Promise((resolve) => receivers.push(resolve)),
  };
};

const closeRaw = async (socket: Socket) => {
  if (socket.destroyed) return;
  const closed = once(socket, "close");
  socket.destroy();
  await closed;
};

describe("private application tool pipe", () => {
  it("accepts fragmented prefixes and coalesced JSON-RPC calls with exact metadata", async () => {
    const calls: unknown[] = [];
    const metadata = {
      callId: "native-call",
      "x-codex-turn-metadata": { thread_id: "thread-a", turn_id: "turn-a" },
    };
    await withPipe(
      {
        listTools: async () => {
          calls.push("list");
          return [{ name: "read_page", inputSchema: { type: "object" } }];
        },
        callTool: async ({ signal: _signal, ...input }) => {
          calls.push(input);
          return {
            content: [{ type: "text", text: "第一行\nsecond line" }],
            structuredContent: { ok: true },
          };
        },
      },
      async (descriptor) => {
        const peer = await rawPeer(descriptor);
        try {
          const first = rawFrame(authenticate(descriptor));
          peer.socket.write(first.subarray(0, 2));
          await setImmediate();
          expect(calls).toEqual([]);
          peer.socket.write(first.subarray(2, first.length - 3));
          await setImmediate();
          expect(calls).toEqual([]);
          peer.socket.write(
            Buffer.concat([
              first.subarray(first.length - 3),
              rawFrame({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
              rawFrame({
                jsonrpc: "2.0",
                id: "call-2",
                method: "tools/call",
                params: { name: "read_page", arguments: { pageId: "page-a" }, _meta: metadata },
              }),
            ]),
          );
          const replies = await Promise.all([peer.read(), peer.read(), peer.read()]);
          expect(replies).toEqual(
            expect.arrayContaining([
              { jsonrpc: "2.0", id: 0, result: { version: 1, instanceId: descriptor.instanceId } },
              {
                jsonrpc: "2.0",
                id: 1,
                result: { tools: [{ name: "read_page", inputSchema: { type: "object" } }] },
              },
              {
                jsonrpc: "2.0",
                id: "call-2",
                result: {
                  content: [{ type: "text", text: "第一行\nsecond line" }],
                  structuredContent: { ok: true },
                },
              },
            ]),
          );
          expect(calls).toEqual([
            "list",
            { name: "read_page", arguments: { pageId: "page-a" }, metadata },
          ]);
        } finally {
          await closeRaw(peer.socket);
        }
      },
    );
  });

  it.each([0, 1024 * 1024 + 1])(
    "rejects a %s-byte declared frame before reading its payload",
    async (length) => {
      let calls = 0;
      await withPipe(
        {
          ...emptyHost,
          listTools: async () => {
            calls += 1;
            return [];
          },
        },
        async (descriptor) => {
          const peer = await rawPeer(descriptor);
          try {
            const closed = once(peer.socket, "close");
            const prefix = Buffer.alloc(4);
            prefix.writeUInt32LE(length);
            peer.socket.write(prefix);
            await closed;
            expect(calls).toBe(0);
          } finally {
            await closeRaw(peer.socket);
          }
        },
      );
    },
  );

  it("cancels only the matching private JSON-RPC call and keeps the connection usable", async () => {
    const admitted = barrier();
    const cancelled = barrier();
    let didCancel = false;
    let calls = 0;
    await withPipe(
      {
        ...emptyHost,
        callTool: async ({ signal }) => {
          calls += 1;
          signal.addEventListener(
            "abort",
            () => {
              didCancel = true;
              cancelled.resolve();
            },
            { once: true },
          );
          admitted.resolve();
          await cancelled.promise;
          return { content: [] };
        },
      },
      async (descriptor) => {
        const peer = await rawPeer(descriptor);
        try {
          peer.socket.write(rawFrame(authenticate(descriptor)));
          await peer.read();
          peer.socket.write(
            rawFrame({
              jsonrpc: "2.0",
              id: 7,
              method: "tools/call",
              params: { name: "wait_sessions", arguments: {}, _meta: {} },
            }),
          );
          await admitted.promise;
          peer.socket.write(rawFrame({ jsonrpc: "2.0", id: 8, method: "tools/cancel" }));
          peer.socket.write(rawFrame({ jsonrpc: "2.0", id: 10, method: "tools/list" }));
          expect(await peer.read()).toEqual({ jsonrpc: "2.0", id: 10, result: { tools: [] } });
          expect(didCancel).toBe(false);
          peer.socket.write(rawFrame({ jsonrpc: "2.0", id: 7, method: "tools/cancel" }));
          await cancelled.promise;
          peer.socket.write(rawFrame({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
          expect(await peer.read()).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [] } });
          expect(calls).toBe(1);
        } finally {
          await closeRaw(peer.socket);
        }
      },
    );
  });

  it("returns sanitized JSON-RPC host failures while keeping domain errors as tool results", async () => {
    await withPipe(
      {
        ...emptyHost,
        callTool: async ({ name }) => {
          if (name === "fail") throw new Error("private host detail");
          return {
            content: [{ type: "text", text: "Permission denied" }],
            isError: true,
            structuredContent: { code: "permission_denied" },
          };
        },
      },
      async (descriptor) => {
        const peer = await rawPeer(descriptor);
        try {
          peer.socket.write(rawFrame(authenticate(descriptor)));
          await peer.read();
          peer.socket.write(
            rawFrame({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "fail", arguments: {}, _meta: {} },
            }),
          );
          expect(await peer.read()).toEqual({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32603, message: "Application tool host failed" },
          });
          peer.socket.write(
            rawFrame({
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "read_page", arguments: {}, _meta: {} },
            }),
          );
          expect(await peer.read()).toEqual({
            jsonrpc: "2.0",
            id: 2,
            result: {
              content: [{ type: "text", text: "Permission denied" }],
              isError: true,
              structuredContent: { code: "permission_denied" },
            },
          });
        } finally {
          await closeRaw(peer.socket);
        }
      },
    );
  });

  it("rejects another instance or token before admitting any host request", async () => {
    let calls = 0;
    await withPipe(
      {
        ...emptyHost,
        listTools: async () => {
          calls += 1;
          return [];
        },
      },
      async (descriptor) => {
        await expect(connectAppToolsPipe({ ...descriptor, token: randomUUID() })).rejects.toThrow(
          "unavailable",
        );
        await expect(
          connectAppToolsPipe({ ...descriptor, instanceId: randomUUID() }),
        ).rejects.toThrow("unavailable");
        expect(calls).toBe(0);
        const client = await connectAppToolsPipe(descriptor);
        try {
          expect(await client.listTools(new AbortController().signal)).toEqual([]);
        } finally {
          client.close();
        }
        expect(calls).toBe(1);
      },
    );
  });

  it("preserves a typed tool result and invocation across the socket", async () => {
    const invocation = {
      name: "read_page",
      arguments: { pageId: "page-1" },
      metadata: { callId: "call-1" },
    };
    await withPipe(
      {
        ...emptyHost,
        callTool: async ({ signal: _signal, ...input }) => {
          expect(input).toEqual(invocation);
          return {
            content: [{ type: "text", text: "Page content" }],
            structuredContent: { pageId: "page-1" },
          };
        },
      },
      async (descriptor) => {
        const client = await connectAppToolsPipe(descriptor);
        try {
          const result = await client.callTool({
            ...invocation,
            signal: new AbortController().signal,
          });
          expect(result.structuredContent).toEqual({ pageId: "page-1" });
        } finally {
          client.close();
        }
      },
    );
  });

  it.each(["cancel", "disconnect", "shutdown"] as const)(
    "cancels pending host work on %s without replay",
    async (action) => {
      const admitted = barrier();
      const cancelled = barrier();
      let calls = 0;
      await withPipe(
        {
          ...emptyHost,
          callTool: async ({ signal }) => {
            calls += 1;
            signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
            admitted.resolve();
            await cancelled.promise;
            return { content: [] };
          },
        },
        async (descriptor, shutdown) => {
          const client = await connectAppToolsPipe(descriptor);
          const controller = new AbortController();
          try {
            const pending = client.callTool({
              name: "wait_sessions",
              arguments: {},
              metadata: {},
              signal: controller.signal,
            });
            const rejection = expect(pending).rejects.toThrow();
            await admitted.promise;
            if (action === "cancel") controller.abort();
            if (action === "disconnect") client.close();
            if (action === "shutdown") await shutdown();
            await cancelled.promise;
            await rejection;
            expect(calls).toBe(1);
          } finally {
            client.close();
          }
        },
      );
    },
  );

  it("rejects an oversized frame without invoking the host", async () => {
    let calls = 0;
    await withPipe(
      {
        ...emptyHost,
        callTool: async () => {
          calls += 1;
          return { content: [] };
        },
      },
      async (descriptor) => {
        const client = await connectAppToolsPipe(descriptor);
        try {
          await expect(
            client.callTool({
              name: "read_page",
              arguments: { body: "x".repeat(1024 * 1024) },
              metadata: {},
              signal: new AbortController().signal,
            }),
          ).rejects.toThrow("budget");
          expect(calls).toBe(0);
        } finally {
          client.close();
        }
      },
    );
  });
});
