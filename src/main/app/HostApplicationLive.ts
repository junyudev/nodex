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
import { ProfileAssets } from "../local-store/ProfileAssets";
import { ChatGptDesktop, live as chatGptDesktopLive } from "../codex-application/ChatGptDesktop";
import {
  ComposerExternalSuggestions,
  live as composerExternalSuggestionsLive,
} from "../codex-application/ComposerExternalSuggestions";
import {
  CodexGitMessageGeneration,
  live as codexGitMessageGenerationLive,
} from "../codex-application/CodexGitMessageGeneration";
import {
  ExecutionHostConfiguration,
  ManagedWorktreeConfiguration,
  live as executionHostConfigurationLive,
} from "../codex-application/ExecutionHostConfiguration";
import {
  ExecutionHostRuntime,
  ExecutionHostRuntimeError,
  live as executionHostRuntimeLive,
} from "../codex-application/ExecutionHostRuntime";
import {
  ManagedWorktreeRuntime,
  live as managedWorktreeRuntimeLive,
} from "../codex-application/ManagedWorktreeRuntime";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { GitActions, live as gitActionsLive } from "../git-application/GitActions";
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
import {
  GitActionOperationRuntime,
  live as gitActionOperationRuntimeLive,
} from "../host-runtime/GitActionOperationRuntime";
import { GitWorkerRuntime, live as gitWorkerRuntimeLive } from "../host-runtime/GitWorkerRuntime";
import {
  localLive as localWorktreeWorkerRuntimeLive,
  WorktreeWorkerRuntime,
} from "../host-runtime/WorktreeWorkerRuntime";
import { getLogger } from "../logging/logger";
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
import { CodexPlatform } from "./CodexApplicationLive";

const logger = getLogger({ subsystem: "app" });

const chatGpt = chatGptDesktopLive.pipe(Layer.provideMerge(ElectronNet.live));
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
    const electron = yield* ElectronApp;
    const userDataPath = yield* electron.userDataPath;
    return browserProfileRuntimeLive({
      environment: config.environment,
      homeDirectory: config.homeDirectory,
      isPackaged: config.isPackaged,
      nodexHome: config.nodexHome,
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
    return chromeControlRuntimeLive({
      browserRuntime: codex.runtime.browserRuntime,
      homeDirectory: config.homeDirectory,
      peerAuthorizationMode: codex.runtime.source === "bundled" ? "packaged" : "development",
      platform: config.platform as NodeJS.Platform,
      runtimeStateHome: codex.runtimeStateHome,
    });
  }),
);
const browserUse = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    return browserUseRuntimeLive({
      appVersion: config.appVersion,
      browserRuntime: codex.runtime.browserRuntime,
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
      browserRuntime: codex.runtime.browserRuntime,
      peerAuthorizationMode: codex.runtime.source === "bundled" ? "packaged" : "development",
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
    const browserRuntime = codex.runtime.browserRuntime;
    return remoteHostedPipNativePlatformLive({
      expectedExports:
        browserRuntime.status === "available"
          ? browserRuntime.bundle.manifest.capabilities.nativePip.exports.expectedExports
          : [],
      platform: config.platform as NodeJS.Platform,
      verifiedAddonPath:
        browserRuntime.status === "available" ? browserRuntime.bundle.paths.skyNativeAddon : null,
    });
  }),
);
const desktopTools = Layer.unwrap(
  Effect.gen(function* () {
    const codex = yield* CodexPlatform;
    return desktopToolRuntimeLive({
      browserRuntime: codex.runtime.browserRuntime,
      runtimeStateHome: codex.runtimeStateHome,
    });
  }),
).pipe(Layer.provideMerge(Layer.merge(browserPresentation, computerUse)));

const localWorktreeWorker = localWorktreeWorkerRuntimeLive({
  hostId: "local",
  workerPath: `${__dirname}/worktree-worker.js`,
  onInfrastructureError: (error) => {
    logger.error("Worktree worker infrastructure failed", { error: error.message });
  },
});
const executionHosts = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    return executionHostRuntimeLive({
      runtimeStateHome: codex.runtimeStateHome,
      nodexHome: config.nodexHome,
      remoteWorktreeWorkerBundlePath: `${__dirname}/remote-worktree-worker.cjs`,
    });
  }),
).pipe(Layer.provideMerge(Layer.mergeAll(localWorktreeWorker, executionHostConfigurationLive)));
const managedWorktrees = managedWorktreeRuntimeLive.pipe(Layer.provideMerge(executionHosts));

const gitWorker = gitWorkerRuntimeLive({
  workerPath: `${__dirname}/git-worker.js`,
  onInfrastructureError: (error, context) => {
    logger.error("Git worker infrastructure failed", {
      epoch: context.epoch,
      error: error.message,
      phase: context.phase,
    });
  },
  onPerformanceOperation: (metric) => logger.debug("Git worker operation", metric),
});
const gitMessageGeneration = codexGitMessageGenerationLive;
const gitActions = gitActionsLive.pipe(
  Layer.provideMerge(
    Layer.mergeAll(gitWorker, gitActionOperationRuntimeLive, gitMessageGeneration),
  ),
);

/** Browser, execution-host, worktree and Git resource families owned by the Main Scope. */
export const live: Layer.Layer<
  | ElectronNet.ElectronNet
  | ChatGptDesktop
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
  | ManagedWorktreeRuntime
  | GitWorkerRuntime
  | GitActionOperationRuntime
  | CodexGitMessageGeneration
  | GitActions,
  | BrowserApplicationError
  | BrowserProfileRuntimeError
  | BrowserUseRuntimeError
  | ExecutionHostRuntimeError,
  | CodexGateway
  | ApplicationSettings
  | ProfileAssets
  | CodexPlatform
  | MainConfig
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
  managedWorktrees,
  gitActions,
  externalSuggestions,
);
