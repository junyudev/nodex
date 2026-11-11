// The bridge forwards opaque JSON-RPC values without interpreting their schemas.
// @effect-diagnostics preferSchemaOverJson:off
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { acpRequestIdentity } from "effect-acp/protocol";
import type * as AcpSchema from "effect-acp/compat";

import { responsePayloads } from "@nodex/runtime-shared/mcpResponsePayloads";
import { NODEX_APP_MCP_SERVER } from "@nodex/runtime-shared/nodexAppMcp";

import { requestAcpMcp } from "./mcpHttp.ts";

const MAX_CONNECTIONS = 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

interface Route {
  readonly endpoint: string;
  readonly authorization: string;
}

interface PendingRequest {
  readonly id: number;
  readonly cancellation: Deferred.Deferred<void>;
  started: boolean;
  cancelled: boolean;
}

interface Connection {
  readonly route: Route;
  readonly pending: Map<string, PendingRequest>;
  readonly mutex: Semaphore.Semaphore;
  sessionId: string | null;
  protocolVersion: string | null;
  nextRequestId: number;
}

export class AcpMcpOverAcpError extends Error {
  readonly _tag = "AcpMcpOverAcpError";
  override readonly name = "AcpMcpOverAcpError";
}

const bridgeError = (cause: unknown): AcpMcpOverAcpError =>
  cause instanceof AcpMcpOverAcpError
    ? cause
    : new AcpMcpOverAcpError(cause instanceof Error ? cause.message : String(cause), { cause });

const asEnvelope = (value: unknown): JsonRpcEnvelope | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRpcEnvelope)
    : null;

function protocolVersionOf(payload: unknown): string | null {
  const result = asEnvelope(payload)?.result;
  if (typeof result !== "object" || result === null || Array.isArray(result)) return null;
  const protocolVersion = (result as { readonly protocolVersion?: unknown }).protocolVersion;
  return typeof protocolVersion === "string" && protocolVersion.length > 0 ? protocolVersion : null;
}

function errorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return "The MCP server returned an error.";
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" && message.length > 0
    ? message
    : "The MCP server returned an error.";
}

export interface AcpMcpOverAcpBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly desktopEndpoint?: string;
  readonly allocateConnectionId: Effect.Effect<string>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface AcpMcpOverAcpBridge {
  readonly registerDesktopRoute: (route: Route) => Effect.Effect<string>;
  readonly connect: (
    request: AcpSchema.ConnectMcpRequest,
  ) => Effect.Effect<AcpSchema.ConnectMcpResponse, AcpMcpOverAcpError>;
  readonly message: (
    request: AcpSchema.MessageMcpRequest,
    requestId?: string,
  ) => Effect.Effect<AcpSchema.MessageMcpResponse, AcpMcpOverAcpError>;
  readonly notification: (
    request: AcpSchema.MessageMcpNotification,
  ) => Effect.Effect<void, AcpMcpOverAcpError>;
  readonly disconnect: (
    request: AcpSchema.DisconnectMcpRequest,
  ) => Effect.Effect<AcpSchema.DisconnectMcpResponse, AcpMcpOverAcpError>;
  readonly dispose: Effect.Effect<void>;
}

/** Bridges the unstable ACP transport to Nodex's authenticated streamable-HTTP MCP endpoint. */
export const makeAcpMcpOverAcpBridge = Effect.fn("AcpMcpOverAcpBridge.make")(function* (
  options: AcpMcpOverAcpBridgeOptions,
): Effect.fn.Return<AcpMcpOverAcpBridge> {
  const fetchImplementation = options.fetchImplementation ?? requestAcpMcp;
  const connections = new Map<string, Connection>();
  const routes = new Map<string, Route>([[NODEX_APP_MCP_SERVER, options]]);
  if (options.desktopEndpoint !== undefined) {
    routes.set("node_repl", {
      endpoint: options.desktopEndpoint,
      authorization: options.authorization,
    });
  }
  const requestScope = yield* Scope.make();
  let closed = false;

  // Native callbacks can outlive their process. Admission and pending HTTP work
  // belong to this physical bridge, never a later bridge using the same Thread.
  const admit = <A>(effect: Effect.Effect<A, AcpMcpOverAcpError>) =>
    Effect.suspend(() => {
      if (closed) return Effect.fail(new AcpMcpOverAcpError("The native MCP bridge is closed."));
      return effect.pipe(
        Effect.forkIn(requestScope),
        Effect.flatMap((fiber) =>
          Fiber.join(fiber).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))),
        ),
      );
    });

  const connectionFor = (connectionId: string): Effect.Effect<Connection, AcpMcpOverAcpError> =>
    Effect.suspend(() => {
      const connection = connections.get(connectionId);
      return connection === undefined
        ? Effect.fail(new AcpMcpOverAcpError(`Unknown MCP-over-ACP connection "${connectionId}".`))
        : Effect.succeed(connection);
    });

  const send = (
    connection: Connection,
    message: unknown,
  ): Effect.Effect<ReadonlyArray<unknown>, AcpMcpOverAcpError> =>
    Effect.gen(function* () {
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > MAX_MESSAGE_BYTES) {
        return yield* Effect.fail(new AcpMcpOverAcpError("MCP-over-ACP message exceeds 8 MiB."));
      }
      const signal = yield* Effect.abortSignal;
      const response = yield* Effect.tryPromise({
        try: () =>
          fetchImplementation(connection.route.endpoint, {
            method: "POST",
            signal,
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: connection.route.authorization,
              ...(connection.sessionId === null ? {} : { "mcp-session-id": connection.sessionId }),
              ...(connection.protocolVersion === null
                ? {}
                : { "mcp-protocol-version": connection.protocolVersion }),
            },
            body,
          }),
        catch: bridgeError,
      });
      connection.sessionId = response.headers.get("mcp-session-id") ?? connection.sessionId;
      if (!response.ok) {
        yield* Effect.promise(
          () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        return yield* Effect.fail(
          new AcpMcpOverAcpError(`Nodex MCP endpoint responded with HTTP ${response.status}.`),
        );
      }
      const payloads = [...(yield* Stream.runCollect(responsePayloads(response, bridgeError)))];
      for (const payload of payloads) {
        connection.protocolVersion = protocolVersionOf(payload) ?? connection.protocolVersion;
      }
      return payloads;
    }).pipe(Effect.scoped, Effect.mapError(bridgeError));

  const closeConnection = (connection: Connection) =>
    Effect.gen(function* () {
      const sessionId = connection.sessionId;
      if (sessionId !== null) {
        const response = yield* Effect.tryPromise({
          try: (signal) =>
            fetchImplementation(connection.route.endpoint, {
              method: "DELETE",
              signal,
              headers: {
                authorization: connection.route.authorization,
                "mcp-session-id": sessionId,
                ...(connection.protocolVersion === null
                  ? {}
                  : { "mcp-protocol-version": connection.protocolVersion }),
              },
            }),
          catch: bridgeError,
        });
        if (!response.ok && response.status !== 404) {
          return yield* Effect.fail(
            new AcpMcpOverAcpError(
              `Nodex MCP endpoint rejected disconnect with HTTP ${response.status}.`,
            ),
          );
        }
        yield* Effect.promise(
          () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
      }
      return {};
    });

  const disconnect = (request: AcpSchema.DisconnectMcpRequest) =>
    Effect.gen(function* () {
      const connection = yield* connectionFor(request.connectionId);
      connections.delete(request.connectionId);
      return yield* closeConnection(connection);
    });

  return {
    // Connect carries no ACP session id. A fork or reactivation with different
    // authority needs its own server id so existing sessions keep their route.
    registerDesktopRoute: (route) =>
      Effect.gen(function* () {
        for (const [id, existing] of routes) {
          if (id === NODEX_APP_MCP_SERVER) continue;
          if (
            existing.endpoint === route.endpoint &&
            existing.authorization === route.authorization
          ) {
            return id;
          }
        }
        if (!routes.has("node_repl")) {
          routes.set("node_repl", route);
          return "node_repl";
        }
        const id = `node_repl:${yield* options.allocateConnectionId}`;
        routes.set(id, route);
        return id;
      }),
    connect: (request) =>
      admit(
        Effect.gen(function* () {
          const route = routes.get(request.serverId);
          if (route === undefined) {
            return yield* Effect.fail(
              new AcpMcpOverAcpError(`Unknown ACP MCP server "${request.serverId}".`),
            );
          }
          if (connections.size >= MAX_CONNECTIONS) {
            return yield* Effect.fail(new AcpMcpOverAcpError("Too many MCP-over-ACP connections."));
          }
          const connectionId = yield* options.allocateConnectionId;
          const mutex = yield* Semaphore.make(1);
          return yield* Effect.suspend(() => {
            if (closed)
              return Effect.fail(new AcpMcpOverAcpError("The native MCP bridge is closed."));
            if (connections.size >= MAX_CONNECTIONS) {
              return Effect.fail(new AcpMcpOverAcpError("Too many MCP-over-ACP connections."));
            }
            connections.set(connectionId, {
              route,
              pending: new Map(),
              mutex,
              sessionId: null,
              protocolVersion: null,
              nextRequestId: 0,
            });
            return Effect.succeed({ connectionId });
          });
        }),
      ),
    message: (request, requestId) =>
      admit(
        Effect.gen(function* () {
          const connection = yield* connectionFor(request.connectionId);
          const id = ++connection.nextRequestId;
          const pending: PendingRequest | undefined =
            requestId === undefined || request.method === "initialize"
              ? undefined
              : {
                  id,
                  cancellation: Deferred.makeUnsafe<void>(),
                  started: false,
                  cancelled: false,
                };
          if (pending !== undefined && requestId !== undefined) {
            connection.pending.set(requestId, pending);
          }
          const cancelled = () => new AcpMcpOverAcpError("MCP request cancelled.");
          const exchange = connection.mutex.withPermits(1)(
            Effect.suspend(() => {
              if (pending?.cancelled === true) return Effect.fail(cancelled());
              if (pending !== undefined) pending.started = true;
              return send(connection, {
                jsonrpc: "2.0",
                id,
                method: request.method,
                ...(request.params == null ? {} : { params: request.params }),
              });
            }),
          );
          const payloads = yield* (
            pending === undefined
              ? exchange
              : Effect.raceFirst(
                  exchange,
                  Deferred.await(pending.cancellation).pipe(
                    Effect.andThen(Effect.fail(cancelled())),
                  ),
                )
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (requestId !== undefined && connection.pending.get(requestId) === pending) {
                  connection.pending.delete(requestId);
                }
              }),
            ),
          );
          if (pending?.cancelled === true) return yield* Effect.fail(cancelled());
          const response = payloads.find((payload) => asEnvelope(payload)?.id === id);
          const envelope = asEnvelope(response);
          if (envelope === null) {
            return yield* Effect.fail(
              new AcpMcpOverAcpError("MCP server did not return a matching response."),
            );
          }
          if (envelope.error !== undefined) {
            return yield* Effect.fail(new AcpMcpOverAcpError(errorMessage(envelope.error)));
          }
          return (envelope.result ?? null) as AcpSchema.MessageMcpResponse;
        }),
      ),
    notification: (request) =>
      admit(
        Effect.gen(function* () {
          const connection = yield* connectionFor(request.connectionId);
          if (request.method === "notifications/cancelled") {
            const requestId = request.params?.requestId;
            if (typeof requestId !== "string" && typeof requestId !== "number") return;
            const pending = connection.pending.get(acpRequestIdentity(requestId));
            if (pending === undefined || pending.cancelled) return;
            pending.cancelled = true;
            // Send the MCP cancellation before dropping the call stream. The
            // server may acknowledge the notification without replying to the call.
            const notify = pending.started
              ? send(connection, {
                  jsonrpc: "2.0",
                  method: request.method,
                  params: { ...request.params, requestId: pending.id },
                })
              : Effect.void;
            yield* notify.pipe(Effect.ensuring(Deferred.succeed(pending.cancellation, undefined)));
            return;
          }
          yield* connection.mutex.withPermits(1)(
            send(connection, {
              jsonrpc: "2.0",
              method: request.method,
              ...(request.params == null ? {} : { params: request.params }),
            }),
          );
        }),
      ),
    disconnect: (request) => admit(disconnect(request)),
    dispose: Effect.suspend(() => {
      if (closed) return Effect.void;
      closed = true;
      const retiringConnections = [...connections.values()];
      connections.clear();
      routes.clear();
      return Scope.close(requestScope, Exit.void).pipe(
        Effect.andThen(
          Effect.forEach(
            retiringConnections,
            (connection) =>
              closeConnection(connection).pipe(Effect.timeout("1 second"), Effect.ignore),
            { discard: true, concurrency: MAX_CONNECTIONS },
          ),
        ),
      );
    }),
  };
});
