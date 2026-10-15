import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import { make } from "./AgentRuntimeSupervisor";

const fixture = Effect.gen(function* () {
  const started = yield* Queue.unbounded<AgentRuntimeProcessConnection>();
  const requests: string[] = [];
  /** `thread.read` waits on this latch so a test can hold a request in flight. */
  const inFlight = yield* Deferred.make<void>();
  const generations: Array<{
    readonly terminated: Deferred.Deferred<AgentRuntimeProcessError>;
    readonly released: Deferred.Deferred<void>;
  }> = [];
  const acquire = Effect.gen(function* () {
    const terminated = yield* Deferred.make<AgentRuntimeProcessError>();
    const released = yield* Deferred.make<void>();
    generations.push({ terminated, released });
    yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
    const connection: AgentRuntimeProcessConnection = {
      identity: {
        runtimeId: "profile-runtime",
        runtimeGeneration: String(generations.length),
        schemaVersion: 1,
        databasePath: "/tmp/runtime.sqlite",
        mcpEndpoint: "http://localhost:1/mcp",
        lastSequence: 0,
      },
      terminated: Deferred.await(terminated),
      notifications: Stream.empty,
      subscribeNotifications: Effect.succeed(Stream.empty),
      subscribeExecutionNotifications: Effect.succeed(Stream.empty),
      request: (method) =>
        Effect.sync(() => requests.push(method)).pipe(
          Effect.andThen(method === "thread.read" ? Deferred.await(inFlight) : Effect.void),
          Effect.andThen(
            Effect.fail(
              new AgentRuntimeProcessError({ reason: "closed", message: "Fixture command failed" }),
            ),
          ),
        ),
    };
    yield* Queue.offer(started, connection);
    return connection;
  });
  return { generations, acquire, started, requests, inFlight };
});

it.effect("stops the physical generation before restore and retires it after success", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () => Effect.succeed(() => Effect.succeed({})),
    });
    yield* supervisor.get();
    const value = yield* supervisor.withStopped(
      Effect.gen(function* () {
        assert.isTrue(yield* Deferred.isDone(f.generations[0]!.released));
        assert.isNull(yield* supervisor.inspect);
        return "installed";
      }),
      { retireOnSuccess: true },
    );
    assert.strictEqual(value, "installed");
    assert.isTrue(Exit.isFailure(yield* supervisor.get().pipe(Effect.exit)));
    yield* TestClock.adjust("5 seconds");
    assert.strictEqual(f.generations.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("failed restore allows a fresh generation without reviving the old connection", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () => Effect.succeed(() => Effect.succeed({})),
    });
    yield* supervisor.get();
    assert.strictEqual(
      yield* supervisor
        .withStopped(Effect.fail("rollback complete"), { retireOnSuccess: true })
        .pipe(Effect.flip),
      "rollback complete",
    );
    assert.isTrue(yield* Deferred.isDone(f.generations[0]!.released));
    assert.strictEqual((yield* supervisor.get()).identity.runtimeGeneration, "2");
  }).pipe(Effect.scoped),
);

it.live("a stale snapshot cannot stop the replacement physical generation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () => Effect.succeed(() => Effect.succeed({})),
    });
    const first = yield* supervisor.get();
    yield* Deferred.succeed(
      f.generations[0]!.terminated,
      new AgentRuntimeProcessError({ reason: "closed", message: "fixture exit" }),
    );
    yield* Deferred.await(f.generations[0]!.released).pipe(Effect.timeout("5 seconds"));
    const replacement = yield* supervisor.get();
    let installed = false;
    const result = yield* supervisor
      .withStopped(
        Effect.sync(() => {
          installed = true;
        }),
        { expectedConnection: first, retireOnSuccess: true },
      )
      .pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
    assert.isFalse(installed);
    assert.isFalse(yield* Deferred.isDone(f.generations[1]!.released));
    assert.strictEqual(yield* supervisor.get(), replacement);
  }).pipe(Effect.scoped),
);

it.effect(
  "bounds crash recovery per sliding window even when Agent actions keep asking for execution",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const supervisor = yield* make({
        acquire: () => f.acquire,
        activate: () => Effect.succeed(() => Effect.succeed({})),
        restarts: { limit: 3, window: "5 minutes" },
      });
      yield* supervisor.get();
      yield* Queue.take(f.started);
      assert.isTrue(
        Exit.isFailure(yield* supervisor.request("runtime.identity", {}).pipe(Effect.exit)),
      );
      for (let index = 0; index < 4; index += 1) {
        const generation = f.generations[index]!;
        yield* Deferred.succeed(
          generation.terminated,
          new AgentRuntimeProcessError({ reason: "closed", message: "Unexpected exit" }),
        );
        yield* Deferred.await(generation.released);
        yield* TestClock.adjust("250 millis");
        if (index < 3) {
          assert.strictEqual(
            (yield* Queue.take(f.started)).identity.runtimeGeneration,
            String(index + 2),
          );
          assert.deepEqual(yield* supervisor.connectionState, {
            status: "ready",
            generation: String(index + 2),
          });
        }
      }
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(f.generations.length, 4);
      assert.isNull(yield* supervisor.inspect);
      assert.deepEqual(f.requests, ["runtime.identity"]);
      const exhausted = yield* supervisor.connectionState;
      assert.strictEqual(exhausted.status, "failed");
      // User actions inside the window cannot restart a crash loop.
      for (let attempt = 0; attempt < 3; attempt += 1)
        assert.isTrue(Exit.isFailure(yield* supervisor.get().pipe(Effect.exit)));
      assert.strictEqual(f.generations.length, 4);
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual((yield* supervisor.get()).identity.runtimeGeneration, "5");
      assert.deepEqual(yield* supervisor.connectionState, { status: "ready", generation: "5" });
    }).pipe(Effect.scoped),
);

it.effect("publishes each connection transition and reports a failed start with a message", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const states: AgentRuntimeConnectionState[] = [];
    let failStart = true;
    const supervisor = yield* make({
      acquire: () => (failStart ? Effect.fail(new Error("executable missing")) : f.acquire),
      activate: () => Effect.succeed(() => Effect.succeed({})),
    });
    yield* supervisor.connectionChanges.pipe(
      Stream.runForEach((state) => Effect.sync(() => states.push(state))),
      Effect.forkScoped({ startImmediately: true }),
    );
    assert.isTrue(Exit.isFailure(yield* supervisor.get().pipe(Effect.exit)));
    failStart = false;
    yield* supervisor.get();
    yield* supervisor.withStopped(Effect.void);
    yield* Effect.yieldNow;
    assert.deepEqual(
      states.map((state) => state.status),
      ["idle", "starting", "failed", "restarting", "ready", "idle"],
    );
    const failed = states[2];
    assert.isTrue(failed?.status === "failed" && failed.message.length > 0);
    assert.deepEqual(states[3], { status: "restarting", attempt: 1 });
  }).pipe(Effect.scoped),
);

it.live(
  "does no startup work until requested and shares one generation across concurrent callers",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let activations = 0;
      const supervisor = yield* make({
        acquire: () => f.acquire,
        activate: () =>
          Effect.sync(() => {
            activations += 1;
            return () => Effect.succeed({});
          }),
      });
      assert.isNull(yield* supervisor.inspect);
      assert.strictEqual(f.generations.length, 0);
      const connections = yield* Effect.all(
        Array.from({ length: 20 }, () => supervisor.get()),
        { concurrency: 20 },
      );
      assert.strictEqual(new Set(connections).size, 1);
      assert.strictEqual(activations, 1);
      yield* supervisor.close;
      yield* Deferred.await(f.generations[0]!.released);
      assert.isTrue(Exit.isFailure(yield* supervisor.get().pipe(Effect.exit)));
    }).pipe(Effect.scoped),
);

it.live("releases failed generation authority before acquiring its replacement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () => Effect.succeed(() => Effect.succeed({})),
    });
    const first = yield* supervisor.get();
    yield* Deferred.succeed(
      f.generations[0]!.terminated,
      new AgentRuntimeProcessError({ reason: "closed", message: "fixture exit" }),
    );
    yield* Deferred.await(f.generations[0]!.released).pipe(Effect.timeout("5 seconds"));
    const second = yield* supervisor.get();
    assert.notStrictEqual(first, second);
    assert.strictEqual(second.identity.runtimeId, first.identity.runtimeId);
    assert.notStrictEqual(second.identity.runtimeGeneration, first.identity.runtimeGeneration);
  }).pipe(Effect.scoped),
);

it.live("failed Host activation closes its resources and permits an explicit later retry", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () =>
        f.generations.length === 1
          ? Effect.fail(new Error("Host unavailable"))
          : Effect.succeed(() => Effect.succeed({})),
    });
    assert.isTrue(Exit.isFailure(yield* supervisor.get().pipe(Effect.exit)));
    yield* Deferred.await(f.generations[0]!.released);
    assert.strictEqual((yield* supervisor.get()).identity.runtimeGeneration, "2");
  }).pipe(Effect.scoped),
);

const idleSupervisor = (
  f: Effect.Success<typeof fixture>,
  evidence: string[],
  quiescent: () => boolean = () => true,
) =>
  make({
    acquire: () => f.acquire,
    activate: () => Effect.succeed(() => Effect.succeed({})),
    idle: { after: "3 minutes", quiescent: () => Effect.sync(quiescent) },
    quiescence: {
      record: Effect.sync(() => evidence.push("record")),
      clear: Effect.sync(() => evidence.push("clear")),
      startRequired: Effect.sync(() => evidence.at(-1) !== "record"),
    },
  });
const released = (f: Effect.Success<typeof fixture>, index: number) =>
  Deferred.isDone(f.generations[index]!.released);

it.effect("stops a quiet generation without work and restarts it for the next request", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const evidence: string[] = [];
    const supervisor = yield* idleSupervisor(f, evidence);
    yield* supervisor.get();
    yield* TestClock.adjust("2 minutes");
    assert.isFalse(yield* released(f, 0));
    yield* TestClock.adjust("1 minute");
    assert.isTrue(yield* released(f, 0));
    assert.isNull(yield* supervisor.inspect);
    assert.deepEqual(yield* supervisor.connectionState, { status: "idle" });
    assert.deepEqual(evidence, ["clear", "record"]);
    // An idle stop is not a crash: no automatic restart and no recovery budget.
    yield* TestClock.adjust("10 minutes");
    assert.strictEqual(f.generations.length, 1);
    assert.strictEqual((yield* supervisor.get()).identity.runtimeGeneration, "2");
    assert.deepEqual(yield* supervisor.connectionState, { status: "ready", generation: "2" });
    assert.deepEqual(evidence, ["clear", "record", "clear"]);
  }).pipe(Effect.scoped),
);

it.effect("keeps a generation while requests, observers or live work remain", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const evidence: string[] = [];
    let live = true;
    const supervisor = yield* idleSupervisor(f, evidence, () => !live);
    const connection = yield* supervisor.get();
    const request = yield* connection
      .request("thread.read", { threadId: "thread" })
      .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true }));
    yield* TestClock.adjust("10 minutes");
    assert.isFalse(yield* released(f, 0));
    yield* Deferred.succeed(f.inFlight, undefined);
    yield* Fiber.join(request);
    const observer = yield* Scope.make();
    yield* connection.subscribeNotifications.pipe(
      Effect.provideService(Scope.Scope, observer),
      Effect.asVoid,
    );
    yield* TestClock.adjust("10 minutes");
    assert.isFalse(yield* released(f, 0));
    yield* Scope.close(observer, Exit.void);
    // The Runtime still reports live work, so the quiet generation stays.
    yield* TestClock.adjust("10 minutes");
    assert.isFalse(yield* released(f, 0));
    live = false;
    yield* TestClock.adjust("3 minutes");
    assert.isTrue(yield* released(f, 0));
    assert.deepEqual(evidence, ["clear", "record"]);
  }).pipe(Effect.scoped),
);

it.effect(
  "activity restarts the quiet period and a retained operation never starts a process",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const supervisor = yield* idleSupervisor(f, []);
      yield* supervisor.retained(Effect.void);
      assert.strictEqual(f.generations.length, 0);
      const connection = yield* supervisor.get();
      yield* TestClock.adjust("2 minutes");
      yield* connection.request("runtime.identity", {}).pipe(Effect.exit);
      yield* TestClock.adjust("2 minutes");
      assert.isFalse(yield* released(f, 0));
      yield* TestClock.adjust("1 minute");
      assert.isTrue(yield* released(f, 0));
    }).pipe(Effect.scoped),
);

it.effect("records quiescence on quit only when the process is quiet and reports no work", () =>
  Effect.gen(function* () {
    for (const live of [false, true]) {
      const f = yield* fixture;
      const evidence: string[] = [];
      const supervisor = yield* idleSupervisor(f, evidence, () => !live);
      yield* supervisor.get();
      yield* supervisor.close;
      assert.isTrue(yield* released(f, 0));
      assert.deepEqual(evidence, live ? ["clear"] : ["clear", "record"]);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovery starts the process only when evidence cannot prove its store quiet", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const evidence = ["record"];
    const supervisor = yield* idleSupervisor(f, evidence);
    assert.isNull(yield* supervisor.getUnlessQuiet);
    assert.strictEqual(f.generations.length, 0);
    // A running process is used as is.
    const running = yield* supervisor.get();
    assert.strictEqual(yield* supervisor.getUnlessQuiet, running);
    // Missing evidence, such as after a crash, starts the process.
    const crashed = yield* fixture;
    const unproven = yield* idleSupervisor(crashed, []);
    assert.isNotNull(yield* unproven.getUnlessQuiet);
    assert.strictEqual(crashed.generations.length, 1);
  }).pipe(Effect.scoped),
);

it.effect("quitting during a read still records quiet; quitting during a write never does", () =>
  Effect.gen(function* () {
    for (const write of [false, true]) {
      const f = yield* fixture;
      const evidence: string[] = [];
      const supervisor = yield* idleSupervisor(f, evidence);
      yield* supervisor.get();
      const entered = yield* Deferred.make<void>();
      const hold = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never));
      yield* Effect.forkScoped(write ? supervisor.writing(hold) : supervisor.retained(hold));
      yield* Deferred.await(entered);
      yield* supervisor.close;
      assert.deepEqual(evidence, write ? ["clear"] : ["clear", "record"]);
    }
  }).pipe(Effect.scoped),
);

it.effect("a stopped store for restore is not trusted as quiet afterwards", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const evidence: string[] = [];
    const supervisor = yield* idleSupervisor(f, evidence);
    yield* supervisor.get();
    yield* TestClock.adjust("3 minutes");
    assert.deepEqual(evidence, ["clear", "record"]);
    yield* supervisor.withStopped(Effect.void);
    assert.deepEqual(evidence, ["clear", "record", "clear"]);
  }).pipe(Effect.scoped),
);

it.effect("activation and callers share the acquired generation's identity object", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const activated: AgentRuntimeProcessConnection[] = [];
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: (connection) =>
        Effect.sync(() => {
          activated.push(connection);
          return () => Effect.succeed({});
        }),
    });
    const connection = yield* supervisor.get();
    const acquired = yield* Queue.take(f.started);
    assert.strictEqual(activated[0]?.identity, acquired.identity);
    assert.strictEqual(connection.identity, acquired.identity);
  }).pipe(Effect.scoped),
);
