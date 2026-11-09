import { MemberMessages } from "../../host/MemberMessages";
import { ChatAttachments } from "../../host/ChatAttachments";
import * as MobilePushRelay from "../platform/node/MobilePushRelay";
import { NativeConversationDelivery } from "../../host/NativeConversationDelivery";
import { live as nativeManagedChatFacts } from "../codex-application/NativeManagedChatFacts";
import { CodexTurnCommands } from "../codex-application/CodexTurnCommands";
import { HostToolExecutor } from "../../host/HostToolExecutor";
import { make as makeHostTools } from "../agent-runtime/AgentRuntimeHostTools";
import * as HostKernel from "../../host/HostKernel";
import { SpacePageFileHosts } from "../page-files/SpacePageFileHosts";
import { SessionReminderRuntime } from "../host-runtime/SessionReminderRuntime";
import { ChatSearch, live as chatSearchLive } from "../chat-search/ChatSearch";
import { live as insightsLive } from "../insights/Insights";
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
import { CodexComposerPredictionError } from "../codex-application/CodexComposerPrediction";
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
import { presentation as notificationPresentation } from "../host-runtime/NodexEntryNotifications";
import { DeepLinkRuntime } from "../host-runtime/DeepLinkRuntime";
import { ApplicationInitializationRuntime } from "../host-runtime/ApplicationInitializationRuntime";
import * as AppProtocolRuntime from "../host-runtime/AppProtocolRuntime";
import { requestsExplicitNewWindow } from "../main-runtime-startup-events";
import { getLogger } from "../logging/logger";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronIpc, ElectronSyncIpc, ElectronSpaceIpc } from "../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { TerminalSessions } from "../terminal-runtime/TerminalSessions";
import { TerminalRuntimeMap } from "../terminal-runtime/TerminalRuntimeMap";
import * as TerminalRuntimeLive from "../terminal-runtime/TerminalRuntimeLive";
import { MainApplication, MainApplicationError } from "./MainApplication";
import { MainCleanup } from "./MainCleanup";
import { MainConfig } from "./MainConfig";
import { NativeNotificationAuthorization } from "../platform/electron/NativeNotificationAuthorization";
import * as Cause from "effect/Cause";
import { MainObservability } from "./MainObservability";
import { MainShutdown } from "./MainShutdown";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { ApplicationWindowRuntime } from "../window-runtime/ApplicationWindowRuntime";
import { ApplicationWindowShellRuntime } from "../window-runtime/ApplicationWindowShellRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import * as ProductAnalyticsPlatform from "../platform/electron/ProductAnalyticsPlatform";
import * as CodexApplicationLive from "./CodexApplicationLive";
import * as ConversationApplicationLive from "./ConversationApplicationLive";
import * as CoreApplicationLive from "./CoreApplicationLive";
import * as HostApplicationLive from "./HostApplicationLive";
import * as ApplicationStateLive from "./ApplicationStateLive";
import * as ApplicationOperationsLive from "./ApplicationOperationsLive";
import * as NodexAccountLive from "./NodexAccountLive";
import * as HostDesktopToolsLive from "./HostDesktopToolsLive";
import { live as imageFittingLayer } from "../platform/electron/ElectronImageFitting";
import * as AgentRuntimeApplicationLive from "../../host/AgentRuntimeLive";
import * as RendererIngressLive from "./RendererIngressLive";
import * as SpacesApplicationLive from "./SpacesApplicationLive";
import * as WindowApplicationLive from "./WindowApplicationLive";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import * as CodexConversationPeerRuntime from "../platform/node/CodexConversationPeerRuntime";
import { live as shellEnvironmentLive } from "../host-runtime/WorktreeShellEnvironmentRuntime";
import { live as profilePersistedAtomsLive } from "../local-store/ProfilePersistedAtoms";
import { live as codexVisualizationStateLive } from "../codex-application/CodexVisualizationState";
import { WindowsTrayRuntime } from "../host-runtime/WindowsTrayRuntime";
import {
  WindowsTrayIntegration,
  live as windowsTrayIntegrationLive,
} from "../host-runtime/WindowsTrayIntegration";
import { isWindowsStartupActivation } from "../windows-desktop-policy";

const runtimeError = (operation: string, cause: unknown) =>
  new MainApplicationError({ phase: "startup", operation, cause });

const applicationLogger = getLogger({ subsystem: "app" });
// A failed external navigation must not tear down the desktop's other Spaces.
const reportSpaceLinkFailure = (cause: unknown) =>
  Effect.sync(() => applicationLogger.warn("Could not open Space link", { cause }));
const shellEnvironment = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return shellEnvironmentLive({
      baseEnvironment: config.environment,
      platform: config.platform as NodeJS.Platform,
      onError: (error) =>
        applicationLogger.warn("Failed to discover the login shell environment", { error }),
    });
  }),
);

const conversationGraph = ConversationApplicationLive.live.pipe(
  Layer.provideMerge(
    WindowApplicationLive.live.pipe(
      Layer.provideMerge(
        HostApplicationLive.live.pipe(
          Layer.provideMerge(
            CodexApplicationLive.live.pipe(
              Layer.provideMerge(CoreApplicationLive.live),
              Layer.provideMerge(ProductAnalyticsPlatform.live),
            ),
          ),
        ),
      ),
    ),
  ),
);
const executionGraph = AgentRuntimeApplicationLive.runtime.pipe(
  Layer.provide(HostDesktopToolsLive.live),
  Layer.provide(imageFittingLayer),
  Layer.provideMerge(NodexAccountLive.live.pipe(Layer.provideMerge(conversationGraph))),
);
const interactionsGraph = ConversationApplicationLive.interactions.pipe(
  Layer.provideMerge(chatSearchLive.pipe(Layer.provideMerge(executionGraph))),
  Layer.provideMerge(insightsLive.pipe(Layer.provideMerge(executionGraph))),
);
const protocolGraph = ConversationApplicationLive.protocol.pipe(
  Layer.provideMerge(interactionsGraph),
);
const workGraph = HostKernel.workApplication.pipe(Layer.provideMerge(protocolGraph));
const operationsGraph = ApplicationOperationsLive.live.pipe(Layer.provideMerge(workGraph));
const hostApplications = HostKernel.applications.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.effect(NativeConversationDelivery, CodexTurnCommands),
      notificationPresentation,
      nativeManagedChatFacts,
    ).pipe(Layer.provideMerge(operationsGraph)),
  ),
);
const hostTools = Layer.mergeAll(
  AgentRuntimeApplicationLive.hostTools.pipe(
    Layer.provide(
      Layer.effect(HostToolExecutor, makeHostTools.pipe(Effect.map((execute) => ({ execute })))),
    ),
  ),
  ApplicationOperationsLive.tools,
).pipe(Layer.provideMerge(hostApplications));
const sourcesGraph = HostKernel.live.pipe(Layer.provideMerge(hostTools));
);
/** A Space serves only channels the process routes, so routing starts once every route exists. */
const spaces = SpacesApplicationLive.live.pipe(Layer.provideMerge(RendererIngressLive.live));
const applicationGraph = Layer.mergeAll(windowsTrayIntegrationLive, spaces, phone).pipe(
  Layer.provideMerge(sourcesGraph),
  Layer.provide(CodexConversationPeerRuntime.live),
  Layer.provideMerge(shellEnvironment),
  Layer.provideMerge(
    codexVisualizationStateLive.pipe(Layer.provideMerge(profilePersistedAtomsLive)),
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
  | CodexComposerPredictionError
  | MainApplicationError,
  | SpacePageFileHosts
  | ElectronApp
  | ApplicationSettings
  | TemporaryAssets
  | ElectronDesktop
  | ElectronIpc
  | ElectronSpaceIpc
  | ElectronSyncIpc
  | ElectronSessionHost
  | ElectronWindowHost
  | FileSystem.FileSystem
  | BrowserProfileHelperPlatform
  | MainConfig
  | NativeNotificationAuthorization
  | MainCleanup
  | MainShutdown
  | ScopedCallbackRuntime
  | TerminalSessions
  | TerminalRuntimeMap
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | AppProtocolRuntime.AppProtocolRuntime
  | WindowRuntime
  | WindowsTrayRuntime
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
        const hostKernel = yield* HostKernel.HostKernel;
          messages: yield* MemberMessages,
          attachments: yield* ChatAttachments,
          settings: yield* ApplicationSettings,
          chats: yield* ChatSearch,
        const projectionDelivery = yield* ProjectionDeliveryRuntime;
        const coreEventHub = yield* CoreEventHub;
        const reminderScheduler = yield* ReminderSchedulerRuntime;
        const sessionReminders = yield* SessionReminderRuntime;
        const storeSchedulers = yield* StoreAdministrationSchedulerRuntime;
        const projectWorkspace = yield* ProjectWorkspace;
        const browser = yield* BrowserApplication;
        const executionHosts = yield* ExecutionHostRuntime;
        const appUpdates = yield* AppUpdateRuntime;
        const windowsTray = yield* WindowsTrayRuntime;
        const trayIntegration = yield* WindowsTrayIntegration;
        const shutdown = yield* MainShutdown;
        const applicationWindows = yield* ApplicationWindowRuntime;
        const deepLinks = yield* DeepLinkRuntime;
        const sidebarSync = yield* CodexSidebarSyncRuntime;
        const managedWorktreeRetention = yield* ManagedWorktreeRetentionRuntime;
        const threadHandoffRuntime = yield* CodexThreadHandoffRuntime;
        yield* threadHandoffRuntime.prepareRecovery.pipe(
          Effect.mapError((cause) => runtimeError("handoff-recovery-protection", cause)),
        );
        const terminalEvents = yield* terminals.subscribe;
        yield* terminalEvents.pipe(
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
        yield* deepLinks
          .extractFromArgv(config.argv)
          .pipe(Effect.catch((cause) => reportSpaceLinkFailure(cause).pipe(Effect.as(null))));
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
          const launch = authority.initialLaunch;
          if (!launch)
            return yield* runtimeError(
              "personal-core",
              new Error("Personal Space must own its local Core"),
            );
          applicationLogger.info("Native Core authority ready", {
            ...launch.timings,
            artifactValidationMs: Math.round(launch.timings.artifactValidationMs),
            connectMs: Math.round(launch.timings.connectMs),
            selectionMs: Math.round(launch.timings.selectionMs),
            totalMs: Math.round(launch.timings.totalMs),
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
          yield* deepLinks.markReady.pipe(Effect.catch(reportSpaceLinkFailure));
          yield* hostKernel.synchronize.pipe(
            Effect.mapError((cause) => runtimeError("synchronize-automations", cause)),
          );
          yield* managedWorktreeRetention.request;
          yield* Effect.all(
            [
              reminderScheduler.activate({
                openReminder: (payload) =>
                  applicationWindows.sendReminderOpen({
                    ...payload,
                    spaceId: authority.identity.libraryId,
                  }),
              }),
              sessionReminders.activate,
              hostKernel.activate,
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
        yield* windowsTray.markApplicationReady;
        applicationLogger.info("Desktop app initialization finished", {
          durationMs: Math.round(performance.now() - initializationStartedAt),
        });
        yield* appUpdates.markApplicationReady;

        let finishUpdate: (() => void | Promise<void>) | null = null;
        const application = MainApplication.of({
          activate: Effect.sync(applicationWindows.focusLast),
          confirmQuit: trayIntegration.confirmQuit,
          handleBootstrapEvent: (event) => {
            if (event.type === "open-url") {
              return deepLinks
                .handle(event.url)
                .pipe(Effect.catch(reportSpaceLinkFailure), Effect.asVoid);
            }
            if (isWindowsStartupActivation(config.platform, event.argv)) return Effect.void;
            return deepLinks.extractFromArgv(event.argv).pipe(
              Effect.catch((cause) => reportSpaceLinkFailure(cause).pipe(Effect.as(null))),
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
          prepareShutdown: Effect.gen(function* () {
            yield* applicationWindows.prepareQuit;
            const reason = yield* shutdown.awaitRequest;
            if (reason._tag === "UserQuit" || reason._tag === "UpdateInstall") {
              finishUpdate = yield* appUpdates.prepareQuit;
            }
          }),
          completeShutdown: Effect.promise(async () => {
            try {
              await finishUpdate?.();
            } catch (error) {
              applicationLogger.error("Could not install app update", { error });
            }
          }),
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
    | CodexComposerPredictionError
    | MainApplicationError,
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

/** Keeps the pre-Core shell Scope alive while the full authority graph acquires. */
export const productionLive = live.pipe(
  Layer.catch(startupFailureLive),
  Layer.provideMerge(ApplicationStateLive.live),
  Layer.provideMerge(TerminalRuntimeLive.live),
);
