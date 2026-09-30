import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { BROWSER_SIDEBAR_PARTITION } from "../../shared/browser-sidebar";
import type { BrowserDownloadsSnapshot } from "../../shared/browser-download";
import {
  BrowserApplication,
  type BrowserProjection,
} from "../browser-application/BrowserApplication";
import {
  makeBrowserDownloadRuntime,
  type BrowserDownloadRuntime,
} from "../browser/browser-download-service";
import {
  makeBrowserCredentialRuntime,
  type BrowserCredentialRuntime,
} from "../browser/browser-credential-service";
import { BrowserCredentialVault } from "../browser/browser-credential-vault";
import {
  makeBrowserExtensionsRuntime,
  type BrowserExtensionsRuntime,
} from "../browser/browser-extensions-provider";
import {
  makeBrowserLocalServerPreferencesRuntime,
  type BrowserLocalServerPreferencesRuntime,
} from "../browser/browser-local-server-preferences";
import {
  BrowserProfileHelperPlatform,
  resolveBrowserProfileHelperExecutable,
} from "../browser/browser-profile-helper-client";
import {
  makeBrowserProfileImportRuntime,
  type BrowserProfileImportRuntime,
} from "../browser/browser-profile-importer";
import {
  makeBrowserSiteInfoRuntime,
  type BrowserSiteInfoRuntime,
} from "../browser/browser-site-info-provider";
import {
  makeBrowserUsePolicyRuntime,
  type BrowserUsePolicyRuntime,
} from "../browser-use/browser-use-policy-store";
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";

export class BrowserProfileRuntimeError extends Schema.TaggedError<BrowserProfileRuntimeError>()(
  "BrowserProfileRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class BrowserProfileRuntime extends Context.Service<
  BrowserProfileRuntime,
  {
    readonly download: BrowserDownloadRuntime;
    readonly credentials: BrowserCredentialRuntime;
    readonly extensions: BrowserExtensionsRuntime;
    readonly localServerPreferences: BrowserLocalServerPreferencesRuntime;
    readonly policy: BrowserUsePolicyRuntime;
    readonly profileImport: BrowserProfileImportRuntime;
    readonly siteInfo: BrowserSiteInfoRuntime;
  }
>()("nodex/main/host-runtime/BrowserProfileRuntime") {}

export interface BrowserProfileRuntimeOptions {
  readonly environment: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
  readonly isPackaged: boolean;
  readonly nodexHome: string;
  readonly projectRootPath: string;
  readonly platform: string;
  readonly resourcesPath: string;
  readonly runtimeStateHome: string;
  readonly userDataPath: string;
}

const downloadKey = (input: {
  readonly browserConversationId: string;
  readonly browserViewScopeId: string;
  readonly browserTabId: string;
}) => `${input.browserConversationId}\0${input.browserViewScopeId}\0${input.browserTabId}`;

const projectDownloadState = (
  browser: BrowserProjection,
  snapshot: BrowserDownloadsSnapshot,
): void => {
  const activeDownloadKeys = new Set(
    snapshot.downloads
      .filter(
        (download) =>
          download.status === "starting" ||
          download.status === "progressing" ||
          download.status === "paused",
      )
      .map(downloadKey),
  );
  for (const tab of browser.getState().tabs) {
    browser.setDownloadActive(tab, activeDownloadKeys.has(downloadKey(tab)));
  }
};

export const live = (
  options: BrowserProfileRuntimeOptions,
): Layer.Layer<
  BrowserProfileRuntime,
  BrowserProfileRuntimeError,
  | FileSystem.FileSystem
  | BrowserProfileHelperPlatform
  | ElectronApp
  | ElectronDesktop
  | ElectronSessionHost
  | ElectronWindowHost
  | BrowserApplication
  | ScopedCallbackRuntime
> =>
  Layer.effect(
    BrowserProfileRuntime,
    Effect.gen(function* () {
      const app = yield* ElectronApp;
      const browser = yield* BrowserApplication;
      const callbacks = yield* ScopedCallbackRuntime;
      const desktop = yield* ElectronDesktop;
      const profileHelperPlatform = yield* BrowserProfileHelperPlatform;
      const sessions = yield* ElectronSessionHost;
      const windows = yield* ElectronWindowHost;
      const downloadsPath = yield* app.downloadsPath;
      const browserSession = yield* sessions.fromPartition(BROWSER_SIDEBAR_PARTITION);
      const logger = getLogger({ component: "browser-profile-runtime" });
      const policy = yield* makeBrowserUsePolicyRuntime(
        `${options.runtimeStateHome}/browser/config.toml`,
      ).pipe(
        Effect.mapError(
          (cause) => new BrowserProfileRuntimeError({ operation: "initialize-policy", cause }),
        ),
      );
      const credentialVault = new BrowserCredentialVault({
        filePath: `${options.nodexHome}/secrets/browser-credentials.v1.json`,
        encryption: {
          isAvailable: () => desktop.safeStorage.isEncryptionAvailable(),
          encryptString: (plaintext) => desktop.safeStorage.encryptString(plaintext),
          decryptString: (ciphertext) => desktop.safeStorage.decryptString(ciphertext),
        },
      });
      const credentials = yield* makeBrowserCredentialRuntime({
        vault: credentialVault,
        resolveGuest: (identity) => browser.projection.getWebContents(identity),
        resolveGuestIdentity: (webContentsId) => browser.guest.getIdentity(webContentsId),
        resolveGuestOwner: (webContentsId) => browser.guest.getOwnerWebContentsId(webContentsId),
      });
      const localServerPreferences = yield* makeBrowserLocalServerPreferencesRuntime(
        `${options.userDataPath}/browser-local-server-preferences.json`,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new BrowserProfileRuntimeError({
              operation: "initialize-local-server-preferences",
              cause,
            }),
        ),
      );
      const profileHelper = profileHelperPlatform.make({
        executablePath: resolveBrowserProfileHelperExecutable({
          environment: options.environment,
          isPackaged: options.isPackaged,
          resourcesPath: options.resourcesPath,
          repositoryRoot: options.projectRootPath,
        }),
      });
      const profileImport = yield* makeBrowserProfileImportRuntime({
        cookieStore: browserSession.cookies,
        credentials,
        helper: profileHelper,
        homeDirectory: options.homeDirectory,
        platform: options.platform,
      });
      const extensions = makeBrowserExtensionsRuntime(browserSession.extensions ?? null);
      const siteInfo = makeBrowserSiteInfoRuntime(
        { getTabSnapshot: browser.projection.getTab },
        browserSession.cookies,
      );

      const download = yield* makeBrowserDownloadRuntime({
        downloadsDirectory: downloadsPath,
        historyFilePath: `${options.userDataPath}/browser-downloads.json`,
        isAgentControlled: (identity) => browser.projection.isBrowserUseIdentity(identity),
        logger,
        onSnapshot: (snapshot) => {
          projectDownloadState(browser.projection, snapshot);
          callbacks.fork(
            windows.all.pipe(
              Effect.tap((all) =>
                Effect.sync(() =>
                  safeBroadcastToWindows(all, "browser-downloads-state", [snapshot]),
                ),
              ),
              Effect.asVoid,
            ),
          );
        },
        resolveIdentity: (webContentsId) => browser.guest.getIdentity(webContentsId),
        session: browserSession,
        shell: desktop.shell,
      }).pipe(
        Effect.mapError(
          (cause) => new BrowserProfileRuntimeError({ operation: "initialize-downloads", cause }),
        ),
      );
      return BrowserProfileRuntime.of({
        credentials,
        download,
        extensions,
        localServerPreferences,
        policy,
        profileImport,
        siteInfo,
      });
    }),
  );
