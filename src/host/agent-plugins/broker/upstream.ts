import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  ErrorCode,
  isJSONRPCRequest,
  McpError,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { PluginMcpLeaseScope } from "../../../shared/agent-plugins/mcp-lease";
import { remoteEndpoint } from "../../../shared/agent-plugins/portable-1.0.0";
import type { AgentPluginMcpServer } from "../../../shared/agent-plugins/types";
import {
  PluginMcpFailure,
  type PluginMcpBrokerOptions,
  type PluginMcpInstallation,
} from "./contract";
import { prepareStdio } from "./stdio";

export const timeout = (duration: number) =>
  Effect.timeoutOrElse({ duration, orElse: () => Effect.fail(new PluginMcpFailure("timeout")) });

const invalidConfiguration = () => new PluginMcpFailure("invalid_configuration");
const unavailable = () => new PluginMcpFailure("upstream_unavailable");

const reservedHeaders = new Set([
  "accept",
  "connection",
  "content-length",
  "content-type",
  "host",
  "origin",
  "transfer-encoding",
  "last-event-id",
  "proxy-authorization",
]);

function upstreamHeaders(values: Readonly<Record<string, string>>) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values)) {
    const key = name.toLowerCase();
    if (headers.has(key) || reservedHeaders.has(key) || key.startsWith("mcp-"))
      throw new Error("Invalid upstream header");
    headers.set(name, value);
  }
  return headers;
}

const connect = Effect.fnUntraced(function* (
  scope: PluginMcpLeaseScope,
  installation: PluginMcpInstallation,
  server: AgentPluginMcpServer,
  options: PluginMcpBrokerOptions,
) {
  const transport = server.transport;
  if (transport.type === "sse") return yield* invalidConfiguration();
  const signals = new AsyncLocalStorage<AbortSignal>();
  const http = yield* Effect.gen(function* () {
    if (transport.type !== "streamable-http") return undefined;
    if (!remoteEndpoint.safeParse(transport.url).success) return yield* invalidConfiguration();
    const url = new URL(transport.url);
    const values = yield* options.resolveHeaders({
      scope,
      origin: url.origin,
      url: url.href,
      declaredHeaderNames: Object.keys(transport.headers),
    });
    const headers = yield* Effect.try({
      try: () => upstreamHeaders(values),
      catch: invalidConfiguration,
    });
    return new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
      fetch: (target, init) => {
        const signal = signals.getStore();
        // Only the request POST belongs to this operation. The SDK may also send cancellation
        // notifications or maintain a GET stream for the whole connection.
        const request =
          signal &&
          init?.method === "POST" &&
          typeof init.body === "string" &&
          isJSONRPCRequest(JSON.parse(init.body));
        return fetch(target, {
          ...init,
          redirect: "error",
          ...(request && {
            signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
          }),
        });
      },
    });
  });
  const client = new Client({ name: "Nodex Plugin Broker", version: "1" });
  const wire =
    http ??
    (yield* Effect.tryPromise({
      try: () =>
        prepareStdio(
          installation,
          transport as Extract<typeof transport, { type: "stdio" }>,
          options.executableSearchPath,
        ),
      catch: invalidConfiguration,
    }));
  let healthy = true;
  const markClosed = () => {
    healthy = false;
  };
  // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Client exposes a callback slot.
  client.onclose = markClosed;
  yield* Effect.addFinalizer(() =>
    (http
      ? Effect.tryPromise(() => http.terminateSession()).pipe(timeout(500), Effect.ignore)
      : Effect.void
    ).pipe(Effect.ensuring(Effect.tryPromise(() => wire.close()).pipe(Effect.ignore)), (close) =>
      Effect.andThen(Effect.sync(markClosed), close),
    ),
  );

  const request = <A>(operation: (signal: AbortSignal) => Promise<A>) =>
    Effect.tryPromise({
      try: (signal) => {
        if (!healthy) throw unavailable();
        return signals.run(signal, () => operation(signal));
      },
      catch: (error) => {
        if (!(error instanceof McpError) || error.code === Number(ErrorCode.ConnectionClosed))
          healthy = false;
        return error instanceof McpError && error.code === Number(ErrorCode.RequestTimeout)
          ? new PluginMcpFailure("timeout")
          : unavailable();
      },
    });

  yield* request((signal) => client.connect(wire, { signal }));
  const listTools = Effect.gen(function* () {
    if (!client.getServerCapabilities()?.tools) return [];
    const tools: Tool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = yield* request((signal) => client.listTools({ cursor }, { signal }));
      for (const { _meta, execution, ...tool } of page.tools) {
        if (names.has(tool.name) || names.size >= 1024) return yield* unavailable();
        names.add(tool.name);
        if (execution?.taskSupport !== "required") tools.push(tool);
      }
      cursor = page.nextCursor;
      if (cursor === undefined) return tools;
      if (cursors.size >= 50 || cursors.has(cursor)) return yield* unavailable();
      cursors.add(cursor);
    } while (true);
  });

  return {
    healthy: () => healthy,
    listTools: listTools.pipe(timeout(options.requestTimeoutMs ?? 30_000)),
    callTool: (name: string, args: Record<string, unknown>) =>
      request((signal) =>
        client.callTool({ name, arguments: args }, CallToolResultSchema, { signal }),
      ).pipe(
        Effect.map((value) => {
          // callTool types also include the legacy schema, even when the modern schema is explicit.
          const { _meta, ...result } = CallToolResultSchema.parse(value);
          return result;
        }),
        timeout(options.requestTimeoutMs ?? 30_000),
      ),
  };
});

type Connection = Effect.Success<ReturnType<typeof connect>>;

/** One scoped connection family per installation generation, server, Project and principal. */
export const makeUpstream = Effect.fnUntraced(function* (
  identity: PluginMcpLeaseScope,
  installation: PluginMcpInstallation,
  server: AgentPluginMcpServer,
  options: PluginMcpBrokerOptions,
) {
  const owner = yield* Scope.Scope;
  const gate = yield* Semaphore.make(1);
  let current: { scope: Scope.Closeable; connection: Connection } | undefined;
  let remaining = 1 + (options.restartBudget ?? 2);

  const acquire = Effect.gen(function* () {
    if (current?.connection.healthy()) return current.connection;
    if (current) {
      yield* Scope.close(current.scope, Exit.void);
      current = undefined;
    }
    if (remaining <= 0) return yield* new PluginMcpFailure("restart_budget_exhausted");
    remaining--;
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const attempt = yield* Scope.fork(owner);
        const connection = yield* restore(
          connect(identity, installation, server, options).pipe(
            Scope.provide(attempt),
            timeout(options.connectTimeoutMs ?? 10_000),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) ? Scope.close(attempt, exit) : Effect.void,
          ),
        );
        current = { scope: attempt, connection };
        return connection;
      }),
    );
  }).pipe(Effect.retry({ while: (error) => error.code === "upstream_unavailable" }));

  return { get: gate.withPermit(acquire) };
});
