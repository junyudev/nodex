import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BrowserApplication } from "../browser-application/BrowserApplication";
import { ChatGptDesktop } from "../codex-application/ChatGptDesktop";
import { CodexAccount } from "../codex-application/CodexAccount";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CodexConnection } from "../codex-application/CodexConnection";
import { CodexRendererConversationCoordinator } from "../codex-application/CodexRendererConversationCoordinator";
import { CodexMedia, live as codexMediaLive } from "../codex-application/CodexMedia";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { resolveBundledElectronPreload } from "../electron-preload-path";
import {
  ComputerUseSettingsRuntime,
  live as computerUseSettingsRuntimeLive,
} from "../host-runtime/ComputerUseSettingsRuntime";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import {
  StructuralClipboardRuntime,
  live as structuralClipboardRuntimeLive,
} from "../host-runtime/StructuralClipboardRuntime";
import { AppUpdateRuntime, live as appUpdateRuntimeLive } from "../host-runtime/AppUpdateRuntime";
import {
  ApplicationHostRuntime,
  ApplicationHostRuntimeError,
  live as applicationHostRuntimeLive,
} from "../host-runtime/ApplicationHostRuntime";
import {
  ApplicationMenuRuntime,
  live as applicationMenuRuntimeLive,
} from "../host-runtime/ApplicationMenuRuntime";
import {
  ComposerAppshotRuntime,
  live as composerAppshotRuntimeLive,
} from "../host-runtime/ComposerAppshotRuntime";
import * as DatabaseNotifierRuntime from "../host-runtime/DatabaseNotifierRuntime";
import {
  DesktopNotificationRuntime,
  live as desktopNotificationRuntimeLive,
} from "../host-runtime/DesktopNotificationRuntime";
import { DeepLinkRuntime, live as deepLinkRuntimeLive } from "../host-runtime/DeepLinkRuntime";
import { DictationRuntime, live as dictationRuntimeLive } from "../host-runtime/DictationRuntime";
import {
  McpAppSandboxRuntime,
  live as mcpAppSandboxRuntimeLive,
} from "../host-runtime/McpAppSandboxRuntime";
import {
  RemoteHostedPipRuntime,
  live as remoteHostedPipRuntimeLive,
} from "../host-runtime/RemoteHostedPipRuntime";
import {
  RendererClientRuntime,
  live as rendererClientRuntimeLive,
} from "../host-runtime/RendererClientRuntime";
import { getCommandKeymapState } from "../local-store/config";
import { getLogger } from "../logging/logger";
import { LibraryModule } from "../library-application/LibraryModule";
import {
  NodexAgentAuthorizationRuntime,
  live as nodexAgentAuthorizationRuntimeLive,
} from "../codex-application/NodexAgentAuthorizationRuntime";
import { NodexAgentResourceAccess } from "../nodex-agent-application/NodexAgentResourceAccess";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import {
  ElectronClipboard,
  live as electronClipboardLive,
} from "../platform/electron/ElectronClipboard";
import { ElectronIpc } from "../platform/electron/ElectronIpc";
import { ElectronPrivacy, live as electronPrivacyLive } from "../platform/electron/ElectronPrivacy";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import * as ElectronNet from "../platform/electron/ElectronNet";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import {
  ApplicationWindowRuntime,
  live as applicationWindowRuntimeLive,
} from "../window-runtime/ApplicationWindowRuntime";
import { ApplicationWindowShellRuntime } from "../window-runtime/ApplicationWindowShellRuntime";
import { ApplicationInitializationRuntime } from "../host-runtime/ApplicationInitializationRuntime";
import * as WindowSessionCatalog from "../window-runtime/WindowSessionCatalog";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import { live as windowShutdownLive, WindowShutdown } from "../window-runtime/WindowShutdown";
import { MainConfig } from "./MainConfig";
import { MainCleanup } from "./MainCleanup";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";

const appUpdates = appUpdateRuntimeLive;
const desktopNotifications = desktopNotificationRuntimeLive;
const rendererClients = rendererClientRuntimeLive();
const nodexAgentAuthorization = nodexAgentAuthorizationRuntimeLive.pipe(
  Layer.provideMerge(rendererClients),
);
const privacy = electronPrivacyLive;
const dictation = dictationRuntimeLive({
  preloadPath: resolveBundledElectronPreload(__dirname, "global-dictation.js"),
}).pipe(Layer.provideMerge(Layer.mergeAll(privacy, rendererClients)));
const databaseNotifier = DatabaseNotifierRuntime.live;
const structuralClipboard = structuralClipboardRuntimeLive.pipe(
  Layer.provideMerge(Layer.merge(electronClipboardLive, rendererClients)),
);
const mcpAppSandbox = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return mcpAppSandboxRuntimeLive({
      allowLocalDevelopment: !config.isPackaged,
      guestPreloadPath: resolveBundledElectronPreload(__dirname, "mcp-app-sandbox-guest.js"),
      logger: getLogger({ subsystem: "mcp-app-sandbox" }),
      platform: config.platform as NodeJS.Platform,
    });
  }),
);
const codexMedia = codexMediaLive.pipe(Layer.provideMerge(dictation));
const remoteHostedPip = Layer.unwrap(
  Effect.gen(function* () {
    const browser = yield* BrowserApplication;
    const config = yield* MainConfig;
    const electron = yield* ElectronApp;
    const userDataPath = yield* electron.userDataPath;
    return remoteHostedPipRuntimeLive({
      browserSidebarEvents: browser.events,
      isThreadSurfacePresented: browser.projection.hasPresentedSurfaceForThread,
      platform: config.platform as NodeJS.Platform,
      preferenceFilePath: `${userDataPath}/remote-hosted-pip-preferences.json`,
    });
  }),
);
const computerUseSettings = computerUseSettingsRuntimeLive.pipe(
  Layer.provideMerge(remoteHostedPip),
);

const applicationWindows = Layer.unwrap(
  Effect.gen(function* () {
    const appUpdates = yield* AppUpdateRuntime;
    const browser = yield* BrowserApplication;
    const initialization = yield* ApplicationInitializationRuntime;
    const rendererConversations = yield* CodexRendererConversationCoordinator;
    const desktopNotifications = yield* DesktopNotificationRuntime;
    const config = yield* MainConfig;
    const mcpAppSandbox = yield* McpAppSandboxRuntime;
    const rendererClients = yield* RendererClientRuntime;
    const shell = yield* ApplicationWindowShellRuntime;
    const windows = yield* WindowRuntime;
    return applicationWindowRuntimeLive({
      appUpdates,
      browser: browser.guest,
      rendererConversations,
      desktopNotifications,
      mcpAppSandbox,
      platform: config.platform as NodeJS.Platform,
      rendererClients,
      rendererLoaded: initialization.rendererLoaded,
      shell,
      windows,
    });
  }),
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      appUpdates,
      desktopNotifications,
      rendererClients,
      mcpAppSandbox,
      composerAppshotRuntimeLive,
      windowShutdownLive(),
    ),
  ),
);

const applicationMenu = Layer.unwrap(
  Effect.gen(function* () {
    const appUpdates = yield* AppUpdateRuntime;
    const applicationWindows = yield* ApplicationWindowRuntime;
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const windows = yield* WindowRuntime;
    return applicationMenuRuntimeLive({
      checkForUpdates: appUpdates.check,
      environmentPath: config.environmentPath ?? undefined,
      initialCommandKeymap: getCommandKeymapState(),
      isPackaged: config.isPackaged,
      platform: config.platform as NodeJS.Platform,
      requestNewWindow: applicationWindows.requestNew,
      resourcesPath: config.resourcesPath,
      showMessage: desktop.showMessage,
      windows,
    });
  }),
).pipe(Layer.provideMerge(applicationWindows));

const windowSessions = Layer.unwrap(
  Effect.gen(function* () {
    const windows = yield* WindowRuntime;
    return WindowSessionCatalog.fromResolver((webContentsId) =>
      windows.resolveSessionId(webContentsId),
    );
  }),
);
const deepLinks = Layer.unwrap(
  Effect.gen(function* () {
    const applicationWindows = yield* ApplicationWindowRuntime;
    const windows = yield* WindowRuntime;
    return deepLinkRuntimeLive({ focusWindow: applicationWindows.focusLast, windows });
  }),
).pipe(Layer.provideMerge(applicationWindows));

/** Physical Window resources and their bounded, scope-owned shutdown policy. */
export const live: Layer.Layer<
  | AppUpdateRuntime
  | ApplicationHostRuntime
  | ApplicationMenuRuntime
  | ApplicationWindowRuntime
  | ComposerAppshotRuntime
  | ComputerUseSettingsRuntime
  | CodexMedia
  | DatabaseNotifierRuntime.DatabaseNotifierRuntime
  | DesktopNotificationRuntime
  | DeepLinkRuntime
  | DictationRuntime
  | ElectronPrivacy
  | ElectronClipboard
  | McpAppSandboxRuntime
  | NodexAgentAuthorizationRuntime
  | RemoteHostedPipRuntime
  | RendererClientRuntime
  | StructuralClipboardRuntime
  | WindowSessionCatalog.WindowSessionCatalog
  | WindowShutdown,
  ApplicationHostRuntimeError,
  | ApplicationInitializationRuntime
  | ApplicationWindowShellRuntime
  | BrowserApplication
  | ChatGptDesktop
  | CodexAccount
  | CodexApplicationEventHub
  | CodexConnection
  | CodexGateway
  | CodexRendererConversationCoordinator
  | CoreAuthority
  | DesktopToolRuntime
  | ElectronApp
  | ElectronDesktop
  | ElectronIpc
  | ElectronSessionHost
  | ElectronWindowHost
  | ElectronNet.ElectronNet
  | LibraryModule
  | MainCleanup
  | MainConfig
  | NodexAgentResourceAccess
  | ProjectWorkspace
  | ScopedCallbackRuntime
  | WindowRuntime
> = Layer.mergeAll(
  applicationHostRuntimeLive(),
  applicationMenu,
  computerUseSettings,
  codexMedia,
  databaseNotifier,
  deepLinks,
  dictation,
  nodexAgentAuthorization,
  structuralClipboard,
  windowSessions,
);
