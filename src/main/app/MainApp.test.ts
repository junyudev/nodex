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
import { MainApplicationError } from "./MainApplication";
import { MainShutdown, layer as shutdownLayer } from "./MainShutdown";

const fakeElectronLayer = (events: string[]) =>
  Layer.succeed(
    ElectronApp,
    ElectronApp.of({
      appPath: Effect.succeed("/tmp/nodex-test-app"),
      downloadsPath: Effect.succeed("/tmp/nodex-test-downloads"),
      isInApplicationsFolder: Effect.succeed(true),
      locale: Effect.succeed("en-US"),
      userDataPath: Effect.succeed("/tmp/nodex-test-user-data"),
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
    }),
  );

it.effect("starts, replays bootstrap events, closes runtime, then quits", () =>
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
      "ready",
      "gate",
      "start",
      "url:nodex://pages/one",
      "argv",
      "release",
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

it.effect("relaunches after a startup recovery request only once the Main Scope is released", () =>
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

it.effect("routes process termination signals through Main shutdown before quitting Electron", () =>
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
      prepareShutdown: Effect.gen(function* () {
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
