import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { CodexOwnerNotificationDrainTimeout, make } from "./CodexOwnerNotificationDrainRuntime";

it.effect("tracks monotonic sent and acknowledged owner notification sequences", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    assert.strictEqual(runtime.next("thread-1"), 1);
    assert.strictEqual(runtime.next("thread-1"), 2);
    assert.isTrue(runtime.canAck("thread-1", 2));
    assert.isTrue(runtime.ack("thread-1", 2));
    yield* runtime.awaitCurrent("thread-1");
  }),
);

it.effect("allows cross-process consumption to take longer than a renderer frame budget", () =>
  Effect.gen(function* () {
    const runtime = yield* make();
    runtime.next("thread-1");
    const waiting = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    yield* TestClock.adjust("1 second");
    assert.isUndefined(waiting.pollUnsafe());
    assert.isTrue(runtime.ack("thread-1", 1));
    yield* Fiber.join(waiting);
  }),
);

it.effect("a canceled caller cannot lend its old deadline to a later drain", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    runtime.next("thread-1");
    const canceled = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    yield* TestClock.adjust("500 millis");
    yield* Fiber.interrupt(canceled);
    const current = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    yield* TestClock.adjust("500 millis");
    assert.isUndefined(current.pollUnsafe());
    assert.isTrue(runtime.ack("thread-1", 1));
    yield* Fiber.join(current);
  }),
);

it.effect("rejects malformed, duplicate, and future ACKs without crossing the drain barrier", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 hour" });
    runtime.next("thread-1");
    const waiting = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });

    assert.isFalse(runtime.canAck("thread-1", Number.NaN));
    assert.isFalse(runtime.ack("thread-1", Number.NaN));
    assert.isFalse(runtime.ack("thread-1", 2));
    assert.isFalse(runtime.ack("thread-1", Number.MAX_SAFE_INTEGER + 1));
    yield* Effect.yieldNow;
    assert.isUndefined(waiting.pollUnsafe());

    assert.isTrue(runtime.ack("thread-1", 1));
    yield* Fiber.join(waiting);
    assert.isFalse(runtime.ack("thread-1", 1));
  }),
);

it.effect("each drain waits only for the notification prefix captured by that caller", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    runtime.next("thread-1");
    const first = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.next("thread-1");
    const second = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.ack("thread-1", 1);
    yield* Effect.yieldNow;
    assert.strictEqual(first.pollUnsafe()?._tag, "Success");
    assert.isUndefined(second.pollUnsafe());
    runtime.ack("thread-1", 2);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }),
);

it.effect("reports the captured prefix and actual ACK on timeout without forging consumption", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    runtime.next("thread-1");
    const first = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.next("thread-1");
    const second = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.ack("thread-1", 1);
    yield* Fiber.join(first);
    yield* TestClock.adjust("1 second");
    const timedOut = yield* Fiber.await(second);
    assert.isTrue(Exit.isFailure(timedOut));
    if (!Exit.isFailure(timedOut)) return;
    const error = Cause.squash(timedOut.cause);
    assert.instanceOf(error, CodexOwnerNotificationDrainTimeout);
    assert.strictEqual(error.sentSequence, 2);
    assert.strictEqual(error.ackSequence, 1);
    assert.include(error.message, "did not finish synchronizing");
    const retry = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    assert.isUndefined(retry.pollUnsafe());
    assert.isTrue(runtime.ack("thread-1", 2));
    yield* Fiber.join(retry);
  }),
);

it.effect(
  "owner replacement and release cannot acknowledge the previous owner's pending work",
  () =>
    Effect.gen(function* () {
      const runtime = yield* make({ timeout: "1 hour" });
      runtime.next("thread-1");
      const resetWait = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
        startImmediately: true,
      });
      runtime.resetOwner("thread-1");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(resetWait)));
      assert.strictEqual(runtime.next("thread-1"), 2);
      const releaseWait = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
        startImmediately: true,
      });
      runtime.release("thread-1");
      assert.isTrue(Exit.isFailure(yield* Fiber.await(releaseWait)));
      assert.strictEqual(runtime.next("thread-1"), 1);
    }),
);

it.effect("Thread clear and Main Scope close interrupt active barriers", () =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const runtime = yield* make({ timeout: "1 hour" }).pipe(
      Effect.provideService(Scope.Scope, ownerScope),
    );
    runtime.next("thread-1");
    const cleared = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.clear("thread-1");
    assert.isTrue((yield* Fiber.await(cleared))._tag === "Failure");

    runtime.next("thread-2");
    const closed = yield* Effect.forkChild(runtime.awaitCurrent("thread-2"), {
      startImmediately: true,
    });
    const closedSignal = yield* Deferred.make<void>();
    yield* Effect.forkChild(
      Fiber.await(closed).pipe(Effect.andThen(Deferred.succeed(closedSignal, undefined))),
    );
    yield* Scope.close(ownerScope, Exit.void);
    yield* Deferred.await(closedSignal);
    assert.isTrue((yield* Fiber.await(closed))._tag === "Failure");
  }),
);
