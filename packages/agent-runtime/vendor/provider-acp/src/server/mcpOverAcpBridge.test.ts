// The bridge intentionally treats MCP JSON-RPC messages as opaque JSON.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { acpRequestIdentity } from "effect-acp/protocol";

import { makeAcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";

describe("AcpMcpOverAcpBridge", () => {
  it.effect("forwards authenticated MCP requests and closes the negotiated session", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly method: string;
        readonly headers: Headers;
        readonly body: unknown;
      }> = [];
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body === undefined ? null : JSON.parse(String(init.body));
          requests.push({ method, headers, body });
          if (method === "DELETE") return new Response(null, { status: 204 });
          if (body === null || typeof body !== "object") return new Response(null, { status: 202 });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { tools: [] },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      const connected = yield* bridge.connect({ serverId: "nodex_app" });
      expect(connected).toEqual({ connectionId: "connection-1" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "initialize" }),
      ).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "tools/list" }),
      ).toEqual({ tools: [] });
      yield* bridge.notification({
        connectionId: connected.connectionId,
        method: "notifications/initialized",
      });
      yield* bridge.disconnect({ connectionId: connected.connectionId });

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests.at(-1)?.method).toBe("DELETE");
      expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-42");
    }),
  );

  it.effect("aborts an in-flight HTTP request when the ACP call is interrupted", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<AbortSignal>();
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          if (!init?.signal) throw new Error("Missing cancellation signal");
          started.resolve(init.signal);
          return new Promise<Response>(() => {});
        },
      });
      const connected = yield* bridge.connect({ serverId: "nodex_app" });
      const request = yield* bridge
        .message({ connectionId: connected.connectionId, method: "tools/list" })
        .pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      expect(signal.aborted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unknown servers, connections, and oversized messages", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
      });

      for (const serverId of ["other", "node_repl"]) {
        expect(yield* bridge.connect({ serverId }).pipe(Effect.flip)).toMatchObject({
          _tag: "AcpMcpOverAcpError",
        });
      }
      expect(
        yield* bridge.message({ connectionId: "missing", method: "tools/list" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "AcpMcpOverAcpError" });

      const connected = yield* bridge.connect({ serverId: "nodex_app" });
      const failure = yield* bridge
        .message({
          connectionId: connected.connectionId,
          method: "tools/call",
          params: { payload: "x".repeat(8 * 1024 * 1024) },
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("exceeds 8 MiB");
    }),
  );
});

it.effect.each(["nodex_app", "node_repl"] as const)(
  "routes %s and sends cancellation before its call completes",
  (serverId) =>
    Effect.gen(function* () {
      const appEndpoint = "http://127.0.0.1:1/mcp";
      const desktopEndpoint = `${appEndpoint}/node_repl`;
      const endpoint = serverId === "node_repl" ? desktopEndpoint : appEndpoint;
      const callStarted = Promise.withResolvers<number>();
      const callAborted = Promise.withResolvers<void>();
      let cancelledAtServer = false;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: appEndpoint,
        desktopEndpoint,
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (url, init) => {
          expect(url).toBe(endpoint);
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer bridge-test");
          const body = JSON.parse(String(init?.body));
          if (body.method === "tools/call") {
            callStarted.resolve(body.id);
            init?.signal?.addEventListener("abort", () => callAborted.resolve(), { once: true });
            // MCP may leave the call unanswered after acknowledging cancellation.
            return new Promise<Response>(() => {});
          }
          const id = await callStarted.promise;
          expect(body).toMatchObject({
            method: "notifications/cancelled",
            params: { requestId: id, reason: "cancelled by agent" },
          });
          cancelledAtServer = true;
          return new Response(null, { status: 202 });
        },
      });
      const { connectionId } = yield* bridge.connect({ serverId });
      const call = yield* bridge
        .message({ connectionId, method: "tools/call" }, acpRequestIdentity(42))
        .pipe(Effect.flip, Effect.forkChild);
      yield* Effect.promise(() => callStarted.promise);
      const queued = yield* bridge
        .message({ connectionId, method: "tools/call" }, acpRequestIdentity(43))
        .pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
      yield* bridge.notification({
        connectionId,
        method: "notifications/cancelled",
        params: { requestId: 43 },
      });
      expect((yield* Fiber.join(queued)).message).toBe("MCP request cancelled.");
      expect(cancelledAtServer).toBe(false);

      yield* bridge.notification({
        connectionId,
        method: "notifications/cancelled",
        params: { requestId: 42, reason: "cancelled by agent" },
      });
      expect((yield* Fiber.join(call)).message).toBe("MCP request cancelled.");
      yield* Effect.promise(() => callAborted.promise);
      expect(cancelledAtServer).toBe(true);
    }),
);

it.effect("binds a fork's Desktop server ID to its own endpoint and credential", () =>
  Effect.gen(function* () {
    const source = { endpoint: "http://127.0.0.1:1/mcp/node_repl", authorization: "Bearer source" };
    const fork = { endpoint: "http://127.0.0.1:2/mcp/node_repl", authorization: "Bearer fork" };
    let nextId = 0;
    const bridge = yield* makeAcpMcpOverAcpBridge({
      endpoint: "http://127.0.0.1:1/mcp",
      desktopEndpoint: source.endpoint,
      authorization: source.authorization,
      allocateConnectionId: Effect.sync(() => String(++nextId)),
      fetchImplementation: async (endpoint, init) =>
        Response.json({
          jsonrpc: "2.0",
          id: JSON.parse(String(init?.body)).id,
          result: { endpoint, authorization: new Headers(init?.headers).get("authorization") },
        }),
    });
    const sourceId = yield* bridge.registerDesktopRoute(source);
    const forkId = yield* bridge.registerDesktopRoute(fork);
    expect(sourceId).toBe("node_repl");
    expect(forkId).not.toBe(sourceId);
    for (const [serverId, route] of [
      [sourceId, source],
      [forkId, fork],
    ] as const) {
      const { connectionId } = yield* bridge.connect({ serverId });
      expect(yield* bridge.message({ connectionId, method: "tools/list" })).toEqual(route);
    }
  }),
);
