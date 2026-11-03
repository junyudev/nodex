import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deferredRelease } from "../dictation/dictation-release.test-fixtures";
import { assert, it } from "@effect/vitest";
import { beforeEach, vi } from "vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { createCommandKeymapState } from "../../shared/command-keybindings";
import { testLayer as mainConfigTestLayer } from "../app/MainConfig";
import { CodexPlatform } from "../app/CodexApplicationLive";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronPrivacy } from "../platform/electron/ElectronPrivacy";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { RendererClientRuntime } from "./RendererClientRuntime";
import { DictationRuntime, DictationRuntimeError, live } from "./DictationRuntime";

const native = vi.hoisted(() => ({
  windowsDispose: vi.fn<() => Promise<void>>(),
  macDispose: vi.fn<() => void>(),
  managerDispose: vi.fn<() => void>(),
  windowDispose: vi.fn<() => void>(),
}));

vi.mock("../platform/electron/WindowsDictationNative", () => ({
  createWindowsDictationNativeHelperClient: () => ({ dispose: () => native.windowsDispose() }),
}));
vi.mock("../dictation/mac-dictation-native-helper-client", () => ({
  resolveMacDictationHelperExecutable: () => "/fixture/dictation-helper",
  MacDictationNativeHelperClient: class {
    dispose() {
      native.macDispose();
    }
  },
}));
// These independently covered children stay inert; the real DictationRuntime owns finalization.
vi.mock("../dictation/global-dictation-manager", () => ({
  GlobalDictationManager: class {
    subscribe() {
      return () => {};
    }
    initialize() {
      return Promise.resolve(null);
    }
    dispose() {
      native.managerDispose();
    }
  },
}));
vi.mock("../dictation/global-dictation-window-controller", () => ({
  GlobalDictationWindowController: class {
    subscribeTerminal() {
      return () => {};
    }
    dispose() {
      native.windowDispose();
    }
  },
}));

beforeEach(() => {
  native.windowsDispose.mockReset().mockResolvedValue(undefined);
  native.macDispose.mockReset();
  native.managerDispose.mockReset();
  native.windowDispose.mockReset();
});

const buildRuntime = Effect.fn("DictationRuntimeTest.build")(function* (
  scope: Scope.Closeable,
  platform: "win32" | "darwin" = "win32",
) {
  const nodexHome = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-dictation-scope-test-"))),
    (home) => Effect.promise(() => rm(home, { recursive: true, force: true })),
  ).pipe(Effect.provideService(Scope.Scope, scope));
  const capabilities = Layer.mergeAll(
    mainConfigTestLayer({
      platform,
      arch: platform === "win32" ? "x64" : "arm64",
      nodexHome,
      profileSettingsPath: path.join(nodexHome, "config.toml"),
    }),
    WebContentsDestructionSubscriptions.live,
    Layer.succeed(ApplicationSettings, {
      snapshot: () =>
        Effect.succeed({
          commandKeymap: createCommandKeymapState({}, platform === "win32" ? "windows" : "macOS"),
        }),
    } as unknown as ApplicationSettings["Service"]),
    Layer.succeed(CodexPlatform, {
      runtime: { browserRuntime: {} },
    } as unknown as CodexPlatform["Service"]),
    Layer.succeed(ElectronPrivacy, {
      systemPreferences: {},
    } as unknown as ElectronPrivacy["Service"]),
    Layer.succeed(ElectronDesktop, {
      shell: { openExternal: () => Promise.resolve() },
    } as unknown as ElectronDesktop["Service"]),
    Layer.succeed(RendererClientRuntime, {
      events: Stream.never,
    } as unknown as RendererClientRuntime["Service"]),
    Layer.succeed(WindowRuntime, {
      all: () => [],
      get: () => undefined,
    } as unknown as WindowRuntime["Service"]),
    Layer.succeed(ApplicationWindowRuntime, {
      openDictationRecording: () => true,
    } as unknown as ApplicationWindowRuntime["Service"]),
  );
  const context = yield* Layer.buildWithScope(
    live({ preloadPath: "/fixture/preload.cjs" }).pipe(Layer.provide(capabilities)),
    scope,
  );
  return Context.get(context, DictationRuntime);
});

it.effect("Scope closure waits for the concrete Windows helper release", () =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = deferredRelease();
        native.windowsDispose.mockImplementation(() => {
          Deferred.doneUnsafe(started, Effect.void);
          return release.promise;
        });
        yield* buildRuntime(scope);
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Effect.gen(function* () {
          yield* Deferred.await(started);
          assert.isUndefined(closing.pollUnsafe());
          assert.strictEqual(native.managerDispose.mock.calls.length, 1);
          assert.strictEqual(native.windowDispose.mock.calls.length, 1);
          // Another managed task can run while native release remains pending.
          const turn = yield* Effect.forkChild(Effect.succeed("event-loop-alive"));
          assert.strictEqual(yield* Fiber.join(turn), "event-loop-alive");
          assert.isUndefined(closing.pollUnsafe());
          release.resolve();
          yield* Fiber.join(closing);
          assert.strictEqual(native.windowsDispose.mock.calls.length, 1);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => release.resolve()).pipe(
              Effect.andThen(Fiber.await(closing)),
              Effect.asVoid,
            ),
          ),
        );
      }),
    (scope) => Scope.close(scope, Exit.void),
  ),
);

it.effect("Scope closure preserves release failure and still runs remaining finalizers", () =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = deferredRelease();
        const failure = new Error("native release did not finish");
        let previousOwnerReleased = false;
        yield* Scope.addFinalizer(
          scope,
          Effect.sync(() => {
            previousOwnerReleased = true;
          }),
        );
        native.windowsDispose.mockImplementation(() => {
          Deferred.doneUnsafe(started, Effect.void);
          return release.promise;
        });
        yield* buildRuntime(scope);
        const closing = yield* Effect.forkChild(Scope.close(scope, Exit.void));
        yield* Effect.gen(function* () {
          yield* Deferred.await(started);
          assert.isUndefined(closing.pollUnsafe());
          release.reject(failure);
          const closed = yield* Fiber.await(closing);
          assert.isTrue(Exit.isFailure(closed));
          if (Exit.isFailure(closed)) {
            const defect = Cause.findDefect(closed.cause);
            assert.isTrue(Result.isSuccess(defect));
            if (Result.isSuccess(defect)) {
              assert.instanceOf(defect.success, DictationRuntimeError);
              const error = defect.success as DictationRuntimeError;
              assert.strictEqual(error.operation, "release-native-dictation-helper");
              assert.strictEqual(error.cause, failure);
            }
          }
          assert.isTrue(previousOwnerReleased);
          assert.strictEqual(native.managerDispose.mock.calls.length, 1);
          assert.strictEqual(native.windowDispose.mock.calls.length, 1);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => release.resolve()).pipe(
              Effect.andThen(Fiber.await(closing)),
              Effect.asVoid,
            ),
          ),
        );
      }),
    (scope) => Scope.close(scope, Exit.void),
  ),
);

it.effect("Scope closure accepts the concrete Mac helper's synchronous disposal", () =>
  Effect.acquireUseRelease(
    Scope.make(),
    (scope) =>
      Effect.gen(function* () {
        yield* buildRuntime(scope, "darwin");
        yield* Scope.close(scope, Exit.void);
        assert.strictEqual(native.macDispose.mock.calls.length, 1);
        assert.strictEqual(native.windowsDispose.mock.calls.length, 0);
      }),
    (scope) => Scope.close(scope, Exit.void),
  ),
);
