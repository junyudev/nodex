import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import type { BrowserSidebarTabSnapshot } from "../../../shared/browser-sidebar";
import { BrowserState } from "../../browser-application/BrowserState";
import { BrowserApplication } from "../../browser-application/BrowserApplication";
import { makeBrowserRuntimeRegistry } from "../../browser/browser-runtime-registry";
import { makeBrowserPageEmulationRuntimeUnsafe } from "../../browser/browser-page-emulation";
import { makeBrowserEarlyPageRestoreRuntime } from "../../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserWebContentsListenerRuntime } from "../../browser/BrowserWebContentsListenerRuntime";
import { BrowserProfileRuntime } from "../../host-runtime/BrowserProfileRuntime";
import { MainConfig } from "../../app/MainConfig";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { ElectronWindowHost } from "../../platform/electron/ElectronWindowHost";
import { browserElectronPlatform } from "../../platform/electron/BrowserElectronPlatform";
import { WindowSessionCatalog } from "../../window-runtime/WindowSessionCatalog";
import { live } from "./BrowserProfileIpc";

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  ...args: readonly unknown[]
) => Effect.Effect<unknown, unknown>;
type EventHandler = (event: IpcMainEvent, ...args: readonly unknown[]) => Effect.Effect<void>;

it.effect("registers and releases Browser Profile ingress with the Main Scope", () =>
  Effect.gen(function* () {
    const handlers = new Map<string, InvokeHandler>();
    const listeners = new Map<string, EventHandler>();
    const ipc = ElectronIpc.of({
      handle: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => handlers.set(channel, handler as InvokeHandler)),
          () => Effect.sync(() => handlers.delete(channel)),
        ).pipe(Effect.asVoid),
      on: (channel, handler) =>
        Effect.acquireRelease(
          Effect.sync(() => listeners.set(channel, handler as EventHandler)),
          () => Effect.sync(() => listeners.delete(channel)),
        ).pipe(Effect.asVoid),
    });
    const scope = yield* Scope.make();
    const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
    const browserSidebar = new BrowserState({
      earlyPageRestores:
        yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>().pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      electron: browserElectronPlatform,
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
    const browser = BrowserApplication.of({
      applyCommand: browserSidebar.handleCommand.bind(browserSidebar),
      guest: {
        endImageDrag: (id: number) => browserSidebar.endBrowserImageDrag(id),
        getIdentity: (id: number) => browserSidebar.getIdentityForWebContents(id),
        getOwnerWebContentsId: (id: number) => browserSidebar.getOwnerWebContentsIdForGuest(id),
        isAuthorized: (id: number) => browserSidebar.isAuthorizedGuestWebContents(id),
        startImageDrag: (id: number, url: string) => browserSidebar.startBrowserImageDrag(id, url),
      },
    } as unknown as BrowserApplication["Service"]);
    yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(
              BrowserProfileRuntime,
              BrowserProfileRuntime.of({
                credentials: {} as never,
                download: {} as never,
                extensions: {} as never,
                localServerPreferences: {} as never,
                policy: {} as never,
                profileImport: {} as never,
                siteInfo: {} as never,
              }),
            ),
            Layer.succeed(BrowserApplication, browser),
            Layer.succeed(
              ElectronDesktop,
              ElectronDesktop.of({
                dialog: null as never,
                menu: null as never,
                nativeTheme: null as never,
                safeStorage: null as never,
                shell: null as never,
                showMessage: () => Effect.die("unused"),
                showNotification: () => Effect.die("unused"),
                onPowerEvent: () => Effect.void,
              }),
            ),
            Layer.succeed(ElectronIpc, ipc),
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
      "browser-contact-info-fill",
      "browser-contact-info-list",
      "browser-contact-info-remove",
      "browser-contact-info-upsert",
      "browser-credential-candidate-action",
      "browser-credential-fill",
      "browser-credential-generate-fill",
      "browser-credential-remove",
      "browser-credentials-list",
      "browser-credentials-list-all",
      "browser-download-action",
      "browser-download-history-clear",
      "browser-downloads-list",
      "browser-extension-load",
      "browser-extension-remove",
      "browser-extensions-list",
      "browser-local-server-preferences-get",
      "browser-local-server-preferences-update",
      "browser-profile-capabilities",
      "browser-profile-import",
      "browser-profile-import-profiles",
      "browser-site-info",
      "browser-use-policy-get",
      "browser-use-policy-update-modes",
      "browser-use-policy-update-origin-rule",
    ]);
    assert.deepEqual([...listeners.keys()].sort(), [
      "browser-annotation-anchor-update",
      "browser-annotation-selection",
      "browser-credential-save-candidate",
      "browser-image-drag-ended",
      "browser-image-drag-started",
      "browser-navigation-button",
    ]);

    yield* Scope.close(scope, Exit.void);
    assert.strictEqual(handlers.size, 0);
    assert.strictEqual(listeners.size, 0);
  }),
);
