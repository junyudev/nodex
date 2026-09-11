import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { FileSearchEvent } from "../../shared/file-search";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { codexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { makeFileSearchSession } from "./FileSearch";

it.effect(
  "reuses native indexing, fences notifications, reconnects, and stops with its Scope",
  () =>
    Effect.gen(function* () {
      const bus = yield* PubSub.unbounded<CodexEndpointEvent>();
      const scope = yield* Scope.make();
      let generation = 1;
      const calls: Array<{ method: string; params: unknown; fence: unknown }> = [];
      const received: FileSearchEvent[] = [];
      const reconnected = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const gateway = {
        localHostId: "local",
        events: Stream.fromPubSub(bus),
        awaitReady: (hostId: string) => Effect.sync(() => assert.strictEqual(hostId, "local")),
        connection: () => Effect.sync(() => ({ kind: "ready", hostId: "local", generation })),
        requestOnHost: (host: string, method: string, params: unknown, fence: unknown) =>
          Effect.gen(function* () {
            assert.strictEqual(host, "local");
            calls.push({ method, params, fence });
            if (method === "fuzzyFileSearch/sessionUpdate" && generation === 2)
              yield* Deferred.succeed(reconnected, undefined);
            return {};
          }),
      } as unknown as CodexGateway["Service"];
      const session = yield* makeFileSearchSession(
        { hostId: "default", sessionId: "search", roots: ["/repo"] },
        (event) =>
          Effect.sync(() => {
            received.push(event);
          }).pipe(Effect.andThen(Deferred.succeed(delivered, undefined)), Effect.asVoid),
      ).pipe(
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(Scope.Scope, scope),
      );
      yield* session.update("a");
      yield* session.update("abc");
      const notification = (
        hostId: string,
        eventGeneration: number,
        sessionId: string,
        query: string,
      ): CodexEndpointEvent => ({
        kind: "notification",
        hostId,
        generation: eventGeneration,
        value: {
          protocol: "generated",
          method: "fuzzyFileSearch/sessionUpdated",
          params: { sessionId, query, files: [] },
        },
      });
      yield* PubSub.publish(bus, notification("other", 1, "search", "abc"));
      yield* PubSub.publish(bus, notification("local", 0, "search", "abc"));
      yield* PubSub.publish(bus, notification("local", 1, "other", "abc"));
      yield* PubSub.publish(bus, notification("local", 1, "search", "a"));
      yield* PubSub.publish(bus, notification("local", 1, "search", "abc"));
      yield* Deferred.await(delivered);
      assert.strictEqual(received.length, 1);
      assert.deepEqual(
        calls.map(({ method }) => method),
        [
          "fuzzyFileSearch/sessionStart",
          "fuzzyFileSearch/sessionUpdate",
          "fuzzyFileSearch/sessionUpdate",
        ],
      );
      generation = 2;
      yield* PubSub.publish(bus, {
        kind: "connection",
        value: { kind: "ready", hostId: "local", generation },
      });
      yield* Deferred.await(reconnected);
      yield* Scope.close(scope, Exit.succeed(undefined));
      assert.deepEqual(calls.at(-1), {
        method: "fuzzyFileSearch/sessionStop",
        params: { sessionId: "search" },
        fence: { expectedHostId: "local", expectedGeneration: 2 },
      });
      assert.strictEqual(
        calls.filter(({ method }) => method === "fuzzyFileSearch/sessionStart").length,
        2,
      );
      const afterClose = yield* Effect.exit(session.update("late"));
      assert.isTrue(Exit.isFailure(afterClose));
      yield* PubSub.shutdown(bus);
    }),
);

it.effect("recreates a missing native session before retrying the current query", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: string[] = [];
      let missing = true;
      const gateway = {
        localHostId: "local",
        events: Stream.never,
        awaitReady: () => Effect.void,
        connection: () => Effect.succeed({ kind: "ready", hostId: "local", generation: 1 }),
        requestOnHost: (_host: string, method: string) =>
          Effect.suspend(() => {
            calls.push(method);
            if (method === "fuzzyFileSearch/sessionUpdate" && missing) {
              missing = false;
              return Effect.fail(
                codexRuntimeError({
                  operation: "test",
                  reason: "request",
                  retryable: false,
                  cause: new Error("fuzzy file search session not found: search"),
                }),
              );
            }
            return Effect.succeed({});
          }),
      } as unknown as CodexGateway["Service"];
      const session = yield* makeFileSearchSession(
        { hostId: "local", sessionId: "search", roots: ["/repo"] },
        () => Effect.void,
      ).pipe(Effect.provideService(CodexGateway, gateway));
      yield* session.update("abc");
      assert.deepEqual(calls, [
        "fuzzyFileSearch/sessionStart",
        "fuzzyFileSearch/sessionUpdate",
        "fuzzyFileSearch/sessionStart",
        "fuzzyFileSearch/sessionUpdate",
      ]);
    }),
  ),
);

it.effect("stops an admitted native index when its start reply is interrupted", () =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const stopped: unknown[] = [];
    const gateway = {
      events: Stream.never,
      awaitReady: () => Effect.void,
      connection: () => Effect.succeed({ kind: "ready", hostId: "remote", generation: 4 }),
      requestOnHost: (_host: string, method: string, params: unknown) => {
        if (method === "fuzzyFileSearch/sessionStart")
          return Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Effect.never));
        return Effect.sync(() => {
          stopped.push(params);
          return {};
        });
      },
    } as unknown as CodexGateway["Service"];
    const pending = yield* makeFileSearchSession(
      { hostId: "remote", sessionId: "pending", roots: ["/repo"] },
      () => Effect.void,
    ).pipe(Effect.provideService(CodexGateway, gateway), Effect.scoped, Effect.forkScoped);
    yield* Deferred.await(admitted);
    yield* Fiber.interrupt(pending);
    assert.deepEqual(stopped, [{ sessionId: "pending" }]);
  }),
);
