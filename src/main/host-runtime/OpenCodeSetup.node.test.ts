// @effect-diagnostics strictEffectProvide:off
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { expect } from "vite-plus/test";
import type { OpenCodeSetupState } from "../../shared/opencode-setup";
import {
  AgentRuntimeProviderConfiguration,
  AgentRuntimeProviderConfigurationError,
} from "../agent-runtime/AgentRuntimeProviderConfiguration";
import { testLayer as mainConfigLayer } from "../app/MainConfig";
import {
  OpenCodeInstallPlatform,
  OpenCodeInstallPlatformError,
  type OpenCodeInstalledExecutable,
  type OpenCodeInstallOutput,
} from "../platform/node/OpenCodeInstallPlatform";
import { make, type OpenCodeSetup } from "./OpenCodeSetup";

const installed: OpenCodeInstalledExecutable = {
  binaryPath: "/user/.opencode/bin/opencode",
  version: "2.0.25",
};
const harness = (
  initial: OpenCodeInstalledExecutable | OpenCodeInstallPlatformError | null = null,
  platform = "darwin",
  refreshFails = false,
) =>
  Effect.gen(function* () {
    const native = yield* Ref.make(initial);
    const finished = yield* Deferred.make<
      OpenCodeInstalledExecutable,
      OpenCodeInstallPlatformError
    >();
    const started = yield* Deferred.make<void>();
    let calls = 0;
    let released = 0;
    let refreshed = 0;
    let refreshFailure = refreshFails;
    let output: ((event: OpenCodeInstallOutput) => Effect.Effect<void>) | undefined;
    const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const owner = yield* make.pipe(
      Effect.provideService(OpenCodeInstallPlatform, {
        probe: () =>
          Effect.gen(function* () {
            const value = yield* Ref.get(native);
            if (Schema.is(OpenCodeInstallPlatformError)(value)) return yield* value;
            return value;
          }),
        install: (onOutput) =>
          Effect.gen(function* () {
            calls++;
            output = onOutput;
            yield* Deferred.succeed(started, undefined);
            const value = yield* Deferred.await(finished);
            yield* Ref.set(native, value);
            return value;
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                released++;
              }),
            ),
          ),
      }),
      Effect.provideService(AgentRuntimeProviderConfiguration, {
        refresh: Effect.suspend(() => {
          refreshed++;
          return refreshFailure
            ? Effect.fail(
                new AgentRuntimeProviderConfigurationError({ cause: "fixture refresh failure" }),
              )
            : Effect.void;
        }),
      }),
      Effect.provide(mainConfigLayer({ platform })),
      Effect.provideService(Scope.Scope, scope),
    );
    return {
      owner,
      started: Deferred.await(started),
      finish: (value = installed) => Deferred.succeed(finished, value),
      fail: (error: OpenCodeInstallPlatformError) => Deferred.fail(finished, error),
      emit: (data: string, stream: OpenCodeInstallOutput["stream"] = "stdout") =>
        Effect.suspend(() =>
          output ? output({ stream, data }) : Effect.die("Installer has not started"),
        ),
      calls: () => calls,
      released: () => released,
      refreshed: () => refreshed,
      recoverRefresh: Effect.sync(() => {
        refreshFailure = false;
      }),
      scope,
    };
  });
const watch = (
  owner: OpenCodeSetup["Service"],
  phase: OpenCodeSetupState["installation"]["phase"],
) =>
  owner.changes.pipe(
    Stream.filter((state) => state.installation.phase === phase),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkScoped,
  );

it.effect(
  "classifies missing, unsupported, unusable and native version compatibility independently of installation",
  () =>
    Effect.gen(function* () {
      const missing = yield* harness();
      expect((yield* missing.owner.read).executable).toEqual({ status: "missing" });
      for (const [version, status] of [
        ["1.14.18", "incompatible"],
        ["1.14.19-beta.1", "incompatible"],
        ["1.14.19", "ready"],
        ["1.14.19+build.1", "ready"],
        ["2.0.0-beta.1", "ready"],
      ] as const) {
        const value = yield* harness({ ...installed, version });
        const state = yield* value.owner.read;
        expect(state.executable.status).toBe(status);
        expect(state.installation.phase).toBe("idle");
        expect(value.calls()).toBe(0);
      }
      const unusable = yield* harness(
        new OpenCodeInstallPlatformError({
          reason: "invalid-version",
          message: "Cannot read this executable",
        }),
      );
      expect((yield* unusable.owner.read).executable).toEqual({
        status: "unusable",
        message: "Cannot read this executable",
      });
      const unsupported = yield* harness(null, "win32");
      expect((yield* unsupported.owner.read).supported).toBe(false);
      expect((yield* unsupported.owner.install).installation).toMatchObject({
        phase: "failed",
        reason: "unsupported-platform",
      });
      expect(unsupported.calls()).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect(
  "keeps installation single-flight outside the requesting Scope and refreshes providers after success",
  () =>
    Effect.gen(function* () {
      const value = yield* harness();
      const done = yield* watch(value.owner, "succeeded");
      yield* Effect.yieldNow;
      const snapshots = yield* Effect.all(
        [value.owner.install.pipe(Effect.scoped), value.owner.install],
        { concurrency: "unbounded" },
      );
      yield* value.started;
      expect(snapshots.every((state) => state.installation.phase === "running")).toBe(true);
      expect(value.calls()).toBe(1);
      expect((yield* value.owner.read).installation.phase).toBe("running");
      yield* value.emit("Downloading 25%\n");
      yield* value.finish();
      const final = yield* Fiber.join(done);
      expect(final.executable).toEqual({ status: "ready", ...installed });
      expect(final.installation).toMatchObject({ phase: "succeeded" });
      expect(value.refreshed()).toBe(1);
      expect(value.released()).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect(
  "reuses every existing host installation without replacing old or unusable executables",
  () =>
    Effect.gen(function* () {
      for (const initial of [
        installed,
        { ...installed, version: "1.2.24" },
        new OpenCodeInstallPlatformError({
          reason: "existing-installation",
          message: "Existing file is not executable",
        }),
      ]) {
        const value = yield* harness(initial);
        const ready = initial === installed;
        const done = yield* watch(value.owner, ready ? "succeeded" : "idle");
        yield* Effect.yieldNow;
        yield* value.owner.install;
        const final = yield* Fiber.join(done);
        expect(final.executable.status).not.toBe("missing");
        expect(value.calls()).toBe(0);
        expect(value.refreshed()).toBe(ready ? 1 : 0);
      }
    }).pipe(Effect.scoped),
);

it.effect(
  "throttles progress snapshots and delivers terminal state without waiting for the throttle",
  () =>
    Effect.gen(function* () {
      const value = yield* harness();
      const events: OpenCodeSetupState[] = [];
      yield* value.owner.changes.pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            events.push(state);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Effect.yieldNow;
      yield* value.owner.install;
      yield* value.started;
      expect(events).toHaveLength(1);
      for (let progress = 1; progress <= 20; progress++) yield* value.emit(`##### ${progress}%\r`);
      yield* TestClock.adjust("99 millis");
      expect(events).toHaveLength(1);
      yield* TestClock.adjust("1 millis");
      expect(events).toHaveLength(2);
      expect(events[1]!.revision).toBeGreaterThan(events[0]!.revision);
      expect(events[1]!.installation).toMatchObject({ phase: "running", log: { progress: 0.2 } });
      const done = yield* watch(value.owner, "succeeded");
      yield* Effect.yieldNow;
      yield* value.finish();
      yield* Fiber.join(done);
      expect(events.at(-1)?.installation.phase).toBe("succeeded");
    }).pipe(Effect.scoped),
);

it.effect("bounds retained UTF-8 logs and clears cancelled work before another installation", () =>
  Effect.gen(function* () {
    const value = yield* harness();
    yield* value.owner.install;
    yield* value.started;
    yield* value.emit("##### 90%\n");
    yield* value.emit("前".repeat(30_000) + "\nlast output");
    const active = yield* value.owner.read;
    expect(active.installation.phase).toBe("running");
    if (active.installation.phase !== "running") return;
    expect(active.installation.log.lines.length).toBeLessThanOrEqual(200);
    expect(
      new TextEncoder().encode(active.installation.log.lines.join("\n")).length,
    ).toBeLessThanOrEqual(64 * 1024);
    expect(active.installation.log.lines.at(-1)).toBe("last output");
    expect(active.installation.log.progress).toBeNull();
    const cancelled = yield* value.owner.cancel;
    expect(cancelled.installation.phase).toBe("idle");
    expect(value.released()).toBe(1);
    yield* value.emit("late output");
    expect((yield* value.owner.read).revision).toBe(cancelled.revision);
    yield* value.owner.install;
    expect((yield* value.owner.read).installation).toEqual({
      phase: "running",
      log: { lines: [], progress: null },
    });
    yield* value.owner.cancel;
  }).pipe(Effect.scoped),
);

it.effect("keeps failed installer output and identifies a post-install configuration failure", () =>
  Effect.gen(function* () {
    const failed = yield* harness();
    const failure = yield* watch(failed.owner, "failed");
    yield* Effect.yieldNow;
    yield* failed.owner.install;
    yield* failed.started;
    yield* failed.emit("Network unavailable\n", "stderr");
    yield* failed.fail(
      new OpenCodeInstallPlatformError({ reason: "process", message: "Download failed" }),
    );
    const result = yield* Fiber.join(failure);
    expect(result.installation).toMatchObject({
      phase: "failed",
      reason: "process",
      message: "Download failed",
      log: { lines: ["Network unavailable"] },
    });
    expect(failed.refreshed()).toBe(0);
    const stale = yield* harness(null, "darwin", true);
    const staleResult = yield* watch(stale.owner, "failed");
    yield* Effect.yieldNow;
    yield* stale.owner.install;
    yield* stale.started;
    yield* stale.finish();
    const state = yield* Fiber.join(staleResult);
    expect(state.executable.status).toBe("ready");
    expect(state.installation).toMatchObject({ phase: "failed", reason: "configuration" });
    yield* stale.recoverRefresh;
    const recovered = yield* watch(stale.owner, "succeeded");
    yield* Effect.yieldNow;
    yield* stale.owner.install;
    yield* Fiber.join(recovered);
    expect(stale.calls()).toBe(1);
    expect(stale.refreshed()).toBe(2);
  }).pipe(Effect.scoped),
);

it.effect(
  "does not refresh or replace an incompatible installation discovered during installer admission",
  () =>
    Effect.gen(function* () {
      const value = yield* harness();
      const done = yield* watch(value.owner, "idle");
      yield* Effect.yieldNow;
      yield* value.owner.install;
      yield* value.started;
      yield* value.finish({ ...installed, version: "1.2.24" });
      const result = yield* Fiber.join(done);
      expect(result.executable).toMatchObject({ status: "incompatible", version: "1.2.24" });
      expect(value.refreshed()).toBe(0);
    }).pipe(Effect.scoped),
);

it.effect("closing the Main Scope interrupts a running installer", () =>
  Effect.gen(function* () {
    const value = yield* harness();
    yield* value.owner.install;
    yield* value.started;
    yield* Scope.close(value.scope, Exit.void);
    expect(value.released()).toBe(1);
    expect(value.refreshed()).toBe(0);
  }).pipe(Effect.scoped),
);
