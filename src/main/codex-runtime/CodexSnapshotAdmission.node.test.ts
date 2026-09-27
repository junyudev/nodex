import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeCodexSnapshotAdmission } from "./CodexSnapshotAdmission";

it.effect("drains admitted requests and keeps new work outside the snapshot", () =>
  Effect.gen(function* () {
    const gate = yield* makeCodexSnapshotAdmission();
    const requestStarted = yield* Deferred.make<void>();
    const finishRequest = yield* Deferred.make<void>();
    const snapshotStarted = yield* Deferred.make<void>();
    const finishSnapshot = yield* Deferred.make<void>();
    const nextStarted = yield* Deferred.make<void>();
    const first = yield* gate
      .request(
        Deferred.succeed(requestStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishRequest)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(requestStarted);
    const snapshot = yield* gate
      .snapshot(
        Deferred.succeed(snapshotStarted, undefined).pipe(
          Effect.andThen(Deferred.await(finishSnapshot)),
        ),
      )
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const next = yield* gate
      .request(Deferred.succeed(nextStarted, undefined))
      .pipe(Effect.forkScoped);
    assert.isFalse(yield* Deferred.isDone(snapshotStarted));
    assert.isFalse(yield* Deferred.isDone(nextStarted));
    yield* Deferred.succeed(finishRequest, undefined);
    yield* Fiber.join(first);
    yield* Deferred.await(snapshotStarted);
    assert.isFalse(yield* Deferred.isDone(nextStarted));
    yield* Deferred.succeed(finishSnapshot, undefined);
    yield* Fiber.join(snapshot);
    yield* Fiber.join(next);
    assert.isTrue(yield* Deferred.isDone(nextStarted));
  }),
);

it.effect("reopens admission when a waiting snapshot is cancelled", () =>
  Effect.gen(function* () {
    const gate = yield* makeCodexSnapshotAdmission();
    const started = yield* Deferred.make<void>();
    const request = yield* gate
      .request(Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const snapshot = yield* gate.snapshot(Effect.never).pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(snapshot);
    assert.strictEqual(yield* gate.request(Effect.succeed("resumed")), "resumed");
    yield* Fiber.interrupt(request);
    assert.strictEqual(yield* gate.snapshot(Effect.succeed("reusable")), "reusable");
  }),
);

it.effect("restores admission after capture failure", () =>
  Effect.gen(function* () {
    const gate = yield* makeCodexSnapshotAdmission();
    yield* gate.snapshot(Effect.fail("capture failed")).pipe(Effect.result);
    assert.strictEqual(yield* gate.request(Effect.succeed(1)), 1);
  }),
);

it.effect("permits stopping active work during drain, then seals every request for capture", () =>
  Effect.gen(function* () {
    const gate = yield* makeCodexSnapshotAdmission();
    const draining = yield* Deferred.make<void>();
    const seal = yield* Deferred.make<void>();
    const captured = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const snapshot = yield* gate
      .snapshot(
        Effect.gen(function* () {
          yield* Deferred.succeed(draining, undefined);
          yield* Deferred.await(seal);
          yield* gate.seal;
          yield* Deferred.succeed(captured, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(Effect.forkScoped);
    yield* Deferred.await(draining);
    assert.strictEqual(yield* gate.request(Effect.succeed("stopped"), true), "stopped");
    yield* Deferred.succeed(seal, undefined);
    yield* Deferred.await(captured);
    const sent = yield* Deferred.make<void>();
    const control = yield* gate
      .request(Deferred.succeed(sent, undefined), true)
      .pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.isFalse(yield* Deferred.isDone(sent));
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(snapshot);
    yield* Fiber.join(control);
  }),
);
