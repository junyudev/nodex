import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as Exit from "effect/Exit";
import { live, HostShellEnvironment } from "./HostShellEnvironment";

it.effect("coalesces discovery within one Scope and rejects admission after release", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let loads = 0;
    const context = yield* Layer.buildWithScope(
      live({
        baseEnvironment: { PATH: "/usr/bin" },
        platform: "darwin",
        loadInteractiveEnvironment: async () => {
          loads += 1;
          return { PATH: "/opt/bin:/usr/bin" };
        },
      }),
      scope,
    );
    const runtime = Context.get(context, HostShellEnvironment);
    const [first, second] = yield* Effect.all([runtime.load, runtime.recover], {
      concurrency: "unbounded",
    });
    assert.strictEqual(first.PATH, "/opt/bin:/usr/bin");
    assert.deepEqual(second, { status: "captured", environment: { PATH: "/opt/bin:/usr/bin" } });
    assert.strictEqual(loads, 1);

    yield* Scope.close(scope, Exit.void);
    const afterClose = yield* Effect.exit(runtime.load);
    assert.strictEqual(afterClose._tag, "Failure");
  }),
);

it.effect("interrupts active discovery when its Scope closes", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const context = yield* Layer.buildWithScope(
      live({
        baseEnvironment: { PATH: "/usr/bin" },
        platform: "darwin",
        loadInteractiveEnvironment: (signal) =>
          new Promise<NodeJS.ProcessEnv>((_resolve, reject) => {
            markStarted?.();
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
      scope,
    );
    const runtime = Context.get(context, HostShellEnvironment);
    const fiber = yield* Effect.forkChild(runtime.load);
    yield* Effect.promise(() => started);
    yield* Scope.close(scope, Exit.void);
    const exit = yield* Fiber.await(fiber);
    assert.strictEqual(exit._tag, "Failure");
  }),
);

it.effect("keeps shared discovery alive when one caller stops waiting", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let markStarted: (() => void) | undefined;
    let finish: ((environment: NodeJS.ProcessEnv) => void) | undefined;
    let aborted = false;
    let loads = 0;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const context = yield* Layer.buildWithScope(
      live({
        baseEnvironment: { PATH: "/usr/bin" },
        platform: "darwin",
        loadInteractiveEnvironment: (signal) =>
          new Promise<NodeJS.ProcessEnv>((resolve, reject) => {
            loads += 1;
            finish = resolve;
            markStarted?.();
            signal?.addEventListener(
              "abort",
              () => {
                aborted = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      }),
      scope,
    );
    const runtime = Context.get(context, HostShellEnvironment);
    const first = yield* Effect.forkChild(runtime.load);
    yield* Effect.promise(() => started);
    yield* Fiber.interrupt(first);

    assert.isFalse(aborted);
    finish?.({ PATH: "/opt/bin:/usr/bin" });
    const environment = yield* runtime.load;
    assert.strictEqual(environment.PATH, "/opt/bin:/usr/bin");
    assert.strictEqual(loads, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("diagnoses a failed capture and retries on the next demand", () =>
  Effect.gen(function* () {
    let attempts = 0;
    const context = yield* Layer.build(
      live({
        platform: "darwin",
        baseEnvironment: { PATH: "/usr/bin" },
        loadInteractiveEnvironment: () =>
          ++attempts === 1
            ? Promise.reject(new Error("shell exited before capture"))
            : Promise.resolve({ PATH: "/tools:/usr/bin" }),
      }),
    );
    const shell = Context.get(context, HostShellEnvironment);
    const failure = yield* shell.recover;
    assert.deepEqual(failure, {
      status: "failed",
      reason: "capture",
      message: "shell exited before capture",
    });
    assert.deepEqual(yield* shell.latest, failure);
    assert.deepEqual(yield* shell.load, { PATH: "/tools:/usr/bin" });
    assert.strictEqual(attempts, 2);
  }).pipe(Effect.scoped),
);

it.effect("bounds a stalled login shell and aborts the underlying capture", () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(
      live({
        platform: "darwin",
        baseEnvironment: { PATH: "/usr/bin" },
        loadInteractiveEnvironment: (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      }),
    );
    const shell = Context.get(context, HostShellEnvironment);
    const capture = yield* Effect.forkChild(shell.recover);
    yield* TestClock.adjust("25 seconds");
    assert.deepEqual(yield* Fiber.join(capture), {
      status: "failed",
      reason: "timeout",
      message: "Login shell exceeded 25 seconds",
    });
  }).pipe(Effect.scoped),
);
