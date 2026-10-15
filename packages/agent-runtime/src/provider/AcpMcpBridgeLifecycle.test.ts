import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { makeAcpMcpOverAcpBridge } from "../../vendor/provider-acp/src/server/mcpOverAcpBridge.ts";

const options = {
  endpoint: "http://127.0.0.1:1/mcp",
  authorization: "Bearer native-connection",
  allocateConnectionId: Effect.succeed("connection"),
};

describe("ACP native MCP lifetime", () => {
  it.effect("permanently closes old handlers and leaves a replacement connection usable", () =>
    Effect.gen(function* () {
      const exchanges: Array<{ method: string; authorization: string | null }> = [];
      const fetchImplementation = async (_url: string, init?: RequestInit) => {
        exchanges.push({
          method: init?.method ?? "GET",
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (init?.method === "DELETE") return new Response(null, { status: 204 });
        const request = JSON.parse(String(init?.body)) as { id: number; method: string };
        return Response.json(
          { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18", tools: [] } },
          {
            headers: { "mcp-session-id": "authenticated-native-session" },
          },
        );
      };
      const old = yield* makeAcpMcpOverAcpBridge({ ...options, fetchImplementation });
      yield* old.connect({ serverId: "nodex_app" });
      yield* old.message({ connectionId: "connection", method: "initialize" });
      yield* old.dispose;
      yield* old.dispose;
      for (const request of [
        old.connect({ serverId: "nodex_app" }),
        old.message({ connectionId: "connection", method: "tools/call" }),
        old.notification({ connectionId: "connection", method: "notifications/initialized" }),
        old.disconnect({ connectionId: "connection" }),
      ]) {
        expect((yield* request.pipe(Effect.flip)).message).toContain("closed");
      }
      expect(exchanges.map((exchange) => exchange.method)).toEqual(["POST", "DELETE"]);
      const replacement = yield* makeAcpMcpOverAcpBridge({
        ...options,
        authorization: "Bearer replacement",
        fetchImplementation,
      });
      yield* replacement.connect({ serverId: "nodex_app" });
      expect(
        yield* replacement.message({ connectionId: "connection", method: "tools/list" }),
      ).toMatchObject({ tools: [] });
      expect(exchanges.at(-1)?.authorization).toBe("Bearer replacement");
      yield* replacement.dispose;
    }),
  );

  it.effect(
    "native retirement aborts in-flight HTTP and drains requests waiting for that connection",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<AbortSignal>();
        let sends = 0;
        const bridge = yield* makeAcpMcpOverAcpBridge({
          ...options,
          fetchImplementation: (_url, init) => {
            sends += 1;
            started.resolve(init!.signal!);
            return new Promise<Response>(() => {});
          },
        });
        yield* bridge.connect({ serverId: "nodex_app" });
        const first = yield* bridge
          .message({ connectionId: "connection", method: "tools/call" })
          .pipe(Effect.forkChild);
        const signal = yield* Effect.promise(() => started.promise);
        const queued = yield* bridge
          .message({ connectionId: "connection", method: "tools/list" })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* bridge.dispose;
        for (const fiber of [first, queued]) {
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        }
        expect(signal.aborted).toBe(true);
        expect(sends).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "retirement interrupts an admitted connection allocation before it can publish a connection",
    () =>
      Effect.gen(function* () {
        const allocating = yield* Deferred.make<void>();
        const never = yield* Deferred.make<string>();
        const bridge = yield* makeAcpMcpOverAcpBridge({
          ...options,
          allocateConnectionId: Deferred.succeed(allocating, undefined).pipe(
            Effect.andThen(Deferred.await(never)),
          ),
        });
        const connecting = yield* bridge.connect({ serverId: "nodex_app" }).pipe(Effect.forkChild);
        yield* Deferred.await(allocating);
        yield* bridge.dispose;
        yield* Deferred.succeed(never, "late-connection");
        const exit = yield* Fiber.await(connecting);
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
        expect(
          (yield* bridge.connect({ serverId: "nodex_app" }).pipe(Effect.flip)).message,
        ).toContain("closed");
      }).pipe(Effect.scoped),
  );

  it.effect(
    "caller cancellation interrupts its HTTP child while keeping the native bridge available",
    () =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<AbortSignal>();
        const bridge = yield* makeAcpMcpOverAcpBridge({
          ...options,
          fetchImplementation: (_url, init) => {
            started.resolve(init!.signal!);
            return new Promise<Response>(() => {});
          },
        });
        yield* bridge.connect({ serverId: "nodex_app" });
        const request = yield* bridge
          .message({ connectionId: "connection", method: "tools/call" })
          .pipe(Effect.forkChild);
        const signal = yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(request);
        expect(signal.aborted).toBe(true);
        yield* bridge.disconnect({ connectionId: "connection" });
        expect(yield* bridge.connect({ serverId: "nodex_app" })).toEqual({
          connectionId: "connection",
        });
        yield* bridge.dispose;
      }).pipe(Effect.scoped),
  );
});
