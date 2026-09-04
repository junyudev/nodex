import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { Session } from "electron";
import type { BrowserSidebarTabSnapshot } from "../../shared/browser-sidebar";
import { BrowserState } from "../browser-application/BrowserState";
import {
  BrowserApplication,
  type BrowserProjection,
} from "../browser-application/BrowserApplication";
import { BrowserProfileHelperPlatform } from "../browser/browser-profile-helper-client";
import { makeBrowserRuntimeRegistry } from "../browser/browser-runtime-registry";
import { makeBrowserPageEmulationRuntimeUnsafe } from "../browser/browser-page-emulation";
import { makeBrowserEarlyPageRestoreRuntime } from "../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserWebContentsListenerRuntime } from "../browser/BrowserWebContentsListenerRuntime";
import { ElectronApp } from "../platform/electron/ElectronApp";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { ElectronSessionHost } from "../platform/electron/ElectronSessionHost";
import { ElectronWindowHost } from "../platform/electron/ElectronWindowHost";
import { browserElectronPlatform } from "../platform/electron/BrowserElectronPlatform";
import { layer as callbackLayer, ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import { BrowserProfileRuntime, live } from "./BrowserProfileRuntime";

class FakeBrowserSession extends EventEmitter {
  readonly cookies = {};
  readonly extensions = null;
}

it.layer(NodeServices.layer)("BrowserProfileRuntime", (it) => {
  it.effect("owns Browser Profile services and the download session listener", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-browser-profile-effect-"))),
      (root) =>
        Effect.gen(function* () {
          const browserSession = new FakeBrowserSession();
          const scope = yield* Scope.make();
          const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
          const browserSidebar = new BrowserState({
            earlyPageRestores:
              yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>().pipe(
                Effect.provideService(Scope.Scope, scope),
              ),
            electron: browserElectronPlatform,
            clipboard: { writeText: () => Effect.void, writeImage: () => Effect.void },
            events: { publish: () => undefined },
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
          const callbacksContext = yield* Layer.buildWithScope(callbackLayer, scope);
          const callbacks = Context.get(callbacksContext, ScopedCallbackRuntime);
          const projection: BrowserProjection = {
            admitLocalServerThumbnail: (input) => browserSidebar.admitLocalServerThumbnail(input),
            getBrowserUseState: () => browserSidebar.getBrowserUseStateSnapshot(),
            getState: () => browserSidebar.getStateSnapshot(),
            getTab: (identity) => browserSidebar.getTabSnapshot(identity),
            getWebContents: (identity) => browserSidebar.getWebContentsForTab(identity),
            hasPresentedSurfaceForThread: (threadId) =>
              browserSidebar.hasPresentedBrowserUseSurfaceForThread(threadId),
            isBrowserUseIdentity: (identity) => browserSidebar.isBrowserUseIdentity(identity),
            listPendingPresentations: (scopeId) =>
              browserSidebar.listPendingBrowserUsePresentationRequests(scopeId),
            setDownloadActive: (identity, active) =>
              browserSidebar.setDownloadActive(identity, active),
          };
          const context = yield* Layer.buildWithScope(
            live({
              environment: {},
              homeDirectory: root,
              isPackaged: false,
              nodexHome: `${root}/home`,
              projectRootPath: root,
              platform: "darwin",
              resourcesPath: `${root}/resources`,
              userDataPath: `${root}/user-data`,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.succeed(
                    BrowserApplication,
                    BrowserApplication.of({
                      guest: {
                        getIdentity: (webContentsId: number) =>
                          browserSidebar.getIdentityForWebContents(webContentsId),
                        getOwnerWebContentsId: (webContentsId: number) =>
                          browserSidebar.getOwnerWebContentsIdForGuest(webContentsId),
                      },
                      projection: {
                        ...projection,
                      },
                    } as unknown as BrowserApplication["Service"]),
                  ),
                  Layer.succeed(
                    ElectronApp,
                    ElectronApp.of({
                      appPath: Effect.succeed(root),
                      downloadsPath: Effect.succeed(`${root}/downloads`),
                      isInApplicationsFolder: Effect.succeed(true),
                      locale: Effect.succeed("en-US"),
                      userDataPath: Effect.succeed(`${root}/user-data`),
                      whenReady: Effect.void,
                      quit: Effect.void,
                      relaunch: Effect.void,
                      exit: () => Effect.void,
                      onActivate: () => Effect.void,
                      onBeforeQuit: () => Effect.void,
                      onOpenUrl: () => Effect.void,
                      onSecondInstance: () => Effect.void,
                      onTerminationSignal: () => Effect.void,
                      onWindowAllClosed: () => Effect.void,
                    }),
                  ),
                  Layer.succeed(
                    ElectronDesktop,
                    ElectronDesktop.of({
                      dialog: null as never,
                      menu: null as never,
                      nativeTheme: null as never,
                      safeStorage: {
                        isEncryptionAvailable: () => false,
                        encryptString: (value: string) => Buffer.from(value),
                        decryptString: (value: Buffer) => value.toString("utf8"),
                      } as never,
                      shell: {
                        openPath: async () => "",
                        showItemInFolder: () => undefined,
                      } as never,
                      showMessage: () => Effect.die("unused"),
                      showNotification: () => Effect.die("unused"),
                      onPowerEvent: () => Effect.void,
                    }),
                  ),
                  Layer.succeed(
                    ElectronNet,
                    ElectronNet.of({
                      appVersion: "test",
                      fetch: () => Effect.die("unused"),
                      readBase64: () => Effect.die("unused"),
                    }),
                  ),
                  Layer.succeed(
                    ElectronSessionHost,
                    ElectronSessionHost.of({
                      defaultSession: Effect.die("unused"),
                      fromPartition: () => Effect.succeed(browserSession as unknown as Session),
                      hasOwnerWindow: () => false,
                      protocol: null as never,
                      scopedRegistration: () => Effect.void,
                    }),
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
                  Layer.succeed(ScopedCallbackRuntime, callbacks),
                  Layer.succeed(
                    BrowserProfileHelperPlatform,
                    BrowserProfileHelperPlatform.of({
                      make: () => ({ readProfile: () => Effect.die("unused") }),
                    }),
                  ),
                ),
              ),
            ),
            scope,
          );
          const runtime = Context.get(context, BrowserProfileRuntime);

          assert.isObject(runtime.extensions);
          assert.isObject(runtime.siteInfo);
          assert.isObject(runtime.download);
          assert.deepEqual(yield* runtime.localServerPreferences.snapshot, {
            showMode: "online",
            sortMode: "recently-used",
            expandedProjectIds: [],
          });
          assert.strictEqual(browserSession.listenerCount("will-download"), 1);

          yield* Scope.close(scope, Exit.void);
          assert.strictEqual(browserSession.listenerCount("will-download"), 0);
        }),
      (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
    ),
  );
});
