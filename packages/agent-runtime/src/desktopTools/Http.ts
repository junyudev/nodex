import { randomUUID } from "node:crypto";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  CancelledNotificationSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { DesktopTools, desktopToolsPath, type DesktopCaller } from "./DesktopTools.ts";

const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "invalid_mcp_credential" },
  { status: 401, headers: { "cache-control": "no-store", "www-authenticate": "Bearer" } },
);
const badRequest = HttpServerResponse.jsonUnsafe(
  { jsonrpc: "2.0", error: { code: -32600, message: "Expected an MCP initialize request" } },
  { status: 400 },
);

// A credential can reconnect without replacing the Thread's REPL. Only the exact credential
// that initialized an HTTP session can post notifications or delete it.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry;
    const tools = yield* DesktopTools;
    const sessions = new Map<string, Session>();
    const idleMs = 24 * 60 * 60_000;
    const sessionLimit = 512;
    let initializing = 0;

    const makeSession = async (caller: DesktopCaller, credential: string, signal: AbortSignal) => {
      const upstream = await tools.initialize(caller, signal);
      signal.throwIfAborted();
      const controller = new AbortController();
      const requests = new Map<RequestId, AbortController>();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => {
          sessions.set(id, session);
        },
      });
      const server = new Server(
        { name: "node_repl", version: upstream.version },
        {
          capabilities: { tools: {} },
          ...(upstream.instructions === undefined ? {} : { instructions: upstream.instructions }),
        },
      );
      const socketSignal = (extra: {
        authInfo?: { extra?: Record<string, unknown> } | undefined;
      }) => {
        const signal = extra.authInfo?.extra?.socketSignal;
        return signal instanceof AbortSignal ? [signal] : [];
      };
      server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
        tools.list(
          caller,
          request.params,
          AbortSignal.any([controller.signal, extra.signal, ...socketSignal(extra)]),
        ),
      );
      server.setNotificationHandler(CancelledNotificationSchema, ({ params }) => {
        if (params.requestId !== undefined) requests.get(params.requestId)?.abort();
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const requestController = new AbortController();
        const signals = [
          extra.signal,
          controller.signal,
          requestController.signal,
          ...socketSignal(extra),
        ];
        requests.set(extra.requestId, requestController);
        try {
          return await tools.call(caller, request.params, AbortSignal.any(signals), (progress) => {
            const token = request.params._meta?.progressToken;
            if (token === undefined) return;
            void extra
              .sendNotification({
                method: "notifications/progress",
                params: { ...progress, progressToken: token },
              })
              .catch(() => {});
          });
        } finally {
          if (requests.get(extra.requestId) === requestController) requests.delete(extra.requestId);
        }
      });
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- MCP Protocol uses a callback
      server.onclose = () => {
        controller.abort();
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      const session = { transport, credential, lastUsed: Date.now(), close: () => server.close() };
      return session;
    };
    type Session = Awaited<ReturnType<typeof makeSession>>;

    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await Promise.allSettled([...sessions.values()].map((session) => session.close()));
      }),
    );

    const handle = Effect.fn("DesktopTools.http")(function* (
      request: HttpServerRequest.HttpServerRequest,
    ) {
      // The endpoint is for local provider processes and serves no browser origins.
      if (request.headers.origin !== undefined) return HttpServerResponse.empty({ status: 403 });
      const authorization = request.headers.authorization;
      const token = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      const scope = token.length === 0 ? undefined : yield* registry.resolve(token);
      if (!scope || !tools.has(scope.thread)) return unauthorized;
      const id = request.headers["mcp-session-id"];
      const existing = id === undefined ? undefined : sessions.get(id);
      if (existing && existing.credential !== scope.thread.providerSessionId) return unauthorized;
      if (id !== undefined && !existing) return HttpServerResponse.empty({ status: 404 });

      const now = Date.now();
      for (const session of sessions.values())
        if (session !== existing && now - session.lastUsed > idleMs)
          yield* Effect.promise(() => session.close());
      let parsedBody: unknown;
      if (!existing) {
        if (request.method !== "POST") return badRequest;
        parsedBody = yield* request.json.pipe(Effect.orElseSucceed(() => undefined));
        if (!isInitializeRequest(parsedBody)) return badRequest;
      }
      const response = NodeHttpServerRequest.toServerResponse(request);
      const controller = new AbortController();
      response.once("close", () => controller.abort());
      if (response.destroyed) controller.abort();
      const webRequest = yield* HttpServerRequest.toWeb(request, { signal: controller.signal });
      return yield* Effect.tryPromise(async () => {
        if (!existing && sessions.size + initializing >= sessionLimit)
          return HttpServerResponse.empty({ status: 503 });
        const session =
          existing ??
          (await (async () => {
            initializing++;
            try {
              return await makeSession(
                scope.thread,
                scope.thread.providerSessionId,
                controller.signal,
              );
            } finally {
              initializing--;
            }
          })());
        session.lastUsed = now;
        try {
          if (controller.signal.aborted) return HttpServerResponse.empty({ status: 499 });
          const result = await session.transport.handleRequest(webRequest, {
            ...(parsedBody === undefined ? {} : { parsedBody }),
            // SDK handlers need the disconnect signal. The registry retains the actual bearer.
            authInfo: {
              token: "",
              clientId: scope.thread.providerSessionId,
              scopes: [],
              extra: { socketSignal: controller.signal },
            },
          });
          return HttpServerResponse.fromWeb(result);
        } finally {
          if (session.transport.sessionId === undefined) await session.close();
        }
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 503 })));
    });
    return HttpRouter.add("*", desktopToolsPath, (request) =>
      handle(request).pipe(Effect.orElseSucceed(() => badRequest)),
    );
  }),
);
