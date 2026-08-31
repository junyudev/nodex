import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { make, makeWithCapacity } from "./ThreadCreationRuntime";

it.effect("releases notification-first starts only after local materialization", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const response = yield* Deferred.make<string>();
    const materialization = yield* gate
      .materialize("local", 7, Deferred.await(response), (threadId) => threadId)
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isTrue(gate.defer("local", 7, "thread-a"));
    assert.isFalse(gate.defer("remote", 7, "thread-remote"));
    yield* Deferred.succeed(response, "thread-a");
    assert.strictEqual(yield* Fiber.join(materialization), "thread-a");
    const release = Option.getOrThrow(yield* Stream.runHead(gate.releases));
    assert.deepEqual(release, { hostId: "local", generation: 7, threadId: "thread-a" });
    assert.isFalse(gate.defer("local", 7, "thread-a"));

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("drains an unknown started Thread when its request fails", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const rejectRequest = yield* Deferred.make<void>();
    const failed = yield* gate
      .materialize(
        "local",
        3,
        Deferred.await(rejectRequest).pipe(Effect.andThen(Effect.fail("request failed"))),
        () => null,
      )
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isTrue(gate.defer("local", 3, "orphan-thread"));
    yield* Deferred.succeed(rejectRequest, undefined);
    assert.strictEqual((yield* Fiber.await(failed))._tag, "Failure");
    assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
      hostId: "local",
      generation: 3,
      threadId: "orphan-thread",
    });

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps the physical materialization alive after its renderer waiter is interrupted", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const response = yield* Deferred.make<string>();
    const committed = yield* Deferred.make<string>();
    const waiter = yield* gate
      .materialize(
        "local",
        11,
        Deferred.await(response).pipe(
          Effect.tap((threadId) => Deferred.succeed(committed, threadId)),
        ),
        (threadId) => threadId,
      )
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isTrue(gate.defer("local", 11, "thread-detached"));
    yield* Fiber.interrupt(waiter);
    yield* Deferred.succeed(response, "thread-detached");
    assert.strictEqual(yield* Deferred.await(committed), "thread-detached");
    assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
      hostId: "local",
      generation: 11,
      threadId: "thread-detached",
    });

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails health instead of dropping a deferred canonical start release", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* makeWithCapacity(1).pipe(Effect.provideService(Scope.Scope, scope));
    const response = yield* Deferred.make<void>();
    const materialization = yield* gate
      .materialize(
        "local",
        1,
        Deferred.await(response).pipe(Effect.andThen(Effect.fail("request failed"))),
        () => null,
      )
      .pipe(Effect.forkChild);
    const termination = yield* gate.termination.pipe(Effect.flip, Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isTrue(gate.defer("local", 1, "thread-a"));
    assert.isTrue(gate.defer("local", 1, "thread-b"));
    yield* Deferred.succeed(response, undefined);
    yield* Fiber.await(materialization);
    const overflow = yield* Fiber.join(termination);

    assert.strictEqual(overflow.capacity, 1);
    assert.strictEqual(overflow.hostId, "local");
    assert.strictEqual(overflow.generation, 1);
    assert.strictEqual(overflow.threadId, "thread-b");
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("never admits or releases a start across Endpoint generations", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const gate = yield* make.pipe(Effect.provideService(Scope.Scope, scope));
    const oldResponse = yield* Deferred.make<void>();
    const nextResponse = yield* Deferred.make<void>();
    const oldMaterialization = yield* gate
      .materialize("local", 21, Deferred.await(oldResponse), () => null)
      .pipe(Effect.forkChild);
    const nextMaterialization = yield* gate
      .materialize("local", 22, Deferred.await(nextResponse), () => null)
      .pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.isTrue(gate.defer("local", 21, "thread-old"));
    assert.isTrue(gate.defer("local", 22, "thread-next"));
    assert.isFalse(gate.defer("local", 23, "thread-unknown"));

    yield* Deferred.succeed(oldResponse, undefined);
    yield* Fiber.join(oldMaterialization);
    assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
      hostId: "local",
      generation: 21,
      threadId: "thread-old",
    });

    yield* Deferred.succeed(nextResponse, undefined);
    yield* Fiber.join(nextMaterialization);
    assert.deepEqual(Option.getOrThrow(yield* Stream.runHead(gate.releases)), {
      hostId: "local",
      generation: 22,
      threadId: "thread-next",
    });

    yield* Scope.close(scope, Exit.void);
  }),
);
