import type { SessionActivity } from "../agent-runtime/AgentRuntimeSessionActivity";
import { describe } from "vite-plus/test";
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
import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { ProjectWorkspaceRead } from "../core-client/types";
import type { CoreModules } from "../core-runtime/CoreModules";
import { CoreApplicationAgent } from "../core-runtime/CoreApplicationAgent";
import { make as makeSessionDiscovery } from "./SessionDiscovery";

describe("SessionWaiter", () => {
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
    runtimeNotifications: Effect.Effect<
      Stream.Stream<unknown>,
      never,
      Scope.Scope
    > = Effect.succeed(Stream.never),
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
            liveness: Stream.make("ready" as const),
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
            return Effect.fail(
              new SessionObservationError({ reason: "authorization", cause: null }),
            );
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
            return Effect.fail(
              new SessionObservationError({ reason: "authorization", cause: null }),
            );
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

  it.effect(
    "wakes from Agent Runtime lifecycle changes without a Core or native notification",
    () =>
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

  it.effect("pins each child execution independently while its Run keeps working", () =>
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
                phase === 0 ? "running" : "complete",
                `${execution?.threadId}:${phase}`,
              ),
              execution,
              status: phase === 0 ? "waiting" : "completed",
              selectedRunId: execution!.threadId,
              runId: execution!.threadId,
              activeFlags: [],
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

  it.effect.each([
    { kind: "live question", flag: "waitingOnUserInput", continuationPending: false },
    { kind: "approval", flag: "waitingOnApproval", continuationPending: false },
    { kind: "secret card", flag: "waitingOnUserInput", continuationPending: false },
    { kind: "question before restart", flag: "waitingOnUserInput", continuationPending: true },
  ] as const)(
    "ends on a new $kind and suppresses unchanged attention on re-wait",
    ({ flag, continuationPending }) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<void>();
        const inspected = yield* Deferred.make<void>();
        let attention = false;
        let progressReads = 0;
        const waiter = yield* setup(
          (sessionId) =>
            Deferred.succeed(inspected, undefined).pipe(
              Effect.as({
                ...snapshot(
                  sessionId,
                  attention ? "needs_attention" : "running",
                  attention ? "input" : "work",
                ),
                status: continuationPending ? "cancelled" : "running",
                activeFlags: attention ? [flag] : [],
                ...(continuationPending ? { continuationPending: true as const } : {}),
              }),
            ),
          () => {
            progressReads++;
            return emptyProgress;
          },
          Stream.fromPubSub(events),
        );
        const waiting = yield* waiter
          .wait({ targets: [{ sessionId: "session:a" }], timeoutMs: 1000 }, provenance)
          .pipe(Effect.forkChild);
        yield* Deferred.await(inspected);
        attention = true;
        yield* PubSub.publish(events, undefined);
        const result = yield* Fiber.join(waiting);
        assert.equal(result.reason, "ready");
        assert.equal(result.targets[0]?.disposition, "needs_attention");
        assert.deepEqual(result.targets[0]?.activeFlags, [flag]);
        assert.equal(progressReads, 1);
        const repeated = yield* waiter
          .wait(
            {
              targets: [{ sessionId: "session:a", afterCursor: result.targets[0]!.cursor }],
              timeoutMs: 1000,
            },
            provenance,
          )
          .pipe(Effect.forkChild);
        yield* TestClock.adjust(1000);
        const unchanged = yield* Fiber.join(repeated);
        assert.equal(unchanged.reason, "timeout");
        assert.isFalse(unchanged.targets[0]!.changed);
        assert.equal(progressReads, 1);
      }),
  );

  it.effect("keeps waiting through an async question until its Thread stops working", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<void>();
      const baseline = yield* Deferred.make<void>();
      const questionSeen = yield* Deferred.make<void>();
      let phase = 0;
      let settled = false;
      const waiter = yield* setup(
        (sessionId) =>
          Effect.gen(function* () {
            if (phase === 0) yield* Deferred.succeed(baseline, undefined);
            if (phase === 1) yield* Deferred.succeed(questionSeen, undefined);
            return {
              ...snapshot(sessionId, phase === 2 ? "needs_attention" : "running", `phase:${phase}`),
              status: phase === 2 ? "waiting" : "running",
              activeFlags: phase === 2 ? ["waitingOnUserInput" as const] : [],
            };
          }),
        () => emptyProgress,
        Stream.fromPubSub(events),
      );
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
      yield* Deferred.await(baseline);
      phase = 1;
      yield* PubSub.publish(events, undefined);
      yield* Deferred.await(questionSeen);
      yield* TestClock.adjust(1);
      assert.isFalse(settled);
      phase = 2;
      yield* PubSub.publish(events, undefined);
      const result = yield* Fiber.join(waiting);
      assert.equal(result.reason, "ready");
      assert.equal(result.targets[0]?.disposition, "needs_attention");
    }),
  );

  it.effect.each(["failed", "systemError", "cancelled", "interrupted", "rolled_back", "completed"])(
    "still ends on the terminal status %s",
    (status) =>
      Effect.gen(function* () {
        const waiter = yield* setup(
          (sessionId) =>
            Effect.succeed({ ...snapshot(sessionId, "needs_attention", status), status }),
          () => emptyProgress,
        );
        const result = yield* waiter.wait(
          { targets: [{ sessionId: "session:a" }], timeoutMs: 1000 },
          provenance,
        );
        assert.equal(result.reason, "ready");
        assert.equal(result.targets[0]?.status, status);
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
});

describe("SessionDiscovery", () => {
  const make = makeSessionDiscovery;
  type Item =
    components["schemas"]["CollectionWindow_ProjectWorkspaceSessionListingItem"]["items"][number];
  type RuntimeItem = AgentRuntimeOperations["sessions.catalog"]["output"]["items"][number];
  const at = (day: number) => `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`;
  const native = (id: string, day: number, projectId: string | null = "project:a"): Item =>
    ({
      cursor: `core:${id}`,
      task: {
        session: {
          id,
          project_id: projectId,
          created_at: at(day),
          activity_at: Date.parse(at(day)),
          display_title: id,
          pinned: false,
          unread: false,
          attention_at: Date.parse(at(day)),
          archived: false,
        },
        thread: {
          thread_id: `thread:${id}`,
          recency_at: Date.parse(at(day)),
          thread_preview: id,
          backend_binding: { driver: "codex", instanceId: "codex" },
          status: { status_type: "idle", active_flags: [] },
        },
      },
      project_name: projectId,
      direct_section_id: null,
      project_section_id: null,
      project_pinned: false,
    }) as never;
  const bound = (id: string, threadId: string, projectId = "project:a"): Item => ({
    ...native(id, 1, projectId),
    task: {
      session: {
        ...native(id, 1, projectId).task.session,
        execution_ref: { runtime_id: "runtime", thread_id: threadId },
      },
      thread: null,
    },
  });
  const runtime = (id: string, day: number): RuntimeItem => ({
    threadId: id,
    title: id,
    preview: `Prompt ${id}`,
    providerInstanceId: "arbitrary-custom-id",
    providerDriver: "claudeAgent",
    model: "model",
    effort: null,
    recencyAt: at(day),
    createdAt: at(1),
    latestUserAuthoredMessageAt: null,
    updatedAt: at(1),
    activeRunId: null,
    worktreePath: null,
    status: "idle",
    activeFlags: [],
    cursor: `runtime:${id}`,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    runStatus: null,
    activityRunStatus: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: id,
    branch: null,
    pullRequests: [],
    itemCount: 0,
    itemCountCoverage: "complete",
  });
  const fixture = (options: {
    native?: readonly Item[];
    runtime?: readonly RuntimeItem[];
    bindings?: readonly Item[];
    runtimePageSize?: number;
    activity?: ReadonlyMap<string, SessionActivity>;
    runtimeId?: string;
    unavailable?: "core" | "runtime";
  }) => {
    const reads: unknown[] = [];
    const core = {
      workspace: {
        read: (request: ProjectWorkspaceRead) => {
          reads.push(request);
          if (request.kind !== "session_window")
            return Effect.die("Only catalog reads belong to discovery");
          if (request.native_only && options.unavailable === "core")
            return Effect.fail(new Error("Core unavailable"));
          const matching =
            request.execution_refs === undefined || request.execution_refs === null
              ? (options.native ?? [])
              : (options.bindings ?? []).filter((item) =>
                  request.execution_refs!.some(
                    (ref) => ref.thread_id === item.task.session.execution_ref?.thread_id,
                  ),
                );
          const scoped = matching.filter(
            (item) =>
              (!request.projectless_only || item.task.session.project_id === null) &&
              (request.project_id === undefined ||
                request.project_id === null ||
                item.task.session.project_id === request.project_id),
          );
          const offset = request.window.after
            ? scoped.findIndex((item) => item.cursor === request.window.after) + 1
            : 0;
          const items = scoped.slice(offset, offset + (request.window.first ?? 100));
          return Effect.succeed({
            value: {
              kind: "session_window",
              search_revision: 1,
              sessions: {
                items,
                next_cursor:
                  offset + items.length < scoped.length ? (items.at(-1)?.cursor ?? null) : null,
                authority: { projection_revision: 5 },
              },
            },
          });
        },
      },
    } as never as CoreModules["Service"];
    const list = make({
      core,
      sessionActivity: Effect.succeed(options.activity ?? new Map()),
      sessionCatalog: (input) => {
        if (options.unavailable === "runtime") return Effect.fail(new Error("Runtime unavailable"));
        const rows = (options.runtime ?? []).filter(
          (item) =>
            (input.includeSubagents || item.relationshipToParent !== "subagent") &&
            (!input.query ||
              `${item.title}\n${item.preview}`.toLowerCase().includes(input.query.toLowerCase())),
        );
        const start = input.cursor ? rows.findIndex((item) => item.cursor === input.cursor) + 1 : 0;
        const items = rows.slice(start, start + (options.runtimePageSize ?? input.limit ?? 100));
        return Effect.succeed({
          runtimeId: options.runtimeId ?? "runtime",
          items,
          nextCursor: start + items.length < rows.length ? (items.at(-1)?.cursor ?? null) : null,
        });
      },
    });
    return { list, reads };
  };

  it.effect(
    "merges owner recency before pagination and supports lossless smaller response budgets",
    () =>
      Effect.gen(function* () {
        const f = fixture({
          native: [native("native:10", 10), native("native:8", 8), native("draft", 1, null)],
          runtime: [runtime("runtime:9", 9), runtime("runtime:7", 7)],
          bindings: [bound("session:9", "runtime:9"), bound("session:7", "runtime:7")],
        });
        const first = yield* f.list({ archived: false, limit: 3 });
        assert.deepEqual(
          first.sessions.map((item) => item.sessionId),
          ["native:10", "session:9", "native:8"],
        );
        const second = yield* f.list({ archived: false, limit: 3, cursor: first.nextCursor! });
        assert.deepEqual(
          second.sessions.map((item) => item.sessionId),
          ["session:7", "draft"],
        );
        assert.equal(second.nextCursor, null);
        const shortened = yield* f.list({
          archived: false,
          limit: 1,
          cursor: first.entryCursors[0]!,
        });
        assert.equal(shortened.sessions[0]?.sessionId, "session:9");
        assert.equal(shortened.sessions[0]?.preview, "Prompt runtime:9");
        assert.equal(shortened.sessions[0]?.backend, "claudeAgent");
        const otherProfile = yield* f
          .list({ archived: false, limit: 1, cursor: first.nextCursor! })
          .pipe(
            Effect.provideService(CoreApplicationAgent, { profile_id: "other-profile" } as never),
            Effect.result,
          );
        assert.equal(otherProfile._tag, "Failure");
        const changedRuntime = fixture({ runtimeId: "new-runtime" });
        const oldCursor = yield* changedRuntime
          .list({ archived: false, limit: 1, cursor: first.nextCursor! })
          .pipe(Effect.result);
        assert.equal(oldCursor._tag, "Failure");
      }),
  );

  it.effect(
    "advances sparse Project filters without emitting older rows ahead of an unread source",
    () =>
      Effect.gen(function* () {
        const f = fixture({
          native: [native("native:4", 4)],
          runtimePageSize: 1,
          runtime: [runtime("other-project", 9), runtime("matching", 8)],
          bindings: [
            bound("other", "other-project", "project:other"),
            bound("matching", "matching"),
          ],
        });
        const first = yield* f.list({ archived: false, projectId: "project:a", limit: 10 });
        assert.deepEqual(first.sessions, []);
        assert.isString(first.nextCursor);
        const second = yield* f.list({
          archived: false,
          projectId: "project:a",
          limit: 10,
          cursor: first.nextCursor!,
        });
        assert.deepEqual(
          second.sessions.map((item) => item.sessionId),
          ["matching", "native:4"],
        );
        assert.equal(second.nextCursor, null);
        const wrongScope = yield* f
          .list({
            archived: false,
            projectId: "project:other",
            limit: 10,
            cursor: first.nextCursor!,
          })
          .pipe(Effect.result);
        assert.equal(wrongScope._tag, "Failure");
        if (wrongScope._tag === "Failure")
          assert.equal(wrongScope.failure.reason, "invalid_cursor");
      }),
  );

  it.effect.each([false, true])(
    "preserves both backends' attention flags in archived=%s listings",
    (archived) =>
      Effect.gen(function* () {
        const flags = ["waitingOnApproval", "waitingOnUserInput"] as const;
        const nativeItem = native("native:attention", 5);
        const runtimeBinding = bound("runtime:attention", "thread:attention");
        const f = fixture({
          native: [
            {
              ...nativeItem,
              task: {
                ...nativeItem.task,
                session: { ...nativeItem.task.session, archived },
                thread: {
                  ...nativeItem.task.thread!,
                  status: { status_type: "active", active_flags: [...flags] },
                },
              },
            },
          ],
          runtime: [{ ...runtime("thread:attention", 6), activeFlags: flags }],
          bindings: [
            {
              ...runtimeBinding,
              task: {
                ...runtimeBinding.task,
                session: { ...runtimeBinding.task.session, archived },
              },
            },
          ],
        });
        const page = yield* f.list({ archived, limit: 10 });
        assert.equal(page.sessions.length, 2);
        for (const session of page.sessions) {
          assert.deepEqual(session.status.active_flags, flags);
          assert.equal(session.archived, archived);
        }
      }),
  );

  it.effect("keeps available source results and explicitly reports the failed source", () =>
    Effect.gen(function* () {
      const nativeOnly = fixture({ native: [native("native", 5)], unavailable: "runtime" });
      const result = yield* nativeOnly.list({ archived: false, limit: 10 });
      assert.equal(result.sessions[0]?.sessionId, "native");
      assert.deepEqual(
        result.sources.map((source) => [source.source, source.availability]),
        [
          ["core", "available"],
          ["runtime", "unavailable"],
        ],
      );
      const runtimeOnly = fixture({
        unavailable: "core",
        runtime: [runtime("runtime", 6)],
        bindings: [bound("bound", "runtime")],
      });
      const available = yield* runtimeOnly.list({ archived: false, limit: 10 });
      assert.equal(available.sessions[0]?.sessionId, "bound");
      assert.equal(available.sources[0]?.availability, "unavailable");
    }),
  );

  it.effect(
    "enumerates mixed sources exactly once across sparse pages and equal recency coordinates",
    () =>
      Effect.gen(function* () {
        const natives = Array.from({ length: 20 }, (_, index) =>
          native(`native:${String(index).padStart(2, "0")}`, (index % 7) + 1),
        ).sort(
          (left, right) =>
            right.task.thread!.recency_at - left.task.thread!.recency_at ||
            left.task.session.id.localeCompare(right.task.session.id),
        );
        const runtimes = Array.from({ length: 80 }, (_, index) =>
          runtime(`runtime:${String(index).padStart(2, "0")}`, (index % 7) + 1),
        ).sort(
          (left, right) =>
            right.recencyAt!.localeCompare(left.recencyAt!) ||
            left.threadId.localeCompare(right.threadId),
        );
        const bindings = runtimes
          .filter((_, index) => index % 4 === 0)
          .map((item) => bound(item.threadId, item.threadId));
        const expected = [
          ...natives.map((item) => ({
            id: item.task.session.id,
            at: item.task.thread!.recency_at,
            source: "core",
          })),
          ...runtimes
            .filter((item) => bindings.some((binding) => binding.task.session.id === item.threadId))
            .map((item) => ({
              id: item.threadId,
              at: Date.parse(item.recencyAt!),
              source: "runtime",
            })),
        ].sort(
          (left, right) =>
            right.at - left.at ||
            left.source.localeCompare(right.source) ||
            left.id.localeCompare(right.id),
        );
        for (const limit of [1, 9, 50]) {
          const f = fixture({ native: natives, runtime: runtimes, bindings, runtimePageSize: 7 });
          const found: string[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 150; page++) {
            const result = yield* f.list({
              archived: false,
              limit,
              ...(cursor === undefined ? {} : { cursor }),
            });
            found.push(...result.sessions.map((item) => item.sessionId));
            if (result.nextCursor === null) break;
            assert.notEqual(result.nextCursor, cursor);
            cursor = result.nextCursor;
          }
          assert.deepEqual(
            found,
            expected.map((item) => item.id),
          );
        }
      }),
  );

  it.effect("keeps continuations readable with maximum Unicode filter scopes", () =>
    Effect.gen(function* () {
      const query = "😀".repeat(100);
      const projectId = "漢".repeat(512);
      const recent = {
        ...runtime("root:recent", 9),
        preview: query,
        cursor: JSON.stringify({ version: 1, query, at: at(9), threadId: "root:recent" }),
      };
      const f = fixture({
        native: [
          {
            ...native("older", 2, projectId),
            task: {
              ...native("older", 2, projectId).task,
              thread: { ...native("older", 2, projectId).task.thread!, thread_preview: query },
            },
          },
        ],
        runtime: [recent],
        bindings: [bound("recent", recent.threadId, projectId)],
      });
      const scope = { archived: false, query, projectId, limit: 1 };
      const page = yield* f.list(scope);
      assert.isNotNull(page.nextCursor);
      assert.isTrue(
        sessionObservationSchemas.list_sessions.safeParse({
          query,
          projectId,
          limit: 1,
          cursor: page.nextCursor,
        }).success,
      );
      const next = yield* f.list({ ...scope, cursor: page.nextCursor! });
      assert.equal(next.sessions[0]?.sessionId, "older");
      assert.equal(next.nextCursor, null);
    }),
  );

  it.effect("discovers renamed Runtime Sessions by Core title and canonical prompt preview", () =>
    Effect.gen(function* () {
      const binding = bound("session:renamed", "root");
      const renamed = {
        ...binding,
        task: {
          ...binding.task,
          session: { ...binding.task.session, display_title: "Renamed illustration work" },
        },
      };
      const f = fixture({
        runtime: [
          {
            ...runtime("root", 9),
            title: "Old title",
            preview: "Original prompt about characters",
          },
        ],
        bindings: [renamed],
      });
      const byTitle = yield* f.list({ archived: false, query: "ILLUSTRATION", limit: 1 });
      assert.equal(byTitle.sessions[0]?.title, renamed.task.session.display_title);
      const byPreview = yield* f.list({ archived: false, query: "characters", limit: 1 });
      assert.equal(byPreview.sessions[0]?.sessionId, "session:renamed");
      const old = yield* f.list({ archived: false, query: "Old title", limit: 1 });
      assert.deepEqual(old.sessions, []);
      assert.equal(old.nextCursor, null);
    }),
  );

  it.effect(
    "filters exact execution state while preserving Core metadata and sparse continuation",
    () =>
      Effect.gen(function* () {
        const active = {
          ...runtime("active", 9),
          status: "active" as const,
          runStatus: "waiting" as const,
        };
        const settled = {
          ...runtime("settled", 8),
          runStatus: "completed" as const,
          branch: "feature/search",
        };
        const placement = bound("session:settled", "settled");
        const f = fixture({
          runtime: [active, settled],
          bindings: [
            bound("session:active", "active"),
            {
              ...placement,
              task: {
                ...placement.task,
                session: {
                  ...placement.task.session,
                  settled_at: Date.parse(at(8)),
                },
              },
            },
          ],
          runtimePageSize: 1,
        });
        const first = yield* f.list({
          archived: false,
          limit: 10,
          statuses: ["completed"],
          lanes: ["settled"],
        });
        assert.equal(first.sessions.length, 0);
        assert.isNotNull(first.nextCursor);
        const second = yield* f.list({
          archived: false,
          limit: 10,
          statuses: ["completed"],
          lanes: ["settled"],
          cursor: first.nextCursor!,
        });
        assert.equal(second.sessions[0]?.sessionId, "session:settled");
        assert.equal(second.sessions[0]?.attention.settledAt, at(8));
        assert.equal(second.sessions[0]?.branch, "feature/search");
        assert.equal(second.sessions[0]?.itemCountCoverage, "complete");
        assert.equal(
          (yield* f
            .list({ archived: false, limit: 10, statuses: ["running"], cursor: first.nextCursor! })
            .pipe(Effect.result))._tag,
          "Failure",
        );
      }),
  );

  it.effect(
    "filters and sorts the full attention result before paging, and detects changed membership",
    () =>
      Effect.gen(function* () {
        const pinBinding = bound("pin", "pin-thread");
        const pin = {
          ...pinBinding,
          task: {
            ...pinBinding.task,
            session: { ...pinBinding.task.session, pinned: true, pinned_order: 0 },
          },
          member_requests: { personal: false, pending: [] },
        };
        const background = bound("background", "background-thread");
        const waiting = {
          ...bound("waiting", "waiting-thread"),
          member_requests: {
            personal: false,
            pending: [{ id: "mine", kind: "question" as const }],
          },
        };
        const live = (
          sessionId: string,
          status: SessionActivity["status"],
          facts: Partial<SessionActivity> = {},
        ): SessionActivity => ({
          sessionId,
          status,
          threadId: sessionId + "-thread",
          activeRunId: null,
          pendingRequestCount: 0,
          backgroundTasks: [],
          providerInstanceId: "test",
          model: "test",
          updatedAt: at(1),
          ...facts,
        });
        const activity = new Map([
          ["background", live("background", "background")],
          [
            "waiting",
            live("waiting", "waiting", {
              pendingRequestCount: 2,
              activeFlags: ["waitingOnUserInput", "waitingOnApproval"],
              pendingRequestIds: ["mine", "not-mine"],
            }),
          ],
        ]);
        const f = fixture({
          native: [native("quiet", 9)],
          runtime: [
            runtime("background-thread", 8),
            runtime("waiting-thread", 7),
            runtime("pin-thread", 2),
          ],
          bindings: [pin, background, waiting],
          runtimePageSize: 1,
          activity,
        });
        const request = { archived: false, order: "attention", limit: 2 } as const;
        const first = yield* f.list(request);
        assert.deepEqual(
          first.sessions.map(({ sessionId }) => sessionId),
          ["pin", "waiting"],
        );
        assert.equal(first.sessions[1]?.attention.waitingOn, "input");
        const next = yield* f.list({ ...request, cursor: first.entryCursors[0]! });
        assert.deepEqual(
          next.sessions.map(({ sessionId }) => sessionId),
          ["waiting", "quiet"],
        );
        const working = yield* f.list({ ...request, lanes: ["working"] });
        assert.deepEqual(
          working.sessions.map(({ sessionId }) => sessionId),
          ["background"],
        );
        assert.equal(working.sessions[0]?.attention.working, "background");
        activity.set(
          "waiting",
          live("waiting", "waiting", {
            pendingRequestCount: 1,
            activeFlags: ["waitingOnUserInput"],
            pendingRequestIds: ["another-request"],
          }),
        );
        const stale = yield* f.list({ ...request, cursor: first.nextCursor! }).pipe(Effect.flip);
        assert.equal(stale.reason, "cursor_stale");
        const refreshed = yield* f.list(request);
        assert.deepEqual(
          refreshed.sessions.map(({ sessionId }) => sessionId),
          ["pin", "quiet"],
        );
      }),
  );

  it.effect("filters canonical running activity even when the presented latest Run is queued", () =>
    Effect.gen(function* () {
      const f = fixture({
        runtime: [
          {
            ...runtime("root", 9),
            status: "active",
            runStatus: "queued",
            activityRunStatus: "running",
            activeRunId: "running",
          },
        ],
        bindings: [bound("session:running", "root")],
      });
      const page = yield* f.list({ archived: false, limit: 20, statuses: ["running"] });
      assert.equal(page.sessions[0]?.sessionId, "session:running");
      assert.equal(page.sessions[0]?.runStatus, "queued");
      assert.equal(page.sessions[0]?.activityRunStatus, "running");
      assert.equal(page.sessions[0]?.status.status_type, "active");
    }),
  );

  it.effect(
    "discovers child executions through their bound product Session and fences includeSubagents cursors",
    () =>
      Effect.gen(function* () {
        const root = runtime("root", 8);
        const child = {
          ...runtime("child", 10),
          rootThreadId: "root",
          parentThreadId: "root",
          relationshipToParent: "subagent" as const,
        };
        const f = fixture({ runtime: [child, root], bindings: [bound("session:root", "root")] });
        const first = yield* f.list({ archived: false, includeSubagents: true, limit: 1 });
        assert.equal(first.sessions[0]?.sessionId, "session:root");
        assert.deepEqual(first.sessions[0]?.execution, { threadId: "child" });
        assert.equal(first.sessions[0]?.threadId, "child");
        const byChildTitle = yield* f.list({
          archived: false,
          includeSubagents: true,
          limit: 20,
          query: "child",
        });
        assert.deepEqual(
          byChildTitle.sessions.map((session) => [session.sessionId, session.executionTitle]),
          [["session:root", "child"]],
        );
        assert.equal(byChildTitle.sessions[0]?.title, "session:root");
        const second = yield* f.list({
          archived: false,
          includeSubagents: true,
          limit: 1,
          cursor: first.nextCursor!,
        });
        assert.deepEqual(second.sessions[0]?.execution, { threadId: "root" });
        const roots = yield* f.list({ archived: false, includeSubagents: false, limit: 20 });
        assert.deepEqual(
          roots.sessions.map((session) => session.threadId),
          ["root"],
        );
        const changed = yield* f
          .list({ archived: false, includeSubagents: false, limit: 20, cursor: first.nextCursor! })
          .pipe(Effect.result);
        assert.equal(changed._tag, "Failure");
      }).pipe(Effect.provideService(CoreApplicationAgent, null)),
  );

  it.effect("a projectless discovery scope excludes Project Sessions before pagination", () =>
    Effect.gen(function* () {
      const f = fixture({ native: [native("project", 10), native("projectless", 1, null)] });
      const page = yield* f.list({ archived: false, scope: "project", limit: 1 });
      assert.deepEqual(
        page.sessions.map((session) => session.sessionId),
        ["projectless"],
      );
      assert.equal(page.nextCursor, null);
      assert.equal(
        f.reads.some(
          (request) =>
            (request as ProjectWorkspaceRead).kind === "session_window" &&
            "projectless_only" in (request as object),
        ),
        true,
      );
    }).pipe(Effect.provideService(CoreApplicationAgent, null)),
  );
});
