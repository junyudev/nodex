import { describe, expect, test } from "vite-plus/test";
import { CoreRequestClass } from "../core-runtime/CoreRequestClass";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { BootstrapRuntimeEvent } from "../bootstrap-events";
import {
  ElectronApp,
  type ElectronBeforeQuitDecision,
  type ElectronTerminationSignal,
} from "../platform/electron/ElectronApp";
import { program } from "./MainApp";
import { layer as cleanupLayer } from "./MainCleanup";
import { testLayer as configLayer } from "./MainConfig";
import { mainApplicationTestLayer } from "./MainApplication.test-support";
import { MainShutdown, layer as shutdownLayer } from "./MainShutdown";
import { coreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { CoreStartupError } from "../core-client/core-launcher";
import { CoreTransportError } from "../core-client/local-http";
import { MainApplicationError, type MainExit } from "./MainExit";
import { makeMainFatalIncident, fatalIncidentPresentation } from "./MainFatalIncident";
import { CallbackRuntimeClosedError, ScopedCallbackRuntime, layer } from "./ScopedCallbackRuntime";

describe("MainApp", () => {
  const fakeElectronLayer = (events: string[], overrides: Partial<ElectronApp["Service"]> = {}) =>
    Layer.succeed(
      ElectronApp,
      ElectronApp.of({
        appPath: Effect.succeed("/tmp/nodex-test-app"),
        downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
        isInApplicationsFolder: Effect.succeed(true),
        locale: Effect.succeed("en-US"),
        userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
        setAppUserModelId: () => Effect.void,
        whenReady: Effect.sync(() => events.push("ready")),
        quit: Effect.sync(() => events.push("quit")),
        relaunch: Effect.sync(() => events.push("relaunch")),
        exit: (code) => Effect.sync(() => events.push(`exit:${code}`)),
        onActivate: () => Effect.void,
        onBeforeQuit: () => Effect.void,
        onOpenUrl: () => Effect.void,
        onSecondInstance: () => Effect.void,
        onTerminationSignal: () => Effect.void,
        onWindowAllClosed: () => Effect.void,
        ...overrides,
      }),
    );

  it.effect.each([
    { isPackaged: true, appId: "app.jyu.nodex" },
    { isPackaged: false, appId: "app.jyu.nodex.dev" },
  ])("sets $appId before readiness, then runs the application lifecycle", ({ isPackaged, appId }) =>
    Effect.gen(function* () {
      const events: string[] = [];
      const started = yield* Deferred.make<void>();
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events, {
          setAppUserModelId: (id) => Effect.sync(() => events.push(`app-id:${id}`)),
        }),
        configLayer({ platform: "win32", isPackaged }),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const initialEvents: readonly BootstrapRuntimeEvent[] = [
        { type: "open-url", url: "nodex://pages/one" },
        { type: "second-instance", argv: ["--new-window"] },
      ];
      const applicationLayer = mainApplicationTestLayer({
        acquire: Effect.sync(() => events.push("start")).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.asVoid,
        ),
        handleBootstrapEvent: (event) =>
          Effect.sync(() => events.push(event.type === "open-url" ? `url:${event.url}` : "argv")),
        release: Effect.sync(() => events.push("release")),
        prepareShutdown: Effect.sync(() => events.push("prepare-update")),
        completeShutdown: Effect.sync(() => events.push("handoff-update")),
      });

      const fiber = yield* program({
        initialEvents,
        applicationLayer,
        runStartupGate: Effect.sync(() => {
          events.push("gate");
          return "continue" as const;
        }),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* shutdown.request({ _tag: "UserQuit" });
      yield* Fiber.join(fiber);

      assert.deepEqual(events, [
        `app-id:${appId}`,
        "ready",
        "gate",
        "start",
        "url:nodex://pages/one",
        "argv",
        "prepare-update",
        "release",
        "handoff-update",
        "quit",
      ]);
      assert.isTrue(Exit.isSuccess(yield* shutdown.awaitRuntimeClosed));
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect("rolls back an acquired runtime and publishes the startup failure exit", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events),
        configLayer(),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationError = new MainApplicationError({
        phase: "startup",
        operation: "startup",
        cause: new Error("failed startup"),
      });
      const applicationLayer = mainApplicationTestLayer({
        acquire: Effect.fail(applicationError),
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });

      const result = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
      }).pipe(Effect.provide(context));
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.phase, "startup");
      assert.deepEqual(events, ["ready", "release"]);
      assert.isTrue(Exit.isFailure(yield* shutdown.awaitRuntimeClosed));
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect("reports an acquisition defect as startup and a release defect as closing", () =>
    Effect.gen(function* () {
      for (const phase of ["startup", "closing"] as const) {
        const events: string[] = [];
        const foundation = Layer.mergeAll(
          shutdownLayer,
          cleanupLayer,
          fakeElectronLayer(events),
          configLayer(),
        );
        const foundationScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(foundation, foundationScope);
        const shutdown = Context.get(context, MainShutdown);
        const defect = new Error("filesystem publication failed");
        const result = yield* program({
          initialEvents: [],
          applicationLayer: mainApplicationTestLayer({
            acquire: phase === "startup" ? Effect.die(defect) : Effect.void,
            handleBootstrapEvent: () => Effect.void,
            release: phase === "closing" ? Effect.die(defect) : Effect.void,
          }),
          runStartupGate: Effect.succeed("continue" as const),
          onApplicationReady: () => shutdown.request({ _tag: "UserQuit" }).pipe(Effect.asVoid),
        }).pipe(Effect.provide(context));

        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure") {
          assert.strictEqual(result.phase, phase);
          assert.strictEqual(Cause.squash(result.cause), defect);
        }
        assert.notInclude(events, "quit");
        yield* Scope.close(foundationScope, Exit.void);
      }
    }),
  );

  it.effect("keeps a startup-failure presentation active without publishing readiness", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events),
        configLayer(),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        acquire: Effect.sync(() => events.push("failure-presented")).pipe(
          Effect.andThen(shutdown.request({ _tag: "UserQuit" })),
          Effect.asVoid,
        ),
        handleBootstrapEvent: () => Effect.sync(() => events.push("bootstrap-event")),
        readiness: "startup-failed",
      });

      const result = yield* program({
        initialEvents: [{ type: "open-url", url: "nodex://pages/one" }],
        applicationLayer,
        onApplicationReady: () => Effect.sync(() => events.push("ready")),
        runStartupGate: Effect.succeed("continue" as const),
      }).pipe(Effect.provide(context));

      assert.strictEqual(result._tag, "Shutdown");
      assert.deepEqual(events, ["ready", "failure-presented", "quit"]);
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect("relaunches only after an authority-drift shutdown has released the runtime", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const started = yield* Deferred.make<void>();
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events),
        configLayer(),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* shutdown.request({ _tag: "AuthorityDriftRelaunch" });
      yield* Fiber.join(fiber);
      assert.deepEqual(events, ["ready", "release", "relaunch", "quit"]);
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect("relaunches after a Store restore only once the Main Scope is released", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const started = yield* Deferred.make<void>();
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events),
        configLayer(),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(started);
      yield* shutdown.request({ _tag: "StoreRestoreRelaunch" });
      yield* Fiber.join(fiber);

      assert.deepEqual(events, ["ready", "release", "relaunch", "quit"]);
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect(
    "relaunches after a startup recovery request only once the Main Scope is released",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const started = yield* Deferred.make<void>();
        const foundation = Layer.mergeAll(
          shutdownLayer,
          cleanupLayer,
          fakeElectronLayer(events),
          configLayer(),
        );
        const foundationScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(foundation, foundationScope);
        const shutdown = Context.get(context, MainShutdown);
        const applicationLayer = mainApplicationTestLayer({
          acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          handleBootstrapEvent: () => Effect.void,
          release: Effect.sync(() => events.push("release")),
        });
        const fiber = yield* program({
          initialEvents: [],
          applicationLayer,
          runStartupGate: Effect.succeed("continue" as const),
        }).pipe(Effect.provide(context), Effect.forkScoped);
        yield* Deferred.await(started);
        yield* shutdown.request({ _tag: "StartupFailure" });
        yield* Fiber.join(fiber);

        assert.deepEqual(events, ["ready", "release", "relaunch", "quit"]);
        yield* Scope.close(foundationScope, Exit.void);
      }),
  );

  it.effect("returns a typed runtime failure after fatal application truth loss", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const ready = yield* Deferred.make<void>();
      const foundation = Layer.mergeAll(
        shutdownLayer,
        cleanupLayer,
        fakeElectronLayer(events),
        configLayer(),
      );
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const failure = new Error("canonical projection failed");
      const applicationLayer = mainApplicationTestLayer({
        acquire: Effect.void,
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
        onApplicationReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* shutdown.request({ _tag: "RuntimeFatal", subsystem: "projection", cause: failure });
      const exit = yield* Fiber.join(fiber);

      assert.strictEqual(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.strictEqual(exit.phase, "runtime");
        const error = Cause.squash(exit.cause);
        assert.isTrue(Schema.is(MainApplicationError)(error));
        if (Schema.is(MainApplicationError)(error)) assert.strictEqual(error.cause, failure);
      }
      assert.deepEqual(events, ["ready", "release"]);
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect("routes Electron activation through the scoped Main runtime", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const activate = yield* Ref.make<Effect.Effect<void> | null>(null);
      const electron = Layer.succeed(
        ElectronApp,
        ElectronApp.of({
          appPath: Effect.succeed("/tmp/nodex-test-app"),
          downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
          isInApplicationsFolder: Effect.succeed(true),
          locale: Effect.succeed("en-US"),
          userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
          setAppUserModelId: () => Effect.void,
          whenReady: Effect.void,
          quit: Effect.sync(() => events.push("quit")),
          relaunch: Effect.void,
          exit: () => Effect.void,
          onActivate: (handler) => Ref.set(activate, handler),
          onBeforeQuit: () => Effect.void,
          onOpenUrl: () => Effect.void,
          onSecondInstance: () => Effect.void,
          onTerminationSignal: () => Effect.void,
          onWindowAllClosed: () => Effect.void,
        }),
      );
      const foundation = Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer());
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        activate: Effect.sync(() => events.push("activate")),
        acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
        onApplicationReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(ready);

      const handler = yield* Ref.get(activate);
      if (handler) yield* handler;
      assert.deepEqual(events, ["activate"]);

      yield* shutdown.request({ _tag: "UserQuit" });
      yield* Fiber.join(fiber);
      assert.deepEqual(events, ["activate", "release", "quit"]);
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect(
    "routes process termination signals through Main shutdown before quitting Electron",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const started = yield* Deferred.make<void>();
        const termination = yield* Ref.make<
          ((signal: ElectronTerminationSignal) => Effect.Effect<void>) | null
        >(null);
        const electron = Layer.succeed(
          ElectronApp,
          ElectronApp.of({
            appPath: Effect.succeed("/tmp/nodex-test-app"),
            downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
            isInApplicationsFolder: Effect.succeed(true),
            locale: Effect.succeed("en-US"),
            userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
            setAppUserModelId: () => Effect.void,
            whenReady: Effect.void,
            quit: Effect.sync(() => events.push("quit")),
            relaunch: Effect.void,
            exit: () => Effect.void,
            onActivate: () => Effect.void,
            onBeforeQuit: () => Effect.void,
            onOpenUrl: () => Effect.void,
            onSecondInstance: () => Effect.void,
            onTerminationSignal: (handler) => Ref.set(termination, handler),
            onWindowAllClosed: () => Effect.void,
          }),
        );
        const foundation = Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer());
        const foundationScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(foundation, foundationScope);
        const shutdown = Context.get(context, MainShutdown);
        const applicationLayer = mainApplicationTestLayer({
          acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          handleBootstrapEvent: () => Effect.void,
          release: Effect.sync(() => events.push("release")),
        });
        const fiber = yield* program({
          initialEvents: [],
          applicationLayer,
          runStartupGate: Effect.succeed("continue" as const),
        }).pipe(Effect.provide(context), Effect.forkScoped);
        yield* Deferred.await(started);

        const handler = yield* Ref.get(termination);
        if (handler) yield* handler("SIGINT");
        yield* Fiber.join(fiber);

        assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "Signal", signal: "SIGINT" });
        assert.deepEqual(events, ["release", "quit"]);
        yield* Scope.close(foundationScope, Exit.void);
      }),
  );

  it.effect("interrupts an in-flight runtime acquisition when a termination signal wins", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const startEntered = yield* Deferred.make<void>();
      const startInterrupted = yield* Deferred.make<void>();
      const termination = yield* Ref.make<
        ((signal: ElectronTerminationSignal) => Effect.Effect<void>) | null
      >(null);
      const electron = Layer.succeed(
        ElectronApp,
        ElectronApp.of({
          appPath: Effect.succeed("/tmp/nodex-test-app"),
          downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
          isInApplicationsFolder: Effect.succeed(true),
          locale: Effect.succeed("en-US"),
          userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
          setAppUserModelId: () => Effect.void,
          whenReady: Effect.void,
          quit: Effect.sync(() => events.push("quit")),
          relaunch: Effect.void,
          exit: () => Effect.void,
          onActivate: () => Effect.void,
          onBeforeQuit: () => Effect.void,
          onOpenUrl: () => Effect.void,
          onSecondInstance: () => Effect.void,
          onTerminationSignal: (handler) => Ref.set(termination, handler),
          onWindowAllClosed: () => Effect.void,
        }),
      );
      const foundation = Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer());
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        acquire: Deferred.succeed(startEntered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(startInterrupted, undefined)),
        ),
        handleBootstrapEvent: () => Effect.void,
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(startEntered);

      const handler = yield* Ref.get(termination);
      if (handler) yield* handler("SIGTERM");
      yield* Fiber.join(fiber);

      yield* Deferred.await(startInterrupted);
      assert.deepEqual(events, ["release", "quit"]);
      assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "Signal", signal: "SIGTERM" });
      assert.isTrue(Exit.isSuccess(yield* shutdown.awaitRuntimeClosed));
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect(
    "turns Cmd-Q during startup into structured interruption without consulting runtime",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const startEntered = yield* Deferred.make<void>();
        const startInterrupted = yield* Deferred.make<void>();
        const beforeQuit = yield* Ref.make<(() => ElectronBeforeQuitDecision) | null>(null);
        const electron = Layer.succeed(
          ElectronApp,
          ElectronApp.of({
            appPath: Effect.succeed("/tmp/nodex-test-app"),
            downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
            isInApplicationsFolder: Effect.succeed(true),
            locale: Effect.succeed("en-US"),
            userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
            setAppUserModelId: () => Effect.void,
            whenReady: Effect.void,
            quit: Effect.sync(() => events.push("quit")),
            relaunch: Effect.void,
            exit: () => Effect.void,
            onActivate: () => Effect.void,
            onBeforeQuit: (handler) => Ref.set(beforeQuit, handler),
            onOpenUrl: () => Effect.void,
            onSecondInstance: () => Effect.void,
            onTerminationSignal: () => Effect.void,
            onWindowAllClosed: () => Effect.void,
          }),
        );
        const foundation = Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer());
        const foundationScope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(foundation, foundationScope);
        const shutdown = Context.get(context, MainShutdown);
        const applicationLayer = mainApplicationTestLayer({
          acquire: Deferred.succeed(startEntered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(startInterrupted, undefined)),
          ),
          handleBootstrapEvent: () => Effect.void,
          release: Effect.sync(() => events.push("release")),
        });
        const fiber = yield* program({
          initialEvents: [],
          applicationLayer,
          runStartupGate: Effect.succeed("continue" as const),
        }).pipe(Effect.provide(context), Effect.forkScoped);
        yield* Deferred.await(startEntered);

        const handler = yield* Ref.get(beforeQuit);
        const decision = handler?.();
        assert.isTrue(decision?.preventDefault);
        if (decision) yield* decision.task;
        yield* Fiber.join(fiber);

        yield* Deferred.await(startInterrupted);
        assert.deepEqual(events, ["release", "quit"]);
        assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "UserQuit" });
        assert.isTrue(Exit.isSuccess(yield* shutdown.awaitRuntimeClosed));
        yield* Scope.close(foundationScope, Exit.void);
      }),
  );

  it.effect("turns the first ready-state before-quit into the same scoped shutdown", () =>
    Effect.gen(function* () {
      const events: string[] = [];
      const started = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      const beforeQuit = yield* Ref.make<(() => ElectronBeforeQuitDecision) | null>(null);
      const electron = Layer.succeed(
        ElectronApp,
        ElectronApp.of({
          appPath: Effect.succeed("/tmp/nodex-test-app"),
          downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
          isInApplicationsFolder: Effect.succeed(true),
          locale: Effect.succeed("en-US"),
          userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
          setAppUserModelId: () => Effect.void,
          whenReady: Effect.void,
          quit: Effect.sync(() => events.push("quit")),
          relaunch: Effect.void,
          exit: () => Effect.void,
          onActivate: () => Effect.void,
          onBeforeQuit: (handler) => Ref.set(beforeQuit, handler),
          onOpenUrl: () => Effect.void,
          onSecondInstance: () => Effect.void,
          onTerminationSignal: () => Effect.void,
          onWindowAllClosed: () => Effect.void,
        }),
      );
      const foundation = Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer());
      const foundationScope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(foundation, foundationScope);
      const shutdown = Context.get(context, MainShutdown);
      const applicationLayer = mainApplicationTestLayer({
        acquire: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
        handleBootstrapEvent: () => Effect.void,
        confirmQuit: CoreRequestClass.pipe(
          Effect.map((requestClass) => {
            assert.strictEqual(requestClass, "interactive");
            return true;
          }),
        ),
        prepareShutdown: Effect.gen(function* () {
          assert.strictEqual(yield* CoreRequestClass, "interactive");
          events.push("flush");
          yield* Effect.yieldNow;
          assert.deepEqual(events, ["flush"]);
          events.push("persisted");
        }),
        release: Effect.sync(() => events.push("release")),
      });
      const fiber = yield* program({
        initialEvents: [],
        applicationLayer,
        runStartupGate: Effect.succeed("continue" as const),
        onApplicationReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      }).pipe(Effect.provide(context), Effect.forkScoped);
      yield* Deferred.await(ready);
      yield* Effect.yieldNow;

      const handler = yield* Ref.get(beforeQuit);
      const decision = handler?.();
      assert.isTrue(decision?.preventDefault);
      if (decision) yield* decision.task;
      yield* Fiber.join(fiber);
      assert.deepEqual(events, ["flush", "persisted", "release", "quit"]);
      assert.deepEqual(yield* shutdown.awaitRequest, { _tag: "UserQuit" });
      yield* Scope.close(foundationScope, Exit.void);
    }),
  );

  it.effect(
    "Windows stays resident without windows and a canceled Quit leaves its Scope alive",
    () =>
      Effect.gen(function* () {
        const events: string[] = [];
        const ready = yield* Deferred.make<void>();
        let windowAllClosed = Effect.void;
        let beforeQuit: (() => ElectronBeforeQuitDecision) | null = null;
        let approved = false;
        const electron = fakeElectronLayer(events, {
          onWindowAllClosed: (handler) =>
            Effect.sync(() => {
              windowAllClosed = handler;
            }),
          onBeforeQuit: (handler) =>
            Effect.sync(() => {
              beforeQuit = handler;
            }),
        });
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          Layer.mergeAll(shutdownLayer, cleanupLayer, electron, configLayer({ platform: "win32" })),
          scope,
        );
        const shutdown = Context.get(context, MainShutdown);
        const fiber = yield* program({
          initialEvents: [],
          applicationLayer: mainApplicationTestLayer({
            acquire: Effect.void,
            handleBootstrapEvent: () => Effect.void,
            confirmQuit: Effect.sync(() => {
              events.push("confirm");
              return approved;
            }),
            prepareShutdown: Effect.sync(() => {
              events.push("flush");
            }),
            release: Effect.sync(() => {
              events.push("release");
            }),
          }),
          runStartupGate: Effect.succeed("continue"),
          onApplicationReady: () => Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provide(context), Effect.forkScoped);
        yield* Deferred.await(ready);
        yield* windowAllClosed;
        assert.isFalse(yield* shutdown.isRequested);
        const handler = beforeQuit as (() => ElectronBeforeQuitDecision) | null;
        assert.isNotNull(handler);
        const canceled = handler!();
        assert.isTrue(canceled.preventDefault);
        yield* canceled.task;
        assert.isFalse(yield* shutdown.isRequested);
        assert.notInclude(events, "release");
        approved = true;
        yield* handler!().task;
        yield* Fiber.join(fiber);
        assert.deepEqual(events, ["ready", "confirm", "confirm", "flush", "release", "quit"]);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});

describe("MainFatalIncident", () => {
  const context = {
    id: "5fa076e8-3e7a-4cdb-abfc-632bf74fd45d",
    occurredAt: "2026-10-28T06:00:00.000Z",
    appVersion: "0.4.0",
    appBuildVersion: "1.25.23",
  };
  const exitFor = (cause: Cause.Cause<MainApplicationError>): MainExit & { _tag: "Failure" } => ({
    _tag: "Failure",
    phase: "runtime",
    cause,
  });

  test("retains nested failure meaning and code coordinates without copying content or paths", () => {
    const privateError = Object.assign(new Error("private prompt Bearer token-123"), {
      prompt: "private prompt",
      attachment: "private image bytes",
      token: "token-123",
    });
    privateError.stack =
      "Error: private prompt Bearer token-123\n    at Worker.consume (/Users/private-person/secret-workspace/private.ts:42:9)";
    const failure = new MainApplicationError({
      phase: "runtime",
      operation: "core",
      cause: Cause.fail(
        coreRuntimeError({
          operation: "events.read",
          reason: "transport-loss",
          retryable: true,
          generation: "generation-1",
          cause: new CoreTransportError("connection_lost", "response", "ECONNRESET", privateError),
        }),
      ),
    });
    const incident = makeMainFatalIncident(
      exitFor(Cause.fail(failure)),
      {
        failures: [
          { operation: "core.shutdown", subsystem: "core", reason: "private shutdown details" },
        ],
      },
      context,
    );
    expect(failure.message).toContain("core");
    expect(incident.appVersion).toBe("0.4.0 (2523)");
    expect(incident.causes.map(({ parent, name }) => ({ parent, name }))).toEqual([
      { parent: null, name: "MainApplicationError" },
      { parent: 0, name: "CoreRuntimeError" },
      { parent: 1, name: "CoreTransportError" },
      { parent: 2, name: "Error" },
    ]);
    expect(incident.causes[1]).toMatchObject({
      operation: "events.read",
      generation: "generation-1",
      reason: "transport-loss",
      retryable: true,
    });
    expect(incident.causes[2]).toMatchObject({
      transportKind: "connection_lost",
      code: "ECONNRESET",
    });
    expect(incident.causes[3]!.frames).toEqual([
      { function: "Worker.consume", line: 42, column: 9 },
    ]);
    expect(incident.cleanup).toEqual({
      failureCount: 1,
      failures: [{ operation: "core.shutdown", subsystem: "core" }],
    });
    for (const privateValue of [
      "private prompt",
      "token-123",
      "private image",
      "private-person",
      "secret-workspace",
      "private.ts",
      "private shutdown",
    ]) {
      expect(JSON.stringify(incident)).not.toContain(privateValue);
    }
    expect(
      fatalIncidentPresentation(incident, "/profile/diagnostics/fatal/report.json"),
    ).toMatchObject({
      incidentId: context.id,
      detail: expect.stringContaining("Diagnostics: /profile/diagnostics/fatal/report.json"),
    });
  });

  test("retains sibling defects and caps a large cause graph", () => {
    const cause = Cause.fromReasons<MainApplicationError>([
      Cause.makeFailReason(
        new MainApplicationError({ phase: "runtime", operation: "core", cause: null }),
      ),
      ...Array.from({ length: 30 }, () => Cause.makeDieReason(new TypeError("private input"))),
    ]);
    const incident = makeMainFatalIncident(exitFor(cause), { failures: [] }, context);
    expect(incident.causes.length).toBeLessThanOrEqual(12);
    expect(incident.causes[1]).toMatchObject({ name: "TypeError", kind: "defect", parent: null });
    expect(incident.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(incident))).toBeLessThan(16 * 1024);
  });

  test("handles cycles and throwing dependency accessors without hiding the fatal", () => {
    const error = new Error("private input");
    Object.defineProperty(error, "stack", {
      get: () => {
        throw new Error("private getter");
      },
    });
    error.cause = error;
    const incident = makeMainFatalIncident(exitFor(Cause.die(error)), { failures: [] }, context);
    expect(incident.causes).toEqual([
      { kind: "defect", parent: null, name: "UninspectableError", frames: [] },
    ]);
    expect(fatalIncidentPresentation(incident, null).detail).toContain("could not be saved");
  });

  test("classifies errors without retaining custom names from dependencies", () => {
    const privateName = "private-credential-canary";
    const dependencyError = Object.assign(new Error("private message"), { name: privateName });
    const typeError = Object.assign(new TypeError("private input"), { name: privateName });
    const incident = makeMainFatalIncident(
      exitFor(
        Cause.fromReasons([Cause.makeDieReason(dependencyError), Cause.makeDieReason(typeError)]),
      ),
      { failures: [] },
      context,
    );
    expect(incident.causes.map(({ name }) => name)).toEqual(["Error", "TypeError"]);
    expect(JSON.stringify(incident)).not.toContain(privateName);
  });

  test("bounds traversal through deeply nested Cause containers", () => {
    let cause: Cause.Cause<unknown> = Cause.die(new Error("private content"));
    for (let index = 0; index < 12_000; index += 1) cause = Cause.fail(cause);
    const incident = makeMainFatalIncident(exitFor(Cause.die(cause)), { failures: [] }, context);
    expect(incident.truncated).toBe(true);
    expect(incident.causes.length).toBeLessThanOrEqual(12);
    expect(fatalIncidentPresentation(incident, null).incidentId).toBe(context.id);
  });

  test("retains native loader status while excluding stderr, executable paths, and credentials", () => {
    const launch = new CoreStartupError(
      new Error("private stderr /Users/person/secret Bearer credential"),
      { code: -1073741515, error: null },
    );
    const incident = makeMainFatalIncident(
      exitFor(
        Cause.fail(
          new MainApplicationError({ phase: "startup", operation: "core", cause: launch }),
        ),
      ),
      { failures: [] },
      context,
    );
    expect(incident.causes[1]).toMatchObject({
      name: "CoreStartupError",
      reason: "exit",
      exitCode: -1073741515,
      executable: launch.executable,
    });
    expect(launch.windowsStatus).toBe(process.platform === "win32" ? "0xC0000135" : null);
    for (const value of ["private stderr", "/Users/person", "credential"])
      expect(JSON.stringify(incident)).not.toContain(value);
  });
});

describe("ScopedCallbackRuntime", () => {
  it.effect("interrupts admitted callback fibers before rejecting new admission", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const context = yield* Layer.buildWithScope(layer, scope);
      const runtime = context.pipe((services) => Context.get(services, ScopedCallbackRuntime));
      const interrupted = yield* Deferred.make<void>();

      const fiber = runtime.fork(
        Effect.never.pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      );
      assert.isNotNull(fiber);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(interrupted);
      assert.isNull(runtime.fork(Effect.void));
      const rejectedAsClosed = yield* Effect.promise(() =>
        runtime.runPromise(Effect.void).then(() => false, Schema.is(CallbackRuntimeClosedError)),
      );
      assert.isTrue(rejectedAsClosed);
    }),
  );
});
