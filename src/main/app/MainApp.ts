import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { MainCleanup } from "./MainCleanup";
import { MainApplication } from "./MainApplication";
import { MainConfig } from "./MainConfig";
import { MainApplicationError, type MainExit } from "./MainExit";
import { MainShutdown } from "./MainShutdown";

export type MainStartupGateResult = "continue" | "moved" | "quit";

export interface MainAppOptions<R, E = MainApplicationError> {
  readonly initialEvents: readonly import("../bootstrap-events").BootstrapRuntimeEvent[];
  readonly applicationLayer: Layer.Layer<MainApplication, E, R>;
  readonly runStartupGate: Effect.Effect<MainStartupGateResult, MainApplicationError, R>;
  readonly onApplicationReady?: (
    application: MainApplication["Service"],
  ) => Effect.Effect<void, MainApplicationError, R | Scope.Scope>;
}

const runApplication = <R, E>(
  options: MainAppOptions<R, E>,
  onAcquired: (application: MainApplication["Service"] | null) => void,
  onClosing: () => void,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const shutdown = yield* MainShutdown;
      const awaitShutdown = shutdown.awaitRequest.pipe(Effect.tap(() => Effect.sync(onClosing)));
      const acquireApplication = Effect.gen(function* () {
        const application = yield* MainApplication;
        onAcquired(application);
        yield* Effect.addFinalizer(() =>
          application.prepareShutdown.pipe(Effect.ensuring(Effect.sync(() => onAcquired(null)))),
        );
        if (application.readiness === "ready") {
          for (const event of options.initialEvents) yield* application.handleBootstrapEvent(event);
          if (options.onApplicationReady) yield* options.onApplicationReady(application);
        }
        return yield* awaitShutdown;
      }).pipe(
        // Renderer flushes still need the application's IPC and persistence services.
        Effect.scoped,
        // this is the application acquisition boundary inside the process Scope.
        Effect.provide(options.applicationLayer),
        Effect.mapError((cause) =>
          Schema.is(MainApplicationError)(cause)
            ? cause
            : new MainApplicationError({
                phase: "startup",
                operation: "application-graph",
                cause,
              }),
        ),
      );

      return yield* Effect.raceFirst(acquireApplication, awaitShutdown);
    }),
  );

export const program = <R, E>(options: MainAppOptions<R, E>) =>
  Effect.gen(function* () {
    const electron = yield* ElectronApp;
    const cleanup = yield* MainCleanup;
    const config = yield* MainConfig;
    const shutdown = yield* MainShutdown;
    let quitAllowed = false;
    let activeApplication: MainApplication["Service"] | null = null;
    let failurePhase: "startup" | "closing" = "startup";
    yield* electron.onActivate(
      Effect.suspend(() => activeApplication?.activate ?? Effect.void).pipe(Effect.orDie),
    );
    yield* electron.onBeforeQuit(() => ({
      preventDefault: !quitAllowed,
      task: quitAllowed ? Effect.void : shutdown.request({ _tag: "UserQuit" }).pipe(Effect.asVoid),
    }));
    yield* electron.onWindowAllClosed(
      config.platform === "darwin"
        ? Effect.void
        : shutdown.request({ _tag: "UserQuit" }).pipe(Effect.asVoid),
    );
    yield* electron.onTerminationSignal((signal) =>
      shutdown.request({ _tag: "Signal", signal }).pipe(Effect.asVoid),
    );
    yield* electron.whenReady;
    const gate = yield* options.runStartupGate;
    if (gate === "moved") {
      return {
        _tag: "Shutdown",
        reason: { _tag: "UserQuit" },
        cleanup: yield* cleanup.snapshot,
      } satisfies MainExit;
    }
    if (gate === "quit") {
      yield* electron.quit;
      return {
        _tag: "Shutdown",
        reason: { _tag: "UserQuit" },
        cleanup: yield* cleanup.snapshot,
      } satisfies MainExit;
    }

    const applicationExit = yield* Effect.exit(
      runApplication(
        options,
        (application) => {
          activeApplication = application;
        },
        () => {
          failurePhase = "closing";
        },
      ),
    );
    yield* shutdown.markRuntimeClosed(Exit.asVoid(applicationExit));
    if (Exit.isFailure(applicationExit)) {
      const typedFailure = Cause.findErrorOption(applicationExit.cause);
      return {
        _tag: "Failure",
        phase: typedFailure._tag === "Some" ? typedFailure.value.phase : failurePhase,
        cause: applicationExit.cause,
      } satisfies MainExit;
    }
    quitAllowed = true;
    if (applicationExit.value._tag === "RuntimeFatal") {
      return {
        _tag: "Failure",
        phase: "runtime",
        cause: Cause.fail(
          new MainApplicationError({
            phase: "runtime",
            operation: applicationExit.value.subsystem ?? "application-kernel",
            cause: applicationExit.value.cause ?? new Error("Application truth became unavailable"),
          }),
        ),
      } satisfies MainExit;
    }
    if (
      applicationExit.value._tag === "AuthorityDriftRelaunch" ||
      applicationExit.value._tag === "StoreRestoreRelaunch" ||
      applicationExit.value._tag === "StartupFailure"
    ) {
      yield* electron.relaunch;
    }
    yield* electron.quit;
    return {
      _tag: "Shutdown",
      reason: applicationExit.value,
      cleanup: yield* cleanup.snapshot,
    } satisfies MainExit;
  }).pipe(Effect.scoped);
