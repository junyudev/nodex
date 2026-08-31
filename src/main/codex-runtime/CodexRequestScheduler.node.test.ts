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
import type { CodexRuntimeError } from "./CodexRuntimeError";

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

it.effect("bounds a shared read at 128 logical waiters with a typed pressure failure", () =>
  withOpenScheduler((scheduler) =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<string>();
      const waiters: Array<Fiber.Fiber<string, CodexRuntimeError>> = [];
      for (let index = 0; index < 128; index += 1) {
        waiters.push(
          yield* Effect.forkScoped(
            request(scheduler, "thread/items/list", Deferred.await(gate), {
              conversationId: "thread-a",
            }),
          ),
        );
        yield* Effect.yieldNow;
      }

      const error = yield* expectFailure(
        request(scheduler, "thread/items/list", Effect.succeed("overflow"), {
          conversationId: "thread-a",
        }),
      );
      assert.strictEqual(error.reason, "pressure");
      assert.strictEqual(error.retryable, true);
      const snapshot = yield* scheduler.snapshot;
      assert.strictEqual(snapshot.totals.coalesced, 127);
      assert.strictEqual(snapshot.totals.rejected, 1);

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
  "cancels the queue deadline when dispatch begins and grants a fresh execution timeout",
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
        const pending = yield* Effect.forkScoped(
          request(scheduler, "critical/read", Effect.never, {
            priority: "critical",
            timeoutMs: 10,
          }),
        );

        yield* TestClock.adjust(5);
        yield* Deferred.succeed(gates[0]!, "released");
        yield* Fiber.join(blockers[0]!);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(6);
        const beforeExecutionDeadline = yield* scheduler.snapshot;
        assert.strictEqual(beforeExecutionDeadline.current.inFlight, 6);
        assert.strictEqual(beforeExecutionDeadline.totals.executionTimedOut, 0);

        yield* TestClock.adjust(4);
        const error = yield* expectFailure(Fiber.join(pending));
        assert.strictEqual(error.operation, "scheduler.execution");
        assert.strictEqual(error.reason, "timeout");

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
        request(scheduler, "turn/start", Effect.never, {
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
