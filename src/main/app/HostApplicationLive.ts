import { loadMacBrowserPeer } from "../platform/electron/MacBrowserPeer";
import { readDefaultBrowserIdentity } from "../platform/electron/SystemDefaultBrowser";
import { HostShellEnvironment } from "../host-runtime/HostShellEnvironment";
import { matchesPinnedCodexAppServerIdentity } from "../codex/codex-runtime";
import { ExecutionNode } from "../../host/ExecutionNodeLive";
import path from "node:path";
import {
  WindowsDesktopTools,
  unsupportedWindowsDesktopTools,
} from "../platform/node/WindowsDesktopTools";
import { SkillFileMutationLane } from "../host-runtime/SkillFileMutationLane";
import { DatabaseNotifierRuntime } from "../host-runtime/DatabaseNotifierRuntime";
import { WebContentsDestructionSubscriptions } from "../platform/electron/WebContentsDestructionSubscriptions";
import { live as workspaceRuntimeLive } from "../../host/WorkspaceRuntimeLive";
import { live as standaloneSkillsLive } from "../platform/node/StandaloneSkillsNode";
import { PluginService, live as pluginServiceLive } from "../codex-application/PluginService";
import { PluginManager, live as pluginManagerLive } from "../codex-application/PluginManager";
import { PluginCatalogSource } from "../../host/agent-plugins/PluginCatalogSource";
import { makePluginCatalogCache } from "../../host/agent-plugins/PluginCatalogCache";
import { PluginNativeOperations } from "../codex-application/PluginNativeOperations";
import { ProjectWorkspace } from "../project-application/ProjectWorkspace";
import { AppProtocolRuntime } from "../host-runtime/AppProtocolRuntime";
import { CodexExecutionHostAuthState } from "../codex-runtime/CodexExecutionHostAuthState";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import {
  BrowserApplication,
  BrowserApplicationError,
  live as browserApplicationLive,
} from "../browser-application/BrowserApplication";
import { BrowserProfileHelperPlatform } from "../browser/browser-profile-helper-client";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { ChatGptDesktop, live as chatGptDesktopLive } from "../codex-application/ChatGptDesktop";
import { CodexAppServerCapabilities } from "../codex-runtime/CodexAppServerCapabilities";
import {
  CodexWorkspaceRouting,
  live as workspaceRoutingLive,
} from "../codex-runtime/CodexWorkspaceRouting";
import * as CodexSessionTransport from "../platform/node/CodexSessionTransport";
import {
  CodexAttachments,
  live as codexAttachmentsLive,
} from "../codex-application/CodexAttachments";
import {
  ComposerExternalSuggestions,
  live as composerExternalSuggestionsLive,
} from "../codex-application/ComposerExternalSuggestions";
import {
  ExecutionHostConfiguration,
  ManagedWorktreeConfiguration,
} from "../codex-application/ExecutionHostConfiguration";
import {
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
} from "../codex-application/ExecutionHostRuntime";
import { ManagedWorktreeRuntime } from "../codex-application/ManagedWorktreeRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import {
  BrowserPresentationRuntime,
  live as browserPresentationRuntimeLive,
} from "../host-runtime/BrowserPresentationRuntime";
import {
  BrowserProfileRuntime,
  BrowserProfileRuntimeError,
  live as browserProfileRuntimeLive,
} from "../host-runtime/BrowserProfileRuntime";
import {
  BrowserSiteStatusRuntime,
  live as browserSiteStatusRuntimeLive,
} from "../host-runtime/BrowserSiteStatusRuntime";
import {
  BrowserUseRuntime,
  BrowserUseRuntimeError,
  live as browserUseRuntimeLive,
} from "../host-runtime/BrowserUseRuntime";
import {
  ComputerUseRuntime,
  live as computerUseRuntimeLive,
} from "../host-runtime/ComputerUseRuntime";
import {
  ChromeControlRuntime,
  live as chromeControlRuntimeLive,
} from "../host-runtime/ChromeControlRuntime";
import {
  DesktopToolRuntime,
  live as desktopToolRuntimeLive,
} from "../host-runtime/DesktopToolRuntime";
import { GitWorkerRuntime } from "../host-runtime/GitWorkerRuntime";
import { WorktreeWorkerRuntime } from "../host-runtime/WorktreeWorkerRuntime";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { live as electronClipboardLive } from "../platform/electron/ElectronClipboard";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import * as ElectronNet from "../platform/electron/ElectronNet";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import {
  RemoteHostedPipNativePlatform,
  live as remoteHostedPipNativePlatformLive,
} from "../platform/electron/RemoteHostedPipNativePlatform";
import { ScopedCallbackRuntime } from "./ScopedCallbackRuntime";
import { MainConfig } from "./MainConfig";
import { CodexPlatform } from "../../host/ProviderPlatform";
import type { VerifiedBrowserRuntimeBundle } from "../codex/browser-runtime-bundle";

const workspaceRouting = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    const config = yield* MainConfig;
    const shell = yield* HostShellEnvironment;
    return workspaceRoutingLive({
      get browserRuntime() {
        return codex.desktopTools.browserRuntime;
      },
      // The primary account server has already attempted discovery. Keep routing's own
      // deadline for its authenticated exchange, including when recovery previously failed.
      environment: shell.latest.pipe(
        Effect.map((outcome) =>
          outcome && outcome.status !== "failed" ? outcome.environment : config.environment,
        ),
      ),
    });
  }),
).pipe(Layer.provide(CodexSessionTransport.nodeLive));
const chatGpt = chatGptDesktopLive.pipe(
  Layer.provideMerge(Layer.merge(ElectronNet.live, workspaceRouting)),
);
const plugins = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    const config = yield* MainConfig;
    return pluginManagerLive({
      homeDirectory: config.homeDirectory,
      runtimeStateHome: codex.runtimeStateHome,
      profileHome: config.nodexHome,
      // The effective account home links its plugin directory to the shared Codex home.
      codexHome: codex.accountHome.sharedHome,
    }).pipe(
      Layer.provide(
        standaloneSkillsLive({
          codexHome: codex.codexHome,
          environment: config.environment,
          bundledRepoRoot: `${config.resourcesPath}/skills`,
        }),
      ),
    );
  }),
).pipe(
  Layer.provideMerge(pluginServiceLive.pipe(Layer.provideMerge(chatGpt))),
  Layer.provideMerge(SkillFileMutationLane.live),
);
const browserSiteStatus = browserSiteStatusRuntimeLive.pipe(Layer.provideMerge(chatGpt));
const browserApplication = Layer.unwrap(
  Effect.gen(function* () {
    const electron = yield* ElectronApp;
    const userDataPath = yield* electron.userDataPath;
    return browserApplicationLive(userDataPath);
  }),
).pipe(Layer.provideMerge(Layer.merge(browserSiteStatus, electronClipboardLive)));
const browserProfile = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const electron = yield* ElectronApp;
    const userDataPath = yield* electron.userDataPath;
    return browserProfileRuntimeLive({
      environment: config.environment,
      homeDirectory: config.homeDirectory,
      isPackaged: config.isPackaged,
      nodexHome: config.nodexHome,
      runtimeStateHome: codex.runtimeStateHome,
      projectRootPath: config.projectRootPath,
      platform: config.platform,
      resourcesPath: config.resourcesPath,
      userDataPath,
    });
  }),
).pipe(Layer.provideMerge(browserApplication));
const chromeControl = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const platform = config.platform as NodeJS.Platform;
    return chromeControlRuntimeLive({
      architecture: config.arch,
      localAppData: Object.entries(config.environment).find(
        ([key]) => key.toUpperCase() === "LOCALAPPDATA",
      )?.[1],
      get browserRuntime() {
        return codex.desktopTools.browserRuntime;
      },
      windowsBrowserReady: codex.windowsDesktopTools?.ready,
      componentBrowserReady:
        codex.desktopTools.browserRuntimeActivation?.source === "component" &&
        codex.desktopTools.browserRuntime.status !== "available"
          ? codex.desktopTools.browserRuntimeActivation.available.pipe(Effect.asVoid)
          : undefined,
      ...(platform === "darwin" ? loadMacBrowserPeer(config) : undefined),
      registration: config.chromeHostRegistration ?? { kind: "disabled" },
      windowsInstallationDirectory:
        config.isPackaged && platform === "win32" ? path.dirname(config.resourcesPath) : undefined,
      peerAuthorizationMode: config.isPackaged ? "packaged" : "development",
      platform,
      runtimeStateHome: codex.runtimeStateHome,
    }).pipe(
      Layer.provide(
        Layer.succeed(
          WindowsDesktopTools,
          codex.windowsDesktopTools?.native ?? unsupportedWindowsDesktopTools,
        ),
      ),
    );
  }),
);
const browserUse = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    return browserUseRuntimeLive({
      appVersion: config.appVersion,
      readDefaultBrowserIdentity,
      get browserRuntime() {
        return codex.desktopTools.browserRuntime;
      },
      windows: codex.windowsDesktopTools
        ? {
            ...codex.windowsDesktopTools,
            runtimeStateHome: codex.runtimeStateHome,
          }
        : undefined,
      environment: config.environment,
      isPackaged: config.isPackaged,
      platform: config.platform as NodeJS.Platform,
    });
  }),
).pipe(Layer.provideMerge(Layer.merge(browserProfile, chromeControl)));
const browserPresentation = browserPresentationRuntimeLive.pipe(Layer.provideMerge(browserUse));
const externalSuggestions = composerExternalSuggestionsLive.pipe(Layer.provideMerge(chatGpt));

const computerUse = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const electron = yield* ElectronApp;
    const locale = yield* electron.locale;
    return computerUseRuntimeLive({
      windows: codex.windowsDesktopTools
        ? {
            tools: codex.windowsDesktopTools.native,
            environment: config.environment,
            ready: codex.windowsDesktopTools.ready,
          }
        : undefined,
      get browserRuntime() {
        return codex.desktopTools.browserRuntime;
      },
      peerAuthorizationMode: config.isPackaged ? "packaged" : "development",
      platform: config.platform as NodeJS.Platform,
      runtimeConfig: () => ({ locale }),
      runtimeStateHome: codex.runtimeStateHome,
    });
  }),
);
const remoteHostedPipNative = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const browserRuntime = codex.desktopTools.browserRuntime;
    const activation = codex.desktopTools.browserRuntimeActivation;
    const addonLocation = (bundle?: VerifiedBrowserRuntimeBundle) => ({
      expectedExports: bundle?.manifest.capabilities.nativePip?.exports.expectedExports ?? [],
      verifiedAddonPath: bundle?.paths.skyNativeAddon ?? null,
    });
    return remoteHostedPipNativePlatformLive({
      ...addonLocation(browserRuntime.status === "available" ? browserRuntime.bundle : undefined),
      activateAddon:
        browserRuntime.status === "unavailable" && activation?.source === "component"
          ? activation.available.pipe(Effect.map(addonLocation))
          : undefined,
      platform: config.platform as NodeJS.Platform,
    });
  }),
);
const desktopTools = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const nodeRuntime = yield* ExecutionNode;
    return desktopToolRuntimeLive({
      get browserRuntime() {
        return codex.desktopTools.browserRuntime;
      },
      codexDesktopToolsCompatible: () => {
        const installed = codex.package.current;
        return (
          !codex.usesExternalExecutable &&
          installed.status === "available" &&
          matchesPinnedCodexAppServerIdentity(
            installed.package.appServerIdentity,
            config.platform,
            config.arch,
          )
        );
      },
      platform: config.platform,
      windows: codex.windowsDesktopTools
        ? {
            jobLauncher: codex.windowsDesktopTools.coreExecutable,
            ready: codex.windowsDesktopTools.ready,
            environment: config.environment,
          }
        : undefined,
      nodeRuntime,
      isPackaged: config.isPackaged,
      projectRootPath: config.projectRootPath,
      resourcesPath: config.resourcesPath,
      runtimeStateHome: codex.runtimeStateHome,
      codexHome: codex.accountHome.effectiveHome,
    });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(browserPresentation, computerUse)));

const workspaceRuntime = Layer.unwrap(
  Effect.gen(function* () {
    const rendererLifecycle = yield* WebContentsDestructionSubscriptions;
    const nativeEndpoints = yield* CodexGateway;
    return workspaceRuntimeLive({ workerDirectory: __dirname, rendererLifecycle, nativeEndpoints });
  }),
).pipe(Layer.provide(WebContentsDestructionSubscriptions.live));
const attachments = codexAttachmentsLive.pipe(Layer.provideMerge(workspaceRuntime));

/** Agent Sessions receive the plugins Codex has installed, refreshed when plugin state changes. */
const pluginCatalog = Layer.effect(
  PluginCatalogSource,
  Effect.gen(function* () {
    const manager = yield* PluginManager;
    const codex = yield* CodexPlatform;
    return yield* makePluginCatalogCache({
      load: (projectId) =>
        codex.ordinaryPackageAfterStartupCheck.pipe(
          Effect.flatMap((current) =>
            current.status === "available" ? manager.loadCatalog(projectId) : Effect.succeed(null),
          ),
        ),
      invalidations: manager.catalogInvalidations,
    });
  }),
).pipe(Layer.provideMerge(plugins));

/** Browser, execution-host, worktree and Git resource families owned by the Main Scope. */
export const live: Layer.Layer<
  | ElectronNet.ElectronNet
  | ChatGptDesktop
  | PluginManager
  | PluginCatalogSource
  | SkillFileMutationLane
  | PluginService
  | CodexWorkspaceRouting
  | ComposerExternalSuggestions
  | BrowserSiteStatusRuntime
  | BrowserApplication
  | BrowserProfileRuntime
  | BrowserUseRuntime
  | BrowserPresentationRuntime
  | ComputerUseRuntime
  | RemoteHostedPipNativePlatform
  | ChromeControlRuntime
  | DesktopToolRuntime
  | WorktreeWorkerRuntime
  | ExecutionHostConfiguration
  | ManagedWorktreeConfiguration
  | ExecutionHostRuntime
  | CodexAttachments
  | ManagedWorktreeRuntime
  | GitWorkerRuntime,
  | BrowserApplicationError
  | BrowserProfileRuntimeError
  | BrowserUseRuntimeError
  | ExecutionHostRuntimeError,
  | CodexGateway
  | PluginNativeOperations
  | DatabaseNotifierRuntime
  | ProjectWorkspace
  | AppProtocolRuntime
  | CodexAppServerCapabilities
  | CodexExecutionHostAuthState
  | ApplicationSettings
  | TemporaryAssets
  | CodexPlatform
  | ExecutionNode
  | MainConfig
  | HostShellEnvironment
  | ScopedCallbackRuntime
  | ElectronApp
  | ElectronDesktop
  | ElectronSessionHost
  | ElectronWindowHost
  | FileSystem.FileSystem
  | BrowserProfileHelperPlatform
> = Layer.mergeAll(
  chromeControl,
  remoteHostedPipNative,
  desktopTools,
  attachments,
  externalSuggestions,
  pluginCatalog,
);
