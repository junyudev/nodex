import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { AgentRuntimeSupervisor } from "../agent-runtime/AgentRuntimeSupervisor";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import {
  SessionObservation,
  SessionObservationError,
  type SessionInspection,
} from "./SessionObservation";
import { make, makeWithSources } from "./SessionWaiter";
import { sessionObservationSchemas } from "../../shared/nodex-app-tools/session-observation-schemas";

const provenance = { profile_id: "profile:a" } as never;
const snapshot = (
  sessionId: string,
  disposition: SessionInspection["disposition"],
  cursor: string,
): SessionInspection => ({
  sessionId,
  selectedRunId: "run:a",
  runId: "run:a",
  title: sessionId,
  backend: "codex",
  agent: { providerInstanceId: "codex", model: "gpt" },
  status: disposition === "running" ? "active" : "idle",
  activeFlags: [],
  disposition,
  cursor,
});
const setup = (
  inspect: SessionObservation["Service"]["inspect"],
  progress: SessionObservation["Service"]["progress"],
  events: Stream.Stream<unknown> = Stream.never,
  runtimeNotifications: Effect.Effect<Stream.Stream<unknown>, never, Scope.Scope> = Effect.succeed(
    Stream.never,
  ),
) =>
  make.pipe(
    Effect.provideService(SessionObservation, { inspect, progress } as never),
    Effect.provideService(DatabaseNotifierRuntime, {
      projectSessionInvalidations: events,
    } as never),
    Effect.provideService(CodexApplicationEventHub, { events: Stream.never } as never),
    Effect.provideService(AgentRuntimeSupervisor, {
      get: () =>
        Effect.succeed({
          subscribeExecutionNotifications: runtimeNotifications,
          terminated: Effect.never,
        }),
    } as never),
  );
const emptyProgress = Effect.succeed({
  availability: "empty" as const,
  coverage: "complete" as const,
  nextCursor: null,
  latestMessage: null,
  latestTool: null,
});

it.effect.each([
  { targets: [{ sessionId: "session:a" }], expectedMs: 600_000 },
  { targets: [{ sessionId: "session:a" }], timeoutMs: 3_600_000, expectedMs: 3_600_000 },
  { targets: [{ sessionId: "session:a" }, { sessionId: "session:b" }], expectedMs: 120_000 },
])("honors the complete admitted wait deadline %# without an earlier tool timeout", (input) =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    let settled = false;
    const waiter = yield* setup(
      (sessionId) =>
        Deferred.succeed(admitted, undefined).pipe(
          Effect.as(snapshot(sessionId, "running", "running")),
        ),
      () => emptyProgress,
    );
    const request = sessionObservationSchemas.wait_sessions.parse({
      targets: input.targets,
      ...("timeoutMs" in input ? { timeoutMs: input.timeoutMs } : {}),
    });
    const waiting = yield* waiter.wait(request, provenance).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          settled = true;
        }),
      ),
      Effect.forkChild,
    );
    yield* Deferred.await(admitted);
    yield* TestClock.adjust(input.expectedMs - 1);
    assert.isFalse(settled);
    yield* TestClock.adjust(1);
    const result = yield* Fiber.join(waiting);
    assert.equal(result.reason, "timeout");
    assert.equal(result.targets.length, input.targets.length);
    assert.isTrue(
      result.targets.every(
        (target) => target.selectedRunId === "run:a" && target.runId === "run:a",
      ),
    );
  }),
);

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
            return {
              availability: "empty" as const,
              coverage: "complete" as const,
              nextCursor: null,
              latestMessage: null,
              latestTool: null,
            };
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
      assert.strictEqual(reads, 2);
    }),
);

it.effect("suppresses unchanged completion progress and keeps access errors per target", () =>
  Effect.gen(function* () {
    let reads = 0;
    const initialized = yield* Deferred.make<void>();
    const waiter = yield* setup(
      (sessionId) => {
        if (sessionId === "session:denied")
          return Effect.fail(new SessionObservationError({ reason: "authorization", cause: null }));
        return Deferred.succeed(initialized, undefined).pipe(
          Effect.as(snapshot(sessionId, "complete", "done")),
        );
      },
      () => {
        reads += 1;
        return emptyProgress;
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
    assert.strictEqual(timeout.targets[0]?.progress, undefined);
    assert.strictEqual(reads, 1);
    const denied = yield* waiter.wait(
      {
        targets: [{ sessionId: "session:a", afterCursor: "done" }, { sessionId: "session:denied" }],
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
      () => Effect.die("No progress before delivery"),
      events,
    );
    const fiber = yield* waiter
      .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 3_600_000 }, provenance)
      .pipe(Effect.forkChild);
    yield* Deferred.await(initialized);
    yield* TestClock.adjust("10 minutes");
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
      () => Effect.die("No progress after revocation"),
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

it.effect(
  "awaits asynchronous source preparation before the baseline and releases its subscription",
  () =>
    Effect.gen(function* () {
      const prepared = yield* Deferred.make<void>();
      const events = yield* PubSub.unbounded<void>();
      let inspected = false;
      let completed = false;
      const waiter = yield* makeWithSources([], {
        prepareSources: Effect.gen(function* () {
          yield* Deferred.await(prepared);
          const queue = yield* PubSub.subscribe(events);
          return [Stream.fromSubscription(queue)];
        }),
      }).pipe(
        Effect.provideService(SessionObservation, {
          inspect: (sessionId: string) =>
            Effect.gen(function* () {
              inspected = true;
              const result = snapshot(
                sessionId,
                completed ? "complete" : "running",
                completed ? "done" : "running",
              );
              if (!completed) {
                completed = true;
                yield* PubSub.publish(events, undefined);
              }
              return result;
            }),
          progress: () => emptyProgress,
        } as never),
      );
      const waiting = yield* waiter
        .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 120000 }, provenance)
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isFalse(inspected);
      yield* Deferred.succeed(prepared, undefined);
      const result = yield* Fiber.join(waiting);
      assert.equal(result.reason, "ready");
      assert.equal(result.targets[0]?.cursor, "done");
    }),
);

it.effect(
  "refreshes compact progress on a running timeout even when control state is unchanged",
  () =>
    Effect.gen(function* () {
      const initialized = yield* Deferred.make<void>();
      let progressReads = 0;
      const progress = {
        availability: "available" as const,
        coverage: "complete" as const,
        nextCursor: null,
        latestMessage: null,
        latestTool: {
          id: "tool:latest",
          runId: "run:active",
          type: "command_execution",
          status: "in_progress",
        },
      };
      const waiter = yield* setup(
        (sessionId) =>
          Deferred.succeed(initialized, undefined).pipe(
            Effect.as(snapshot(sessionId, "running", "steady")),
          ),
        () =>
          Effect.sync(() => {
            progressReads += 1;
            return progress;
          }),
      );
      const waiting = yield* waiter
        .wait(
          { targets: [{ sessionId: "session:a", afterCursor: "steady" }], timeoutMs: 1000 },
          provenance,
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(initialized);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(waiting);
      assert.equal(result.reason, "timeout");
      assert.equal(result.targets[0]?.changed, false);
      assert.deepEqual(result.targets[0]?.progress, progress);
      assert.equal(progressReads, 1);
    }),
);

it.effect("omits a target whose access is revoked during progress delivery", () =>
  Effect.gen(function* () {
    const waiter = yield* setup(
      (sessionId) => Effect.succeed(snapshot(sessionId, "complete", "done")),
      () =>
        Effect.fail(
          new SessionObservationError({
            reason: "authorization",
            cause: new Error("Revoked after inspection"),
          }),
        ),
    );
    const result = yield* waiter.wait(
      { targets: [{ sessionId: "session:a" }], timeoutMs: 0 },
      provenance,
    );
    assert.deepEqual(result.targets, []);
    assert.deepEqual(result.errors, [
      { kind: "error", sessionId: "session:a", reason: "authorization" },
    ]);
  }),
);

it.effect("wakes from Agent Runtime lifecycle changes without a Core or native notification", () =>
  Effect.gen(function* () {
    const runtime = yield* PubSub.unbounded<unknown>();
    let completed = false;
    const waiter = yield* setup(
      (sessionId) =>
        Effect.gen(function* () {
          const value = snapshot(
            sessionId,
            completed ? "complete" : "running",
            completed ? "done" : "running",
          );
          if (!completed) {
            completed = true;
            yield* PubSub.publish(runtime, {
              delivery: 1,
              notification: {
                type: "execution.lifecycle",
                subscriptionId: "lifecycle",
                runtimeGeneration: "generation",
                sequence: 1,
                threadId: "root",
                eventType: "run.updated",
                runStatus: "completed",
              },
            });
          }
          return value;
        }),
      () => emptyProgress,
      Stream.never,
      PubSub.subscribe(runtime).pipe(Effect.map(Stream.fromSubscription)),
    );
    const result = yield* waiter.wait(
      { targets: [{ sessionId: "session:a" }], timeoutMs: 120000 },
      provenance,
    );
    assert.equal(result.reason, "ready");
    assert.equal(result.targets[0]?.cursor, "done");
  }),
);

it.effect(
  "pins the initial Run while unrelated queued work appears and scopes delivered progress",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<void>();
      const requests: Array<string | null | undefined> = [];
      const progressRuns: Array<string | null | undefined> = [];
      let reads = 0;
      const waiter = yield* makeWithSources([Stream.fromPubSub(events)]).pipe(
        Effect.provideService(SessionObservation, {
          inspect: (sessionId: string, _provenance: unknown, requested?: string | null) =>
            Effect.gen(function* () {
              requests.push(requested);
              reads++;
              const current =
                reads >= 3
                  ? snapshot(sessionId, "complete", "finished")
                  : snapshot(sessionId, "running", "working");
              // The second event represents a different Run arriving. The selected Run still runs.
              if (reads < 3) yield* PubSub.publish(events, undefined);
              return {
                ...current,
                selectedRunId: requested ?? "run:original",
                runId: "run:original",
              };
            }),
          progress: (_sessionId: string, _provenance: unknown, runId?: string | null) => {
            progressRuns.push(runId);
            return emptyProgress;
          },
        } as never),
      );
      const result = yield* waiter.wait(
        { targets: [{ sessionId: "session:a" }], timeoutMs: 120000 },
        provenance,
      );
      assert.equal(result.reason, "ready");
      assert.deepEqual(requests, [undefined, "run:original", "run:original"]);
      assert.deepEqual(progressRuns, ["run:original"]);
      assert.equal(result.targets[0]?.runId, "run:original");
    }),
);

it.effect(
  "follows a restart continuation and wakes on owner settlement without a global notification",
  () =>
    Effect.gen(function* () {
      let continued = false;
      let resolvedProgress: string | null | undefined;
      const waiter = yield* makeWithSources([]).pipe(
        Effect.provideService(SessionObservation, {
          inspect: (sessionId: string, _provenance: unknown, selected?: string | null) =>
            Effect.succeed({
              ...snapshot(
                sessionId,
                continued ? "complete" : "running",
                continued ? "done" : "cut-pending",
              ),
              selectedRunId: selected ?? "run:cut",
              runId: continued ? "run:continuation" : "run:cut",
              executionRevision: continued ? "revision:done" : "revision:pending",
            }),
          awaitChange: (selected: SessionInspection) =>
            Effect.sync(() => {
              assert.equal(selected.selectedRunId, "run:cut");
              continued = true;
            }),
          progress: (_sessionId: string, _provenance: unknown, runId?: string | null) => {
            resolvedProgress = runId;
            return emptyProgress;
          },
        } as never),
      );
      const result = yield* waiter.wait(
        { targets: [{ sessionId: "session:a", runId: "run:cut" }], timeoutMs: 120000 },
        provenance,
      );
      assert.equal(result.targets[0]?.selectedRunId, "run:cut");
      assert.equal(result.targets[0]?.runId, "run:continuation");
      assert.equal(resolvedProgress, "run:continuation");
      assert.isFalse("executionRevision" in result.targets[0]!);
    }),
);

it.effect("uses the final projection read when completion races the timeout", () =>
  Effect.gen(function* () {
    let reads = 0;
    const initialized = yield* Deferred.make<void>();
    const waiter = yield* setup(
      (sessionId) =>
        Effect.gen(function* () {
          reads++;
          yield* Deferred.succeed(initialized, undefined);
          return snapshot(
            sessionId,
            reads > 1 ? "complete" : "running",
            reads > 1 ? "finished" : "working",
          );
        }),
      () => emptyProgress,
    );
    const fiber = yield* waiter
      .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 1000 }, provenance)
      .pipe(Effect.forkChild);
    yield* Deferred.await(initialized);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.reason, "ready");
    assert.equal(result.targets[0]?.disposition, "complete");
  }),
);

it.effect("keeps an initially empty selection empty when a later Run appears", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<void>();
    const inspected = yield* Deferred.make<void>();
    const requested: Array<string | null | undefined> = [];
    const waiter = yield* makeWithSources([Stream.fromPubSub(events)]).pipe(
      Effect.provideService(SessionObservation, {
        inspect: (sessionId: string, _provenance: unknown, runId?: string | null) =>
          Effect.gen(function* () {
            requested.push(runId);
            if (requested.length === 1) yield* PubSub.publish(events, undefined);
            else yield* Deferred.succeed(inspected, undefined);
            return {
              ...snapshot(sessionId, "complete", "empty"),
              selectedRunId: null,
              runId: null,
            };
          }),
        progress: () => emptyProgress,
      } as never),
    );
    const waiting = yield* waiter
      .wait(
        { targets: [{ sessionId: "session:a", afterCursor: "empty" }], timeoutMs: 1000 },
        provenance,
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(inspected);
    yield* TestClock.adjust("1 second");
    const result = yield* Fiber.join(waiting);
    assert.equal(result.reason, "timeout");
    assert.equal(result.targets[0]?.runId, null);
    assert.deepEqual(requested, [undefined, null, null]);
  }),
);

it.effect(
  "defers native selection during admission, then pins the published Turn before its completion",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<void>();
      const requested: Array<string | null | undefined> = [];
      const waiter = yield* makeWithSources([Stream.fromPubSub(events)]).pipe(
        Effect.provideService(SessionObservation, {
          inspect: (sessionId: string, _provenance: unknown, runId?: string | null) =>
            Effect.gen(function* () {
              requested.push(runId);
              const phase = requested.length;
              if (phase < 3) yield* PubSub.publish(events, undefined);
              return phase === 1
                ? {
                    ...snapshot(sessionId, "running", "admitted"),
                    selectedRunId: null,
                    runId: null,
                    selectionPending: true,
                  }
                : {
                    ...snapshot(
                      sessionId,
                      phase === 3 ? "complete" : "running",
                      phase === 3 ? "completed" : "published",
                    ),
                    selectedRunId: "turn:new",
                    runId: "turn:new",
                  };
            }),
          progress: () => emptyProgress,
        } as never),
      );
      const result = yield* waiter.wait(
        { targets: [{ sessionId: "session:a" }], timeoutMs: 120000 },
        provenance,
      );
      assert.equal(result.reason, "ready");
      assert.equal(result.targets[0]?.selectedRunId, "turn:new");
      assert.deepEqual(requested, [undefined, undefined, "turn:new"]);
      assert.isFalse("selectionPending" in result.targets[0]!);
    }),
);

it.effect(
  "waits through attention on active Runs and pins each child execution independently",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<void>();
      const seen = yield* Deferred.make<void>();
      let phase = 0;
      const calls: Array<{ threadId: string | undefined; runId: string | null | undefined }> = [];
      const waiter = yield* setup(
        (sessionId, _provenance, runId, execution) =>
          Effect.gen(function* () {
            calls.push({ threadId: execution?.threadId, runId });
            if (calls.length === 2) yield* Deferred.succeed(seen, undefined);
            return {
              ...snapshot(
                sessionId,
                phase === 0 ? "needs_attention" : "complete",
                `${execution?.threadId}:${phase}`,
              ),
              execution,
              status: phase === 0 ? "waiting" : "completed",
              selectedRunId: execution!.threadId,
              runId: execution!.threadId,
              activeFlags: phase === 0 ? ["approval"] : [],
            };
          }),
        () => emptyProgress,
        Stream.fromPubSub(events),
      );
      const parsed = sessionObservationSchemas.wait_sessions.parse({
        targets: [
          { sessionId: "session:a", execution: { threadId: "child:a" } },
          { sessionId: "session:a", execution: { threadId: "child:b" } },
        ],
        timeoutMs: 1000,
      });
      let settled = false;
      const waiting = yield* waiter.wait(parsed, provenance).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(seen);
      yield* TestClock.adjust(1);
      assert.isFalse(settled);
      phase = 1;
      yield* PubSub.publish(events, undefined);
      const result = yield* Fiber.join(waiting);
      assert.equal(result.reason, "ready");
      assert.deepEqual(
        result.targets.map((target) => target.execution?.threadId),
        ["child:a", "child:b"],
      );
      assert.deepEqual(calls.slice(2), [
        { threadId: "child:a", runId: "child:a" },
        { threadId: "child:b", runId: "child:b" },
      ]);
    }),
);

it.effect("keeps a failed selected Run pending until its automatic continuation settles", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<void>();
    const inspected = yield* Deferred.make<void>();
    let continuationPending = true;
    const waiter = yield* setup(
      (sessionId) =>
        Deferred.succeed(inspected, undefined).pipe(
          Effect.as({
            ...snapshot(sessionId, "needs_attention", "failed"),
            status: "failed",
            ...(continuationPending ? { continuationPending: true as const } : {}),
          }),
        ),
      () => emptyProgress,
      Stream.fromPubSub(events),
    );
    let settled = false;
    const waiting = yield* waiter
      .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 1000 }, provenance)
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            settled = true;
          }),
        ),
        Effect.forkChild,
      );
    yield* Deferred.await(inspected);
    yield* TestClock.adjust(1);
    assert.isFalse(settled);
    continuationPending = false;
    yield* PubSub.publish(events, undefined);
    const result = yield* Fiber.join(waiting);
    assert.equal(result.reason, "ready");
    assert.equal(result.targets[0]?.status, "failed");
  }),
);
