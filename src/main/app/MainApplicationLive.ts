import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { performance } from "node:perf_hooks";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { CoreEventHub } from "../core-runtime/CoreEventHub";
import { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { AutomationRoutingIndex } from "../core-runtime/AutomationRoutingIndex";
import { ProjectionDeliveryRuntime } from "../core-runtime/ProjectionDeliveryRuntime";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { CodexSidebarSyncRuntime } from "../codex-application/CodexSidebarSyncRuntime";
import { CodexThreadHandoffRuntime } from "../codex-application/CodexThreadHandoffRuntime";
import {
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
} from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRetentionRuntime } from "../codex-application/ManagedWorktreeRetentionRuntime";
import { BrowserProfileHelperPlatform } from "../browser/browser-profile-helper-client";
import { projectSessionIdFromTerminalSessionId } from "../browser/browser-local-server-runtime";
import {
  BrowserApplication,
  BrowserApplicationError,
} from "../browser-application/BrowserApplication";
import { AppUpdateRuntime } from "../host-runtime/AppUpdateRuntime";
import { ApplicationHostRuntimeError } from "../host-runtime/ApplicationHostRuntime";
import { BrowserProfileRuntimeError } from "../host-runtime/BrowserProfileRuntime";
import { BrowserUseRuntimeError } from "../host-runtime/BrowserUseRuntime";
import { ReminderSchedulerRuntime } from "../host-runtime/ReminderSchedulerRuntime";
import { ScheduledAutomationRuntime } from "../host-runtime/ScheduledAutomationRuntime";
import { StoreAdministrationSchedulerRuntime } from "../host-runtime/StoreAdministrationSchedulerRuntime";
import { DeepLinkRuntime } from "../host-runtime/DeepLinkRuntime";
import { ApplicationInitializationRuntime } from "../host-runtime/ApplicationInitializationRuntime";
import * as AppProtocolRuntime from "../host-runtime/AppProtocolRuntime";
import { InitialProjectBootstrapRuntime } from "../initial-project/InitialProjectBootstrapRuntime";
import { requestsExplicitNewWindow } from "../main-runtime-startup-events";
import { getLogger } from "../logging/logger";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronIpc, ElectronSyncIpc } from "../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { TerminalRuntimeMap } from "../terminal-runtime/TerminalRuntimeMap";
import * as TerminalRuntimeLive from "../terminal-runtime/TerminalRuntimeLive";
import { MainApplication, MainApplicationError } from "./MainApplication";
import { MainCleanup } from "./MainCleanup";
import { MainConfig } from "./MainConfig";
import { MainShutdown } from "./MainShutdown";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
import { ApplicationWindowShellRuntime } from "../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import * as CodexApplicationLive from "./CodexApplicationLive";
import * as ConversationApplicationLive from "./ConversationApplicationLive";
import * as CoreApplicationLive from "./CoreApplicationLive";
import * as HostApplicationLive from "./HostApplicationLive";
import * as ApplicationStateLive from "./ApplicationStateLive";
import * as ApplicationOperationsLive from "./ApplicationOperationsLive";
import * as RendererIngressLive from "./RendererIngressLive";
import * as WindowApplicationLive from "./WindowApplicationLive";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { TemporaryAssets } from "../local-store/TemporaryAssets";

const runtimeError = (operation: string, cause: unknown) =>
  new MainApplicationError({ phase: "startup", operation, cause });

const applicationLogger = getLogger({ subsystem: "app" });

const applicationGraph = RendererIngressLive.live.pipe(
  Layer.provideMerge(
    ApplicationOperationsLive.live.pipe(
      Layer.provideMerge(
        ConversationApplicationLive.live.pipe(
          Layer.provideMerge(
            WindowApplicationLive.live.pipe(
              Layer.provideMerge(
                HostApplicationLive.live.pipe(
                  Layer.provideMerge(
                    CodexApplicationLive.live.pipe(Layer.provideMerge(CoreApplicationLive.live)),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  ),
);

/** Fully acquired production desktop application graph. */
export const live: Layer.Layer<
  MainApplication,
  | ApplicationHostRuntimeError
  | BrowserApplicationError
  | BrowserProfileRuntimeError
  | BrowserUseRuntimeError
  | CoreRuntimeError
  | ExecutionHostRuntimeError
  | MainApplicationError,
  | ElectronApp
  | ApplicationSettings
  | TemporaryAssets
  | ElectronDesktop
  | ElectronIpc
  | ElectronSyncIpc
  | ElectronSessionHost
  | ElectronWindowHost
  | FileSystem.FileSystem
  | BrowserProfileHelperPlatform
  | MainConfig
  | MainCleanup
  | MainShutdown
  | ScopedCallbackRuntime
  | TerminalSessions
  | TerminalRuntimeMap
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | AppProtocolRuntime.AppProtocolRuntime
  | WindowRuntime
> = Layer.effect(
  MainApplication,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const terminals = yield* TerminalSessions;
    const runtimeScope = yield* Scope.Scope;

    return yield* Effect.interruptible(
      Effect.gen(function* () {
        const initialization = yield* ApplicationInitializationRuntime;
        const authority = yield* CoreAuthority;
        const automationRouting = yield* AutomationRoutingIndex;
        const initialProjectBootstrap = yield* InitialProjectBootstrapRuntime;
        const scheduledAutomations = yield* ScheduledAutomationRuntime;
        const projectionDelivery = yield* ProjectionDeliveryRuntime;
        const coreEventHub = yield* CoreEventHub;
        const reminderScheduler = yield* ReminderSchedulerRuntime;
        const storeSchedulers = yield* StoreAdministrationSchedulerRuntime;
        const projectWorkspace = yield* ProjectWorkspace;
        const browser = yield* BrowserApplication;
        const executionHosts = yield* ExecutionHostRuntime;
        const appUpdates = yield* AppUpdateRuntime;
        const applicationWindows = yield* ApplicationWindowRuntime;
        const deepLinks = yield* DeepLinkRuntime;
        const sidebarSync = yield* CodexSidebarSyncRuntime;
        const managedWorktreeRetention = yield* ManagedWorktreeRetentionRuntime;
        const threadHandoffRuntime = yield* CodexThreadHandoffRuntime;
        yield* terminals.events.pipe(
          Stream.runForEach((event) => {
            if (event.channel !== "terminal-data") return Effect.void;
            const projectSessionId = projectSessionIdFromTerminalSessionId(event.payload.sessionId);
            if (!projectSessionId) return Effect.void;
            return projectWorkspace.getProjectSession(projectSessionId).pipe(
              Effect.flatMap((session) =>
                typeof session?.projectId === "string"
                  ? browser.localServers.observePtyData(session.projectId, event.payload.data)
                  : Effect.void,
              ),
              Effect.catch((cause) =>
                Effect.sync(() =>
                  applicationLogger.warn("Failed to observe terminal local-server output", {
                    cause,
                    terminalSessionId: event.payload.sessionId,
                  }),
                ),
              ),
            );
          }),
          Effect.forkIn(runtimeScope),
        );
        yield* applicationWindows.rendererLoaded.pipe(
          Stream.runForEach(() =>
            Effect.all([deepLinks.flush, appUpdates.startAutomaticChecks], {
              concurrency: 2,
            }).pipe(Effect.asVoid),
          ),
          Effect.forkIn(runtimeScope),
          Effect.asVoid,
        );
        yield* deepLinks.extractFromArgv(config.argv);
        yield* threadHandoffRuntime.recover().pipe(
          Effect.catch((cause) =>
            Effect.sync(() => applicationLogger.error("Task handoff recovery failed", { cause })),
          ),
          Effect.forkIn(runtimeScope, { startImmediately: true }),
          Effect.asVoid,
        );
        yield* SubscriptionRef.changes(executionHosts.activeSshHosts).pipe(
          Stream.runForEach(() => Effect.sync(sidebarSync.invalidate)),
          Effect.forkIn(runtimeScope),
          Effect.asVoid,
        );
        const initializationStartedAt = performance.now();
        const initialize = Effect.gen(function* () {
          applicationLogger.info("Native Core authority ready", {
            ...authority.initialLaunch.timings,
            artifactValidationMs: Math.round(authority.initialLaunch.timings.artifactValidationMs),
            connectMs: Math.round(authority.initialLaunch.timings.connectMs),
            selectionMs: Math.round(authority.initialLaunch.timings.selectionMs),
            totalMs: Math.round(authority.initialLaunch.timings.totalMs),
          });
          let coreStreamInterruptionPublished = false;
          yield* SubscriptionRef.changes(coreEventHub.connection).pipe(
            Stream.runForEach((connection) => {
              if (connection.kind === "ready") {
                coreStreamInterruptionPublished = false;
                return Effect.void;
              }
              if (connection.kind === "backing-off") {
                if (coreStreamInterruptionPublished) return Effect.void;
                coreStreamInterruptionPublished = true;
                return projectionDelivery
                  .resetStream("reconnect")
                  .pipe(
                    Effect.andThen(
                      Effect.sync(() =>
                        applicationLogger.warn(
                          "Native Core event stream interrupted; reconnecting",
                          { error: connection.error },
                        ),
                      ),
                    ),
                  );
              }
              if (connection.kind === "failed") {
                return Effect.sync(() =>
                  applicationLogger.error("Native Core event supervisor terminated unexpectedly", {
                    error: connection.error,
                  }),
                );
              }
              return Effect.void;
            }),
            Effect.forkIn(runtimeScope),
            Effect.asVoid,
          );
          yield* initialProjectBootstrap
            .ensure((presentation) =>
              Effect.sync(() => applicationWindows.seedInitialProjectPresentation(presentation)),
            )
            .pipe(Effect.mapError((cause) => runtimeError("initial-project-bootstrap", cause)));
          yield* deepLinks.markReady;
          yield* automationRouting.synchronize.pipe(
            Effect.mapError((cause) => runtimeError("synchronize-automations", cause)),
          );
          yield* managedWorktreeRetention.request;
          yield* Effect.all(
            [
              reminderScheduler.activate({
                openReminder: applicationWindows.sendReminderOpen,
              }),
              scheduledAutomations.activate,
              storeSchedulers.activate,
            ],
            { concurrency: "unbounded", discard: true },
          );
        });
        const initializationFiber = yield* initialize.pipe(Effect.forkIn(runtimeScope));

        yield* executionHosts.reconcile().pipe(
          Effect.mapError((cause) => runtimeError("reconcile-execution-hosts", cause)),
          Effect.catch((error) =>
            Effect.sync(() =>
              applicationLogger.warn("Some configured SSH execution hosts are unavailable", {
                error,
              }),
            ),
          ),
        );
        yield* Fiber.join(initializationFiber);
        yield* initialization.markDone;
        applicationLogger.info("Desktop app initialization finished", {
          durationMs: Math.round(performance.now() - initializationStartedAt),
        });
        yield* appUpdates.markApplicationReady;

        const application = MainApplication.of({
          activate: Effect.sync(applicationWindows.focusLast),
          handleBootstrapEvent: (event) => {
            if (event.type === "open-url") {
              return deepLinks.handle(event.url).pipe(
                Effect.mapError((cause) => runtimeError("handle-open-url", cause)),
                Effect.asVoid,
              );
            }
            return deepLinks.extractFromArgv(event.argv).pipe(
              Effect.tap((handled) =>
                handled
                  ? Effect.void
                  : Effect.sync(() => {
                      if (requestsExplicitNewWindow([...event.argv])) {
                        applicationWindows.requestNew();
                        return;
                      }
                      applicationWindows.focusLast();
                    }),
              ),
              Effect.mapError((cause) => runtimeError("handle-second-instance", cause)),
              Effect.asVoid,
            );
          },
          readiness: "ready",
        });
        yield* Scope.addFinalizer(
          runtimeScope,
          Effect.sync(() => {
            applicationWindows.beginApplicationQuit();
            applicationLogger.info("Nodex Main Scope closing");
          }),
        );
        return application;
      }),
    ).pipe(
      Effect.mapError((cause) =>
        Schema.is(MainApplicationError)(cause) ? cause : runtimeError("startup", cause),
      ),
    );
  }),
).pipe(Layer.provide(applicationGraph));

const startupFailureLive = (
  error:
    | ApplicationHostRuntimeError
    | BrowserApplicationError
    | BrowserProfileRuntimeError
    | BrowserUseRuntimeError
    | CoreRuntimeError
    | ExecutionHostRuntimeError
    | MainApplicationError,
): Layer.Layer<
  MainApplication,
  never,
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | MainShutdown
  | ScopedCallbackRuntime
  | WindowRuntime
> =>
  Layer.effect(
    MainApplication,
    Effect.gen(function* () {
      const callbacks = yield* ScopedCallbackRuntime;
      const initialization = yield* ApplicationInitializationRuntime;
      const shell = yield* ApplicationWindowShellRuntime;
      const shutdown = yield* MainShutdown;
      const windows = yield* WindowRuntime;

      applicationLogger.error("Desktop app startup failed; preserving the canonical window", {
        error,
      });
      yield* initialization.markFailed;
      shell.failAll(error);

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
        activate: Effect.sync(() => {
          const window = windows.getLastFocused();
          if (!window || window.isDestroyed()) return;
          window.show();
          window.focus();
        }),
        handleBootstrapEvent: () => Effect.void,
        readiness: "startup-failed",
      });
    }),
  );

/** Keeps the pre-Core shell Scope alive while the full authority graph acquires. */
export const productionLive = live.pipe(
  Layer.catch(startupFailureLive),
  Layer.provideMerge(ApplicationStateLive.live),
  Layer.provideMerge(TerminalRuntimeLive.live),
);
