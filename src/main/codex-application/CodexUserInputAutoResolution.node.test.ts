import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import {
  make,
  USER_INPUT_AUTO_RESOLUTION_COUNTDOWN,
  USER_INPUT_FOREGROUND_INACTIVITY,
} from "./CodexUserInputAutoResolution";
import {
  CodexRendererPresentationRegistry,
  make as makePresentationRegistry,
} from "./CodexRendererPresentationRegistry";

const makeRuntime = Effect.fn("CodexUserInputAutoResolutionTest.makeRuntime")(function* (
  presented: boolean,
) {
  const registry = yield* makePresentationRegistry;
  registry.setClientForegrounded("renderer-a", presented);
  registry.setPresented("thread-1", "renderer-a", "surface-a", presented);
  return {
    registry,
    runtime: yield* make.pipe(Effect.provideService(CodexRendererPresentationRegistry, registry)),
  };
});

it.effect("waits for foreground inactivity before publishing one typed timeout", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { runtime } = yield* makeRuntime(true).pipe(Effect.provideService(Scope.Scope, scope));
    const changes = yield* runtime.changes.pipe(
      Stream.take(3),
      Stream.runCollect,
      Effect.forkScoped,
    );
    const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
    assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");

    yield* TestClock.adjust(USER_INPUT_FOREGROUND_INACTIVITY);
    const scheduled = (yield* runtime.snapshot)[0];
    assert.strictEqual(scheduled?.phase.type, "scheduled");
    yield* TestClock.adjust(USER_INPUT_AUTO_RESOLUTION_COUNTDOWN);
    assert.isEmpty(yield* runtime.snapshot);
    const observed = [...(yield* Fiber.join(changes))];
    const expected = {
      type: "timedOut",
      conversationId: "thread-1",
      requestId: "request-1",
    } as const;
    assert.deepEqual(observed.at(-1), expected);
    assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(timeout)), {
      ...expected,
      connection: { hostId: "local", generation: 1 },
      responseKind: "emptyUserInput",
    });
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect(
  "starts explicit MCP countdowns immediately and snoozes by restarting the same duration",
  () =>
    Effect.gen(function* () {
      const { runtime } = yield* makeRuntime(true);
      const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* runtime.observeRequest(
        "thread-1",
        "mcp-request",
        { hostId: "local", generation: 3 },
        { responseKind: "declineMcpElicitation", autoResolutionMs: 5_000 },
      );
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");

      yield* TestClock.adjust("4 seconds");
      assert.isTrue(yield* runtime.snooze("thread-1", "mcp-request"));
      assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");
      yield* TestClock.adjust("4999 millis");
      assert.lengthOf(yield* runtime.snapshot, 1);
      yield* TestClock.adjust("1 millis");
      assert.isEmpty(yield* runtime.snapshot);
      assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(timeout)), {
        type: "timedOut",
        conversationId: "thread-1",
        requestId: "mcp-request",
        connection: { hostId: "local", generation: 3 },
        responseKind: "declineMcpElicitation",
      });
    }),
);

it.effect("resets inactivity, preserves scalar request identity, and snoozes permanently", () =>
  Effect.gen(function* () {
    const { registry, runtime } = yield* makeRuntime(true);
    yield* runtime.observeRequest("thread-1", 7, { hostId: "local", generation: 1 });
    yield* TestClock.adjust("59 seconds");
    yield* runtime.recordActivity("thread-1");
    yield* TestClock.adjust("59 seconds");
    assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");

    registry.setPresented("thread-1", "renderer-a", "surface-a", false);
    yield* runtime.reevaluatePresentation("thread-1");
    assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "scheduled");
    registry.setPresented("thread-1", "renderer-a", "surface-a", true);
    yield* runtime.reevaluatePresentation("thread-1");
    assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "waitingForInactivity");
    registry.setPresented("thread-1", "renderer-a", "surface-a", false);
    yield* runtime.reevaluatePresentation("thread-1");
    assert.isFalse(yield* runtime.snooze("thread-1", "7"));
    assert.isTrue(yield* runtime.snooze("thread-1", 7));
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual((yield* runtime.snapshot)[0]?.phase.type, "snoozed");
  }),
);

it.effect("clears every request generation when the app-server disconnects", () =>
  Effect.gen(function* () {
    const { runtime } = yield* makeRuntime(false);
    const removal = yield* runtime.changes.pipe(
      Stream.filter((change) => change.type === "removed" && change.reason === "disconnected"),
      Stream.runHead,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
    yield* runtime.handleDisconnect("local", 1);

    assert.isEmpty(yield* runtime.snapshot);
    assert.deepEqual(Option.getOrUndefined(yield* Fiber.join(removal)), {
      type: "removed",
      conversationId: "thread-1",
      requestId: "request-1",
      reason: "disconnected",
    });
  }),
);

it.effect("a lost host generation cannot clear remote timers or a replacement occurrence", () =>
  Effect.gen(function* () {
    const { runtime } = yield* makeRuntime(false);
    const local = { hostId: "local", generation: 1 };
    const remote = { hostId: "remote", generation: 1 };
    yield* runtime.observeRequest("old", 7, local);
    yield* runtime.observeRequest("remote", 7, remote);
    yield* runtime.observeRequest("replacement", 7, local);
    yield* runtime.observeRequest("replacement", 7, { ...local, generation: 2 });
    yield* runtime.handleDisconnect("local", 1);
    assert.deepEqual(
      (yield* runtime.snapshot).map((entry) => entry.conversationId),
      ["remote", "replacement"],
    );
    yield* runtime.observeServerResolution("replacement", 7, local);
    yield* runtime.observeResponse("replacement", 7, local);
    yield* runtime.observeServerResolution("remote", 7, local);
    assert.strictEqual((yield* runtime.snapshot).length, 2);
    yield* runtime.handleDisconnect("remote", 1);
    assert.deepEqual(
      (yield* runtime.snapshot).map((entry) => entry.conversationId),
      ["replacement"],
    );
    yield* runtime.observeServerResolution("replacement", 7, { ...local, generation: 2 });
    assert.isEmpty(yield* runtime.snapshot);
    yield* TestClock.adjust("10 minutes");
    assert.isEmpty(yield* runtime.snapshot);
  }),
);

it.effect("replaces requests and cancels stale generations on response or reconciliation", () =>
  Effect.gen(function* () {
    const { runtime } = yield* makeRuntime(false);
    const changes = yield* runtime.changes.pipe(
      Stream.take(4),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Effect.yieldNow;
    yield* runtime.observeRequest("thread-1", 7, { hostId: "local", generation: 1 });
    yield* runtime.observeRequest("thread-1", "7", { hostId: "local", generation: 1 });
    yield* runtime.observeResponse("thread-1", 7, { hostId: "local", generation: 1 });
    assert.lengthOf(yield* runtime.snapshot, 1);
    yield* runtime.reconcilePendingRequests("thread-1", [7]);
    assert.isEmpty(yield* runtime.snapshot);
    yield* TestClock.adjust("10 minutes");
    const observed = [...(yield* Fiber.join(changes))];
    assert.deepInclude(observed, {
      type: "removed",
      conversationId: "thread-1",
      requestId: 7,
      reason: "replaced",
    });
  }),
);

it.effect("interrupts every countdown when its owning Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const { runtime } = yield* makeRuntime(false).pipe(Effect.provideService(Scope.Scope, scope));
    const timeout = yield* runtime.timeouts.pipe(Stream.runHead, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* runtime.observeRequest("thread-1", "request-1", { hostId: "local", generation: 1 });
    yield* Scope.close(scope, Exit.void);
    yield* TestClock.adjust("10 minutes");
    assert.isTrue(Option.isNone(yield* Fiber.join(timeout)));
  }),
);
