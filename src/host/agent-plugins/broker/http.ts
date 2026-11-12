import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import { PluginMcpFailure } from "./contract";

export const leasePath = (id: string) => "/plugin-mcp/" + id;

type Projection = {
  readonly listTools: Effect.Effect<readonly Tool[], PluginMcpFailure>;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CallToolResult, PluginMcpFailure>;
};

export const listen = Effect.fnUntraced(function* (
  authorize: (
    id: string,
    token: string,
    connection: symbol,
    sessionId: string | undefined,
  ) =>
    | { readonly projection: Projection; readonly sessionId?: string }
    | PluginMcpFailure
    | undefined,
) {
  // The authenticated HTTP connection must survive idle time between Agent turns.
  const listener = createServer({ keepAliveTimeout: 0 });
  const connections = new WeakMap<Socket, symbol>();
  const port = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const ready = once(listener, "listening");
        listener.listen(0, "127.0.0.1");
        await ready;
        const address = listener.address();
        if (!address || typeof address === "string") throw new Error("Expected a loopback address");
        return address.port;
      },
      catch: () => new PluginMcpFailure("listener_unavailable"),
    }),
    () =>
      Effect.callback<void>((resume) => {
        listener.close(() => resume(Effect.void));
        listener.closeAllConnections();
      }),
  );
  const host = "127.0.0.1:" + port;
  const run = yield* FiberSet.makeRuntimePromise();
  const forkRequest = yield* FiberSet.makeRuntime();

  const handle = Effect.fnUntraced(function* (request: IncomingMessage, response: ServerResponse) {
    response.setHeader("cache-control", "no-store");
    if (request.headers.host !== host || request.headers.origin !== undefined) {
      response.writeHead(403, { connection: "close" }).end();
      return;
    }
    // This stateless JSON endpoint has no server-initiated event stream.
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST" }).end();
      return;
    }

    const id = /^\/plugin-mcp\/([A-Za-z0-9_-]+)$/.exec(request.url ?? "")?.[1];
    const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1];
    let connection = connections.get(request.socket);
    if (!connection) {
      connection = Symbol();
      connections.set(request.socket, connection);
    }
    const sessionId = request.headers["mcp-session-id"];
    const access =
      id && token && !Array.isArray(sessionId)
        ? authorize(id, token, connection, sessionId)
        : undefined;
    if (!access || access instanceof PluginMcpFailure) {
      const reason = access?.code ?? "invalid_lease";
      response
        .writeHead(401, {
          "content-type": "application/json",
          "www-authenticate": "Bearer",
          ...(!access && { connection: "close" }),
        })
        .end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32000,
              message: access ? "Lease revoked" : "Invalid lease",
              data: { reason },
            },
          }),
        );
      return;
    }

    if (access.sessionId) response.setHeader("mcp-session-id", access.sessionId);
    const lease = access.projection;
    const server = new Server(
      { name: "Nodex Plugin Tools", version: "1" },
      { capabilities: { tools: {} } },
    );
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    yield* Effect.acquireUseRelease(
      Effect.succeed(server),
      () =>
        Effect.tryPromise(async (signal) => {
          const invoke = <A>(operation: Effect.Effect<A, PluginMcpFailure>) =>
            run(
              operation.pipe(
                Effect.mapError(
                  (failure) =>
                    new McpError(ErrorCode.InternalError, failure.code, { reason: failure.code }),
                ),
              ),
              { signal },
            );
          server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: [...(await invoke(lease.listTools))],
          }));
          server.setRequestHandler(CallToolRequestSchema, ({ params }) =>
            invoke(lease.callTool(params.name, params.arguments ?? {})),
          );
          await server.connect(transport);
          await transport.handleRequest(request, response);
        }),
      () => Effect.tryPromise(() => server.close()).pipe(Effect.ignore),
    ).pipe(
      Effect.catch(() =>
        Effect.sync(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(503).end();
        }),
      ),
    );
  });

  listener.on("request", (request, response) => {
    forkRequest(
      handle(request, response).pipe(
        Effect.raceFirst(Effect.tryPromise((signal) => once(response, "close", { signal }))),
        Effect.ignore,
      ),
    );
  });
  return "http://" + host;
});
