import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { TerminalEnvironment } from "../platform/node/TerminalEnvironment";
import { TerminalProcessMetricsReader } from "../platform/node/TerminalProcessMetrics";
import {
  TerminalPty,
  type TerminalPtyExit,
  type TerminalPtyHandle,
} from "../platform/node/TerminalPty";
import { live as terminalRuntimeMapLive } from "./TerminalRuntimeMap";
import {
  TerminalSessions,
  live as terminalSessionsLive,
  type TerminalSessionEvent,
} from "./TerminalSessions";

interface FakePty {
  readonly layer: Layer.Layer<TerminalPty>;
  readonly outputs: Queue.Queue<string>[];
  readonly exits: Deferred.Deferred<TerminalPtyExit>[];
  readonly writes: string[];
  readonly resizes: Array<readonly [number, number]>;
  readonly releases: number[];
}

const fakePty = (): FakePty => {
  const outputs: Queue.Queue<string>[] = [];
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
            const output = yield* Queue.unbounded<string>();
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
              kill: Deferred.succeed(exit, { exitCode: null, signal: 15 }).pipe(Effect.asVoid),
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
  TerminalProcessMetricsReader,
  TerminalProcessMetricsReader.of({
    read: (pids) =>
      Effect.succeed(
        new Map(
          pids.map((pid) => [
            pid,
            { cpuPercent: 12.5, rssKb: 4_096n, childProcessCount: 2, sampledAtMs: 123 },
          ]),
        ),
      ),
  }),
);

const makeHarness = Effect.fn("TerminalSessionsTest.makeHarness")(function* () {
  const fake = fakePty();
  const scope = yield* Scope.make();
  const runtimeMap = terminalRuntimeMapLive.pipe(Layer.provide(fake.layer));
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
    const observed: TerminalSessionEvent[] = [];
    yield* Effect.forkScoped(
      sessions.events.pipe(Stream.runForEach((event) => Effect.sync(() => observed.push(event)))),
    );
    yield* Effect.yieldNow;

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

it.effect("retires the PTY on exit while retaining an inspectable terminal snapshot", () =>
  Effect.gen(function* () {
    const { fake, scope, sessions } = yield* makeHarness();
    yield* sessions.create(ownerA, request);
    yield* Queue.offer(fake.outputs[0]!, "hello");
    yield* waitFor(() => fake.outputs.length === 1);
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
      assert.deepEqual(fake.writes, ["vp run check\r"]);
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
