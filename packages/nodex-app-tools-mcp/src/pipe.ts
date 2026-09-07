import { timingSafeEqual } from "node:crypto";
import { createConnection, createServer, type Socket } from "node:net";
import {
  CallToolResultSchema,
  ErrorCode,
  McpError,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { APP_TOOLS_CALL_TIMEOUT_MS } from "./manifest";
import type { AppToolsHost } from "./server";

export { APP_TOOLS_CALL_TIMEOUT_MS } from "./manifest";

const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_PENDING = 32;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const AUTHENTICATION_ID = 0;
const object = z.record(z.string(), z.unknown());
const requestId = z.union([z.number().int().safe().nonnegative(), z.string().min(1).max(80)]);
const envelope = { jsonrpc: z.literal("2.0"), id: requestId };
const call = z.strictObject({
  name: z.string().min(1).max(128),
  arguments: object,
  _meta: object,
});
const authentication = z.strictObject({
  ...envelope,
  method: z.literal("nodex/authenticate"),
  params: z.strictObject({
    version: z.literal(1),
    instanceId: z.string().uuid(),
    token: z.string().max(256),
  }),
});
const authenticated = z.strictObject({ version: z.literal(1), instanceId: z.string().uuid() });
const request = z.discriminatedUnion("method", [
  z.strictObject({ ...envelope, method: z.literal("tools/list") }),
  z.strictObject({ ...envelope, method: z.literal("tools/call"), params: call }),
  z.strictObject({ ...envelope, method: z.literal("tools/cancel") }),
]);
const response = z.union([
  z.strictObject({ ...envelope, result: z.unknown() }),
  z.strictObject({
    ...envelope,
    error: z.strictObject({ code: z.number().int(), message: z.string() }),
  }),
]);

export interface AppToolsPipeDescriptor {
  readonly path: string;
  readonly instanceId: string;
  readonly token: string;
}

/** Private JSON-RPC frames have a four-byte little-endian payload length, including fragmented reads. */
const frames = (socket: Socket, receive: (value: unknown) => void) => {
  const header = Buffer.allocUnsafe(4);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let headerBytes = 0;
  let payload: Buffer | null = null;
  let payloadBytes = 0;
  socket.on("data", (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length && !socket.destroyed) {
      if (!payload) {
        const size = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + size);
        offset += size;
        headerBytes += size;
        if (headerBytes !== 4) continue;
        const length = header.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) return void socket.destroy();
        payload = Buffer.allocUnsafe(length);
        payloadBytes = 0;
      }
      const size = Math.min(payload.length - payloadBytes, chunk.length - offset);
      chunk.copy(payload, payloadBytes, offset, offset + size);
      offset += size;
      payloadBytes += size;
      if (payloadBytes !== payload.length) continue;
      try {
        receive(JSON.parse(decoder.decode(payload)));
      } catch {
        return void socket.destroy();
      }
      headerBytes = 0;
      payload = null;
    }
  });
};

const send = (socket: Socket, value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  if (
    payload.length > MAX_FRAME_BYTES ||
    socket.writableLength + payload.length + 4 > MAX_FRAME_BYTES + 4
  ) {
    socket.destroy();
    throw new Error("Application tool pipe budget exceeded");
  }
  if (socket.destroyed) throw new Error("Application tool pipe closed");
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
};

const equalSecret = (received: string, expected: string) => {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
};

/** Node transport only. The owning Main Scope must close the lease. */
export const listenAppToolsPipe = async (
  descriptor: AppToolsPipeDescriptor,
  host: AppToolsHost,
): Promise<{ close: () => Promise<void> }> => {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= 64) return void socket.destroy();
    sockets.add(socket);
    const pending = new Map<z.infer<typeof requestId>, AbortController>();
    let authorized = false;
    const handshakeTimer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
      clearTimeout(handshakeTimer);
      sockets.delete(socket);
      for (const controller of pending.values()) controller.abort();
      pending.clear();
    });
    const execute = async (
      message: Exclude<z.infer<typeof request>, { method: "tools/cancel" }>,
    ) => {
      if (pending.has(message.id) || pending.size >= MAX_PENDING) return void socket.destroy();
      const controller = new AbortController();
      pending.set(message.id, controller);
      const timer = setTimeout(() => controller.abort(), APP_TOOLS_CALL_TIMEOUT_MS);
      const clearCallTimer = () => clearTimeout(timer);
      controller.signal.addEventListener("abort", clearCallTimer, { once: true });
      try {
        const result =
          message.method === "tools/list"
            ? { tools: await host.listTools(controller.signal) }
            : await host.callTool({
                name: message.params.name,
                arguments: message.params.arguments,
                metadata: message.params._meta,
                signal: controller.signal,
              });
        if (!controller.signal.aborted && !socket.destroyed)
          send(socket, { jsonrpc: "2.0", id: message.id, result });
      } catch {
        if (!controller.signal.aborted && !socket.destroyed)
          send(socket, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: ErrorCode.InternalError, message: "Application tool host failed" },
          });
      } finally {
        clearCallTimer();
        controller.signal.removeEventListener("abort", clearCallTimer);
        pending.delete(message.id);
      }
    };
    frames(socket, (value) => {
      if (!authorized) {
        const message = authentication.parse(value);
        if (
          message.params.instanceId !== descriptor.instanceId ||
          !equalSecret(message.params.token, descriptor.token)
        )
          return void socket.destroy();
        authorized = true;
        clearTimeout(handshakeTimer);
        send(socket, {
          jsonrpc: "2.0",
          id: message.id,
          result: { version: 1, instanceId: descriptor.instanceId },
        });
        return;
      }
      const message = request.parse(value);
      if (message.method === "tools/cancel") {
        pending.get(message.id)?.abort();
        return;
      }
      void execute(message).catch(() => socket.destroy());
    });
  });
  await new Promise<void>((accept, reject) => {
    server.once("error", reject);
    server.listen(descriptor.path, () => {
      server.off("error", reject);
      accept();
    });
  });
  // Runtime accept errors terminate this endpoint; callers fail instead of drifting to another host.
  server.on("error", () => {
    for (const socket of sockets) socket.destroy();
  });
  let closing: Promise<void> | undefined;
  return {
    close: () =>
      (closing ??= new Promise<void>((accept, reject) => {
        for (const socket of sockets) socket.destroy();
        server.close((error) => (error ? reject(error) : accept()));
      })),
  };
};

/** Each stdio process has one authenticated connection; lost calls are never replayed. */
export const connectAppToolsPipe = async (
  descriptor: AppToolsPipeDescriptor,
): Promise<AppToolsHost & { close: () => void }> => {
  const socket = createConnection(descriptor.path);
  const pending = new Map<
    z.infer<typeof requestId>,
    {
      accept: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  let nextId = 1;
  const closed = () => {
    for (const receiver of pending.values())
      receiver.reject(new Error("Application tool pipe closed"));
    pending.clear();
  };
  socket.on("error", () => socket.destroy());
  socket.once("close", closed);
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => socket.destroy(), HANDSHAKE_TIMEOUT_MS);
    let authorized = false;
    const fail = () => {
      clearTimeout(timer);
      reject(new Error("Application tool host unavailable"));
    };
    socket.once("close", fail);
    frames(socket, (value) => {
      const message = response.parse(value);
      if (!authorized) {
        if (
          message.id !== AUTHENTICATION_ID ||
          "error" in message ||
          authenticated.parse(message.result).instanceId !== descriptor.instanceId
        )
          return void socket.destroy();
        authorized = true;
        clearTimeout(timer);
        socket.off("close", fail);
        accept();
        return;
      }
      const receiver = pending.get(message.id);
      if (!receiver) return;
      pending.delete(message.id);
      if ("error" in message)
        receiver.reject(new McpError(message.error.code, message.error.message));
      else receiver.accept(message.result);
    });
    socket.once("connect", () => {
      try {
        send(socket, {
          jsonrpc: "2.0",
          id: AUTHENTICATION_ID,
          method: "nodex/authenticate",
          params: { version: 1, instanceId: descriptor.instanceId, token: descriptor.token },
        });
      } catch {
        socket.destroy();
      }
    });
  });
  const invoke = (
    input: { method: "tools/list" } | { method: "tools/call"; params: z.infer<typeof call> },
    signal: AbortSignal,
  ): Promise<unknown> => {
    if (signal.aborted) return Promise.reject(new Error("Application tool call cancelled"));
    if (pending.size >= MAX_PENDING)
      return Promise.reject(new Error("Application tool pipe is busy"));
    return new Promise((accept, reject) => {
      const id = nextId++;
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        pending.delete(id);
      };
      const cancel = () => {
        finish();
        if (!socket.destroyed) {
          try {
            send(socket, { jsonrpc: "2.0", id, method: "tools/cancel" });
          } catch {
            socket.destroy();
          }
        }
        reject(new Error("Application tool call cancelled"));
      };
      const timer = setTimeout(cancel, APP_TOOLS_CALL_TIMEOUT_MS);
      pending.set(id, {
        accept: (value) => {
          finish();
          accept(value);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) return cancel();
      try {
        send(socket, { jsonrpc: "2.0", id, ...input });
      } catch (error) {
        finish();
        reject(error);
      }
    });
  };
  return {
    listTools: async (signal) =>
      z
        .strictObject({ tools: ToolSchema.array() })
        .parse(await invoke({ method: "tools/list" }, signal)).tools,
    callTool: async ({ signal, name, arguments: args, metadata }) =>
      CallToolResultSchema.parse(
        await invoke(
          { method: "tools/call", params: { name, arguments: args, _meta: metadata } },
          signal,
        ),
      ),
    close: () => socket.destroy(),
  };
};
