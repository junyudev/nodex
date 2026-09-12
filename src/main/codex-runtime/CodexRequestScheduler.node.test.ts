import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import { CodexRequestScheduler, live } from "./CodexRequestScheduler";
import { CodexScheduledRequestTrace, makeCodexHostRequestMetrics } from "./CodexHostRequestMetrics";
import { makeCodexRendererRequestLifetimes } from "./CodexRendererRequestLifetimes";
import type { CodexRuntimeError } from "./CodexRuntimeError";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";
import type { CodexTurnDelivery } from "../../shared/codex-conversation-state/codex-turn-delivery";

const withOpenScheduler = <A>(
  use: (
    scheduler: CodexRequestScheduler["Service"],
  ) => Effect.Effect<A, CodexRuntimeError, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scheduler = yield* CodexRequestScheduler;
      yield* scheduler.openGeneration("local", 1);
      return yield* use(scheduler);
    }),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this helper owns a fresh test application Scope.
  ).pipe(Effect.provide(Layer.fresh(live)));

const request = <A>(
  scheduler: CodexRequestScheduler["Service"],
  method: string,
  dispatch: Effect.Effect<A>,
  options: Parameters<CodexRequestScheduler["Service"]["schedule"]>[0]["options"] = {},
) =>
  scheduler.schedule({
    hostId: "local",
    generation: 1,
    method,
    params: { threadId: "thread-a" },
    dispatch,
    options,
  });

const expectFailure = <A>(effect: Effect.Effect<A, CodexRuntimeError>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return result.failure;
      throw new Error("Expected the scheduled request to fail");
    }),
  );

const sent = <A>(effect: Effect.Effect<A>) =>
  Effect.gen(function* () {
    const trace = yield* CodexScheduledRequestTrace;
    if (!trace) return yield* Effect.die("Missing dispatch trace");
    trace.startedAtMs = 0;
    trace.onDispatched?.();
    return yield* effect;
  });

it.effect(
  "Main retains a sent Turn past its deadline and releases admission until the real response",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<string>();
        const deliveries: CodexTurnDelivery[] = [];
        const pending = yield* request(scheduler, "turn/start", sent(Deferred.await(response)), {
          requestId: "turn/start:wire-main",
          timeoutMs: 30,
          retainResponse: true,
          onOutcomeUnknown: (delivery) =>
            Effect.sync(() => {
              deliveries.push(delivery);
            }),
        }).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 1);
        yield* TestClock.adjust(30);
        assert.deepEqual(deliveries, [
          { requestId: "turn/start:wire-main", method: "turn/start", stage: "outcome-unknown" },
        ]);
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
        yield* TestClock.adjust(100);
        assert.strictEqual(deliveries.length, 1);
        yield* Deferred.succeed(response, "accepted");
        assert.strictEqual(yield* Fiber.join(pending), "accepted");
        assert.strictEqual((yield* scheduler.snapshot).totals.completed, 1);
      }),
    ),
);

it.effect("a late native response waits for the already-admitted delivery callback", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const response = yield* Deferred.make<string>();
      const entered = yield* Deferred.make<void>();
      const recorded = yield* Deferred.make<void>();
      const observed: string[] = [];
      const pending = yield* request(scheduler, "turn/steer", sent(Deferred.await(response)), {
        timeoutMs: 30,
        retainResponse: true,
        onOutcomeUnknown: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(recorded)),
            Effect.tap(() =>
              Effect.sync(() => {
                observed.push("recorded");
              }),
            ),
          ),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            observed.push("returned");
          }),
        ),
        Effect.forkScoped,
      );
      const clock = yield* TestClock.adjust(30).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* Deferred.succeed(response, "accepted");
      yield* Effect.yieldNow;
      assert.deepEqual(observed, []);
      yield* Deferred.succeed(recorded, undefined);
      yield* Fiber.join(clock);
      assert.strictEqual(yield* Fiber.join(pending), "accepted");
      assert.deepEqual(observed, ["recorded", "returned"]);
    }),
  ),
);

it.effect(
  "Main's uncertain injection rejects its caller but keeps native admission until the reply",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<string>();
        const pending = yield* request(
          scheduler,
          "thread/inject_items",
          sent(Deferred.await(response)),
          {
            requestId: "thread/inject_items:wire-main",
            timeoutMs: 30,
            outcomeOnTimeout: "unknown",
          },
        ).pipe(Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(30);
        const error = yield* expectFailure(Fiber.join(pending));
        assert.deepEqual(encodeCodexNativeRequestFailure(error).delivery, {
          requestId: "thread/inject_items:wire-main",
          method: "thread/inject_items",
          stage: "outcome-unknown",
        });
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 1);
        yield* Deferred.succeed(response, "late result");
        yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
      }),
    ),
);

it.effect("Main expires before readiness without an uncertain submission or a late dispatch", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let wasSent = false;
      const deliveries: CodexTurnDelivery[] = [];
      const pending = yield* request(
        scheduler,
        "turn/start",
        Deferred.await(ready).pipe(
          Effect.andThen(
            sent(
              Effect.sync(() => {
                wasSent = true;
              }),
            ),
          ),
        ),
        {
          requestId: "turn/start:unsent-main",
          timeoutMs: 30,
          retainResponse: true,
          onOutcomeUnknown: (delivery) =>
            Effect.sync(() => {
              deliveries.push(delivery);
            }),
        },
      ).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(30);
      const error = yield* expectFailure(Fiber.join(pending));
      assert.deepEqual(encodeCodexNativeRequestFailure(error).delivery, {
        requestId: "turn/start:unsent-main",
        method: "turn/start",
        stage: "not-sent",
      });
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.yieldNow;
      assert.isFalse(wasSent);
      assert.deepEqual(deliveries, []);
      assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
    }),
  ),
);

it.effect(
  "retained caller timeout frees admission while preserving the native result and host pending count",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const lifetimes = yield* makeCodexRendererRequestLifetimes;
        const hostMetrics = makeCodexHostRequestMetrics("local", "local", "stdio");
        const response = yield* Deferred.make<string>();
        let dispatches = 0;
        const pending = yield* lifetimes.start(
          "window:retained",
          true,
          request(
            scheduler,
            "turn/start",
            Effect.gen(function* () {
              const trace = yield* CodexScheduledRequestTrace;
              if (!trace) return yield* Effect.die("Missing native dispatch trace");
              trace.startedAtMs = 0;
              trace.onDispatched?.();
              dispatches += 1;
              return yield* Deferred.await(response);
            }),
            {
              hostMetrics,
              responseTimeoutOwner: "caller",
              rendererCaller: { destinationId: "window" },
            },
          ),
        );
        yield* Effect.yieldNow;
        assert.strictEqual(dispatches, 1);
        yield* Effect.forEach(Array.from({ length: 5 }), (_, index) =>
          Effect.forkScoped(
            request(scheduler, `critical/${index}`, Effect.never, { priority: "critical" }),
          ),
        );
        let nextDispatched = false;
        yield* Effect.forkScoped(
          request(
            scheduler,
            "critical/next",
            Effect.sync(() => {
              nextDispatched = true;
            }).pipe(Effect.andThen(Effect.never)),
            { priority: "critical" },
          ),
        );
        yield* Effect.yieldNow;
        assert.isFalse(nextDispatched);
        yield* lifetimes.abandon("window:retained");
        yield* lifetimes.abandon("window:retained");
        yield* Effect.yieldNow;
        assert.isTrue(nextDispatched);
        assert.strictEqual(hostMetrics.receiveState.pendingClientRequests, 1);
        assert.strictEqual((yield* scheduler.snapshot).totals.outcomeUnknown, 1);
        yield* Deferred.succeed(response, "accepted once");
        assert.strictEqual(yield* Fiber.join(pending), "accepted once");
        assert.strictEqual(dispatches, 1);
        assert.strictEqual(hostMetrics.receiveState.pendingClientRequests, 0);
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 6);
      }),
    ),
);

it.effect("retained callers queued before native dispatch expire without being sent", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const lifetimes = yield* makeCodexRendererRequestLifetimes;
      yield* Effect.forEach(Array.from({ length: 6 }), (_, index) =>
        Effect.forkScoped(
          request(scheduler, `critical/${index}`, Effect.never, { priority: "critical" }),
        ),
      );
      yield* Effect.yieldNow;
      assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 6);
      let dispatched = false;
      const pending = yield* lifetimes.start(
        "window:unsent",
        true,
        request(
          scheduler,
          "turn/start",
          Effect.sync(() => {
            dispatched = true;
          }),
          {
            responseTimeoutOwner: "caller",
            rendererCaller: { destinationId: "window" },
          },
        ),
      );
      yield* Effect.yieldNow;
      assert.strictEqual((yield* scheduler.snapshot).current.queued, 1);
      yield* lifetimes.abandon("window:unsent");
      yield* Effect.yieldNow;
      assert.strictEqual((yield* scheduler.snapshot).current.queued, 0);
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      assert.isFalse(dispatched);
      assert.strictEqual((yield* scheduler.snapshot).totals.outcomeUnknown, 0);
    }),
  ),
);

it.effect(
  "retained timeout during native readiness cancels the unsent operation and releases admission",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const lifetimes = yield* makeCodexRendererRequestLifetimes;
        const ready = yield* Deferred.make<void>();
        let dispatched = false;
        const pending = yield* lifetimes.start(
          "window:ready",
          true,
          request(
            scheduler,
            "turn/start",
            Deferred.await(ready).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  dispatched = true;
                }),
              ),
            ),
            { responseTimeoutOwner: "caller", rendererCaller: { destinationId: "window" } },
          ),
        );
        yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 1);
        yield* lifetimes.abandon("window:ready");
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
        yield* Deferred.succeed(ready, undefined);
        yield* Effect.yieldNow;
        assert.isFalse(dispatched);
        assert.strictEqual((yield* scheduler.snapshot).totals.outcomeUnknown, 0);
      }),
    ),
);

it.effect(
  "native generation retirement rejects retained late-result callers without leaking host counts",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const lifetimes = yield* makeCodexRendererRequestLifetimes;
        const hostMetrics = makeCodexHostRequestMetrics("local", "local", "stdio");
        const pending = yield* lifetimes.start(
          "window:retired",
          true,
          request(
            scheduler,
            "turn/start",
            Effect.gen(function* () {
              const trace = yield* CodexScheduledRequestTrace;
              if (!trace) return yield* Effect.die("Missing native dispatch trace");
              trace.startedAtMs = 0;
              trace.onDispatched?.();
              return yield* Effect.never;
            }),
            {
              hostMetrics,
              responseTimeoutOwner: "caller",
              rendererCaller: { destinationId: "window" },
            },
          ),
        );
        yield* Effect.yieldNow;
        yield* lifetimes.abandon("window:retired");
        yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
        yield* scheduler.retireGeneration("local", 1);
        assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
        assert.strictEqual(hostMetrics.receiveState.pendingClientRequests, 0);
      }),
    ),
);

for (const method of ["thread/resume", "thread/read"]) {
  it.effect(`accounts for abandoned ${method} until its dispatch slot is released`, () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const response = yield* Deferred.make<string>();
        const first = yield* Effect.forkScoped(
          request(scheduler, method, Deferred.await(response)),
        );
        yield* Effect.yieldNow;
        yield* Effect.forEach(Array.from({ length: 5 }), (_, index) =>
          Effect.forkScoped(
            request(scheduler, `critical/${index}`, Effect.never, { priority: "critical" }),
          ),
        );
        yield* Effect.yieldNow;
        let dispatched = false;
        yield* Effect.forkScoped(
          request(
            scheduler,
            "critical/next",
            Effect.sync(() => {
              dispatched = true;
            }).pipe(Effect.andThen(Effect.never)),
            { priority: "critical" },
          ),
        );
        yield* Effect.yieldNow;
        assert.strictEqual(dispatched, false);

        yield* Fiber.interrupt(first);
        yield* Effect.yieldNow;
        assert.strictEqual(dispatched, method === "thread/resume");
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 6);

        yield* Deferred.succeed(response, "late response");
        yield* Effect.yieldNow;
        const settled = yield* scheduler.snapshot;
        assert.strictEqual(dispatched, true);
        assert.strictEqual(settled.current.inFlight, 6);
        assert.strictEqual(settled.current.queued, 0);
        assert.strictEqual(settled.totals.lateCompletions, method === "thread/resume" ? 1 : 0);
      }),
    ),
  );
}

it.effect("shares selected reads without coupling the leader to its first caller", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      let dispatches = 0;
      const dispatch = Effect.sync(() => {
        dispatches += 1;
      }).pipe(Effect.andThen(Deferred.await(gate)));
      const first = yield* Effect.forkScoped(request(scheduler, "thread/read", dispatch));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkScoped(request(scheduler, "thread/read", dispatch));
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(gate, "shared");

      assert.strictEqual(yield* Fiber.join(second), "shared");
      assert.strictEqual(dispatches, 1);
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.totals.logicalScheduled, 2);
      assert.strictEqual(snapshot.totals.physicalDispatched, 1);
      assert.strictEqual(snapshot.totals.coalesced, 1);
      assert.strictEqual(snapshot.totals.callerDetached, 1);
      assert.strictEqual(snapshot.current.inFlight, 0);
    }),
  ),
);

it.effect(
  "reports a detached physical response after its last logical renderer caller closes",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<string>();
        const orphaned: unknown[] = [];
        const pending = yield* Effect.forkScoped(
          request(
            scheduler,
            "thread/read",
            Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate))),
            {
              requestId: "destroyed-read",
              rendererCaller: { destinationId: "1", abandonment: () => "disposed" },
              onDetachedPhysicalResponse: (response) =>
                Effect.sync(() => {
                  orphaned.push(response);
                }),
            },
          ),
        );
        yield* Deferred.await(started);

        yield* Fiber.interrupt(pending);
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 1);
        yield* Deferred.succeed(gate, "orphan-result");
        yield* Effect.yieldNow;

        assert.deepEqual(orphaned, [{ type: "result", result: "orphan-result" }]);
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 0);
      }),
    ),
);

it.effect(
  "admits a leader plus 128 coalesced waiters and counts followers after leader cancellation",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const gate = yield* Deferred.make<string>();
        const waiters: Array<Fiber.Fiber<string, CodexRuntimeError>> = [];
        for (let index = 0; index < 129; index += 1) {
          waiters.push(
            yield* Effect.forkScoped(
              request(scheduler, "thread/turns/list", Deferred.await(gate), {
                conversationId: "thread-a",
              }),
            ),
          );
          yield* Effect.yieldNow;
        }

        const error = yield* expectFailure(
          request(scheduler, "thread/turns/list", Effect.succeed("overflow"), {
            conversationId: "thread-a",
          }),
        );
        assert.strictEqual(error.reason, "pressure");
        assert.strictEqual(error.retryable, true);
        const snapshot = yield* scheduler.snapshot;
        assert.strictEqual(snapshot.totals.coalesced, 128);
        assert.strictEqual(snapshot.totals.rejected, 1);

        const leader = waiters.shift();
        if (!leader) throw new Error("Missing leader");
        yield* Fiber.interrupt(leader);
        const afterLeaderCancellation = yield* expectFailure(
          request(scheduler, "thread/turns/list", Effect.succeed("overflow")),
        );
        assert.strictEqual(afterLeaderCancellation.reason, "pressure");
        yield* Deferred.succeed(gate, "shared");
        yield* Effect.forEach(waiters, Fiber.join, { discard: true });
      }),
    ),
);

it.effect(
  "expires queued work before dispatch and starts execution timeout only after dispatch",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const blockers = yield* Effect.forEach(Array.from({ length: 6 }), (_, index) =>
          Effect.forkScoped(
            scheduler.schedule({
              hostId: "local",
              generation: 1,
              method: `critical/${index}`,
              params: { index },
              dispatch: Effect.never,
              options: { priority: "critical", coalesce: false },
            }),
          ),
        );
        yield* Effect.yieldNow;
        const queued = yield* Effect.forkScoped(
          request(scheduler, "queued/read", Effect.succeed("too-late"), {
            priority: "critical",
            timeoutMs: 10,
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust(10);

        const queuedError = yield* expectFailure(Fiber.join(queued));
        assert.strictEqual(queuedError.reason, "timeout");
        assert.strictEqual(queuedError.operation, "scheduler.queue");

        yield* Effect.forEach(blockers, Fiber.interrupt, { discard: true });
        yield* scheduler.retireGeneration("local", 1);
      }),
    ),
);

it.effect(
  "keeps the original response deadline after queueing and observes a late native result",
  () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const gates = yield* Effect.forEach(Array.from({ length: 6 }), () =>
          Deferred.make<string>(),
        );
        const blockers = yield* Effect.forEach(gates, (gate, index) =>
          Effect.forkScoped(
            scheduler.schedule({
              hostId: "local",
              generation: 1,
              method: `critical/${index}`,
              params: { index },
              dispatch: Deferred.await(gate),
              options: { priority: "critical", coalesce: false },
            }),
          ),
        );
        yield* Effect.yieldNow;
        const response = yield* Deferred.make<string>();
        const pending = yield* Effect.forkScoped(
          request(scheduler, "critical/read", sent(Deferred.await(response)), {
            priority: "critical",
            timeoutMs: 10,
          }),
        );

        yield* TestClock.adjust(5);
        yield* Deferred.succeed(gates[0]!, "released");
        yield* Fiber.join(blockers[0]!);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(4);
        const beforeExecutionDeadline = yield* scheduler.snapshot;
        assert.strictEqual(beforeExecutionDeadline.current.inFlight, 6);
        assert.strictEqual(beforeExecutionDeadline.totals.executionTimedOut, 0);

        yield* TestClock.adjust(1);
        const error = yield* expectFailure(Fiber.join(pending));
        assert.strictEqual(error.operation, "scheduler.execution");
        assert.strictEqual(error.reason, "timeout");
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 6);
        yield* Deferred.succeed(response, "late native result");
        yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).current.inFlight, 5);

        yield* Effect.forEach(gates.slice(1), (gate) => Deferred.succeed(gate, "released"), {
          discard: true,
        });
        yield* Effect.forEach(blockers.slice(1), Fiber.join, { discard: true });
      }),
    ),
);

it.effect("classifies a dispatched mutation timeout as outcome unknown", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        request(scheduler, "turn/start", sent(Effect.never), {
          timeoutMs: 25,
          outcomeOnTimeout: "unknown",
        }),
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust(25);

      const error = yield* expectFailure(Fiber.join(pending));
      assert.strictEqual(error.reason, "outcome-unknown");
      assert.strictEqual(error.retryable, false);
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.totals.executionTimedOut, 1);
      assert.strictEqual(snapshot.totals.outcomeUnknown, 1);
    }),
  ),
);

it.effect("retires queued and in-flight work and rejects the stale generation", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const active = yield* Effect.forkScoped(request(scheduler, "thread/read", Effect.never));
      yield* Effect.yieldNow;
      yield* scheduler.retireGeneration("local", 1);

      const activeError = yield* expectFailure(Fiber.join(active));
      assert.strictEqual(activeError.reason, "session-lost");
      const staleError = yield* expectFailure(
        request(scheduler, "thread/read", Effect.succeed("stale")),
      );
      assert.strictEqual(staleError.reason, "session-lost");
      const snapshot = yield* scheduler.snapshot;
      assert.deepStrictEqual(
        {
          generations: snapshot.current.generations,
          inFlight: snapshot.current.inFlight,
          queued: snapshot.current.queued,
        },
        { generations: 0, inFlight: 0, queued: 0 },
      );
      assert.strictEqual(snapshot.totals.generationsRetired, 1);
    }),
  ),
);

it.effect("binds every generation to the Scope that opened it", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const owner = yield* Scope.make();
      yield* scheduler
        .openGeneration("remote-a", 2)
        .pipe(Effect.provideService(Scope.Scope, owner));
      const active = yield* Effect.forkScoped(
        scheduler.schedule({
          hostId: "remote-a",
          generation: 2,
          method: "thread/read",
          params: { threadId: "thread-a" },
          dispatch: Effect.never,
        }),
      );
      yield* Effect.yieldNow;

      yield* Scope.close(owner, Exit.void);

      const error = yield* expectFailure(Fiber.join(active));
      assert.strictEqual(error.reason, "session-lost");
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.current.generations, 1);
      assert.strictEqual(snapshot.current.inFlight, 0);
      assert.strictEqual(snapshot.totals.generationsRetired, 1);
    }),
  ),
);

it.effect("isolates identical coalescing keys in different host generations", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      yield* scheduler.openGeneration("remote", 1);
      const gate = yield* Deferred.make<void>();
      const local = yield* Effect.forkScoped(
        request(scheduler, "thread/read", Deferred.await(gate).pipe(Effect.as("local"))),
      );
      yield* Effect.yieldNow;
      const remote = yield* Effect.forkScoped(
        scheduler.schedule({
          hostId: "remote",
          generation: 1,
          method: "thread/read",
          params: { threadId: "thread-a" },
          dispatch: Deferred.await(gate).pipe(Effect.as("remote")),
        }),
      );
      yield* Effect.yieldNow;
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.current.inFlight, 2);
      assert.strictEqual(snapshot.totals.coalesced, 0);
      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual(yield* Fiber.join(local), "local");
      assert.strictEqual(yield* Fiber.join(remote), "remote");
    }),
  ),
);

it.effect("zero timeout leaves a queued and executing request without an explicit deadline", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const pending = yield* Effect.forkScoped(
        request(scheduler, "thread/read", Effect.sleep(1_000).pipe(Effect.as("complete")), {
          timeoutMs: 0,
        }),
      );
      yield* TestClock.adjust(1_000);
      assert.strictEqual(yield* Fiber.join(pending), "complete");
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.totals.executionTimedOut, 0);
      assert.strictEqual(snapshot.totals.queueExpired, 0);
    }),
  ),
);

for (const reason of ["timeout", "disposed"] as const) {
  it.effect(`requeues plugin waiters with their own dispatch after ${reason}`, () =>
    withOpenScheduler((scheduler) =>
      Effect.gen(function* () {
        const original = yield* Deferred.make<string>();
        const replacement = yield* Deferred.make<string>();
        const started = yield* Deferred.make<void>();
        let replacementCalls = 0;
        const leader = yield* request(
          scheduler,
          "plugin/list",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(original))),
          {
            coalesce: true,
            responseTimeoutOwner: "caller",
            rendererCaller: { destinationId: "first", abandonment: () => reason },
          },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const survivor = yield* request(
          scheduler,
          "plugin/list",
          Effect.sync(() => {
            replacementCalls++;
          }).pipe(Effect.andThen(Deferred.await(replacement))),
          {
            coalesce: true,
            responseTimeoutOwner: "caller",
            rendererCaller: { destinationId: "second" },
          },
        ).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* Fiber.interrupt(leader);
        yield* Effect.yieldNow;
        assert.strictEqual(replacementCalls, 1);
        yield* Deferred.succeed(original, "orphan");
        yield* Deferred.succeed(replacement, "replacement");
        assert.strictEqual(yield* Fiber.join(survivor), "replacement");
      }),
    ),
  );
}

it.effect("detaches a coalesced plugin follower without redispatching the live leader", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      let dispatches = 0;
      const dispatch = Effect.sync(() => {
        dispatches += 1;
      }).pipe(Effect.andThen(Deferred.await(gate)));
      const leader = yield* request(scheduler, "plugin/list", dispatch, {
        coalesce: true,
        responseTimeoutOwner: "caller",
        rendererCaller: { destinationId: "leader" },
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const follower = yield* request(scheduler, "plugin/list", dispatch, {
        coalesce: true,
        responseTimeoutOwner: "caller",
        rendererCaller: { destinationId: "follower", abandonment: () => "timeout" },
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      yield* Fiber.interrupt(follower);
      yield* Effect.yieldNow;
      assert.strictEqual(dispatches, 1);
      yield* Deferred.succeed(gate, "leader-result");
      assert.strictEqual(yield* Fiber.join(leader), "leader-result");
    }),
  ),
);
