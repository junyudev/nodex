import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import type { IpcMainInvokeEvent } from "electron";
import type { BrowserSidebarTabSnapshot } from "../../../shared/browser-sidebar";
import { MainConfig } from "../../app/MainConfig";
import { BrowserState } from "../../browser-application/BrowserState";
import {
  BrowserApplication,
  type BrowserProjection,
} from "../../browser-application/BrowserApplication";
import { make as makeBrowserSidebarEventHub } from "../../browser/BrowserSidebarEventHub";
import { makeBrowserRuntimeRegistry } from "../../browser/browser-runtime-registry";
import { makeBrowserPageEmulationRuntimeUnsafe } from "../../browser/browser-page-emulation";
import { makeBrowserEarlyPageRestoreRuntime } from "../../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserWebContentsListenerRuntime } from "../../browser/BrowserWebContentsListenerRuntime";
import { BrowserPresentationRuntime } from "../../host-runtime/BrowserPresentationRuntime";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { browserElectronPlatform } from "../../platform/electron/BrowserElectronPlatform";
import { WindowSessionCatalog } from "../../window-runtime/WindowSessionCatalog";
import { ProfileAssets } from "../../local-store/ProfileAssets";
import { makeProfileAssets } from "../../local-store/assets";
import { live } from "./BrowserSidebarIpc";

type Handler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, unknown>;

it.effect(
  "registers and releases Browser sidebar ingress and projections with the Main Scope",
  () =>
    Effect.gen(function* () {
      const handlers = new Map<string, Handler>();
      const ipc = ElectronIpc.of({
        handle: (channel, handler) =>
          Effect.acquireRelease(
            Effect.sync(() => handlers.set(channel, handler as Handler)),
            () => Effect.sync(() => handlers.delete(channel)),
          ).pipe(Effect.asVoid),
        on: () => Effect.void,
      });
      const scope = yield* Scope.make();
      const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
      const events = yield* makeBrowserSidebarEventHub.pipe(
        Effect.provideService(Scope.Scope, scope),
      );
      const browser = new BrowserState({
        earlyPageRestores:
          yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>().pipe(
            Effect.provideService(Scope.Scope, scope),
          ),
        electron: browserElectronPlatform,
        events,
        runtimeRegistry: makeBrowserRuntimeRegistry(),
        saveBrowserImage: () => {
          throw new Error("Unexpected browser image save");
        },
        fork: (effect) => void runBackground(effect),
        pageEmulation: makeBrowserPageEmulationRuntimeUnsafe(),
        siteStatus: { cachedCommentModeBlocked: () => null },
        webContentsListeners: yield* makeBrowserWebContentsListenerRuntime.pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      });
      const projection: BrowserProjection = {
        admitLocalServerThumbnail: (input) => browser.admitLocalServerThumbnail(input),
        getBrowserUseState: () => browser.getBrowserUseStateSnapshot(),
        getState: () => browser.getStateSnapshot(),
        getTab: (identity) => browser.getTabSnapshot(identity),
        getWebContents: (identity) => browser.getWebContentsForTab(identity),
        hasPresentedSurfaceForThread: (threadId) =>
          browser.hasPresentedBrowserUseSurfaceForThread(threadId),
        isBrowserUseIdentity: (identity) => browser.isBrowserUseIdentity(identity),
        listPendingPresentations: (scopeId) =>
          browser.listPendingBrowserUsePresentationRequests(scopeId),
        setDownloadActive: (identity, activeDownload) =>
          browser.setDownloadActive(identity, activeDownload),
      };
      const application = BrowserApplication.of({
        events,
        history: {} as never,
        localServers: { updates: Stream.empty } as never,
        localServerThumbnail: {} as never,
        pages: {} as never,
        projection,
        webviewDestroyed: browser.handleWebviewDestroyed.bind(browser),
        webviewHostCreated: browser.handleWebviewHostCreated.bind(browser),
      } as unknown as BrowserApplication["Service"]);
      yield* Layer.buildWithScope(
        live.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(
                BrowserPresentationRuntime,
                BrowserPresentationRuntime.of({
                  applyCommand: (command, context) =>
                    browser.handleCommand(command, context).pipe(Effect.orDie),
                  clearBrowsingData: (kind) =>
                    kind === "downloads"
                      ? Effect.succeed({ ok: true })
                      : browser.clearBrowsingData(kind),
                }),
              ),
              Layer.succeed(BrowserApplication, application),
              Layer.succeed(ElectronIpc, ipc),
              Layer.succeed(
                ProfileAssets,
                ProfileAssets.of(makeProfileAssets({ assetsRootPath: "/tmp/nodex-test/assets" })),
              ),
              Layer.succeed(
                ElectronWindowHost,
                ElectronWindowHost.of({
                  all: Effect.succeed([]),
                  destroyAll: Effect.void,
                  fromWebContents: () => Effect.succeed(null),
                  onCreated: () => Effect.void,
                }),
              ),
              Layer.succeed(
                MainConfig,
                MainConfig.of({
                  assistantStreamingDebug: false,
                  appVersion: "test",
                  arch: "arm64",
                  argv: [],
                  composerAppshotHelperPath: null,
                  documentsPath: "/tmp/Documents",
                  environment: {},
                  environmentPath: null,
                  homeDirectory: "/tmp",
                  initialProjectsDirectory: null,
                  isDefaultApp: false,
                  isPackaged: false,
                  nodexHome: "/tmp/nodex-test",
                  profileSettingsPath: "/tmp/nodex-test/config.toml",
                  platform: "darwin",
                  profileId: "test",
                  projectRootPath: "/repo",
                  rendererUrl: "http://localhost:5173",
                  resourcesPath: "/resources",
                  runtimeBinaryPath: "/electron",
                }),
              ),
              Layer.succeed(
                WindowSessionCatalog,
                WindowSessionCatalog.of({ resolveForWebContents: () => Effect.succeed(null) }),
              ),
            ),
          ),
        ),
        scope,
      );

      assert.deepEqual([...handlers.keys()].sort(), [
        "browser-annotation-capture-evidence",
        "browser-browsing-data-clear",
        "browser-history-delete",
        "browser-history-list",
        "browser-local-server-thumbnail",
        "browser-sidebar-command",
        "browser-sidebar-runtime-snapshot",
        "browser-sidebar-webview-destroyed",
        "browser-sidebar-webview-host-created",
      ]);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual(handlers.size, 0);
    }),
);
