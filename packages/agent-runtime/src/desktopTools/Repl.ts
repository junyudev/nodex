// @effect-diagnostics nodeBuiltinImport:off -- owns the signed Desktop Tool stdio process boundary
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CancelledNotificationSchema,
  ElicitRequestSchema,
  isJSONRPCRequest,
  isJSONRPCResponse,
  isJSONRPCErrorResponse,
  type ElicitRequest,
  type ElicitResult,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { HostDesktopTools } from "@nodex/provider-core/server/ExecutionHost";

import { spawnDesktopReplProcess } from "./ReplProcess.ts";

interface ReplOptions {
  readonly home: string;
  readonly sessionId: string;
  readonly server: HostDesktopTools["server"];
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | null;
  readonly elicit: (params: ElicitRequest["params"], signal: AbortSignal) => Promise<ElicitResult>;
}

/**
 * MCP's stock stdio transport adds ambient environment defaults and only kills its direct
 * child. This boundary uses MCP framing but owns the whole process group, without wrapping
 * or changing the host's signed node_repl -> codex -> node launcher.
 */
function desktopToolTransport(
  options: ReplOptions,
  onReceive: (message: JSONRPCMessage) => void,
): Transport {
  let child: ChildProcessWithoutNullStreams | undefined;
  let stop: (() => Promise<void>) | undefined;
  let closing: Promise<void> | undefined;
  let notifiedClosed = false;
  const notifyClosed = () => {
    if (notifiedClosed) return;
    notifiedClosed = true;
    transport.onclose?.();
  };
  const buffer = new ReadBuffer();
  const cancellationAcks = new Map<RequestId, { done: Promise<void>; resolve: () => void }>();
  const transport: Transport = {
    async start() {
      const launched = spawnDesktopReplProcess(options.home, options.sessionId, {
        command: options.server.command,
        args: options.server.args,
        cwd: options.cwd ?? undefined,
        env: { ...options.environment, ...options.server.env },
      });
      child = launched.child;
      stop = launched.stop;
      // Runtime diagnostics can contain code or private configuration; never relay stderr.
      child.stderr.resume();
      child.stdin.on("error", (error) => transport.onerror?.(error));
      child.stdout.on("error", (error) => transport.onerror?.(error));
      child.stdout.on("data", (chunk: Buffer) => {
        try {
          buffer.append(chunk);
          for (
            let message = buffer.readMessage();
            message !== null;
            message = buffer.readMessage()
          ) {
            if (
              (isJSONRPCResponse(message) || isJSONRPCErrorResponse(message)) &&
              message.id !== undefined
            ) {
              cancellationAcks.get(message.id)?.resolve();
              cancellationAcks.delete(message.id);
            }
            onReceive(message);
            transport.onmessage?.(message);
          }
        } catch {
          transport.onerror?.(new Error("Invalid Desktop Tool MCP message"));
          void transport.close();
        }
      });
      child.once("exit", () => {
        notifyClosed();
        void transport.close();
      });
      await new Promise<void>((resolve, reject) => {
        child!.once("spawn", resolve);
        child!.once("error", reject);
      });
    },
    send(message: JSONRPCMessage) {
      return new Promise<void>((resolve, reject) => {
        if (!child || closing) return reject(new Error("Desktop Tool transport closed"));
        if ("method" in message && message.method === "notifications/cancelled") {
          const id = message.params?.requestId;
          if (typeof id === "string" || typeof id === "number") {
            let acknowledge = () => {};
            const done = new Promise<void>((resolve) => {
              acknowledge = resolve;
            });
            cancellationAcks.set(id, { done, resolve: acknowledge });
            // Never retain acknowledgments forever if a crashed child cannot answer.
            if (cancellationAcks.size > 64)
              cancellationAcks.delete(cancellationAcks.keys().next().value!);
          }
        }
        child.stdin.write(serializeMessage(message), (error) =>
          error ? reject(error) : resolve(),
        );
      });
    },
    close() {
      if (closing) return closing;
      closing = Promise.resolve().then(async () => {
        // Cancellation notifications are written before close. EOF alone leaves active kernels
        // alive; signal the owned group and bound graceful termination before escalating.
        if (cancellationAcks.size > 0) {
          await Promise.race([
            Promise.all([...cancellationAcks.values()].map((ack) => ack.done)),
            delay(1_000),
          ]);
          cancellationAcks.clear();
        }
        child?.stdin.end();
        try {
          await stop?.();
        } finally {
          buffer.clear();
          notifyClosed();
        }
      });
      return closing;
    },
  };
  return transport;
}

/** One lazy client per Thread. Concurrent callers share startup and a crash clears the slot. */
export function makeRepl(options: ReplOptions) {
  let current: Promise<Client> | undefined;
  let running: Client | undefined;
  const transports = new Set<Transport>();
  let closed = false;

  const get = () => {
    if (closed) return Promise.reject(new Error("Desktop Tool runtime closed"));
    if (current) return current;
    const elicitations = new Map<RequestId, AbortController>();
    const transport = desktopToolTransport(options, (message) => {
      if (isJSONRPCRequest(message) && message.method === "elicitation/create") {
        elicitations.set(message.id, new AbortController());
      }
    });
    transports.add(transport);
    const client = new Client(
      { name: "nodex-desktop-tools", version: "1" },
      { capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const controller = elicitations.get(extra.requestId);
      if (!controller) return { action: "cancel" };
      try {
        return await options.elicit(
          request.params,
          AbortSignal.any([extra.signal, controller.signal]),
        );
      } finally {
        elicitations.delete(extra.requestId);
      }
    });
    // MCP SDK 1.32.2 ignores requestId 0. The controller is installed before SDK
    // dispatch so a cancellation in the same read can also find it.
    client.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
      if (params.requestId !== undefined) elicitations.get(params.requestId)?.abort();
    });
    const forget = () => {
      if (current === starting) current = undefined;
      if (running === client) running = undefined;
      for (const controller of elicitations.values()) controller.abort();
      void transport.close().then(() => transports.delete(transport));
    };
    // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Protocol uses a callback
    client.onclose = forget;
    // A crashed launcher can leave descendants alive briefly. Drain its group before
    // starting another one for the same Thread.
    const previous = [...transports].filter((entry) => entry !== transport);
    const starting = Promise.all(previous.map((entry) => entry.close()))
      .then(() => {
        if (closed) throw new Error("Desktop Tool runtime closed");
        return client.connect(transport, { timeout: 30_000 });
      })
      .then(() => {
        if (closed || current !== starting) throw new Error("Desktop Tool runtime closed");
        running = client;
        return client;
      })
      .catch(() => {
        forget();
        throw new Error("Desktop Tool runtime unavailable");
      });
    current = starting;
    return starting;
  };

  const close = async () => {
    closed = true;
    // Let outstanding SDK abort handlers write their cancellation before closing stdin.
    await Promise.resolve();
    await Promise.all([...transports].map((transport) => transport.close()));
  };
  return { get, running: () => running, close };
}
