import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ProfileAssets } from "../local-store/ProfileAssets";
import type {
  BrowserBrowsingDataClearResult,
  BrowserBrowsingDataKind,
  BrowserSidebarBrowserUseCaptureSurfaceEvent,
  BrowserSidebarBrowserUseStateSnapshot,
  BrowserSidebarBrowserUseViewportEvent,
  BrowserSidebarCommand,
  BrowserSidebarCommandResult,
  BrowserSidebarPhysicalHostIdentity,
  BrowserSidebarLocalServerThumbnailRequest,
  BrowserSidebarStateSnapshot,
  BrowserSidebarTabIdentity,
  BrowserSidebarTabSnapshot,
  BrowserSidebarWebviewDestroyed,
  BrowserSidebarWebviewHostCreated,
  BrowserUseCursorState,
  BrowserUsePresentationRequest,
  BrowserUseTabState,
} from "../../shared/browser-sidebar";
import { BrowserState, type BrowserLocalServerThumbnailAdmission } from "./BrowserState";
import { makeBrowserForkTransfer, type BrowserForkTransfer } from "./BrowserForkTransfer";
import {
  makeBrowserHistoryRuntime,
  type BrowserHistoryRuntime,
} from "../browser/browser-history-store";
import {
  makeBrowserLocalServerRuntime,
  type BrowserLocalServerRuntime,
} from "../browser/browser-local-server-runtime";
import {
  makeBrowserLocalServerThumbnailRuntime,
  type BrowserLocalServerThumbnailRuntime,
} from "../browser/browser-local-server-thumbnail";
import { makeBrowserPageRuntime } from "../browser/browser-page-store";
import {
  make as makeBrowserSidebarEventHub,
  type BrowserSidebarEventHubService,
} from "../browser/BrowserSidebarEventHub";
import { makeBrowserEarlyPageRestoreRuntime } from "../browser/BrowserEarlyPageRestoreRuntime";
import { makeBrowserPageEmulationRuntime } from "../browser/browser-page-emulation";
import {
  type BrowserAttachmentAuthorizationResult,
  type BrowserAttachedGuestOwnership,
  type BrowserAttachmentRoute,
  makeBrowserRuntimeRegistry,
} from "../browser/browser-runtime-registry";
import { makeBrowserWebContentsListenerRuntime } from "../browser/BrowserWebContentsListenerRuntime";
import {
  browserElectronPlatform,
  type BrowserWebContentsLike,
} from "../platform/electron/BrowserElectronPlatform";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { BrowserSiteStatusRuntime } from "../host-runtime/BrowserSiteStatusRuntime";

export interface BrowserCommandContext {
  readonly browserViewScopeId?: string;
  readonly ownerWebContentsId?: number;
}

export interface BrowserUseRouteIdentity {
  readonly browserConversationId: string;
  readonly browserViewScopeId: string;
  readonly codexSessionId: string;
  readonly ownerWebContentsId: number;
  readonly projectId: string | null;
}

/**
 * Synchronous host seam used only inside Electron's webview attachment callbacks.
 * It owns identity admission; asynchronous Browser behavior stays on BrowserApplication.
 */
export interface BrowserGuestHost {
  readonly authorizeAttachment: (
    ownerWebContentsId: number,
    route: BrowserSidebarPhysicalHostIdentity,
  ) => BrowserAttachmentAuthorizationResult;
  readonly consumeAuthorizedAttachment: (
    attachToken: string,
    ownerWebContentsId: number,
    guestWebContentsId: number,
  ) => BrowserAttachedGuestOwnership | null;
  readonly endImageDrag: (guestWebContentsId: number) => void;
  readonly getIdentity: (guestWebContentsId: number) => BrowserSidebarTabIdentity | null;
  readonly getOwnerWebContentsId: (guestWebContentsId: number) => number | null;
  readonly isAuthorized: (guestWebContentsId: number) => boolean;
  readonly isRegisteredStorage: (
    identity: BrowserSidebarTabIdentity,
    browserStorageId: string | undefined,
  ) => boolean;
  readonly prepareHistoryRestore: (
    route: BrowserAttachmentRoute,
    guestWebContentsId: number,
  ) => void;
  readonly registerOwnership: (
    ownerWebContentsId: number,
    guestWebContentsId: number,
    identity: BrowserSidebarTabIdentity | BrowserAttachmentRoute,
    browserStorageId?: string,
  ) => void;
  readonly releaseOwner: (ownerWebContentsId: number) => void;
  readonly revokeAttachment: (attachToken: string) => void;
  readonly startImageDrag: (guestWebContentsId: number, sourceUrl: string) => boolean;
}

/** Browser state projection consumed by profile and presentation capabilities. */
export interface BrowserProjection {
  readonly admitLocalServerThumbnail: (
    input: BrowserSidebarLocalServerThumbnailRequest,
  ) => BrowserLocalServerThumbnailAdmission;
  readonly getBrowserUseState: () => BrowserSidebarBrowserUseStateSnapshot;
  readonly getState: () => BrowserSidebarStateSnapshot;
  readonly getTab: (identity: BrowserSidebarTabIdentity) => BrowserSidebarTabSnapshot | null;
  readonly getWebContents: (identity: BrowserSidebarTabIdentity) => BrowserWebContentsLike | null;
  readonly hasPresentedSurfaceForThread: (threadId: string, ownerWebContentsId?: number) => boolean;
  readonly isBrowserUseIdentity: (identity: BrowserSidebarTabIdentity) => boolean;
  readonly listPendingPresentations: (
    browserViewScopeId: string,
  ) => readonly BrowserUsePresentationRequest[];
  readonly setDownloadActive: (
    identity: BrowserSidebarTabIdentity,
    activeDownload: boolean,
  ) => void;
}

/** Narrow synchronous adapter used by the physical IAB Promise protocol. */
export interface BrowserAutomationHost {
  readonly getTab: BrowserProjection["getTab"];
  readonly getWebContents: BrowserProjection["getWebContents"];
  readonly isVisible: (route: BrowserUseRouteIdentity, browserTabId: string) => boolean;
  readonly listTabs: (
    browserConversationId: string,
    browserViewScopeId: string,
  ) => readonly BrowserSidebarTabSnapshot[];
  readonly releaseDebugger: (contents: BrowserWebContentsLike) => void;
  readonly releaseTab: (identity: BrowserSidebarTabIdentity) => void;
  readonly setActiveTab: (
    identity: Omit<BrowserSidebarTabIdentity, "browserTabId">,
    browserTabId: string | null,
  ) => void;
  readonly setCaptureSurface: (event: BrowserSidebarBrowserUseCaptureSurfaceEvent) => void;
  readonly setCursor: (cursor: BrowserUseCursorState) => boolean;
  readonly setViewport: (event: BrowserSidebarBrowserUseViewportEvent) => void;
  readonly setVisible: (
    route: BrowserUseRouteIdentity,
    browserTabId: string,
    visible: boolean,
  ) => void;
  readonly upsertTab: (tab: BrowserUseTabState) => void;
}

export class BrowserApplication extends Context.Service<
  BrowserApplication,
  {
    readonly applyCommand: (
      command: BrowserSidebarCommand,
      context?: BrowserCommandContext,
    ) => Effect.Effect<BrowserSidebarCommandResult, BrowserApplicationError>;
    readonly automation: BrowserAutomationHost;
    readonly clearBrowsingData: (
      kind: Exclude<BrowserBrowsingDataKind, "downloads">,
    ) => Effect.Effect<BrowserBrowsingDataClearResult, BrowserApplicationError>;
    readonly closeConversation: (browserConversationId: string) => Effect.Effect<void>;
    readonly events: BrowserSidebarEventHubService;
    readonly forkTransfer: BrowserForkTransfer;
    readonly guest: BrowserGuestHost;
    readonly history: BrowserHistoryRuntime;
    readonly localServers: BrowserLocalServerRuntime;
    readonly localServerThumbnail: BrowserLocalServerThumbnailRuntime;
    readonly projection: BrowserProjection;
    readonly webviewDestroyed: (
      event: BrowserSidebarWebviewDestroyed,
    ) => Effect.Effect<BrowserSidebarCommandResult, BrowserApplicationError>;
    readonly webviewHostCreated: (
      event: BrowserSidebarWebviewHostCreated,
      ownerWebContentsId?: number,
    ) => Effect.Effect<BrowserSidebarCommandResult, BrowserApplicationError>;
  }
>()("nodex/main/browser-application/BrowserApplication") {}

export class BrowserApplicationError extends Schema.TaggedError<BrowserApplicationError>()(
  "BrowserApplicationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const applicationError = (operation: string, cause: unknown): BrowserApplicationError =>
  new BrowserApplicationError({ operation, cause });

export const live = (
  userDataPath: string,
): Layer.Layer<
  BrowserApplication,
  BrowserApplicationError,
  BrowserSiteStatusRuntime | ElectronNet | FileSystem.FileSystem | ProfileAssets
> =>
  Layer.effect(
    BrowserApplication,
    Effect.gen(function* () {
      const siteStatus = yield* BrowserSiteStatusRuntime;
      const assets = yield* ProfileAssets;
      const electronNet = yield* ElectronNet;
      const events = yield* makeBrowserSidebarEventHub;
      const earlyPageRestores =
        yield* makeBrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>();
      const pageEmulation = yield* makeBrowserPageEmulationRuntime;
      const runBackground = yield* FiberSet.makeRuntime<never, void, never>();
      const fork = <E>(effect: Effect.Effect<void, E>): void => {
        runBackground(
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Browser background operation failed").pipe(
                Effect.annotateLogs({ cause: String(cause) }),
              ),
            ),
          ),
        );
      };
      const runtimeRegistry = makeBrowserRuntimeRegistry();
      const webContentsListeners = yield* makeBrowserWebContentsListenerRuntime;
      const localServerThumbnail = yield* makeBrowserLocalServerThumbnailRuntime();
      const localServers = yield* makeBrowserLocalServerRuntime({
        fetch: electronNet.fetch,
        invalidateThumbnail: localServerThumbnail.invalidate,
      });
      const history = yield* makeBrowserHistoryRuntime(`${userDataPath}/browser-history.json`).pipe(
        Effect.mapError((cause) => applicationError("initialize-history", cause)),
      );
      const pages = yield* makeBrowserPageRuntime(
        `${userDataPath}/browser-sidebar-page-states.json`,
      ).pipe(Effect.mapError((cause) => applicationError("initialize-pages", cause)));
      const state = new BrowserState({
        earlyPageRestores,
        electron: browserElectronPlatform,
        events,
        fork,
        historyStore: history,
        pageEmulation,
        pageStore: pages,
        runtimeRegistry,
        siteStatus,
        saveBrowserImage: assets.saveUploadedImage,
        webContentsListeners,
      });

      const applyCommand = (command: BrowserSidebarCommand, context: BrowserCommandContext = {}) =>
        state
          .handleCommand(command, context)
          .pipe(Effect.mapError((cause) => applicationError("apply-command", cause)));
      const projection: BrowserProjection = {
        admitLocalServerThumbnail: (input) => state.admitLocalServerThumbnail(input),
        getBrowserUseState: () => state.getBrowserUseStateSnapshot(),
        getState: () => state.getStateSnapshot(),
        getTab: (identity) => state.getTabSnapshot(identity),
        getWebContents: (identity) => state.getWebContentsForTab(identity),
        hasPresentedSurfaceForThread: (threadId, ownerWebContentsId) =>
          state.hasPresentedBrowserUseSurfaceForThread(threadId, ownerWebContentsId),
        isBrowserUseIdentity: (identity) => state.isBrowserUseIdentity(identity),
        listPendingPresentations: (browserViewScopeId) =>
          state.listPendingBrowserUsePresentationRequests(browserViewScopeId),
        setDownloadActive: (identity, activeDownload) =>
          state.setDownloadActive(identity, activeDownload),
      };
      const guest: BrowserGuestHost = {
        authorizeAttachment: (ownerWebContentsId, route) =>
          state.authorizeWebviewAttachment(ownerWebContentsId, route),
        consumeAuthorizedAttachment: (attachToken, ownerWebContentsId, guestWebContentsId) =>
          state.consumeAuthorizedWebviewAttachment(
            attachToken,
            ownerWebContentsId,
            guestWebContentsId,
          ),
        endImageDrag: (guestWebContentsId) => state.endBrowserImageDrag(guestWebContentsId),
        getIdentity: (guestWebContentsId) => state.getIdentityForWebContents(guestWebContentsId),
        getOwnerWebContentsId: (guestWebContentsId) =>
          state.getOwnerWebContentsIdForGuest(guestWebContentsId),
        isAuthorized: (guestWebContentsId) =>
          state.isAuthorizedGuestWebContents(guestWebContentsId),
        isRegisteredStorage: (identity, browserStorageId) =>
          state.isRegisteredBrowserStorage(identity, browserStorageId),
        prepareHistoryRestore: (route, guestWebContentsId) =>
          state.prepareAttachedWebviewHistoryRestore(route, guestWebContentsId),
        registerOwnership: (ownerWebContentsId, guestWebContentsId, identity, browserStorageId) =>
          state.registerAttachedWebviewOwnership(
            ownerWebContentsId,
            guestWebContentsId,
            identity,
            browserStorageId,
          ),
        releaseOwner: (ownerWebContentsId) => state.releaseRendererOwner(ownerWebContentsId),
        revokeAttachment: (attachToken) => state.revokeAuthorizedWebviewAttachment(attachToken),
        startImageDrag: (guestWebContentsId, sourceUrl) =>
          state.startBrowserImageDrag(guestWebContentsId, sourceUrl),
      };
      const automation: BrowserAutomationHost = {
        getTab: projection.getTab,
        getWebContents: projection.getWebContents,
        isVisible: (route, browserTabId) =>
          state.isBrowserVisibleForBrowserUse(route, browserTabId),
        listTabs: (browserConversationId, browserViewScopeId) =>
          state.listTabSnapshots(browserConversationId, browserViewScopeId),
        releaseDebugger: (contents) => state.releaseBrowserUseDebugger(contents),
        releaseTab: (identity) => state.releaseBrowserUseTab(identity),
        setActiveTab: (identity, browserTabId) =>
          state.setActiveBrowserUseTab(identity, browserTabId),
        setCaptureSurface: (event) => state.setBrowserUseCaptureSurface(event),
        setCursor: (cursor) => state.setBrowserUseCursor(cursor),
        setViewport: (event) => state.setBrowserUseViewport(event),
        setVisible: (route, browserTabId, visible) =>
          state.setBrowserVisibleForBrowserUse(route, browserTabId, visible),
        upsertTab: (tab) => state.upsertBrowserUseTab(tab),
      };

      return BrowserApplication.of({
        applyCommand,
        automation,
        clearBrowsingData: (kind) => state.clearBrowsingData(kind),
        closeConversation: (browserConversationId) =>
          state.closeBrowserConversation(browserConversationId),
        events,
        forkTransfer: makeBrowserForkTransfer(state),
        guest,
        history,
        localServers,
        localServerThumbnail,
        projection,
        webviewDestroyed: (event) => state.handleWebviewDestroyed(event),
        webviewHostCreated: (event, ownerWebContentsId) =>
          state
            .handleWebviewHostCreated(event, ownerWebContentsId)
            .pipe(Effect.mapError((cause) => applicationError("register-webview", cause))),
      });
    }),
  );
