import { ASYNC_WAIT_TIMEOUT_MS } from "../../../config/test-timeouts";
import { fileURLToPath } from "node:url";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { acquire as acquireWriterLease } from "../../../packages/agent-runtime/src/platform/node/RuntimeHomeLease";
import {
  acquireAgentRuntimeProcess,
  AgentRuntimeProcessError,
} from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeLiveness } from "../platform/node/agent-runtime-liveness";
import type { AgentRuntimeConnectionState } from "../../shared/agent-runtime-api";
import { HostInvocation } from "../../host/HostInvocation";
import { make } from "./AgentRuntimeSupervisor";

const fixture = Effect.gen(function* () {
  const started = yield* Queue.unbounded<AgentRuntimeProcessConnection>();
  const requests: string[] = [];
  /** `thread.read` waits on this latch so a test can hold a request in flight. */
  const inFlight = yield* Deferred.make<void>();
  const generations: Array<{
    readonly terminated: Deferred.Deferred<AgentRuntimeProcessError>;
    readonly released: Deferred.Deferred<void>;
    readonly liveness: SubscriptionRef.SubscriptionRef<AgentRuntimeLiveness>;
  }> = [];
  const acquire = Effect.gen(function* () {
    const terminated = yield* Deferred.make<AgentRuntimeProcessError>();
    const released = yield* Deferred.make<void>();
    const liveness = yield* SubscriptionRef.make<AgentRuntimeLiveness>("ready");
    generations.push({ terminated, released, liveness });
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
      liveness: SubscriptionRef.changes(liveness),
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

const writerHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-runtime-lease-" });
  const lock = path.join(home, ".writer.lock", "owner.json");
  return { home, owner: fs.readFileString(lock), hasOwner: fs.exists(lock) };
});

const startProcess = (
  home: string,
  host: Parameters<typeof acquireAgentRuntimeProcess>[0]["host"],
) =>
  acquireAgentRuntimeProcess({
    executable: process.execPath,
    entryPath: fileURLToPath(
      new URL("../../../packages/agent-runtime/src/nodex/entry.ts", import.meta.url),
    ),
    configuration: { home, cwd: home, providers: {} },
    profileHome: home,
    environment: { ...process.env, NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}` },
    host,
  });

it.live(
  "releases the writer before the next request when the activating caller is interrupted",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { home, hasOwner } = yield* writerHome;
      const activating = yield* Deferred.make<AgentRuntimeProcessConnection>();
      const reports: string[] = [];
      const supervisor = yield* make({
        reportStartFailure: (failure) => Effect.sync(() => void reports.push(failure)),
        acquire: () => acquireWriterLease(home).pipe(Effect.andThen(f.acquire)),
        activate: (connection) =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(activating)) return () => Effect.void;
            yield* Deferred.succeed(activating, connection);
            return yield* Effect.never;
          }),
      });

      const firstCaller = yield* supervisor.get().pipe(Effect.forkScoped);
      const first = yield* Deferred.await(activating);
      assert.isTrue(yield* hasOwner);
      yield* Fiber.interrupt(firstCaller);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(firstCaller)));
      const writerReleased = !(yield* hasOwner);
      const generationReleased = yield* Deferred.isDone(f.generations[0]!.released);
      const second = yield* supervisor.get();
      assert.isTrue(writerReleased);
      assert.isTrue(generationReleased);
      assert.notEqual(second.identity.runtimeGeneration, first.identity.runtimeGeneration);
      yield* supervisor.close;
      assert.isFalse(yield* hasOwner);
      assert.isEmpty(reports);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses an execution writer held by another Runtime process", () =>
  Effect.gen(function* () {
    const { home, owner } = yield* writerHome;
    const other = yield* startProcess(home, () => Effect.void);
    const otherOwner = yield* owner;
    const reports: string[] = [];
    const supervisor = yield* make({
      acquire: (host) => startProcess(home, host),
      activate: () => Effect.succeed(() => Effect.void),
      reportStartFailure: (failure) => Effect.sync(() => void reports.push(failure)),
    });

    const { profileBusyMessage } = yield* supervisor.get().pipe(Effect.flip);
    assert.ok(profileBusyMessage);
    assert.include(profileBusyMessage, "Another Nodex is already running Agents for this Profile");
    assert.deepEqual(yield* supervisor.connectionState, {
      status: "failed",
      message: profileBusyMessage,
    });
    assert.equal(yield* owner, otherOwner);
    assert.isEmpty(reports);
    assert.strictEqual(
      (yield* other.request("runtime.identity", {})).runtimeGeneration,
      other.identity.runtimeGeneration,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("reports a real pre-ready initialization failure from the execution process", () =>
  Effect.gen(function* () {
    const { home } = yield* writerHome;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(home, "agent-runtime.sqlite"), "invalid SQLite fixture");
    const reports: string[] = [];
    const supervisor = yield* make({
      acquire: (host) => startProcess(home, host),
      activate: () => Effect.succeed(() => Effect.void),
      reportStartFailure: (failure) => Effect.sync(() => void reports.push(failure)),
    });

    const error = yield* supervisor.get().pipe(Effect.flip);
    assert.equal(error.operation, "start");
    assert.deepEqual(reports, ["initialization-failed"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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

it.effect("reports one safe startup failure per attempt despite concurrent Session reads", () =>
  Effect.gen(function* () {
    const reports: string[] = [];
    let starts = 0;
    const supervisor = yield* make({
      acquire: () =>
        Effect.suspend(() => {
          starts += 1;
          return Effect.fail(
            new AgentRuntimeProcessError({
              reason: "start",
              code: "bootstrap-rejected",
              message: "C:\\private\\runtime with a private environment value",
            }),
          );
        }),
      activate: () => Effect.succeed(() => Effect.void),
      reportStartFailure: (failure) => Effect.sync(() => void reports.push(failure)),
      restarts: { limit: 1, window: "5 minutes" },
    });

    const results = yield* Effect.all(
      Array.from({ length: 6 }, () =>
        supervisor.request("thread.read", { threadId: "thread" }).pipe(Effect.flip),
      ),
      { concurrency: "unbounded" },
    );

    assert.lengthOf(results, 6);
    assert.equal(starts, 2);
    assert.deepEqual(reports, ["bootstrap-rejected", "bootstrap-rejected"]);
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

it.effect("a Member can cold-start execution without lending their authority to the Host", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const callback = yield* Deferred.make<Parameters<typeof startProcess>[1]>();
    const reconciled = yield* Deferred.make<string, Error>();
    const hostOnly = (value: string) =>
      HostInvocation.pipe(
        Effect.flatMap((proof) =>
          proof === null
            ? Effect.succeed(value)
            : Effect.fail(new Error("Host operation refused under Member authority")),
        ),
      );
    const supervisor = yield* make({
      acquire: (host) =>
        hostOnly("held sessions").pipe(
          Effect.andThen(Deferred.succeed(callback, host)),
          Effect.andThen(f.acquire),
        ),
      activate: () =>
        Effect.gen(function* () {
          yield* hostOnly("cleanup completed").pipe(Deferred.into(reconciled), Effect.forkScoped);
          return () => hostOnly("tool authorized");
        }),
    });
    yield* Effect.gen(function* () {
      const connection = yield* supervisor.get();
      assert.strictEqual(yield* Deferred.await(reconciled), "cleanup completed");
      const execute = yield* Deferred.await(callback);
      assert.strictEqual(
        yield* execute({
          type: "host.request",
          id: "prepare",
          operation: "thread.prepare",
          identity: {
            runtimeId: connection.identity.runtimeId,
            runtimeGeneration: connection.identity.runtimeGeneration,
            threadId: "thread:member",
            providerInstanceId: "codex",
            nativeDriver: "codex",
          },
          cwd: null,
        }),
        "tool authorized",
      );
      assert.strictEqual(yield* HostInvocation, "proof:member");
    }).pipe(Effect.provideService(HostInvocation, "proof:member"));
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
    yield* Deferred.await(f.generations[0]!.released).pipe(Effect.timeout(ASYNC_WAIT_TIMEOUT_MS));
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

it.effect("reading the current connection never starts or revives a quiet process", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* idleSupervisor(f, []);
    assert.isNull(yield* supervisor.currentConnection);
    assert.equal(f.generations.length, 0);
    const running = yield* supervisor.get();
    assert.strictEqual(yield* supervisor.currentConnection, running);
    yield* TestClock.adjust("3 minutes");
    assert.isTrue(yield* released(f, 0));
    assert.isNull(yield* supervisor.currentConnection);
    assert.equal(f.generations.length, 1);
    const replacement = yield* supervisor.get();
    assert.strictEqual(yield* supervisor.currentConnection, replacement);
    assert.notStrictEqual(replacement, running);
    yield* supervisor.close;
    assert.isNull(yield* supervisor.currentConnection);
    assert.equal(f.generations.length, 2);
  }).pipe(Effect.scoped),
);

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

it.effect(
  "publishes liveness only for the current generation and explicit restarts preserve crash allowance",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const supervisor = yield* make({
        acquire: () => f.acquire,
        activate: () => Effect.succeed(() => Effect.void),
        restarts: { limit: 1, window: "5 minutes" },
      });
      yield* supervisor.restart("1");
      assert.equal(f.generations.length, 0);
      yield* supervisor.get();
      const first = f.generations[0]!;
      yield* SubscriptionRef.set(first.liveness, "busy");
      yield* Effect.yieldNow;
      // A busy process is still ready; only the surfaces waiting on it say why.
      assert.deepEqual(yield* supervisor.connectionState, {
        status: "ready",
        generation: "1",
        busy: true,
      });
      yield* supervisor.restart("1");
      assert.equal(f.generations.length, 1);
      yield* SubscriptionRef.set(first.liveness, "unresponsive");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* supervisor.connectionState, {
        status: "unresponsive",
        generation: "1",
      });
      yield* SubscriptionRef.set(first.liveness, "ready");
      yield* Effect.yieldNow;
      assert.deepEqual(yield* supervisor.connectionState, { status: "ready", generation: "1" });
      // A process that answered again keeps serving its Agents.
      yield* supervisor.restart("1");
      assert.equal(f.generations.length, 1);
      for (let i = 1; i <= 3; i++) {
        yield* SubscriptionRef.set(f.generations.at(-1)!.liveness, "unresponsive");
        yield* Effect.yieldNow;
        // A stale click, such as from a second window, cannot replace the current process.
        yield* supervisor.restart("stale");
        assert.equal(f.generations.length, i);
        yield* supervisor.restart(String(i));
        assert.equal(f.generations.length, i + 1);
      }
      assert.equal(f.generations.length, 4);
      assert.isTrue(yield* Deferred.isDone(first.released));
      yield* SubscriptionRef.set(first.liveness, "unresponsive");
      yield* Deferred.succeed(
        first.terminated,
        new AgentRuntimeProcessError({ reason: "closed", message: "Late old exit" }),
      );
      yield* Effect.yieldNow;
      assert.deepEqual(yield* supervisor.connectionState, { status: "ready", generation: "4" });
      const last = f.generations[3]!;
      yield* Deferred.succeed(
        last.terminated,
        new AgentRuntimeProcessError({ reason: "closed", message: "Crash" }),
      );
      yield* Deferred.await(last.released);
      yield* TestClock.adjust("250 millis");
      assert.equal((yield* supervisor.get()).identity.runtimeGeneration, "5");
    }).pipe(Effect.scoped),
);

for (const stage of ["acquire", "activate"] as const) {
  it.effect(`the combined start budget includes hung ${stage} and releases the gate`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      let hang = true;
      const supervisor = yield* make({
        acquire: () => (stage === "acquire" && hang ? Effect.never : f.acquire),
        activate: () =>
          stage === "activate" && hang ? Effect.never : Effect.succeed(() => Effect.void),
      });
      const starting = yield* supervisor.get().pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("9 minutes");
      assert.isUndefined(starting.pollUnsafe());
      yield* TestClock.adjust("1 minute");
      assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
      assert.equal((yield* supervisor.connectionState).status, "failed");
      hang = false;
      yield* supervisor.get();
      assert.equal((yield* supervisor.connectionState).status, "ready");
    }).pipe(Effect.scoped),
  );
}

it.effect("quit interrupts a hung start before waiting for the lifecycle gate", () =>
  Effect.gen(function* () {
    const supervisor = yield* make({
      acquire: () => Effect.never,
      activate: () => Effect.succeed(() => Effect.void),
    });
    const starting = yield* supervisor.get().pipe(Effect.exit, Effect.forkScoped);
    yield* Effect.yieldNow;
    yield* supervisor.close;
    assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
    assert.equal((yield* supervisor.connectionState).status, "idle");
  }).pipe(Effect.scoped),
);

it.effect("acquisition and activation spend one shared ten-minute budget", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => Effect.sleep("6 minutes").pipe(Effect.andThen(f.acquire)),
      activate: () => Effect.sleep("6 minutes").pipe(Effect.as(() => Effect.void)),
    });
    const starting = yield* supervisor.get().pipe(Effect.exit, Effect.forkScoped);
    yield* TestClock.adjust("9 minutes");
    assert.isUndefined(starting.pollUnsafe());
    yield* TestClock.adjust("1 minute");
    assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
    assert.isTrue(yield* Deferred.isDone(f.generations[0]!.released));
  }).pipe(Effect.scoped),
);

it.effect("quit bounds quiescence even when the engine stops answering", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const supervisor = yield* make({
      acquire: () => f.acquire,
      activate: () => Effect.succeed(() => Effect.void),
      idle: { after: "3 minutes", quiescent: () => Effect.never },
    });
    yield* supervisor.get();
    const closing = yield* supervisor.close.pipe(Effect.forkScoped);
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(closing);
    assert.isTrue(yield* Deferred.isDone(f.generations[0]!.released));
  }).pipe(Effect.scoped),
);
