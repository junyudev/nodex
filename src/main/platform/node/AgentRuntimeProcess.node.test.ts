import { fileURLToPath } from "node:url";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentCommand } from "@nodex/agent-runtime/contracts";
import { acquireAgentRuntimeProcess } from "./AgentRuntimeProcess";

const entryPath = fileURLToPath(
  new URL("../../../../tests/fixtures/agent-runtime-stdio.mjs", import.meta.url),
);
const acquire = (
  host: Parameters<typeof acquireAgentRuntimeProcess>[0]["host"] = () =>
    Effect.succeed({ sequence: 9 }),
) =>
  acquireAgentRuntimeProcess({
    executable: process.execPath,
    entryPath,
    configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
    requestTimeoutMs: 5_000,
    host,
  });

it.live("correlates out-of-order replies and retains the durable readiness watermark", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    assert.strictEqual(connection.identity.lastSequence, 7);
    const results = yield* Effect.all(
      [
        connection.request("project.read", { projectId: "first" }),
        connection.request("project.read", { projectId: "second" }),
      ],
      { concurrency: 2 },
    );
    assert.deepEqual(
      results.map((value) => value?.id),
      ["first", "second"],
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a slow event consumer cannot starve control replies and sees the delivery gap", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const receiving = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const drained = yield* Deferred.make<void>();
    const deliveries: number[] = [];
    const notifications = yield* connection.subscribeNotifications;
    const collector = yield* notifications.pipe(
      Stream.runForEach((value) =>
        Effect.gen(function* () {
          deliveries.push(value.delivery);
          yield* Deferred.succeed(receiving, undefined);
          if (deliveries.length === 1) yield* Deferred.await(release);
          if (value.delivery === 1_024) yield* Deferred.succeed(drained, undefined);
        }),
      ),
      Effect.forkScoped,
    );
    const observation = yield* connection.request("events.observe", {}).pipe(Effect.forkScoped);
    yield* Deferred.await(receiving);
    assert.isTrue((yield* Fiber.join(observation)).subscribed);
    assert.strictEqual(
      (yield* connection.request("runtime.identity", {})).runtimeId,
      "fixture-runtime",
    );
    yield* Deferred.succeed(release, undefined);
    yield* Deferred.await(drained).pipe(Effect.timeout("5 seconds"));
    assert.strictEqual(deliveries.length, 257);
    assert.isAbove(deliveries[1]! - deliveries[0]!, 1);
    assert.strictEqual(deliveries.at(-1), 1_024);
    yield* Fiber.interrupt(collector);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("Host callbacks may re-enter the process without blocking their command reply", () =>
  Effect.gen(function* () {
    let connection: Effect.Success<ReturnType<typeof acquire>> | undefined;
    connection = yield* acquire(() =>
      connection!.request("runtime.identity", {}).pipe(Effect.as({ sequence: 9 })),
    );
    const command = {
      type: "thread.archive",
      commandId: "fixture-command",
      threadId: "thread",
    } satisfies AgentCommand;
    assert.deepEqual(yield* connection.request("command.dispatch", command), { sequence: 9 });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("unexpected process exit rejects pending work and Scope close reaps the child", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const connection = yield* acquire().pipe(Effect.provideService(Scope.Scope, scope));
    const pid = Number(connection.identity.runtimeGeneration);
    try {
      assert.isTrue(
        Exit.isFailure(
          yield* connection.request("project.read", { projectId: "exit" }).pipe(Effect.exit),
        ),
      );
    } finally {
      yield* Scope.close(scope, Exit.void);
    }
    assert.throws(() => process.kill(pid, 0));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
