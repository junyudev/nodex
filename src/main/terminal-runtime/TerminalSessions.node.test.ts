import { describe, expect, test } from "vite-plus/test";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { TerminalEnvironment } from "../platform/node/TerminalEnvironment";
import { ProcessTelemetry } from "../platform/node/ProcessTelemetry";
import {
  TerminalPty,
  type TerminalPtyExit,
  type TerminalPtyHandle,
} from "../platform/node/TerminalPty";
import {
  TerminalRuntime,
  TerminalRuntimeMap,
  live as terminalRuntimeMapLive,
} from "./TerminalRuntimeMap";
import { TerminalSessions, live as terminalSessionsLive } from "./TerminalSessions";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Ref from "effect/Ref";
import { CoreModules, type CoreModuleClients } from "../core-runtime/CoreModules";
import {
  live as projectRuntimeLifecycleLive,
  ProjectRuntimeLifecycleRuntime,
} from "../host-runtime/ProjectRuntimeLifecycleRuntime";
import { TerminalProjectAdmission, live } from "./TerminalProjectAdmission";
import { terminalReplayData } from "./TerminalReplay";

describe("TerminalSessions", () => {
  interface FakePty {
    readonly layer: Layer.Layer<TerminalPty>;
    readonly outputs: Queue.Queue<string, Cause.Done>[];
    readonly exits: Deferred.Deferred<TerminalPtyExit>[];
    readonly writes: string[];
    readonly resizes: Array<readonly [number, number]>;
    readonly releases: number[];
  }

  const fakePty = (): FakePty => {
    const outputs: Queue.Queue<string, Cause.Done>[] = [];
    const exits: Deferred.Deferred<TerminalPtyExit>[] = [];
    const writes: string[] = [];
    const resizes: Array<readonly [number, number]> = [];
    const releases: number[] = [];
    let nextPid = 200;
    const layer = Layer.succeed(
      TerminalPty,
      TerminalPty.of({
        spawn: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const output = yield* Queue.unbounded<string, Cause.Done>();
              const exit = yield* Deferred.make<TerminalPtyExit>();
              outputs.push(output);
              exits.push(exit);
              const handle: TerminalPtyHandle = {
                pid: nextPid++,
                output: Stream.fromQueue(output),
                exit: Deferred.await(exit),
                write: (data) => Effect.sync(() => writes.push(data)).pipe(Effect.asVoid),
                resize: (cols, rows) =>
                  Effect.sync(() => resizes.push([cols, rows])).pipe(Effect.asVoid),
                kill: Queue.end(output).pipe(
                  Effect.andThen(Deferred.succeed(exit, { exitCode: null, signal: 15 })),
                  Effect.asVoid,
                ),
                prepareForRestart: Effect.void,
              };
              return handle;
            }),
            ({ pid }) => Effect.sync(() => releases.push(pid)),
          ),
      }),
    );
    return { layer, outputs, exits, writes, resizes, releases };
  };

  const environmentLayer = Layer.succeed(
    TerminalEnvironment,
    TerminalEnvironment.of({
      availableShells: Effect.succeed([]),
      resolve: (input) =>
        Effect.succeed({
          sessionId: input.sessionId,
          conversationId: input.conversationId ?? null,
          projectSessionId: input.projectSessionId ?? null,
          title: input.title ?? null,
          command: "/bin/zsh",
          args: ["-l"],
          cwd: input.cwd ?? "/tmp",
          env: { TERM: "xterm-256color" },
          cols: input.size?.cols ?? 80,
          rows: input.size?.rows ?? 24,
        }),
    }),
  );

  const metricsLayer = Layer.succeed(
    ProcessTelemetry,
    ProcessTelemetry.of({
      sample: (request) =>
        Effect.succeed({
          sampledAtMs: 123,
          groups: request.groups.map((group) => ({
            key: group.key,
            processes: 2,
            cpuPercent: 12.5,
            rssKb: 4_096,
          })),
        }),
    }),
  );

  const makeHarness = Effect.fn("TerminalSessionsTest.makeHarness")(function* (
    fake: FakePty = fakePty(),
    prepareRuntime?: (
      runtime: TerminalRuntime["Service"],
    ) => Effect.Effect<TerminalRuntime["Service"], never, Scope.Scope>,
  ) {
    const scope = yield* Scope.make();
    const originalRuntimeMap = terminalRuntimeMapLive.pipe(Layer.provide(fake.layer));
    const runtimeMap: Layer.Layer<TerminalRuntimeMap> = prepareRuntime
      ? Layer.effect(
          TerminalRuntimeMap,
          Effect.gen(function* () {
            const original = yield* TerminalRuntimeMap;
            return TerminalRuntimeMap.of({
              ...original,
              open: (config) =>
                original
                  .open(config)
                  .pipe(
                    Effect.flatMap((runtime) => prepareRuntime(runtime).pipe(Scope.provide(scope))),
                  ),
            });
          }),
        ).pipe(Layer.provide(originalRuntimeMap))
      : originalRuntimeMap;
    const dependencies = Layer.mergeAll(runtimeMap, environmentLayer, metricsLayer);
    const context = yield* Layer.buildWithScope(
      terminalSessionsLive.pipe(Layer.provide(dependencies)),
      scope,
    );
    return { fake, scope, sessions: Context.get(context, TerminalSessions) };
  });

  const ownerA = { webContentsId: 10, windowSessionId: "window-a" } as const;
  const ownerB = { webContentsId: 20, windowSessionId: "window-b" } as const;
  const request = {
    sessionId: "terminal-a",
    conversationId: "thread-a",
    projectSessionId: null,
    cwd: "/tmp",
    size: { cols: 80, rows: 24 },
    title: "Terminal A",
  } as const;

  const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error("Terminal sessions condition did not settle"));
    });

  it.effect("owns view leases atomically and fences stale takeover attempts", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      const events = yield* sessions.subscribe;

      const created = yield* sessions.create(ownerA, request);
      assert.strictEqual(created.status, "acquired");
      const conflict = yield* sessions.acquireViewLease(ownerB, request);
      assert.strictEqual(conflict.status, "conflict");
      const stale = yield* sessions.takeOverViewLease(ownerB, {
        sessionId: request.sessionId,
        expectedGeneration: 0,
        size: { cols: 100, rows: 40 },
      });
      assert.strictEqual(stale.status, "stale");
      const taken = yield* sessions.takeOverViewLease(ownerB, {
        sessionId: request.sessionId,
        expectedGeneration: 1,
        size: { cols: 100, rows: 40 },
      });
      assert.strictEqual(taken.status, "acquired");
      if (taken.status === "acquired") assert.strictEqual(taken.generation, 2);

      const oldOwnerWrite = yield* Effect.result(sessions.write(ownerA, request.sessionId, "old"));
      assert.isTrue(Result.isFailure(oldOwnerWrite));
      yield* sessions.write(ownerB, request.sessionId, "new");
      assert.deepEqual(fake.writes, ["new"]);
      const observed = yield* events.pipe(Stream.take(4), Stream.runCollect);
      assert.isTrue(
        observed.some(
          (event) =>
            event.channel === "terminal-view-lease-revoked" &&
            event.target.webContentsId === ownerA.webContentsId,
        ),
      );
      yield* Scope.close(scope, Exit.void);
      assert.deepEqual(fake.releases, [200]);
    }),
  );

  it.effect(
    "registers an observation before its consumer starts and retains initial lease events",
    () =>
      Effect.gen(function* () {
        const { scope, sessions } = yield* makeHarness();
        const events = yield* sessions.subscribe;
        yield* sessions.create(ownerA, request);
        const initial = yield* events.pipe(Stream.take(2), Stream.runCollect);
        assert.deepEqual(
          initial.map((event) => event.channel),
          ["terminal-init-log", "terminal-attached"],
        );
        const attached = initial[1];
        assert.strictEqual(attached?.channel, "terminal-attached");
        if (attached?.channel === "terminal-attached") {
          assert.strictEqual(attached.payload.snapshot.sessionId, request.sessionId);
          assert.strictEqual(
            attached.payload.snapshot.viewLease?.windowSessionId,
            ownerA.windowSessionId,
          );
        }
        yield* Scope.close(scope, Exit.void);
      }),
  );

  it.effect("retires the PTY on exit while retaining an inspectable terminal snapshot", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      yield* sessions.create(ownerA, request);
      yield* Queue.offer(fake.outputs[0]!, "hello");
      yield* waitFor(() => fake.outputs.length === 1);
      yield* Queue.end(fake.outputs[0]!);
      yield* Deferred.succeed(fake.exits[0]!, { exitCode: 7, signal: null });
      let snapshot = yield* sessions.getSessionSnapshot(request.sessionId);
      for (let attempt = 0; attempt < 100 && !snapshot?.exited; attempt += 1) {
        yield* Effect.yieldNow;
        snapshot = yield* sessions.getSessionSnapshot(request.sessionId);
      }
      assert.strictEqual(snapshot?.buffer, "hello");
      assert.strictEqual(snapshot?.exitCode, 7);
      assert.isNull(snapshot?.viewLease ?? null);
      assert.deepEqual(fake.releases, [200]);
      assert.strictEqual((yield* sessions.getThreadSnapshot("thread-a"))?.sessionId, "terminal-a");
      const owners = {
        conversationIds: new Set(["thread-a"]),
        projectSessionIds: new Set<string>(),
      };
      assert.deepStrictEqual(
        (yield* sessions.listSnapshotsForOwners(owners)).map((item) => item.sessionId),
        ["terminal-a"],
      );
      assert.deepStrictEqual(yield* sessions.listLiveSessionsForOwners(owners), []);
      assert.deepStrictEqual(
        yield* sessions.listSnapshotsForOwners({
          conversationIds: new Set(["other-thread"]),
          projectSessionIds: new Set(),
        }),
        [],
      );
      assert.deepEqual(
        yield* sessions.discardExitedSessionsForOwners({
          conversationIds: new Set(["thread-a"]),
          projectSessionIds: new Set(),
        }),
        ["terminal-a"],
      );
      assert.isNull(yield* sessions.getSessionSnapshot(request.sessionId));
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("retires a process that has already exited before session acquisition completes", () =>
    Effect.gen(function* () {
      const exiting = fakePty();
      const { fake, scope, sessions } = yield* makeHarness(exiting, (runtime) =>
        Effect.gen(function* () {
          const events = yield* runtime.subscribe;
          yield* Queue.end(exiting.outputs[0]!);
          yield* Deferred.succeed(exiting.exits[0]!, { exitCode: 7, signal: null });
          yield* events.pipe(
            Stream.filter((event) => event.kind === "exit"),
            Stream.runHead,
          );
          return runtime;
        }),
      );
      assert.strictEqual((yield* sessions.create(ownerA, request)).status, "not_found");
      const owners = {
        conversationIds: new Set(["thread-a"]),
        projectSessionIds: new Set<string>(),
      };
      assert.deepEqual(yield* sessions.listLiveSessionsForOwners(owners), []);
      assert.deepEqual(fake.releases, [200]);
      assert.strictEqual((yield* sessions.getSessionSnapshot(request.sessionId))?.exitCode, 7);
      assert.isNull((yield* sessions.getSessionSnapshot(request.sessionId))?.viewLease);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "restarts actions in sequence and updates process metrics through the platform seam",
    () =>
      Effect.gen(function* () {
        const { fake, scope, sessions } = yield* makeHarness();
        yield* sessions.create(ownerA, request);
        yield* sessions.runAction(ownerA, {
          ...request,
          command: "vp run check",
          title: "Check",
          size: { cols: 120, rows: 50 },
        });
        assert.deepEqual(fake.releases, [200]);
        assert.deepEqual(fake.writes, ["cd /tmp && vp run check\n"]);
        yield* sessions.refreshSessionProcessMetrics([request.sessionId]);
        const snapshot = yield* sessions.getSessionSnapshot(request.sessionId);
        assert.strictEqual(snapshot?.osPid, 201);
        assert.strictEqual(snapshot?.cpuPercent, 12.5);
        assert.strictEqual(snapshot?.rssKb, 4_096n);
        assert.strictEqual(snapshot?.childProcessCount, 2);
        assert.strictEqual(snapshot?.processMetricsSampledAtMs, 123);
        assert.strictEqual(snapshot?.title, "Check");
        yield* Scope.close(scope, Exit.void);
        assert.deepEqual(fake.releases, [200, 201]);
      }),
  );

  it.effect("delivers an entire output burst in order before publishing process exit", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      const events = yield* sessions.subscribe;
      yield* sessions.create(ownerA, request);
      const chunks = [
        "A".repeat(70_000),
        ...Array.from({ length: 1_100 }, (_, index) => `chunk ${index}\r\n`),
      ];
      yield* Queue.offerAll(fake.outputs[0]!, chunks);
      yield* Queue.end(fake.outputs[0]!);
      yield* Deferred.succeed(fake.exits[0]!, { exitCode: 0, signal: null });
      const observed = yield* events.pipe(Stream.take(chunks.length + 3), Stream.runCollect);
      yield* waitFor(() => fake.releases.length === 1);
      assert.deepEqual(
        observed.slice(0, 2).map((event) => event.channel),
        ["terminal-init-log", "terminal-attached"],
      );
      assert.deepEqual(
        observed.flatMap((event) =>
          event.channel === "terminal-data" ? [event.payload.data] : [],
        ),
        chunks,
      );
      assert.strictEqual(observed.at(-1)?.channel, "terminal-exit");
      const snapshot = yield* sessions.getSessionSnapshot(request.sessionId);
      assert.strictEqual(snapshot?.buffer, chunks.join("").slice(-16_000));
      assert.isTrue(snapshot?.truncated);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("sanitizes replay data while keeping the raw snapshot and live data", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      const events = yield* sessions.subscribe;
      yield* sessions.create(ownerA, request);
      const raw = "\x1b[6n\x1b[31mred\x1b]10;?\x07";
      yield* Queue.offer(fake.outputs[0]!, raw);
      const live = yield* events.pipe(Stream.take(3), Stream.runCollect);
      const data = live[2];
      assert.strictEqual(data?.channel, "terminal-data");
      if (data?.channel === "terminal-data") assert.strictEqual(data.payload.data, raw);
      yield* sessions.acquireViewLease(ownerA, request);
      const replay = yield* events.pipe(Stream.runHead);
      assert.strictEqual(replay._tag, "Some");
      if (replay._tag === "Some" && replay.value.channel === "terminal-init-log") {
        assert.strictEqual(replay.value.payload.data, "\x1b[31mred");
        assert.strictEqual(replay.value.payload.snapshot.buffer, raw);
      } else {
        assert.fail("Expected a terminal init log");
      }
      assert.strictEqual((yield* sessions.getSessionSnapshot(request.sessionId))?.buffer, raw);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("repaints a one-column terminal after 100 ms while allowing writes", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      const size = { cols: 1, rows: 24 };
      yield* sessions.create(ownerA, { ...request, size });
      fake.resizes.length = 0;
      yield* sessions.resize(ownerA, request.sessionId, size);
      assert.deepEqual(fake.resizes, []);
      const repaint = yield* sessions
        .resize(ownerA, request.sessionId, size, true)
        .pipe(Effect.forkScoped);
      yield* waitFor(() => fake.resizes.length === 1);
      yield* sessions.write(ownerA, request.sessionId, "input during repaint");
      yield* TestClock.adjust("99 millis");
      assert.deepEqual(fake.resizes, [[2, 24]]);
      yield* TestClock.adjust("1 millis");
      yield* Fiber.join(repaint);
      assert.deepEqual(fake.resizes, [
        [2, 24],
        [1, 24],
      ]);
      assert.deepEqual(fake.writes, ["input during repaint"]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("does not restore a repaint after the target size or process changes", () =>
    Effect.gen(function* () {
      const { fake, scope, sessions } = yield* makeHarness();
      yield* sessions.create(ownerA, request);
      fake.resizes.length = 0;
      const size = { cols: 100, rows: 30 };
      const old = yield* sessions
        .resize(ownerA, request.sessionId, request.size, true)
        .pipe(Effect.forkScoped);
      yield* waitFor(() => fake.resizes.length === 1);
      yield* sessions.resize(ownerA, request.sessionId, size, true);
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(old);
      assert.deepEqual(fake.resizes, [
        [79, 24],
        [100, 30],
      ]);

      const replaced = yield* sessions
        .resize(ownerA, request.sessionId, size, true)
        .pipe(Effect.forkScoped);
      yield* waitFor(() => fake.resizes.length === 3);
      yield* sessions.runAction(ownerA, { ...request, size, command: "pwd" });
      yield* TestClock.adjust("100 millis");
      yield* Fiber.join(replaced);
      assert.deepEqual(fake.resizes, [
        [79, 24],
        [100, 30],
        [99, 30],
      ]);
      yield* Scope.close(scope, Exit.void);
    }),
  );
});

describe("TerminalRuntimeMap", () => {
  interface FakePty {
    readonly layer: Layer.Layer<TerminalPty>;
    readonly outputs: Queue.Queue<string, Cause.Done>[];
    readonly exits: Deferred.Deferred<TerminalPtyExit>[];
    readonly writes: string[];
    readonly resizes: Array<readonly [number, number]>;
    readonly releases: number[];
  }

  const fakePty = (): FakePty => {
    const outputs: Queue.Queue<string, Cause.Done>[] = [];
    const exits: Deferred.Deferred<TerminalPtyExit>[] = [];
    const writes: string[] = [];
    const resizes: Array<readonly [number, number]> = [];
    const releases: number[] = [];
    let nextPid = 100;
    const layer = Layer.succeed(
      TerminalPty,
      TerminalPty.of({
        spawn: () =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const output = yield* Queue.unbounded<string, Cause.Done>();
              const exit = yield* Deferred.make<TerminalPtyExit>();
              outputs.push(output);
              exits.push(exit);
              const handle: TerminalPtyHandle = {
                pid: nextPid++,
                output: Stream.fromQueue(output),
                exit: Deferred.await(exit),
                write: (data) => Effect.sync(() => writes.push(data)).pipe(Effect.asVoid),
                resize: (cols, rows) =>
                  Effect.sync(() => resizes.push([cols, rows])).pipe(Effect.asVoid),
                kill: Queue.end(output).pipe(
                  Effect.andThen(Deferred.succeed(exit, { exitCode: null, signal: 15 })),
                  Effect.asVoid,
                ),
                prepareForRestart: Effect.void,
              };
              return handle;
            }),
            ({ pid }) => Effect.sync(() => releases.push(pid)),
          ),
      }),
    );
    return { layer, outputs, exits, writes, resizes, releases };
  };

  const config = {
    sessionId: "terminal-a",
    conversationId: "thread-a",
    projectSessionId: null,
    title: "Test",
    command: "/bin/zsh",
    args: ["-l"],
    cwd: "/tmp",
    env: { TERM: "xterm-256color" },
    cols: 80,
    rows: 24,
  } as const;

  const waitFor = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.gen(function* () {
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Wait for the mocked PTY fiber to publish through the owning terminal map.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(new Error("Terminal runtime condition did not settle"));
    });

  it.effect("coalesces terminal acquisition and releases the owned PTY on invalidation", () =>
    Effect.gen(function* () {
      const fake = fakePty();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        terminalRuntimeMapLive.pipe(Layer.provideMerge(fake.layer)),
        scope,
      );
      const runtimes = Context.get(context, TerminalRuntimeMap);
      const [first, second] = yield* Effect.all([runtimes.open(config), runtimes.open(config)], {
        concurrency: "unbounded",
      });
      assert.strictEqual(first, second);
      assert.strictEqual(fake.outputs.length, 1);

      yield* Queue.offer(fake.outputs[0]!, "hello");
      yield* waitFor(() => SubscriptionRef.getUnsafe(first.snapshot).buffer === "hello");
      yield* first.resize({ cols: 1, rows: 0 });
      yield* first.write("pwd\r");
      assert.deepEqual(fake.resizes, [[1, 1]]);
      assert.deepEqual(fake.writes, ["pwd\r"]);

      yield* runtimes.close(config.sessionId);
      assert.deepEqual(fake.releases, [100]);
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect("records process exit and rejects later terminal writes", () =>
    Effect.gen(function* () {
      const fake = fakePty();
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(
        terminalRuntimeMapLive.pipe(Layer.provideMerge(fake.layer)),
        scope,
      );
      const runtime = yield* Context.get(context, TerminalRuntimeMap).open(config);
      yield* Queue.end(fake.outputs[0]!);
      yield* Deferred.succeed(fake.exits[0]!, { exitCode: 7, signal: null });
      yield* waitFor(() => SubscriptionRef.getUnsafe(runtime.snapshot).exited);
      const result = yield* Effect.result(runtime.write("late"));
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result)) assert.strictEqual(result.failure.operation, "closed");
      yield* Scope.close(scope, Exit.void);
    }),
  );

  it.effect(
    "retains output after subscription acquisition while its consumer has not started",
    () =>
      Effect.gen(function* () {
        const fake = fakePty();
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          terminalRuntimeMapLive.pipe(Layer.provide(fake.layer)),
          scope,
        );
        const runtime = yield* Context.get(context, TerminalRuntimeMap).open(config);
        const events = yield* runtime.subscribe;
        yield* Queue.offer(fake.outputs[0]!, "first output");
        yield* waitFor(() => SubscriptionRef.getUnsafe(runtime.snapshot).buffer === "first output");
        const event = Option.getOrThrow(yield* Stream.runHead(events));
        assert.deepEqual(event, {
          kind: "data",
          sessionId: config.sessionId,
          data: "first output",
        });
        yield* Scope.close(scope, Exit.void);
      }),
  );
});

describe("TerminalProjectAdmission", () => {
  const coreLayer = (input?: { readonly lifecycle?: "active" | "archived" | "removed" }) =>
    Layer.succeed(
      CoreModules,
      CoreModules.of({
        workspace: {
          read: (read: { readonly kind: string }) => {
            if (read.kind === "session") {
              return Effect.succeed({
                value: { kind: "session", session: { project_id: "project-a" } },
              });
            }
            if (read.kind === "thread") {
              return Effect.succeed({
                value: { kind: "thread", thread: { project_id: "project-a" } },
              });
            }
            return Effect.succeed({
              value: {
                kind: "project",
                project: { lifecycle: input?.lifecycle ?? "active" },
              },
            });
          },
        },
      } as unknown as CoreModuleClients),
    );

  const request = {
    sessionId: "terminal-a",
    conversationId: "thread-a",
    projectSessionId: "session-a",
    size: { cols: 80, rows: 24 },
  } as const;

  it.effect("serializes terminal admission with project lifecycle transitions", () =>
    Effect.gen(function* () {
      const projectLifecycleLayer = projectRuntimeLifecycleLive;
      const context = yield* Layer.build(
        Layer.merge(
          projectLifecycleLayer,
          live.pipe(Layer.provide(Layer.merge(coreLayer(), projectLifecycleLayer))),
        ),
      );
      const admission = Context.get(context, TerminalProjectAdmission);
      const projectLifecycle = Context.get(context, ProjectRuntimeLifecycleRuntime);
      const active = yield* Ref.make(0);
      const maximum = yield* Ref.make(0);
      const firstEntered = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const operation = (wait: boolean) =>
        Ref.updateAndGet(active, (value) => value + 1).pipe(
          Effect.tap((value) => Ref.update(maximum, (current) => Math.max(current, value))),
          Effect.tap(() => Deferred.succeed(firstEntered, undefined)),
          Effect.andThen(wait ? Deferred.await(releaseFirst) : Effect.void),
          Effect.ensuring(Ref.update(active, (value) => value - 1)),
        );
      const first = yield* projectLifecycle
        .runExclusive("project-a", operation(true))
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstEntered);
      const second = yield* admission.run(request, operation(false)).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(active), 1);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(yield* Ref.get(maximum), 1);
    }),
  );

  it.effect("rejects terminal creation for a non-active project", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        live.pipe(
          Layer.provide(
            Layer.merge(coreLayer({ lifecycle: "archived" }), projectRuntimeLifecycleLive),
          ),
        ),
      );
      const result = yield* Context.get(context, TerminalProjectAdmission)
        .run(request, Effect.void)
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result));
      if (Result.isFailure(result))
        assert.strictEqual(result.failure.operation, "inactive-project");
    }),
  );
});

describe("TerminalReplay", () => {
  test.each([
    ["status reports with private and intermediate bytes", "A\x1b[6n\x1b[?25;4 nB", "AB"],
    ["numeric OSC queries with either terminator", "A\x1b]10;?\x07\x1b]0011;?\x1b\\B", "AB"],
    [
      "colors and alternate-screen transitions",
      "\x1b[31m\x1b[?1049hred\x1b[?1049l",
      "\x1b[31m\x1b[?1049hred\x1b[?1049l",
    ],
    [
      "non-query OSC payloads and extra fields",
      "\x1b]0;name\x07\x1b]4;1;?\x1b\\",
      "\x1b]0;name\x07\x1b]4;1;?\x1b\\",
    ],
    ["query-looking text inside OSC", "\x1b]0;a\x1b[6n\x07", "\x1b]0;a\x1b[6n\x07"],
    ["an incomplete CSI after a query", "\x1b[5nA\x1b[?6", "A\x1b[?6"],
    [
      "an incomplete OSC with embedded escapes",
      "\x1b[5nA\x1b]11;?\x1b[6n\x1b",
      "A\x1b]11;?\x1b[6n\x1b",
    ],
    ["a tail that begins mid-sequence", "11;?\x076n\x1bc", "11;?\x076n\x1bc"],
  ])("filters terminal replay with %s", (_name, input, expected) => {
    expect(terminalReplayData(input)).toBe(expected);
  });
});
