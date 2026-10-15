import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { AgentRuntimeProcessError } from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeProcessConnection } from "../platform/node/AgentRuntimeProcess";
import { make } from "./AgentRuntimeSupervisor";

const fixture = Effect.gen(function* () {
  const started = yield* Queue.unbounded<AgentRuntimeProcessConnection>();
  const requests: string[] = [];
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
  return { generations, acquire, started, requests };
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
  "recovers unexpected exits within a bounded budget without replaying failed commands",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const supervisor = yield* make({
        acquire: () => f.acquire,
        activate: () => Effect.succeed(() => Effect.succeed({})),
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
        if (index < 3)
          assert.strictEqual(
            (yield* Queue.take(f.started)).identity.runtimeGeneration,
            String(index + 2),
          );
      }
      yield* TestClock.adjust("3 seconds");
      assert.strictEqual(f.generations.length, 4);
      assert.isNull(yield* supervisor.inspect);
      assert.deepEqual(f.requests, ["runtime.identity"]);
      assert.strictEqual((yield* supervisor.get()).identity.runtimeGeneration, "5");
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
