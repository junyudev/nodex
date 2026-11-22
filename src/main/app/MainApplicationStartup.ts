import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { ApplicationInitializationRuntime } from "../host-runtime/ApplicationInitializationRuntime";
import { live as shellEnvironmentLive } from "../host-runtime/HostShellEnvironment";
import { WindowsTrayRuntime } from "../host-runtime/WindowsTrayRuntime";
import { getLogger } from "../logging/logger";
import * as ProcessTelemetry from "../platform/node/ProcessTelemetry";
import * as TerminalRuntimeLive from "../terminal-runtime/TerminalRuntimeLive";
import { isWindowsStartupActivation } from "../windows-desktop-policy";
import { ApplicationWindowShellRuntime } from "../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import * as ApplicationStateLive from "./ApplicationStateLive";
import { MainApplication, MainApplicationError } from "./MainApplication";
import { MainConfig } from "./MainConfig";
import { MainObservability } from "./MainObservability";
import { MainShutdown } from "./MainShutdown";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";

type ApplicationGraph = (typeof import("./MainApplicationLive"))["live"];

const runtimeError = (operation: string, cause: unknown) =>
  new MainApplicationError({ phase: "startup", operation, cause });

const applicationLogger = getLogger({ subsystem: "app" });

const shellEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return shellEnvironmentLive({
      baseEnvironment: config.environment,
      platform: config.platform as NodeJS.Platform,
    });
  }),
);

/**
 * The application graph is most of Main's code. It loads once the pre-Core shell exists, so the
 * startup window appears before that code is evaluated rather than after.
 */
const applicationGraph = Layer.unwrap(
  Effect.tryPromise({
    try: () => import("./MainApplicationLive"),
    catch: (cause) => runtimeError("application-graph", cause),
  }).pipe(Effect.map((graph) => graph.live)),
);

const startupFailureLive = (
  error: Layer.Error<ApplicationGraph> | MainApplicationError,
): Layer.Layer<
  MainApplication,
  never,
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | MainShutdown
  | MainObservability
  | ScopedCallbackRuntime
  | WindowRuntime
  | WindowsTrayRuntime
  | MainConfig
> =>
  Layer.effect(
    MainApplication,
    Effect.gen(function* () {
      const callbacks = yield* ScopedCallbackRuntime;
      const initialization = yield* ApplicationInitializationRuntime;
      const shell = yield* ApplicationWindowShellRuntime;
      const shutdown = yield* MainShutdown;
      const windows = yield* WindowRuntime;
      const config = yield* MainConfig;
      const tray = yield* WindowsTrayRuntime;

      applicationLogger.error("Desktop app startup failed; preserving the canonical window", {
        error,
      });
      const observability = yield* MainObservability;
      yield* observability.reportExit({
        _tag: "Failure",
        phase: "startup",
        cause: Cause.fail(runtimeError("startup", error)),
      });
      yield* initialization.markFailed;
      yield* tray.markApplicationFailed;
      shell.failAll(error);

      const revealFailure = Effect.sync(() => {
        const window = windows.getLastFocused();
        if (!window || window.isDestroyed()) return;
        if (config.platform === "win32" && window.isMinimized()) window.restore();
        window.show();
        window.focus();
      });
      yield* tray.actions.pipe(
        Stream.runForEach((action) => {
          if (action.kind === "quit")
            return shutdown.request({ _tag: "UserQuit" }).pipe(Effect.asVoid);
          if (action.kind === "menu") return tray.showMenu([]);
          return revealFailure;
        }),
        Effect.forkScoped,
      );

      for (const window of windows.all()) {
        const onClosed = (): void => {
          if (windows.count() > 0) return;
          callbacks.fork(shutdown.request({ _tag: "UserQuit" }).pipe(Effect.asVoid));
        };
        window.once("closed", onClosed);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            window.removeListener("closed", onClosed);
          }),
        );
      }

      return MainApplication.of({
        activate: revealFailure,
        handleBootstrapEvent: (event) => {
          if (config.platform !== "win32") return Effect.void;
          if (
            event.type === "second-instance" &&
            isWindowsStartupActivation(config.platform, event.argv)
          )
            return Effect.void;
          return revealFailure;
        },
        prepareShutdown: Effect.void,
        readiness: "startup-failed",
      });
    }),
  );

/** Keeps the pre-Core shell Scope alive while the full authority graph loads and acquires. */
export const productionLive = applicationGraph.pipe(
  Layer.catch(startupFailureLive),
  Layer.provideMerge(ApplicationStateLive.live),
  Layer.provideMerge(TerminalRuntimeLive.live),
  Layer.provideMerge(ProcessTelemetry.live),
  Layer.provideMerge(shellEnvironment),
);
