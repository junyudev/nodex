import * as TestClock from "effect/testing/TestClock";
import {
  AGENT_RUNTIME_STALLED_READ_TICKS,
  AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS,
  isAgentRuntimeResponsive,
  nextAgentRuntimeSilentTicks,
} from "./agent-runtime-liveness";
import { ChildProcessSpawner } from "effect/process";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { AgentCommand } from "@nodex/agent-runtime/contracts";
import { acquireAgentRuntimeProcess, AGENT_RUNTIME_NODE_FLAGS } from "./AgentRuntimeProcess";

const entryPath = fileURLToPath(
  new URL("../../../../tests/fixtures/agent-runtime-stdio.mjs", import.meta.url),
);
const acquire = (
  host: Parameters<typeof acquireAgentRuntimeProcess>[0]["host"] = () =>
    Effect.succeed({ sequence: 9 }),
  livenessTickMs?: number,
) =>
  acquireAgentRuntimeProcess({
    executable: process.execPath,
    entryPath,
    configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
    host,
    livenessTickMs,
  });

it.effect("waits for startup work without a transport readiness deadline", () =>
  Effect.gen(function* () {
    const starting = yield* acquireAgentRuntimeProcess({
      executable: process.execPath,
      entryPath,
      configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
      environment: { ...process.env, NODEX_FIXTURE_READY_DELAY_MS: "500" },
      host: () => Effect.succeed({ sequence: 9 }),
    }).pipe(Effect.forkScoped({ startImmediately: true }));
    // The child is still working through this virtual time; the Supervisor owns the start budget.
    yield* TestClock.adjust("5 minutes");
    assert.isUndefined(starting.pollUnsafe());
    assert.equal((yield* Fiber.join(starting)).identity.runtimeId, "fixture-runtime");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("withdraws an interrupted utility over the existing Runtime connection", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const task = yield* Effect.forkChild(
      connection.request("text.generate-structured", {
        cwd: "/tmp",
        prompt: "Rewrite",
        modelSelection: { instanceId: "codex", model: "gpt-6-luna" },
        outputSchema: {},
        timeoutMs: 60_000,
      }),
    );
    yield* connection.request("project.read", { projectId: "cancelled-utilities" }).pipe(
      Effect.repeat({
        times: 100,
        until: (value) => (value as unknown as { activeUtilities: number }).activeUtilities === 1,
      }),
    );
    yield* Fiber.interrupt(task);
    assert.deepEqual(
      (yield* connection.request("project.read", { projectId: "cancelled-utilities" })) as unknown,
      { cancelledUtilities: 1, activeUtilities: 0 },
    );
    assert.equal((yield* connection.request("runtime.identity", {})).runtimeId, "fixture-runtime");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const provider of ["codex", "claude CLI", "claude SDK"] as const) {
  it.live.skipIf(process.platform === "win32")(
    `interrupting a production structured RPC reaps the ${provider} child while the runtime stays live`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-utility-cancel-" });
        const cwd = path.join(home, "utility-cwd");
        yield* fs.makeDirectory(cwd);
        const binary = path.join(home, "provider.mjs");
        const marker = path.join(home, "started");
        yield* fs.writeFileString(
          binary,
          `#!${process.execPath}
import fs from "node:fs";
import path from "node:path";
if (path.basename(process.cwd()) !== "utility-cwd") process.exit(0);
process.stdin.resume();
fs.writeFileSync(${JSON.stringify(marker + ".tmp")}, String(process.pid));
fs.renameSync(${JSON.stringify(marker + ".tmp")}, ${JSON.stringify(marker)});
setInterval(() => {}, 1000);
`,
        );
        yield* fs.chmod(binary, 0o700);
        const started = yield* Deferred.make<void>();
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            watch(home, (_event, name) => {
              if (name?.toString() === "started") Deferred.doneUnsafe(started, Effect.void);
            }),
          ),
          (watcher) => Effect.sync(() => watcher.close()),
        );

        const driver = provider === "codex" ? "codex" : "claudeAgent";
        const config = { binaryPath: binary, homePath: path.join(home, "provider-home") };
        let runtimePid = 0;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const connection = yield* acquireAgentRuntimeProcess({
          executable: process.execPath,
          livenessTickMs: 100,
          entryPath: fileURLToPath(
            new URL("../../../../packages/agent-runtime/src/nodex/entry.ts", import.meta.url),
          ),
          environment: { ...process.env, NODE_OPTIONS: `--import=${import.meta.resolve("tsx")}` },
          configuration: {
            home,
            cwd: home,
            providers:
              driver === "codex"
                ? { codex: { driver, config: { ...config, setupMode: "existing" } } }
                : { claudeAgent: { driver, config } },
          },
          host: () => Effect.die("Structured generation should not call the host"),
        }).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) =>
              spawner.spawn(command).pipe(
                Effect.tap((handle) =>
                  Effect.sync(() => {
                    runtimePid = Number(handle.pid);
                  }),
                ),
              ),
            ),
          ),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            try {
              process.kill(runtimePid, "SIGCONT");
            } catch {}
          }),
        );

        const generating = yield* connection
          .request("text.generate-structured", {
            cwd,
            prompt: "Never return an answer",
            modelSelection: {
              instanceId: driver,
              model: driver === "codex" ? "gpt-6-luna" : "sonnet",
            },
            outputSchema: { type: "object", properties: {} },
            ...(provider === "claude SDK"
              ? { images: [{ mediaType: "image/png", data: "AQID" }] }
              : {}),
            timeoutMs: 60_000,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started).pipe(Effect.timeout("30 seconds"));
        if (provider === "codex") {
          process.kill(runtimePid, "SIGSTOP");
          yield* connection.responsive.pipe(
            Stream.filter((value) => !value),
            Stream.runHead,
            Effect.timeout("3 seconds"),
          );
          process.kill(runtimePid, "SIGCONT");
          yield* connection.responsive.pipe(
            Stream.filter(Boolean),
            Stream.runHead,
            Effect.timeout("3 seconds"),
          );
          // The model child is still held, so only the production Daemon's pong can recover.
          assert.isUndefined(generating.pollUnsafe());
        }
        const pid = Number(yield* fs.readFileString(marker));
        assert.isAbove(pid, 1);
        let reaped = false;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (reaped) return;
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }),
        );
        const childExited = Effect.sync(() => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        });
        assert.isFalse(yield* childExited);
        yield* Fiber.interrupt(generating);
        yield* childExited.pipe(
          Effect.repeat({ until: Boolean, schedule: Schedule.spaced("20 millis") }),
          Effect.timeout("30 seconds"),
        );
        reaped = true;
        assert.strictEqual(
          (yield* connection.request("runtime.identity", {})).runtimeId,
          connection.identity.runtimeId,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    120_000,
  );
}

it.live("withdraws only the cancelled host wait and rejects stale-generation cancellation", () =>
  Effect.gen(function* () {
    const started = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const stopped = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const released = { a: false, b: false };
    const connection = yield* acquire((request) => {
      if (request.operation !== "tool.call") return Effect.die("Expected host tool call");
      const input = request.input as { targets: { sessionId: string }[] };
      const key = input.targets[0]!.sessionId === "host-wait:a" ? "a" : "b";
      return Deferred.succeed(started[key], undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(
          Effect.sync(() => {
            released[key] = true;
          }).pipe(Effect.andThen(Deferred.succeed(stopped[key], undefined))),
        ),
      );
    });
    const a = yield* connection.request("project.read", { projectId: "host-wait:a" });
    const b = yield* connection.request("project.read", { projectId: "host-wait:b" });
    const first = a as unknown as { hostId: string };
    const second = b as unknown as { hostId: string };
    yield* Deferred.await(started.a);
    yield* Deferred.await(started.b);
    yield* connection.request("project.read", { projectId: `host-cancel-wrong:${first.hostId}` });
    assert.deepEqual(released, { a: false, b: false });
    yield* connection.request("project.read", { projectId: `host-cancel:${first.hostId}` });
    yield* Deferred.await(stopped.a).pipe(Effect.timeout("2 seconds"));
    assert.deepEqual(released, { a: true, b: false });
    assert.equal((yield* connection.request("runtime.identity", {})).runtimeId, "fixture-runtime");
    yield* connection.request("project.read", { projectId: `host-cancel:${second.hostId}` });
    yield* Deferred.await(stopped.b).pipe(Effect.timeout("2 seconds"));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

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
    assert.deepEqual(yield* connection.request("command.dispatch", { command: command }), {
      sequence: 9,
    });
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

it.live("shutdown remains admitted with every normal request slot occupied", () =>
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
    const waiting = yield* connection
      .request("runtime.identity", {})
      .pipe(Effect.flip, Effect.forkScoped({ startImmediately: true }));
    assert.isUndefined(waiting.pollUnsafe());
    assert.deepEqual(yield* connection.request("shutdown", {}), {
      stopped: true,
    });
    yield* Effect.forEach(pending, (fiber) => Fiber.await(fiber));
    assert.equal((yield* Fiber.join(waiting)).reason, "closed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("waits for model work's own deadline rather than cutting it at the transport default", () =>
  Effect.gen(function* () {
    const connection = yield* acquireAgentRuntimeProcess({
      executable: process.execPath,
      entryPath,
      configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
      host: () => Effect.succeed({ sequence: 9 }),
    });
    // The engine owns this model-work budget; transport waits for its result.
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

it.live("preserves a known remote refusal without closing the transport", () =>
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
it.live("preserves typed ACP recovery metadata while discarding untrusted failure extras", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    const rejected = yield* connection
      .request("acp.auth.logout", { instanceId: "work" })
      .pipe(Effect.flip);
    assert.deepEqual(rejected.acp, {
      reason: "busy",
      message: "Stop active work first.",
      affectedThreadIds: ["thread:root"],
    });
    assert.strictEqual(
      (yield* connection.request("runtime.identity", {})).runtimeId,
      "fixture-runtime",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("awaits the history import result", () =>
  Effect.gen(function* () {
    const connection = yield* acquireAgentRuntimeProcess({
      executable: process.execPath,
      entryPath,
      configuration: { home: "/tmp", cwd: "/tmp", providers: {} },
      host: () => Effect.succeed({ sequence: 9 }),
    });
    const result = yield* connection.request("thread.import-native", {
      commandId: "import:one",
      threadId: "thread:one",
      projectId: "project:one",
      title: "Imported chat",
      backendKind: "codex",
      sourceHome: "/native/codex",
      sourceNativeThreadId: "native:one",
      cwd: "/tmp",
      modelSelection: { instanceId: "codex", model: "model" },
    });
    assert.deepEqual(result, { threadId: "thread:one" });
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

it.live("preserves structured search continuation failures across the Runtime stdio bridge", () =>
  Effect.gen(function* () {
    const connection = yield* acquire();
    for (const reason of ["invalid_cursor", "cursor_stale"] as const) {
      const error = yield* connection
        .request("sessions.search", { query: reason })
        .pipe(Effect.flip);
      assert.equal(error.reason, "rejected");
      assert.equal(error.engineTag, "SessionSearchError");
      assert.equal(error.engineReason, reason);
    }
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("counts silence in scheduler ticks and resets at both activity boundaries", () =>
  Effect.sync(() => {
    const silent = AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS;
    assert.equal(nextAgentRuntimeSilentTicks(0, true, false), 1);
    assert.equal(nextAgentRuntimeSilentTicks(silent - 1, true, false), silent);
    assert.equal(nextAgentRuntimeSilentTicks(silent, true, false), silent);
    assert.equal(nextAgentRuntimeSilentTicks(silent, false, false), 0);
    assert.equal(nextAgentRuntimeSilentTicks(silent, true, true), 0);
  }),
);

it.effect("either long silence or one stalled read makes the process unresponsive", () =>
  Effect.sync(() => {
    const silent = AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS;
    const stalled = AGENT_RUNTIME_STALLED_READ_TICKS;
    assert.isTrue(isAgentRuntimeResponsive(0, 0));
    assert.isTrue(isAgentRuntimeResponsive(silent - 1, stalled - 1));
    assert.isFalse(isAgentRuntimeResponsive(silent, 0));
    assert.isFalse(isAgentRuntimeResponsive(0, stalled));
  }),
);

it.effect.skipIf(process.platform === "win32")(
  "a held reply still resolves after five minutes of Main clock time",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire();
      const deliveries = yield* connection.subscribeNotifications;
      const reply = yield* connection
        .request("project.read", { projectId: "held" })
        .pipe(Effect.forkScoped);
      yield* Stream.runHead(deliveries);
      yield* TestClock.adjust("5 minutes");
      assert.isUndefined(reply.pollUnsafe());
      process.kill(Number(connection.identity.runtimeGeneration), "SIGUSR1");
      assert.equal((yield* Fiber.join(reply))?.id, "released");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "waits FIFO past 64 slots, removes interrupted waiters, and rejects only beyond 1024 waiters",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire();
      const notifications = yield* connection.subscribeNotifications;
      const active = yield* Effect.forEach(
        Array.from({ length: 64 }, (_, i) => i),
        (i) =>
          connection
            .request("project.read", { projectId: `blocked:${i}` })
            .pipe(Effect.exit, Effect.forkScoped({ startImmediately: true })),
      );
      yield* Stream.runHead(notifications);
      // Caller cancellation cannot free capacity while durable engine work is still held.
      yield* Fiber.interrupt(active[0]!);
      const cancelled = yield* connection
        .request("runtime.identity", {})
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Fiber.interrupt(cancelled);
      const settled: number[] = [];
      const queued = yield* Effect.forEach(
        Array.from({ length: 1024 }, (_, i) => i),
        (i) =>
          connection
            .request("runtime.identity", {})
            .pipe(
              Effect.ensuring(Effect.sync(() => settled.push(i))),
              Effect.exit,
              Effect.forkScoped({ startImmediately: true }),
            ),
      );
      const refused = yield* connection.request("runtime.identity", {}).pipe(Effect.flip);
      assert.equal(refused.reason, "pressure");
      assert.isUndefined(queued[0]!.pollUnsafe());
      process.kill(Number(connection.identity.runtimeGeneration), "SIGUSR1");
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(queued[0]!)));
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(queued[1023]!)));
      // One freed slot admits one waiter at a time, so the order below is admission order.
      assert.deepEqual(
        settled,
        queued.map((_, i) => i),
      );

      yield* connection.request("shutdown", {});
      yield* Effect.forEach(active, (fiber) => Fiber.await(fiber));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("does not wake an idle process with pings", () =>
  Effect.gen(function* () {
    const connection = yield* acquire(undefined, 20);
    yield* Effect.sleep(200);
    assert.equal(
      (yield* connection.request("project.read", { projectId: "ping-count" }))?.title,
      "0",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "SIGSTOP reports unresponsive and SIGCONT restores responsiveness before held work answers",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire(undefined, 30);
      const pid = Number(connection.identity.runtimeGeneration);
      const states: boolean[] = [];
      yield* connection.responsive.pipe(
        Stream.runForEach((value) => Effect.sync(() => states.push(value))),
        Effect.forkScoped({ startImmediately: true }),
      );
      const deliveries = yield* connection.subscribeNotifications;
      const reply = yield* connection
        .request("project.read", { projectId: "held" })
        .pipe(Effect.forkScoped);
      yield* Stream.runHead(deliveries);
      // Registered last, so even a failed assertion resumes the child before process teardown.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(pid, "SIGCONT");
          } catch {}
        }),
      );
      process.kill(pid, "SIGSTOP");
      yield* connection.responsive.pipe(
        Stream.filter((value) => !value),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      );
      process.kill(pid, "SIGCONT");
      yield* connection.responsive.pipe(
        Stream.filter(Boolean),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      );
      assert.deepEqual(states, [true, false, true]);
      assert.isUndefined(reply.pollUnsafe());
      process.kill(pid, "SIGUSR1");
      yield* Fiber.join(reply);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const observeResponsive = (connection: Effect.Success<ReturnType<typeof acquire>>) =>
  Effect.gen(function* () {
    const states: boolean[] = [];
    yield* connection.responsive.pipe(
      Stream.runForEach((value) => Effect.sync(() => states.push(value))),
      Effect.forkScoped({ startImmediately: true }),
    );
    return states;
  });

it.live.skipIf(process.platform === "win32")(
  "a watched read stuck while the process answers is unresponsive until its own reply",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire(undefined, 10);
      const states = yield* observeResponsive(connection);
      const deliveries = yield* connection.subscribeNotifications;
      const read = yield* connection
        .request("thread.snapshot", { threadId: "thread" })
        .pipe(Effect.forkScoped);
      yield* Stream.runHead(deliveries);
      yield* connection.responsive.pipe(
        Stream.filter((value) => !value),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      );
      // The process keeps answering checks and other requests, and that does not clear the stall.
      assert.equal(
        (yield* connection.request("runtime.identity", {})).runtimeId,
        "fixture-runtime",
      );
      yield* Effect.sleep(50);
      assert.deepEqual(states, [true, false]);
      assert.isUndefined(read.pollUnsafe());
      process.kill(Number(connection.identity.runtimeGeneration), "SIGUSR1");
      yield* Fiber.join(read);
      yield* Effect.sleep(0);
      assert.deepEqual(states, [true, false, true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(process.platform === "win32")(
  "a read nobody waits for anymore stops counting even while its reply is still owed",
  () =>
    Effect.gen(function* () {
      const connection = yield* acquire(undefined, 10);
      const states = yield* observeResponsive(connection);
      const deliveries = yield* connection.subscribeNotifications;
      const read = yield* connection
        .request("thread.snapshot", { threadId: "thread" })
        .pipe(Effect.forkScoped);
      yield* Stream.runHead(deliveries);
      yield* connection.responsive.pipe(
        Stream.filter((value) => !value),
        Stream.runHead,
        Effect.timeout("3 seconds"),
      );
      yield* Fiber.interrupt(read);
      assert.deepEqual(states, [true, false, true]);
      yield* Effect.sleep(10 * (AGENT_RUNTIME_STALLED_READ_TICKS + 10));
      assert.deepEqual(states, [true, false, true]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("work outside the watched reads may take as long as it needs", () =>
  Effect.gen(function* () {
    const connection = yield* acquire(undefined, 5);
    const states = yield* observeResponsive(connection);
    const deliveries = yield* connection.subscribeNotifications;
    yield* connection.request("project.read", { projectId: "held" }).pipe(Effect.forkScoped);
    yield* Stream.runHead(deliveries);
    yield* Effect.sleep(5 * (AGENT_RUNTIME_STALLED_READ_TICKS + 10));
    assert.deepEqual(states, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a Main stall does not age a watched read", () =>
  Effect.gen(function* () {
    const connection = yield* acquire(undefined, 30);
    const states = yield* observeResponsive(connection);
    const deliveries = yield* connection.subscribeNotifications;
    yield* connection.request("thread.snapshot", { threadId: "thread" }).pipe(Effect.forkScoped);
    yield* Stream.runHead(deliveries);
    yield* Effect.sync(() => {
      // Longer than the whole stalled-read budget at this tick.
      const until = performance.now() + 30 * (AGENT_RUNTIME_STALLED_READ_TICKS + 5);
      while (performance.now() < until) {
        /* Simulate Main being unscheduled. */
      }
    });
    yield* Effect.sleep(90);
    assert.deepEqual(states, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("a Main event loop stall counts as one silent tick", () =>
  Effect.gen(function* () {
    const connection = yield* acquire(undefined, 30);
    const states: boolean[] = [];
    yield* connection.responsive.pipe(
      Stream.runForEach((value) => Effect.sync(() => states.push(value))),
      Effect.forkScoped({ startImmediately: true }),
    );
    const deliveries = yield* connection.subscribeNotifications;
    yield* connection.request("project.read", { projectId: "held" }).pipe(Effect.forkScoped);
    yield* Stream.runHead(deliveries);
    yield* Effect.sync(() => {
      const until = performance.now() + 250;
      while (performance.now() < until) {
        /* Simulate Main being unscheduled. */
      }
    });
    yield* Effect.sleep(200);
    assert.deepEqual(states, [true]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
