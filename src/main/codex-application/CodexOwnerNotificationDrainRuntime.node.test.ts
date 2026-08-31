import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { make } from "./CodexOwnerNotificationDrainRuntime";

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

it.effect("shares the first barrier while new notifications extend the ack requirement", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    runtime.next("thread-1");
    const first = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    const second = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.next("thread-1");
    runtime.ack("thread-1", 1);
    yield* Effect.yieldNow;
    assert.isUndefined(first.pollUnsafe());
    assert.isUndefined(second.pollUnsafe());
    runtime.ack("thread-1", 2);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
  }),
);

it.effect("fails a frozen barrier without forging an ACK and admits a later real ACK", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 second" });
    runtime.next("thread-1");
    const first = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.next("thread-1");
    yield* TestClock.adjust("1 second");
    assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
    const second = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    yield* Effect.yieldNow;
    assert.isUndefined(second.pollUnsafe());
    assert.isTrue(runtime.ack("thread-1", 2));
    yield* Fiber.join(second);
  }),
);

it.effect("owner reset and release resolve pending barriers", () =>
  Effect.gen(function* () {
    const runtime = yield* make({ timeout: "1 hour" });
    runtime.next("thread-1");
    const resetWait = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.resetOwner("thread-1");
    yield* Fiber.join(resetWait);
    runtime.next("thread-1");
    const releaseWait = yield* Effect.forkChild(runtime.awaitCurrent("thread-1"), {
      startImmediately: true,
    });
    runtime.release("thread-1");
    yield* Fiber.join(releaseWait);
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
