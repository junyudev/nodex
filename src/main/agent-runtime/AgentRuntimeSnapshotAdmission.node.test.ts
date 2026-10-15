import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import { make } from "./AgentRuntimeSnapshotAdmission";

it.effect("drains concurrent Session mutations before capture and rejects new admission", () =>
  Effect.gen(function* () {
    const admission = yield* make();
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const first = yield* admission
      .withWriter(
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    // Ordinary writes are concurrent while the snapshot fence is open.
    assert.strictEqual(yield* admission.withWriter(Effect.succeed(2)), 2);
    const captured = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const snapshot = yield* admission
      .withSnapshot(
        Deferred.succeed(captured, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      )
      .pipe(Effect.forkScoped({ startImmediately: true }));
    assert.isFalse(yield* Deferred.isDone(captured));
    assert.isTrue(Exit.isFailure(yield* admission.withWriter(Effect.void).pipe(Effect.exit)));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(first);
    yield* Deferred.await(captured);
    assert.isTrue(Exit.isFailure(yield* admission.withSnapshot(Effect.void).pipe(Effect.exit)));
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(snapshot);
    assert.strictEqual(yield* admission.withWriter(Effect.succeed(3)), 3);
  }),
);

it.effect("interrupted capture releases admission while prior writers finish", () =>
  Effect.gen(function* () {
    const admission = yield* make();
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writer = yield* admission
      .withWriter(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const snapshot = yield* admission
      .withSnapshot(Effect.never)
      .pipe(Effect.forkScoped({ startImmediately: true }));
    yield* Fiber.interrupt(snapshot);
    assert.strictEqual(yield* admission.withWriter(Effect.succeed(4)), 4);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(writer);
    assert.strictEqual(yield* admission.withSnapshot(Effect.succeed(5)), 5);
  }),
);
