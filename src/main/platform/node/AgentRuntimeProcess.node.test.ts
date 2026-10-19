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
import {
  acquireAgentRuntimeProcess,
  AGENT_RUNTIME_NODE_FLAGS,
  AgentRuntimeProcessError,
} from "./AgentRuntimeProcess";
import * as Schema from "effect/Schema";

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

it.live("admits private provider authentication separately from Turn tool identity", () =>
  Effect.gen(function* () {
    let calls = 0;
    const connection = yield* acquire((request) =>
      Effect.sync(() => {
        calls += 1;
        assert.strictEqual(request.operation, "provider.auth");
        if (request.operation !== "provider.auth")
          return assert.fail("expected provider auth callback");
        assert.strictEqual(request.identity.runtimeId, "fixture-runtime");
        assert.strictEqual(request.identity.providerInstanceId, "codex");
        assert.strictEqual(request.refresh, true);
        assert.strictEqual(request.previousAccountId, "account");
        return null;
      }),
    );
    assert.isNull(yield* connection.request("project.read", { projectId: "host-auth" }));
    assert.strictEqual(calls, 1);
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

it.live(
  "transcript bursts cannot evict lifecycle metadata from its independent delivery budget",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire();
      const metadata = yield* connection.subscribeExecutionNotifications;
      yield* connection.request("execution.observe", {});
      yield* connection.request("events.observe", {});
      yield* connection.request("thread.read", { threadId: "thread" });
      const delivered = yield* metadata.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
      );
      assert.deepEqual(
        delivered.map((entry) => entry.delivery),
        [1, 2],
      );
      assert.deepEqual(
        delivered.map((entry) => entry.notification.type),
        ["execution.lifecycle", "execution.lifecycle"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("snapshot release remains admitted with every normal request slot occupied", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const notifications = yield* connection.subscribeNotifications;
    const pending = yield* Effect.forEach(
      Array.from({ length: 64 }, (_, index) => index),
      (index) =>
        connection
          .request("project.read", { projectId: `blocked:${index}` })
          .pipe(Effect.forkScoped({ startImmediately: true })),
    );
    yield* Stream.runHead(notifications).pipe(Effect.timeout("2 seconds"));
    const refused = yield* connection.request("runtime.identity", {}).pipe(Effect.flip);
    assert.isTrue(Schema.is(AgentRuntimeProcessError)(refused));
    assert.strictEqual(refused.reason, "pressure");
    assert.deepEqual(yield* connection.request("storage.snapshot.release", { leaseId: "lease" }), {
      released: true,
    });
    yield* Effect.forEach(pending, Fiber.join);
    assert.strictEqual(
      (yield* connection.request("runtime.identity", {})).runtimeId,
      "fixture-runtime",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("waits for model work's own deadline rather than cutting it at the transport default", () =>
  Effect.gen(function* () {
    const connection = yield* acquireAgentRuntimeProcess({
      executable: process.execPath,
      entryPath,
      configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
      requestTimeoutMs: 200,
      host: () => Effect.succeed({ sequence: 9 }),
    });
    // The fixture replies 200ms before this budget ends, well after the 200ms default.
    const output = yield* connection.request("text.generate-structured", {
      cwd: "/tmp",
      prompt: "Name this",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      outputSchema: { type: "object" },
      timeoutMs: 700,
    });
    assert.deepEqual(output, { title: "Generated" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("distinguishes a known remote refusal from an uncertain transport timeout", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const rejected = yield* connection
      .request("project.read", { projectId: "reject" })
      .pipe(Effect.flip);
    assert.strictEqual(rejected.reason, "rejected");
    assert.strictEqual(rejected.engineTag, "OrchestratorDispatchError");
    assert.strictEqual(
      (yield* connection.request("runtime.identity", {})).runtimeId,
      "fixture-runtime",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "Session-only tool calls preserve null Run and native retirement reaches the lifecycle channel",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const connection = yield* acquire((request) =>
        Effect.sync(() => {
          calls++;
          assert.equal(request.operation, "tool.call");
          if (request.operation !== "tool.call" || request.identity.runId !== null)
            return assert.fail("Expected native Session identity");
          assert.equal(request.identity.incarnationId, "incarnation");
          assert.isNull(request.identity.attemptId);
          return null;
        }),
      );
      assert.isNull(
        yield* connection.request("project.read", { projectId: "host-native-session" }),
      );
      assert.equal(calls, 1);
      const lifecycle = yield* connection.subscribeExecutionNotifications;
      yield* connection.request("project.read", { projectId: "native-session-closed" });
      const retired = yield* lifecycle.pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.timeout("2 seconds"),
      );
      assert.deepEqual(retired[0]?.notification, {
        type: "execution.native-session.closed",
        runtimeId: connection.identity.runtimeId,
        runtimeGeneration: connection.identity.runtimeGeneration,
        providerSessionId: "acp-session",
        nativeGeneration: 1,
        incarnationId: "incarnation",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a native Session source cannot masquerade as Run preparation", () =>
  Effect.gen(function* () {
    let called = false;
    const connection = yield* acquire(() =>
      Effect.sync(() => {
        called = true;
        return null;
      }),
    );
    const failure = yield* connection
      .request("project.read", { projectId: "invalid-native-prepare" })
      .pipe(Effect.flip);
    assert.equal(failure.reason, "protocol");
    assert.isFalse(called);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("configures providers over stdin so credentials never enter the process environment", () =>
  Effect.gen(function* () {
    const connection = yield* acquireAgentRuntimeProcess({
      executable: process.execPath,
      entryPath,
      configuration: {
        home: "/tmp",
        cwd: "/tmp",
        providers: {
          claude: {
            driver: "claudeAgent",
            environment: [{ name: "ANTHROPIC_API_KEY", value: "fixture-secret", sensitive: true }],
            config: { binaryPath: "/usr/bin/claude" },
          },
        },
        host: { tools: [{ name: "read_page", inputSchema: { type: "object" } }] },
      },
      environment: { FIXTURE_VISIBLE: "1" },
      requestTimeoutMs: 5_000,
      host: () => Effect.succeed(null),
    });
    const received = (yield* connection.request("project.read", {
      projectId: "bootstrap",
    })) as unknown as {
      readonly providers: Readonly<Record<string, unknown>>;
      readonly hostTools: ReadonlyArray<{ readonly name: string }>;
      readonly environment: Readonly<Record<string, string>>;
      readonly execArgv: readonly string[];
    };
    assert.deepEqual(Object.keys(received.providers), ["claude"]);
    assert.deepEqual(
      received.hostTools.map((tool) => tool.name),
      ["read_page"],
    );
    assert.strictEqual(received.environment.FIXTURE_VISIBLE, "1");
    assert.includeMembers([...received.execArgv], [...AGENT_RUNTIME_NODE_FLAGS]);
    assert.isFalse(
      Object.entries(received.environment).some(
        ([name, value]) =>
          name.startsWith("NODEX_AGENT_RUNTIME") || value.includes("fixture-secret"),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("root activity notifications travel on the execution metadata channel", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const execution = yield* connection.subscribeExecutionNotifications;
    yield* connection.request("project.read", { projectId: "activity" });
    const delivered = yield* execution.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("2 seconds"),
    );
    assert.deepEqual(delivered[0]?.notification, {
      type: "activity",
      rootThreadId: "thread:root",
      sequence: 12,
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
