import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  ApplicationInitializationRuntime,
  live as applicationInitializationRuntimeLive,
} from "../host-runtime/ApplicationInitializationRuntime";
import * as AppProtocolRuntime from "../host-runtime/AppProtocolRuntime";
import {
  ApplicationBootstrapIpc,
  live as applicationBootstrapIpcLive,
} from "../ipc/handlers/ApplicationBootstrapIpc";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import {
  ApplicationWindowShellRuntime,
  configuredLive as applicationWindowShellRuntimeLive,
} from "../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime, live as windowRuntimeLive } from "../window-runtime/WindowRuntime";
import { MainObservability } from "./MainObservability";
import { MainConfig } from "./MainConfig";
import { MainShutdown } from "./MainShutdown";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { WindowsTrayRuntime, live as windowsTrayLive } from "../host-runtime/WindowsTrayRuntime";
import { isWindowsStartupActivation } from "../windows-desktop-policy";
import type * as FileSystem from "effect/FileSystem";

const windowsTray = windowsTrayLive();

const windowRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const electron = yield* ElectronApp;
    const config = yield* MainConfig;
    const tray = yield* WindowsTrayRuntime;
    const userDataPath = yield* electron.userDataPath;
    return windowRuntimeLive(
      userDataPath,
      config.platform as NodeJS.Platform,
      tray.canHideLastWindow,
    );
  }),
).pipe(Layer.provideMerge(windowsTray));

const initialization = Layer.unwrap(
  Effect.gen(function* () {
    const windows = yield* WindowRuntime;
    return applicationInitializationRuntimeLive(windows);
  }),
).pipe(Layer.provideMerge(windowRuntime));

const shell = applicationWindowShellRuntimeLive.pipe(
  Layer.provideMerge(Layer.merge(windowRuntime, AppProtocolRuntime.live)),
);

const bootstrapIpc = applicationBootstrapIpcLive.pipe(
  Layer.provideMerge(Layer.merge(initialization, shell)),
);

// Handler registration precedes renderer load, so the first preload invoke can
// never race a not-yet-installed bootstrap authority.
const started = Layer.effect(
  ApplicationWindowShellRuntime,
  Effect.gen(function* () {
    yield* ApplicationBootstrapIpc;
    const applicationShell = yield* ApplicationWindowShellRuntime;
    const settings = yield* ApplicationSettings;
    const config = yield* MainConfig;
    const snapshot = yield* settings.snapshot().pipe(Effect.orDie);
    applicationShell.openInitial(
      snapshot.windowRestore.policy,
      isWindowsStartupActivation(config.platform, config.argv) ? "hidden" : "foreground",
    );
    return applicationShell;
  }),
).pipe(Layer.provideMerge(bootstrapIpc));

/** Pre-Core state and startup presentation acquired before Store migration can block readiness. */
export const live: Layer.Layer<
  | WindowRuntime
  | WindowsTrayRuntime
  | ApplicationInitializationRuntime
  | ApplicationBootstrapIpc
  | ApplicationWindowShellRuntime
  | AppProtocolRuntime.AppProtocolRuntime,
  never,
  | ElectronApp
  | ElectronDesktop
  | ElectronIpc
  | ElectronSessionHost
  | MainConfig
  | MainObservability
  | ApplicationSettings
  | MainShutdown
  | ScopedCallbackRuntime
  | FileSystem.FileSystem
> = started;
