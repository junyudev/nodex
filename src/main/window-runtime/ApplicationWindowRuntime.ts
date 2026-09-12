import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { BrowserWindow, shell } from "electron";
import { BROWSER_SIDEBAR_PARTITION } from "../../shared/browser-sidebar";
import { isAllowedBrowserExternalUrl } from "../../shared/browser-url";
import type { AppUpdateStatus } from "../../shared/types";
import type { WindowSessionRecord } from "../../shared/window-session";
import { MainCleanup } from "../app/MainCleanup";
import { ScopedCallbackRuntime } from "../app/ScopedCallbackRuntime";
import type { BrowserGuestHost } from "../browser-application/BrowserApplication";
import type { BrowserAuthorizedAttachment } from "../browser/browser-runtime-registry";
import {
  consumePendingBrowserWebviewAttachment,
  decideBrowserWebviewAttachment,
  parseBrowserWebviewInstanceId,
  registerPendingBrowserWebviewAttachment,
} from "../browser/browser-webview-attachment-policy";
import type {
  RendererClientRegistration,
  RendererClientRuntimeService,
} from "../codex/renderer-client-runtime-contracts";
import { resolveBundledElectronPreload } from "../electron-preload-path";
import { ComposerAppshotRuntime } from "../host-runtime/ComposerAppshotRuntime";
import type { DesktopNotificationRuntime } from "../host-runtime/DesktopNotificationRuntime";
import type { McpAppSandboxRuntime } from "../host-runtime/McpAppSandboxRuntime";
import { safeSendToWindow } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { captureMainException, captureMainMessage } from "../observability/sentry-main";
import type { ApplicationWindowShellRuntimeService } from "./ApplicationWindowShellRuntime";
import type { WindowRuntimeService } from "./WindowRuntime";
import { WindowShutdown } from "./WindowShutdown";
import {
  createApplicationWindowCoordinator,
  type ApplicationWindowCoordinator,
} from "./application-window-coordinator";

export interface ApplicationWindowRuntimeOptions {
  readonly appUpdates: {
    readonly currentStatus: Effect.Effect<AppUpdateStatus>;
  };
  readonly browser: BrowserGuestHost;
  readonly rendererConversations: {
    readonly setClientForegrounded: (
      clientId: string | null | undefined,
      foregrounded: boolean,
    ) => Effect.Effect<void>;
  };
  readonly desktopNotifications: DesktopNotificationRuntime["Service"];
  readonly mcpAppSandbox: McpAppSandboxRuntime["Service"];
  readonly platform: NodeJS.Platform;
  readonly rendererClients: RendererClientRuntimeService;
  readonly rendererLoaded: Stream.Stream<number>;
  readonly shell: ApplicationWindowShellRuntimeService;
  readonly windows: WindowRuntimeService;
}

export class ApplicationWindowRuntime extends Context.Service<
  ApplicationWindowRuntime,
  ApplicationWindowCoordinator & {
    readonly create: (session: WindowSessionRecord) => BrowserWindow;
    readonly rendererLoaded: Stream.Stream<number>;
    readonly syncTitle: (window: BrowserWindow) => void;
  }
>()("nodex/main/window-runtime/ApplicationWindowRuntime") {}

const syncMacWindowTitle = (platform: NodeJS.Platform, window: BrowserWindow): void => {
  if (platform !== "darwin" || window.isDestroyed()) return;
  window.setTitle("Nodex");
};

/** Installs post-Core feature authorities onto pre-existing canonical windows. */
export const live = (
  options: ApplicationWindowRuntimeOptions,
): Layer.Layer<
  ApplicationWindowRuntime,
  never,
  ComposerAppshotRuntime | MainCleanup | ScopedCallbackRuntime | WindowShutdown
> =>
  Layer.effect(
    ApplicationWindowRuntime,
    Effect.gen(function* () {
      const appshots = yield* ComposerAppshotRuntime;
      const callbacks = yield* ScopedCallbackRuntime;
      const cleanup = yield* MainCleanup;
      const windowShutdown = yield* WindowShutdown;
      const logger = getLogger({ component: "application-window-runtime" });

      const activate = (window: BrowserWindow, session: WindowSessionRecord): void => {
        if (window.isDestroyed()) throw new Error("Cannot activate a destroyed application window");

        appshots.observeWindow(window);
        const webContentsId = window.webContents.id;
        const mcpAppSandboxHost = options.mcpAppSandbox.createHost(window.webContents);
        const pendingBrowserAttachments = new Map<number, BrowserAuthorizedAttachment>();

        window.webContents.setWindowOpenHandler(({ url }) => {
          if (isAllowedBrowserExternalUrl(url)) void shell.openExternal(url);
          return { action: "deny" };
        });
        window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
          const webviewParams = params as typeof params & {
            instanceId?: number | string;
            nodeintegration?: string;
            preload?: string;
            webpreferences?: string;
          };
          if (mcpAppSandboxHost.handlesPartition(webviewParams.partition)) {
            mcpAppSandboxHost.handleWillAttach(event, webPreferences, webviewParams);
            return;
          }
          const instanceId = parseBrowserWebviewInstanceId(webviewParams.instanceId);
          if (instanceId === null || pendingBrowserAttachments.has(instanceId)) {
            logger.warn("Rejected Browser webview attachment", {
              reason: instanceId === null ? "invalid-instance-id" : "duplicate-instance-id",
              webContentsId,
            });
            event.preventDefault();
            return;
          }
          const decision = decideBrowserWebviewAttachment({
            authorizeAttachment: (route) =>
              options.browser.authorizeAttachment(window.webContents.id, route),
            isRegisteredBrowserStorage: (identity, browserStorageId) =>
              options.browser.isRegisteredStorage(identity, browserStorageId),
            ownerBrowserViewScopeId:
              options.windows.resolveSessionId(window.webContents.id) ?? session.id,
            partition: params.partition,
            revokeAuthorizedAttachment: (attachToken) =>
              options.browser.revokeAttachment(attachToken),
            src: params.src,
          });
          if (!decision.ok) {
            logger.warn("Rejected Browser webview attachment", {
              reason: decision.reason,
              browserConversationId: decision.route?.browserConversationId,
              browserViewScopeId: decision.route?.browserViewScopeId,
              browserTabId: decision.route?.browserTabId,
              webContentsId,
            });
            event.preventDefault();
            return;
          }
          const registration = registerPendingBrowserWebviewAttachment(
            pendingBrowserAttachments,
            instanceId,
            decision.authorization,
          );
          if (!registration.ok) {
            options.browser.revokeAttachment(decision.authorization.attachToken);
            logger.warn("Rejected Browser webview attachment", {
              reason: registration.reason,
              browserConversationId: decision.authorization.browserConversationId,
              browserViewScopeId: decision.authorization.browserViewScopeId,
              browserTabId: decision.authorization.browserTabId,
              webContentsId,
            });
            event.preventDefault();
            return;
          }
          Object.assign(webPreferences, {
            allowRunningInsecureContent: false,
            contextIsolation: true,
            nodeIntegration: false,
            nodeIntegrationInSubFrames: false,
            nodeIntegrationInWorker: false,
            preload: resolveBundledElectronPreload(__dirname, "browser-guest.js"),
            plugins: false,
            partition: BROWSER_SIDEBAR_PARTITION,
            sandbox: true,
            webSecurity: true,
            webviewTag: false,
          });
          params.partition = BROWSER_SIDEBAR_PARTITION;
          delete webviewParams.nodeintegration;
          delete webviewParams.preload;
          delete webviewParams.webpreferences;
          delete (webPreferences as typeof webPreferences & { preloadURL?: string }).preloadURL;
        });
        window.webContents.on("did-attach-webview", (_event, guest) => {
          if (mcpAppSandboxHost.handleDidAttach(guest)) return;
          const pending = consumePendingBrowserWebviewAttachment(
            pendingBrowserAttachments,
            (guest as typeof guest & { viewInstanceId?: number | string }).viewInstanceId,
          );
          if (!pending) {
            logger.warn("Rejected unmatched Browser webview attachment", {
              guestWebContentsId: guest.id,
              ownerWebContentsId: webContentsId,
            });
            guest.close();
            return;
          }
          const ownership = options.browser.consumeAuthorizedAttachment(
            pending.attachToken,
            webContentsId,
            guest.id,
          );
          if (!ownership) {
            logger.warn("Rejected unauthorized Browser webview attachment", {
              browserConversationId: pending.browserConversationId,
              browserViewScopeId: pending.browserViewScopeId,
              browserTabId: pending.browserTabId,
              guestWebContentsId: guest.id,
              ownerWebContentsId: webContentsId,
            });
            guest.close();
            return;
          }
          options.browser.registerOwnership(
            webContentsId,
            guest.id,
            ownership,
            ownership.browserStorageId,
          );
          options.browser.prepareHistoryRestore(ownership, guest.id);
        });

        let rendererRegistration: RendererClientRegistration | null =
          options.rendererClients.register(window.webContents);
        callbacks.fork(
          options.rendererConversations.setClientForegrounded(
            rendererRegistration.clientId,
            window.isFocused(),
          ),
        );
        syncMacWindowTitle(options.platform, window);
        window.on("focus", () =>
          callbacks.fork(
            options.rendererConversations.setClientForegrounded(
              rendererRegistration?.clientId,
              true,
            ),
          ),
        );
        window.on("blur", () =>
          callbacks.fork(
            options.rendererConversations.setClientForegrounded(
              rendererRegistration?.clientId,
              false,
            ),
          ),
        );
        window.webContents.on("render-process-gone", (_event, details) => {
          logger.error("Renderer process gone", {
            webContentsId,
            reason: details.reason,
            exitCode: details.exitCode,
          });
          captureMainMessage("Renderer process gone", {
            tags: { reason: details.reason },
            extra: { webContentsId, exitCode: details.exitCode },
          });
        });
        window.on("closed", () => {
          options.browser.releaseOwner(webContentsId);
          options.desktopNotifications.dismissByOriginWebContentsId(webContentsId);
          callbacks.fork(
            options.rendererConversations.setClientForegrounded(
              rendererRegistration?.clientId,
              false,
            ),
          );
          if (rendererRegistration) callbacks.fork(rendererRegistration.release);
          rendererRegistration = null;
        });
        callbacks.fork(
          options.appUpdates.currentStatus.pipe(
            Effect.tap((status) =>
              Effect.sync(() => safeSendToWindow(window, "app:update-status", [status])),
            ),
            Effect.asVoid,
          ),
        );
      };

      const activateClaimedWindow = (window: BrowserWindow, session: WindowSessionRecord): void => {
        const webContentsId = window.webContents.id;
        try {
          activate(window, session);
          options.shell.completeActivation(webContentsId);
        } catch (cause) {
          options.shell.failActivation(webContentsId, cause);
          if (!window.isDestroyed()) window.destroy();
          throw cause;
        }
      };

      const activateClaimedWindows = (): void => {
        for (const lease of options.shell.claimPendingActivation()) {
          activateClaimedWindow(lease.window, lease.session);
        }
      };

      const create = (session: WindowSessionRecord): BrowserWindow => {
        const window = options.shell.create(session, "foreground");
        activateClaimedWindows();
        return window;
      };

      activateClaimedWindows();

      const coordinator = createApplicationWindowCoordinator({
        closeAll: windowShutdown.closeAll,
        create,
        focusedWindow: () => BrowserWindow.getFocusedWindow(),
        reportFailure: ({ cause, operation, windowSessionId }) => {
          const phase =
            operation === "rollback"
              ? "window-session-acquisition-rollback"
              : "window-session-acquisition";
          logger.error(
            operation === "rollback"
              ? "Could not roll back failed Window Session acquisition"
              : "Could not open a new window",
            {
              error: cause instanceof Error ? cause.message : String(cause),
              windowSessionId,
            },
          );
          captureMainException(cause, { tags: { phase } });
        },
        syncTitle: (window) => syncMacWindowTitle(options.platform, window),
        windows: options.windows,
      });
      const prepareQuit = yield* Effect.cached(
        coordinator.prepareQuit.pipe(
          Effect.tap((report) =>
            report.destroyed > 0 || report.failed > 0
              ? Effect.logWarning("Window shutdown required escalation").pipe(
                  Effect.annotateLogs({
                    destroyed: report.destroyed,
                    failed: report.failed,
                    graceful: report.graceful,
                    total: report.total,
                  }),
                )
              : Effect.void,
          ),
          Effect.tap((report) =>
            cleanup.report(
              report.failures.map((failure) => ({
                subsystem: "window",
                operation: failure.phase,
                reason: failure.reason,
              })),
            ),
          ),
        ),
      );
      yield* Effect.addFinalizer(() => prepareQuit.pipe(Effect.asVoid));

      return ApplicationWindowRuntime.of({
        ...coordinator,
        prepareQuit,
        create,
        rendererLoaded: options.rendererLoaded,
        syncTitle: (window) => syncMacWindowTitle(options.platform, window),
      });
    }),
  );
