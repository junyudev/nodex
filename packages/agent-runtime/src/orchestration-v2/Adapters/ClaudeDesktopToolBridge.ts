// @effect-diagnostics nodeBuiltinImport:off -- owns the signed Desktop Tool stdio process boundary
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CancelledNotificationSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  ElicitRequestSchema,
  ListToolsRequestSchema,
  ListToolsResultSchema,
  McpError,
  ToolListChangedNotificationSchema,
  type ElicitRequest,
  type ElicitResult,
  type JSONRPCMessage,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { HostDesktopTools } from "@nodex/provider-core/server/ExecutionHost";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

export class ClaudeDesktopToolBridgeError extends Schema.TaggedError<ClaudeDesktopToolBridgeError>()(
  "ClaudeDesktopToolBridgeError",
  { message: Schema.String },
) {}

export type ClaudeDesktopToolElicitation = ElicitRequest["params"];
export type ClaudeDesktopToolElicitationResult = ElicitResult;

export interface ClaudeDesktopToolBridgeOptions {
  readonly server: HostDesktopTools["server"];
  /** Complete launch environment; the server's explicit bindings take precedence. */
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly cwd: string | undefined;
  readonly currentTurn: () => { readonly sessionId: string; readonly turnId: string } | undefined;
  readonly elicit: (
    params: ClaudeDesktopToolElicitation,
    options: { readonly signal: AbortSignal; readonly requestId: RequestId },
  ) => Promise<ElicitResult>;
  readonly callTimeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 65 * 60_000;
const TURN_ENDED_TIMEOUT_MS = 3_000;

/**
 * MCP's stock stdio transport adds ambient environment defaults and only kills its direct
 * child. This boundary uses MCP framing but owns the whole process group, without wrapping
 * or changing the host's signed node_repl -> codex -> node launcher.
 */
function desktopToolTransport(options: ClaudeDesktopToolBridgeOptions): Transport {
  let child: ChildProcessWithoutNullStreams | undefined;
  let closing: Promise<void> | undefined;
  let notifiedClosed = false;
  const notifyClosed = () => {
    if (notifiedClosed) return;
    notifiedClosed = true;
    transport.onclose?.();
  };
  const buffer = new ReadBuffer();
  const cancellationAcks = new Map<RequestId, { done: Promise<void>; resolve: () => void }>();
  const signalGroup = (signal: NodeJS.Signals | 0) => {
    if (!child?.pid) return false;
    try {
      if (process.platform === "win32") return child.kill(signal);
      process.kill(-child.pid, signal);
      return true;
    } catch {
      return false;
    }
  };
  const transport: Transport = {
    async start() {
      child = spawn(options.server.command, [...options.server.args], {
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        env: { ...options.environment, ...options.server.env },
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
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
            if ("id" in message && message.id !== undefined) {
              cancellationAcks.get(message.id)?.resolve();
              cancellationAcks.delete(message.id);
            }
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
            const { promise: done, resolve } = Promise.withResolvers<void>();
            cancellationAcks.set(id, { done, resolve });
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
        signalGroup("SIGTERM");
        const deadline = Date.now() + 1_000;
        while (signalGroup(0) && Date.now() < deadline) await delay(20);
        signalGroup("SIGKILL");
        buffer.clear();
        notifyClosed();
      });
      return closing;
    },
  };
  return transport;
}

/** One scoped bridge per Claude Session; each query must acquire a new mcpServer facade. */
export const makeClaudeDesktopToolBridge = Effect.fn("makeClaudeDesktopToolBridge")(function* (
  options: ClaudeDesktopToolBridgeOptions,
) {
  const context = yield* Effect.context();
  const runPromise = Effect.runPromiseWith(context);
  const lock = yield* Semaphore.make(1);
  const callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const facades = new Set<McpServer>();
  const calls = new Set<AbortController>();
  const transports = new Set<Transport>();
  let closed = false;
  let running: { client: Client; transport: Transport } | undefined;

  const start = Effect.tryPromise({
    async try() {
      if (closed) throw new Error("closed");
      if (running) return running.client;
      const transport = desktopToolTransport(options);
      transports.add(transport);
      const client = new Client(
        { name: "nodex-desktop-tools", version: "1" },
        { capabilities: { elicitation: { form: {} } } },
      );
      const resource = { client, transport };
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Protocol exposes onclose as a callback property
      client.onclose = () => {
        if (running === resource) running = undefined;
        void transport.close().then(() => transports.delete(transport));
      };
      const elicitations = new Map<RequestId, AbortController>();
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const controller = new AbortController();
        elicitations.set(extra.requestId, controller);
        try {
          return await options.elicit(request.params, {
            signal: AbortSignal.any([extra.signal, controller.signal]),
            requestId: extra.requestId,
          });
        } finally {
          elicitations.delete(extra.requestId);
        }
      });
      // MCP SDK 1.32.2 ignores requestId 0 in its default cancellation handler. The
      // child's first elicitation can have that valid ID, so own reverse-call cancellation.
      client.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
        if (params.requestId !== undefined) elicitations.get(params.requestId)?.abort();
      });
      client.setNotificationHandler(ToolListChangedNotificationSchema, async (notification) => {
        await Promise.allSettled(
          [...facades].map((facade) => facade.server.notification(notification)),
        );
      });
      try {
        await client.connect(transport, { timeout: 30_000 });
        running = resource;
        return client;
      } catch {
        await transport.close();
        throw new Error("start failed");
      }
    },
    catch: () => new ClaudeDesktopToolBridgeError({ message: "Desktop Tool runtime unavailable" }),
  });
  // Startup belongs to the Session, not to a caller waiting for its facade.
  const getClient = lock.withPermits(1)(start).pipe(Effect.uninterruptible);

  const close = Effect.sync(() => {
    closed = true;
    for (const controller of calls) controller.abort();
  }).pipe(
    Effect.andThen(
      lock.withPermits(1)(
        Effect.promise(async () => {
          await Promise.allSettled([...facades].map((facade) => facade.close()));
          const resource = running;
          running = undefined;
          await resource?.client.close();
          await Promise.all([...transports].map((transport) => transport.close()));
          transports.clear();
        }),
      ),
    ),
    Effect.uninterruptible,
  );
  yield* Effect.addFinalizer(() => close);

  const mcpServer: Effect.Effect<McpSdkServerConfigWithInstance, ClaudeDesktopToolBridgeError> =
    Effect.gen(function* () {
      const client = yield* getClient;
      return yield* Effect.sync(() => {
        const facade = new McpServer(
          client.getServerVersion() ?? { name: "node_repl", version: "1" },
          {
            ...(client.getInstructions() === undefined
              ? {}
              : { instructions: client.getInstructions()! }),
          },
        );
        facade.server.registerCapabilities({ tools: client.getServerCapabilities()?.tools ?? {} });
        facades.add(facade);
        // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Protocol exposes onclose as a callback property
        facade.server.onclose = () => {
          facades.delete(facade);
        };
        facade.server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
          const upstream = await runPromise(getClient);
          const result = await upstream.request(request, ListToolsResultSchema, {
            signal: extra.signal,
          });
          return {
            ...result,
            tools: result.tools
              .filter((tool) => {
                const visibility = tool._meta?.ui;
                return !(
                  typeof visibility === "object" &&
                  visibility !== null &&
                  Array.isArray(Reflect.get(visibility, "visibility")) &&
                  Reflect.get(visibility, "visibility").length === 0
                );
              })
              .map(({ annotations: _annotations, ...tool }) => ({
                ...tool,
                // Arbitrary REPL code must never bypass plan-mode or concurrency safeguards.
                _meta: { ...tool._meta, "anthropic/alwaysLoad": true },
              })),
          };
        });
        facade.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
          const turn = options.currentTurn();
          if (!turn || closed)
            return {
              content: [{ type: "text" as const, text: "Desktop tools require an active turn" }],
              isError: true,
            };
          // Hidden lifecycle tools are host-only even if a caller guesses their name.
          if (request.params.name === "turn_ended")
            return {
              content: [{ type: "text" as const, text: "Tool is reserved for the host" }],
              isError: true,
            };
          const controller = new AbortController();
          calls.add(controller);
          const signal = AbortSignal.any([extra.signal, controller.signal]);
          const token = request.params._meta?.progressToken;
          try {
            const upstream = await runPromise(getClient);
            const result = await upstream.request(
              {
                ...request,
                params: {
                  ...request.params,
                  _meta: {
                    ...request.params._meta,
                    callId: request.params._meta?.["claudecode/toolUseId"],
                    "x-codex-turn-metadata": {
                      session_id: turn.sessionId,
                      thread_id: turn.sessionId,
                      turn_id: turn.turnId,
                    },
                  },
                },
              },
              CallToolResultSchema,
              {
                signal,
                timeout: callTimeoutMs,
                ...(token === undefined
                  ? {}
                  : {
                      onprogress: (progress) => {
                        void extra
                          .sendNotification({
                            method: "notifications/progress",
                            params: { ...progress, progressToken: token },
                          })
                          .catch(() => {});
                      },
                    }),
              },
            );
            await runPromise(
              Effect.logDebug("Desktop tool completed", {
                tool: request.params.name,
                outcome: result.isError ? "error" : "success",
              }),
            );
            return result;
          } catch (error) {
            await runPromise(
              Effect.logDebug("Desktop tool failed", {
                tool: request.params.name,
                outcome: signal.aborted ? "cancelled" : "error",
              }),
            );
            // The REPL's own protocol answer tells the model what to change; a lost process does not.
            return {
              content: [
                {
                  type: "text" as const,
                  text: error instanceof McpError ? error.message : "Desktop tool call failed",
                },
              ],
              isError: true,
            };
          } finally {
            calls.delete(controller);
          }
        });
        return {
          type: "sdk" as const,
          name: "node_repl",
          instance: facade,
          timeout: callTimeoutMs,
        };
      });
    });

  const turnEnded = (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly hookEventName: string;
  }) =>
    Effect.promise(async () => {
      if (!running || closed) return;
      await running.client
        .request(
          {
            method: "tools/call",
            params: {
              name: "turn_ended",
              arguments: {
                hook_event_name: input.hookEventName,
                session_id: input.sessionId,
                turn_id: input.turnId,
              },
            },
          },
          CallToolResultSchema,
          { timeout: TURN_ENDED_TIMEOUT_MS },
        )
        .catch(() => {});
    });

  return { mcpServer, turnEnded, close };
});

export type ClaudeDesktopToolBridge = Effect.Success<
  ReturnType<typeof makeClaudeDesktopToolBridge>
>;
