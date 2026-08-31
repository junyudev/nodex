import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import {
  TerminalPty,
  type TerminalPtyExit,
  type TerminalPtyHandle,
} from "../platform/node/TerminalPty";
import { TerminalRuntimeMap, live as terminalRuntimeMapLive } from "./TerminalRuntimeMap";

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
  let nextPid = 100;
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
    assert.deepEqual(fake.resizes, [[2, 1]]);
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
    yield* Deferred.succeed(fake.exits[0]!, { exitCode: 7, signal: null });
    yield* waitFor(() => SubscriptionRef.getUnsafe(runtime.snapshot).exited);
    const result = yield* Effect.result(runtime.write("late"));
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.strictEqual(result.failure.operation, "closed");
    yield* Scope.close(scope, Exit.void);
  }),
);
