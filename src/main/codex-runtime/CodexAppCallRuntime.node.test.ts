import type { ItemStartedNotification } from "@nodex/codex-app-server-protocol/v2/ItemStartedNotification";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./CodexAppCallRuntime";
const event = (id = "call-1"): ItemStartedNotification => ({
  threadId: "thread-1",
  turnId: "turn-1",
  startedAtMs: 1,
  item: {
    type: "mcpToolCall",
    id,
    server: "nodex_app",
    tool: "read_page",
    status: "inProgress",
    arguments: { pageId: "page-1" },
    appContext: null,
    pluginId: null,
    readOnlyHint: true,
    result: null,
    error: null,
    durationMs: null,
  },
});
const request = () => ({
  name: "read_page",
  arguments: { pageId: "page-1" },
  metadata: {
    callId: "call-1",
    "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1" },
  },
});

it.effect("waits for native observation before executing a raced MCP request", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* make;
      yield* runtime.startTurn("thread-1", "turn-1");
      let ran = false;
      const call = yield* runtime
        .run(request(), () =>
          Effect.sync(() => {
            ran = true;
            return 42;
          }),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(ran);
      yield* runtime.observe(event());
      assert.strictEqual(yield* Fiber.join(call), 42);
    }),
  ),
);

it.effect("rejects an unobserved call after a bounded wait without executing it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const runtime = yield* make;
      let ran = false;
      const call = yield* runtime
        .run(request(), () =>
          Effect.sync(() => {
            ran = true;
          }),
        )
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      assert.strictEqual((yield* Fiber.join(call)).reason, "unverified");
      assert.isFalse(ran);
    }),
  ),
);

for (const trigger of ["turn", "generation"] as const) {
  it.effect(`interrupts active work when its ${trigger} closes`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const runtime = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
        yield* runtime.startTurn("thread-1", "turn-1");
        yield* runtime.observe(event());
        const started = yield* Deferred.make<void>();
        const stopped = yield* Deferred.make<void>();
        const call = yield* runtime
          .run(request(), () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(stopped, undefined)),
            ),
          )
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(started);
        if (trigger === "turn") yield* runtime.endTurn("thread-1", "turn-1");
        else yield* Scope.close(scope, Exit.void);
        assert.strictEqual((yield* Fiber.join(call)).reason, "revoked");
        yield* Deferred.await(stopped);
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );
}
