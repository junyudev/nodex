import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { AgentBackendApplication } from "../agent-backend/AgentBackendApplication";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import {
  SessionObservation,
  SessionObservationError,
  type SessionInspection,
} from "./SessionObservation";
import { make } from "./SessionWaiter";

const provenance = { profile_id: "profile:a" } as never;
const snapshot = (
  sessionId: string,
  disposition: SessionInspection["disposition"],
  cursor: string,
): SessionInspection => ({
  sessionId,
  title: sessionId,
  backend: "codex",
  status: disposition === "running" ? "active" : "idle",
  activeFlags: [],
  disposition,
  cursor,
});
const setup = (
  inspect: SessionObservation["Service"]["inspect"],
  read: SessionObservation["Service"]["read"],
  events: Stream.Stream<unknown> = Stream.never,
) =>
  make.pipe(
    Effect.provideService(SessionObservation, { inspect, read } as never),
    Effect.provideService(DatabaseNotifierRuntime, {
      projectSessionInvalidations: events,
    } as never),
    Effect.provideService(CodexApplicationEventHub, { events: Stream.never } as never),
    Effect.provideService(AgentBackendApplication, { changes: Stream.never } as never),
  );
const emptyHistory = Effect.succeed({ history: { availability: "empty", turns: [] } } as never);

it.effect(
  "does not lose completion emitted during the initial read and returns the first ready target",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<unknown>();
      const initialized = yield* Deferred.make<void>();
      let reads = 0;
      let completed = false;
      const waiter = yield* setup(
        (sessionId) =>
          Effect.gen(function* () {
            if (sessionId === "session:other") return snapshot(sessionId, "running", "other");
            const value = snapshot(
              sessionId,
              completed ? "complete" : "running",
              completed ? "done" : "running",
            );
            if (!completed) {
              completed = true;
              yield* PubSub.publish(events, {});
              yield* Deferred.succeed(initialized, undefined);
            }
            return value;
          }),
        () =>
          Effect.sync(() => {
            reads += 1;
            return { history: { availability: "empty", turns: [] } } as never;
          }),
        Stream.fromPubSub(events),
      );
      const fiber = yield* waiter
        .wait(
          {
            targets: [{ sessionId: "session:a" }, { sessionId: "session:other" }],
            timeoutMs: 120000,
          },
          provenance,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(initialized);
      yield* TestClock.adjust("120 seconds");
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.reason, "ready");
      assert.strictEqual(result.targets[0]?.cursor, "done");
      assert.strictEqual(result.targets[1]?.disposition, "running");
      assert.strictEqual(reads, 1);
    }),
);

it.effect(
  "suppresses unchanged completion history, respects deadlines, and keeps authorization errors per target",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      const initialized = yield* Deferred.make<void>();
      const waiter = yield* setup(
        (sessionId) => {
          if (sessionId === "session:denied")
            return Effect.fail(
              new SessionObservationError({ reason: "authorization", cause: null }),
            );
          return Deferred.succeed(initialized, undefined).pipe(
            Effect.as(snapshot(sessionId, "complete", "done")),
          );
        },
        () => {
          reads += 1;
          return emptyHistory;
        },
      );
      const initial = yield* waiter.wait(
        { targets: [{ sessionId: "session:a" }], timeoutMs: 0 },
        provenance,
      );
      assert.strictEqual(initial.reason, "snapshot");
      assert.strictEqual(reads, 1);
      const waiting = yield* waiter
        .wait(
          { targets: [{ sessionId: "session:a", afterCursor: "done" }], timeoutMs: 1000 },
          provenance,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(initialized);
      yield* TestClock.adjust("1 second");
      const timeout = yield* Fiber.join(waiting);
      assert.strictEqual(timeout.reason, "timeout");
      assert.strictEqual(timeout.targets[0]?.changed, false);
      assert.strictEqual(timeout.targets[0]?.history, undefined);
      assert.strictEqual(reads, 1);
      const denied = yield* waiter.wait(
        {
          targets: [
            { sessionId: "session:a", afterCursor: "done" },
            { sessionId: "session:denied" },
          ],
          timeoutMs: 1000,
        },
        provenance,
      );
      assert.strictEqual(denied.reason, "ready");
      assert.deepStrictEqual(denied.errors, [
        { kind: "error", sessionId: "session:denied", reason: "authorization" },
      ]);
      assert.strictEqual(reads, 1);
    }),
);

it.effect("releases event observation when a waiting caller is interrupted", () =>
  Effect.gen(function* () {
    let released = false;
    const initialized = yield* Deferred.make<void>();
    const events = Stream.unwrap(
      Effect.acquireRelease(Effect.succeed(Stream.never), () =>
        Effect.sync(() => {
          released = true;
        }),
      ),
    );
    const waiter = yield* setup(
      (sessionId) =>
        Deferred.succeed(initialized, undefined).pipe(
          Effect.as(snapshot(sessionId, "running", "running")),
        ),
      () => Effect.die("No history while waiting"),
      events,
    );
    const fiber = yield* waiter
      .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 120000 }, provenance)
      .pipe(Effect.forkChild);
    yield* Deferred.await(initialized);
    yield* Fiber.interrupt(fiber);
    assert.strictEqual(released, true);
  }),
);

it.effect("rechecks access before returning a timeout even without an invalidation event", () =>
  Effect.gen(function* () {
    let allowed = true;
    const initialized = yield* Deferred.make<void>();
    const waiter = yield* setup(
      (sessionId) => {
        if (!allowed)
          return Effect.fail(new SessionObservationError({ reason: "authorization", cause: null }));
        return Deferred.succeed(initialized, undefined).pipe(
          Effect.as(snapshot(sessionId, "running", "running")),
        );
      },
      () => Effect.die("No history after revocation"),
    );
    const fiber = yield* waiter
      .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 1000 }, provenance)
      .pipe(Effect.forkChild);
    yield* Deferred.await(initialized);
    allowed = false;
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    assert.strictEqual(result.reason, "timeout");
    assert.deepStrictEqual(result.targets, []);
    assert.deepStrictEqual(result.errors, [
      { kind: "error", sessionId: "session:a", reason: "authorization" },
    ]);
  }),
);
