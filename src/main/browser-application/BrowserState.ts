import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  BROWSER_SIDEBAR_PARTITION,
  BROWSER_SIDEBAR_ZOOM_OPTIONS,
  DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
  makeDefaultBrowserSidebarTabId,
  makeBrowserSidebarConversationScopeKey,
  makeBrowserSidebarTabKey,
  type BrowserBrowsingDataClearResult,
  type BrowserBrowsingDataKind,
  type BrowserSidebarBrowserUseCaptureSurfaceEvent,
  type BrowserSidebarBrowserUseStateSnapshot,
  type BrowserSidebarBrowserUseViewportEvent,
  type BrowserSidebarCommand,
  type BrowserSidebarCommandResult,
  type BrowserSidebarClonedTabInput,
  type BrowserSidebarDestroyWebviewRequest,
  type BrowserSidebarPhysicalHostIdentity,
  type BrowserSidebarLocalServerThumbnailRequest,
  type BrowserSidebarLocalServerThumbnailResult,
  type BrowserSidebarStateSnapshot,
  type BrowserSidebarTabSnapshot,
  type BrowserSidebarTabIdentity,
  type BrowserSidebarThemeVariant,
  type BrowserSidebarViewport,
  type BrowserSidebarWebviewDestroyed,
  type BrowserSidebarWebviewHostCreated,
  type BrowserUsePageClosedEvent,
  type BrowserUsePresentationRequest,
  type BrowserUsePresentationResult,
  type BrowserUseCursorState,
  type BrowserUseTabState,
} from "../../shared/browser-sidebar";
import {
  isAllowedBrowserExternalUrl,
  isAllowedBrowserNavigationUrl,
  isBlankBrowserUrl,
  normalizeBrowserNavigationUrl,
} from "../../shared/browser-url";
import { type BrowserPageRuntime, type BrowserSerializedPage } from "../browser/browser-page-store";
import {
  type BrowserRuntimeRegistry,
  type BrowserAttachmentRoute,
} from "../browser/browser-runtime-registry";
import type { BrowserWebContentsListenerRuntime } from "../browser/BrowserWebContentsListenerRuntime";
import type {
  BrowserEarlyPageRestoreLease,
  BrowserEarlyPageRestoreRuntime,
} from "../browser/BrowserEarlyPageRestoreRuntime";
import { selectBrowserTabsToSuspend } from "../browser/browser-tab-budget";
import { type BrowserPageEmulationRuntime } from "../browser/browser-page-emulation";
import type { BrowserHistoryRuntime } from "../browser/browser-history-store";
import { getLogger, type BackendLogger } from "../logging/logger";
import {
  buildBrowserContextMenuTemplate,
  type BrowserContextMenuParams,
} from "../browser/browser-context-menu";
import { fetchBrowserImage } from "../browser/browser-image-attachment";
import type { ProfileAssetsService } from "../local-store/assets";
import type { BrowserSidebarEventPublisher } from "../browser/BrowserSidebarEventHub";
import type { SiteStatusPolicyRuntime } from "../browser-use/site-status-policy-service";
import type {
  BrowserElectronPlatform,
  BrowserWebContentsLike,
} from "../platform/electron/BrowserElectronPlatform";

type BrowserUseCommand = Extract<
  BrowserSidebarCommand,
  {
    type:
      | "browser-use-upsert-tab"
      | "browser-use-release-tab"
      | "browser-use-resolve-presentation"
      | "browser-use-set-active-tab"
      | "browser-use-set-cursor"
      | "browser-use-set-viewport"
      | "browser-use-set-capture-surface";
  }
>;

interface BrowserStateDeps {
  clipboard: Pick<
    import("../platform/electron/ElectronClipboard").ElectronClipboardPort,
    "writeImage" | "writeText"
  >;
  earlyPageRestores: BrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>;
  events: BrowserSidebarEventPublisher;
  runtimeRegistry: BrowserRuntimeRegistry;
  webContentsListeners: BrowserWebContentsListenerRuntime;
  electron: BrowserElectronPlatform;
  logger?: Pick<BackendLogger, "debug" | "info" | "warn">;
  pageStore?: BrowserPageRuntime;
  historyStore?: Pick<BrowserHistoryRuntime, "clear" | "record">;
  pageEmulation: BrowserPageEmulationRuntime;
  fork: (effect: Effect.Effect<void>) => void;
  siteStatus: Pick<SiteStatusPolicyRuntime, "cachedCommentModeBlocked">;
  saveBrowserImage: ProfileAssetsService["saveUploadedImage"];
}

export type BrowserLocalServerThumbnailAdmission =
  | {
      readonly _tag: "Allowed";
      readonly url: string;
    }
  | {
      readonly _tag: "Denied";
      readonly result: BrowserSidebarLocalServerThumbnailResult;
    };

interface BrowserStateCommandContext {
  browserViewScopeId?: string;
  ownerWebContentsId?: number;
}

class BrowserStateOperationError extends Schema.TaggedError<BrowserStateOperationError>()(
  "BrowserStateOperationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const tryPlatformPromise = <A>(
  operation: string,
  evaluate: () => PromiseLike<A>,
): Effect.Effect<A, BrowserStateOperationError> =>
  Effect.tryPromise({
    try: async () => await evaluate(),
    catch: (cause) => new BrowserStateOperationError({ operation, cause }),
  });

interface BrowserUseCapturedRoute {
  browserConversationId: string;
  browserViewScopeId: string;
  codexSessionId: string;
  ownerWebContentsId: number;
  projectId: string | null;
}

interface PendingBrowserUsePresentation {
  request: BrowserUsePresentationRequest;
  expiresAt: number;
}

const BROWSER_USE_PRESENTATION_TIMEOUT_MS = 15_000;

const DEFAULT_VIEWPORT: BrowserSidebarViewport = {
  width: 390,
  height: 844,
  zoomPercent: 100,
  presetId: "responsive",
};

function browserIdentity(input: BrowserSidebarTabIdentity): BrowserSidebarTabIdentity {
  return {
    browserConversationId: input.browserConversationId,
    browserViewScopeId: input.browserViewScopeId,
    browserTabId: input.browserTabId,
  };
}

function browserConversationScopeKey(
  input: Pick<BrowserSidebarTabIdentity, "browserConversationId" | "browserViewScopeId">,
): string {
  return makeBrowserSidebarConversationScopeKey(input);
}

function browserTabKey(input: BrowserSidebarTabIdentity): string {
  return makeBrowserSidebarTabKey(browserIdentity(input));
}

function makeDefaultDeviceToolbarState(
  isEnabled: boolean,
): BrowserSidebarTabSnapshot["deviceToolbarState"] {
  return {
    responsiveViewportSize: null,
    toolbarState: {
      isEnabled,
      presetId: DEFAULT_VIEWPORT.presetId,
      width: DEFAULT_VIEWPORT.width,
      height: DEFAULT_VIEWPORT.height,
    },
  };
}

function updateDeviceToolbarState(
  current: BrowserSidebarTabSnapshot["deviceToolbarState"],
  input: {
    readonly isEnabled?: boolean;
    readonly viewport?: BrowserSidebarViewport;
  },
): BrowserSidebarTabSnapshot["deviceToolbarState"] {
  const viewport = input.viewport;
  return {
    responsiveViewportSize:
      viewport?.presetId === "responsive"
        ? { width: viewport.width, height: viewport.height }
        : current.responsiveViewportSize,
    toolbarState: {
      ...current.toolbarState,
      ...(input.isEnabled === undefined ? {} : { isEnabled: input.isEnabled }),
      ...(viewport === undefined
        ? {}
        : {
            presetId: viewport.presetId,
            width: viewport.width,
            height: viewport.height,
          }),
    },
  };
}

function viewportFromDeviceToolbarState(
  deviceToolbarState: BrowserSidebarTabSnapshot["deviceToolbarState"],
  zoomPercent: number,
): BrowserSidebarViewport {
  const toolbar = deviceToolbarState.toolbarState;
  const responsive = deviceToolbarState.responsiveViewportSize;
  return {
    width: toolbar.presetId === "responsive" ? (responsive?.width ?? toolbar.width) : toolbar.width,
    height:
      toolbar.presetId === "responsive" ? (responsive?.height ?? toolbar.height) : toolbar.height,
    presetId: toolbar.presetId,
    zoomPercent,
  };
}

const BROWSER_CONTEXT_MENU_MEDIA_TYPES = new Set([
  "none",
  "image",
  "audio",
  "video",
  "canvas",
  "file",
  "plugin",
]);

function isBrowserContextMenuParams(
  value: BrowserContextMenuParams | undefined,
): value is BrowserContextMenuParams {
  return Boolean(
    value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    typeof value.linkURL === "string" &&
    value.linkURL.length <= 16_384 &&
    typeof value.srcURL === "string" &&
    value.srcURL.length <= 16_384 &&
    BROWSER_CONTEXT_MENU_MEDIA_TYPES.has(value.mediaType) &&
    typeof value.hasImageContents === "boolean" &&
    typeof value.isEditable === "boolean" &&
    typeof value.selectionText === "string" &&
    value.selectionText.length <= 8_192 &&
    typeof value.formControlType === "string" &&
    typeof value.editFlags === "object" &&
    value.editFlags !== null &&
    typeof value.editFlags.canCopy === "boolean" &&
    typeof value.editFlags.canCut === "boolean" &&
    typeof value.editFlags.canPaste === "boolean",
  );
}

interface PendingWebviewTeardown extends BrowserSidebarTabIdentity {
  mountGeneration: number;
  reason: BrowserSidebarDestroyWebviewRequest["reason"];
  teardownId: string;
}

interface AttachedBrowserWebviewOwnership {
  ownerWebContentsId: number;
  identity: BrowserSidebarTabIdentity;
  browserStorageId?: string;
  rendererInstanceId?: string;
  hostGeneration?: number;
  mountGeneration?: number;
}

interface ActiveBrowserImageDrag extends BrowserSidebarTabIdentity {
  guestWebContentsId: number;
  ownerWebContentsId: number;
  sourceUrl: string;
}

export class BrowserState {
  private readonly tabs = new Map<string, BrowserSidebarTabSnapshot>();
  private readonly webContentsTabIds = new Map<number, string>();
  private readonly attachedWebviewOwnership = new Map<number, AttachedBrowserWebviewOwnership>();
  private readonly activeImageDragsByOwnerWebContentsId = new Map<number, ActiveBrowserImageDrag>();
  private readonly preparedPagesByStorageId = new Map<string, BrowserSerializedPage>();
  private readonly earlyPageRestores: BrowserEarlyPageRestoreRuntime<BrowserSidebarTabSnapshot>;
  private readonly pendingTeardowns = new Map<string, PendingWebviewTeardown>();
  private readonly browserUseTabs = new Map<string, BrowserUseTabState>();
  private readonly deviceToolbarStates = new Map<
    string,
    BrowserSidebarTabSnapshot["deviceToolbarState"]
  >();
  private readonly themeVariantsByViewScope = new Map<string, BrowserSidebarThemeVariant>();
  private readonly transferredBrowserTabIdsByConversationScope = new Map<string, string[]>();
  private readonly browserUseViewportSizes = new Map<
    string,
    BrowserSidebarBrowserUseViewportEvent
  >();
  private readonly browserUseCaptureSurfaces = new Map<
    string,
    BrowserSidebarBrowserUseCaptureSurfaceEvent
  >();
  private readonly electron: BrowserElectronPlatform;
  private readonly clipboard: BrowserStateDeps["clipboard"];
  private readonly events: BrowserSidebarEventPublisher;
  private readonly contextMenuPresenter: BrowserElectronPlatform["presentContextMenu"];
  private readonly logger: Pick<BackendLogger, "debug" | "info" | "warn">;
  private readonly browserUseActiveTabIdsByConversationScope = new Map<string, string>();
  private readonly pendingBrowserUsePresentations = new Map<
    string,
    PendingBrowserUsePresentation
  >();
  private readonly browserUseCursors = new Map<string, BrowserUseCursorState>();
  private readonly invalidatedPageStorageIds = new Set<string>();
  private readonly pageEmulation: BrowserPageEmulationRuntime;
  private readonly runtimeRegistry: BrowserRuntimeRegistry;
  private readonly webContentsListeners: BrowserWebContentsListenerRuntime;
  private readonly saveBrowserImage: ProfileAssetsService["saveUploadedImage"];
  private readonly siteStatus: Pick<SiteStatusPolicyRuntime, "cachedCommentModeBlocked">;
  private pageStore: BrowserPageRuntime | null;
  private historyStore: Pick<BrowserHistoryRuntime, "clear" | "record"> | null;
  private readonly fork: (effect: Effect.Effect<void>) => void;
  private teardownSequence = 0;

  constructor(deps: BrowserStateDeps) {
    this.clipboard = deps.clipboard;
    this.earlyPageRestores = deps.earlyPageRestores;
    this.events = deps.events;
    this.electron = deps.electron;
    this.contextMenuPresenter = deps.electron.presentContextMenu;
    this.logger = deps.logger ?? getLogger({ subsystem: "browser-sidebar" });
    this.pageStore = deps.pageStore ?? null;
    this.pageEmulation = deps.pageEmulation;
    this.fork = deps.fork;
    this.historyStore = deps.historyStore ?? null;
    this.runtimeRegistry = deps.runtimeRegistry;
    this.webContentsListeners = deps.webContentsListeners;
    this.saveBrowserImage = deps.saveBrowserImage;
    this.siteStatus = deps.siteStatus;
  }

  authorizeWebviewAttachment(
    ownerWebContentsId: number,
    route: BrowserSidebarPhysicalHostIdentity,
  ) {
    return this.runtimeRegistry.authorizeAttachment(ownerWebContentsId, route);
  }

  consumeAuthorizedWebviewAttachment(
    attachToken: string,
    ownerWebContentsId: number,
    guestWebContentsId: number,
  ) {
    return this.runtimeRegistry.consumeAuthorizedAttachment(
      attachToken,
      ownerWebContentsId,
      guestWebContentsId,
    );
  }

  revokeAuthorizedWebviewAttachment(attachToken: string): void {
    this.runtimeRegistry.revokeAuthorizedAttachment(attachToken);
  }

  isAuthorizedGuestWebContents(guestWebContentsId: number): boolean {
    return this.runtimeRegistry.getGuestOwnership(guestWebContentsId) !== null;
  }

  releaseRendererOwner(ownerWebContentsId: number): void {
    this.clearBrowserImageDrag(ownerWebContentsId);
    this.runtimeRegistry.releaseOwner(ownerWebContentsId);
    this.events.publish({ kind: "browserUseOwnerReleased", value: { ownerWebContentsId } });
  }

  getStateSnapshot(): BrowserSidebarStateSnapshot {
    return { tabs: [...this.tabs.values()] };
  }

  getTabSnapshot(identity: BrowserSidebarTabIdentity): BrowserSidebarTabSnapshot | null {
    return this.tabs.get(browserTabKey(identity)) ?? null;
  }

  listPendingBrowserUsePresentationRequests(
    browserViewScopeId: string,
  ): BrowserUsePresentationRequest[] {
    const now = Date.now();
    const requests: BrowserUsePresentationRequest[] = [];
    for (const [key, pending] of this.pendingBrowserUsePresentations) {
      if (pending.expiresAt <= now) {
        this.pendingBrowserUsePresentations.delete(key);
        continue;
      }
      if (pending.request.browserViewScopeId === browserViewScopeId) {
        requests.push(pending.request);
      }
    }
    return requests;
  }

  listTabSnapshots(
    browserConversationId: string,
    browserViewScopeId: string,
  ): BrowserSidebarTabSnapshot[] {
    return [...this.tabs.values()].filter(
      (tab) =>
        tab.browserConversationId === browserConversationId &&
        tab.browserViewScopeId === browserViewScopeId,
    );
  }

  getWebContentsForTab(identity: BrowserSidebarTabIdentity): BrowserWebContentsLike | null {
    const snapshot = this.tabs.get(browserTabKey(identity));
    return snapshot ? this.getAttachedWebContents(snapshot) : null;
  }

  upsertBrowserUseTab(tab: BrowserUseTabState): void {
    this.handleBrowserUseCommand({
      type: "browser-use-upsert-tab",
      tab,
    });
  }

  setActiveBrowserUseTab(
    identity: Omit<BrowserSidebarTabIdentity, "browserTabId">,
    browserTabId: string | null,
  ): void {
    this.handleBrowserUseCommand({
      type: "browser-use-set-active-tab",
      ...identity,
      browserTabId,
    });
  }

  setBrowserVisibleForBrowserUse(
    route: BrowserUseCapturedRoute,
    browserTabId: string,
    visible: boolean,
  ): void {
    const identity = {
      browserConversationId: route.browserConversationId,
      browserViewScopeId: route.browserViewScopeId,
      browserTabId,
    };
    const key = browserTabKey(identity);
    if (!this.browserUseTabs.has(key)) {
      throw new Error("Browser Use page is not available");
    }

    if (!visible) {
      this.pendingBrowserUsePresentations.delete(key);
      const request: BrowserUsePresentationRequest = {
        ...identity,
        requestId: randomUUID(),
        codexSessionId: route.codexSessionId,
        projectId: route.projectId,
        visible: false,
        transition: "default",
        source: "browser-use",
      };
      this.logger.debug("Browser Use presentation requested", {
        ...browserIdentity(request),
        requestId: request.requestId,
        transition: request.transition,
        visible: request.visible,
      });
      this.events.publish({ kind: "browserUsePresentationRequest", value: request });
      return;
    }

    this.setActiveBrowserUseTab(identity, browserTabId);
    if (this.isBrowserVisibleForBrowserUse(route, browserTabId)) return;

    const request: BrowserUsePresentationRequest = {
      ...identity,
      requestId: randomUUID(),
      codexSessionId: route.codexSessionId,
      projectId: route.projectId,
      visible: true,
      transition: "default",
      source: "browser-use",
    };
    this.pendingBrowserUsePresentations.set(key, {
      request,
      expiresAt: Date.now() + BROWSER_USE_PRESENTATION_TIMEOUT_MS,
    });
    this.logger.debug("Browser Use presentation requested", {
      ...browserIdentity(request),
      requestId: request.requestId,
      transition: request.transition,
      visible: request.visible,
    });
    this.events.publish({ kind: "browserUsePresentationRequest", value: request });
  }

  isBrowserVisibleForBrowserUse(route: BrowserUseCapturedRoute, browserTabId: string): boolean {
    const identity = {
      browserConversationId: route.browserConversationId,
      browserViewScopeId: route.browserViewScopeId,
      browserTabId,
    };
    if (
      this.browserUseActiveTabIdsByConversationScope.get(browserConversationScopeKey(identity)) !==
      browserTabId
    ) {
      return false;
    }

    const key = browserTabKey(identity);
    const pending = this.pendingBrowserUsePresentations.get(key);
    if (pending && pending.expiresAt <= Date.now()) {
      this.pendingBrowserUsePresentations.delete(key);
      this.logger.warn("Browser Use presentation timed out", {
        ...browserIdentity(identity),
        requestId: pending.request.requestId,
      });
    }
    if (pending && pending.expiresAt > Date.now()) return true;

    const snapshot = this.tabs.get(key);
    return snapshot?.presented === true && snapshot.visible === true;
  }

  resolveBrowserUsePresentation(result: BrowserUsePresentationResult): void {
    const key = browserTabKey(result);
    const pending = this.pendingBrowserUsePresentations.get(key);
    if (!pending || pending.request.requestId !== result.requestId) return;
    if (result.outcome === "accepted") {
      this.logger.debug("Browser Use presentation accepted", {
        ...browserIdentity(result),
        requestId: result.requestId,
      });
      return;
    }
    this.pendingBrowserUsePresentations.delete(key);
    this.logger.warn("Browser Use presentation was not accepted", {
      ...browserIdentity(result),
      outcome: result.outcome,
      message: result.message?.slice(0, 1_024),
    });
  }

  setBrowserUseCursor(cursor: BrowserUseCursorState): boolean {
    const tab = this.tabs.get(browserTabKey(cursor));
    const isPresented = tab?.presented === true && tab.visible === true;
    this.handleBrowserUseCommand({
      type: "browser-use-set-cursor",
      cursor: {
        ...cursor,
        animateMovement: isPresented && cursor.animateMovement !== false,
      },
    });
    return isPresented && cursor.visible;
  }

  setBrowserUseViewport(event: BrowserSidebarBrowserUseViewportEvent): void {
    this.handleBrowserUseCommand({
      type: "browser-use-set-viewport",
      event,
    });
  }

  setBrowserUseCaptureSurface(event: BrowserSidebarBrowserUseCaptureSurfaceEvent): void {
    this.handleBrowserUseCommand({
      type: "browser-use-set-capture-surface",
      event,
    });
  }

  releaseBrowserUseTab(identity: BrowserSidebarTabIdentity): void {
    this.handleBrowserUseCommand({
      type: "browser-use-release-tab",
      ...identity,
    });
  }

  releaseBrowserUseDebugger(contents: BrowserWebContentsLike): void {
    const debuggerPort = contents.debugger;
    if (
      !debuggerPort ||
      contents.isDestroyed() ||
      !debuggerPort.isAttached() ||
      this.pageEmulation.isDebuggerRetained(contents)
    ) {
      return;
    }
    try {
      debuggerPort.detach?.();
    } catch {
      // The WebContents lifecycle remains authoritative during teardown.
    }
  }

  getIdentityForWebContents(webContentsId: number): BrowserSidebarTabIdentity | null {
    const tabKey = this.webContentsTabIds.get(webContentsId);
    const tab = tabKey ? this.tabs.get(tabKey) : null;
    if (tab) return browserIdentity(tab);
    const ownership = this.attachedWebviewOwnership.get(webContentsId);
    return ownership ? browserIdentity(ownership.identity) : null;
  }

  getOwnerWebContentsIdForGuest(webContentsId: number): number | null {
    return this.attachedWebviewOwnership.get(webContentsId)?.ownerWebContentsId ?? null;
  }

  startBrowserImageDrag(guestWebContentsId: number, sourceUrl: string): boolean {
    const ownership = this.attachedWebviewOwnership.get(guestWebContentsId);
    if (!ownership || sourceUrl.length === 0 || sourceUrl.length > 16_384) {
      return false;
    }
    try {
      const parsed = new URL(sourceUrl);
      if (parsed.username || parsed.password) return false;
    } catch {
      return false;
    }
    const active: ActiveBrowserImageDrag = {
      ...browserIdentity(ownership.identity),
      guestWebContentsId,
      ownerWebContentsId: ownership.ownerWebContentsId,
      sourceUrl,
    };
    this.clearBrowserImageDrag(ownership.ownerWebContentsId);
    this.activeImageDragsByOwnerWebContentsId.set(ownership.ownerWebContentsId, active);
    this.events.publish({
      kind: "imageDragState",
      value: { ...browserIdentity(active), isActive: true },
    });
    return true;
  }

  endBrowserImageDrag(guestWebContentsId: number): void {
    const ownership = this.attachedWebviewOwnership.get(guestWebContentsId);
    if (!ownership) return;
    const active = this.activeImageDragsByOwnerWebContentsId.get(ownership.ownerWebContentsId);
    if (active?.guestWebContentsId !== guestWebContentsId) return;
    this.clearBrowserImageDrag(ownership.ownerWebContentsId);
  }

  isBrowserUseIdentity(identity: BrowserSidebarTabIdentity): boolean {
    const tab = this.browserUseTabs.get(browserTabKey(identity));
    return Boolean(tab && !tab.released);
  }

  setDownloadActive(identity: BrowserSidebarTabIdentity, activeDownload: boolean): void {
    const key = browserTabKey(identity);
    if (this.tabs.get(key)?.activeDownload === activeDownload) return;
    if (!this.tabs.has(key)) return;
    this.updateTab(key, { activeDownload });
  }

  getConversationBrowserTabIds(
    browserConversationId: string,
    browserViewScopeId: string,
  ): string[] {
    const orderedIds: string[] = [];
    const seenIds = new Set<string>();
    const append = (browserTabId: string) => {
      if (seenIds.has(browserTabId)) return;
      seenIds.add(browserTabId);
      orderedIds.push(browserTabId);
    };
    for (const tab of this.browserUseTabs.values()) {
      if (
        tab.browserConversationId !== browserConversationId ||
        tab.browserViewScopeId !== browserViewScopeId ||
        tab.released
      ) {
        continue;
      }
      append(tab.browserTabId);
    }
    for (const tab of this.tabs.values()) {
      if (
        tab.browserConversationId !== browserConversationId ||
        tab.browserViewScopeId !== browserViewScopeId
      ) {
        continue;
      }
      if (tab.webContentsId === null) continue;
      append(tab.browserTabId);
    }
    return orderedIds;
  }

  closeBrowserTab(
    identity: BrowserSidebarTabIdentity,
    reason: BrowserUsePageClosedEvent["reason"] = "agent",
  ): Effect.Effect<void> {
    return Effect.gen(
      function* (this: BrowserState) {
        const key = browserTabKey(identity);
        const browserStorageId = this.tabs.get(key)?.browserStorageId;
        let deletePage = Effect.void;
        if (browserStorageId) {
          this.invalidatedPageStorageIds.add(browserStorageId);
          this.preparedPagesByStorageId.delete(browserStorageId);
          deletePage =
            this.pageStore?.delete(browserStorageId).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  this.logger.warn("Failed to delete Browser page snapshot", {
                    browserStorageId,
                    error: readBoundedErrorMessage(error),
                  }),
                ),
              ),
            ) ?? Effect.void;
        }
        const hadOrdinaryTab = this.tabs.has(key);
        const hadBrowserUseTab = this.browserUseTabs.has(key);
        if (hadOrdinaryTab) this.unregisterTab(key);

        this.browserUseTabs.delete(key);
        this.browserUseCursors.delete(key);
        this.browserUseViewportSizes.delete(key);
        this.browserUseCaptureSurfaces.delete(key);
        this.deviceToolbarStates.delete(key);
        this.pendingBrowserUsePresentations.delete(key);
        if (
          this.browserUseActiveTabIdsByConversationScope.get(
            browserConversationScopeKey(identity),
          ) === identity.browserTabId
        ) {
          this.browserUseActiveTabIdsByConversationScope.delete(
            browserConversationScopeKey(identity),
          );
        }

        const conversationScopeKey = browserConversationScopeKey(identity);
        const transferredIds =
          this.transferredBrowserTabIdsByConversationScope.get(conversationScopeKey);
        if (transferredIds) {
          const remainingIds = transferredIds.filter(
            (browserTabId) => browserTabId !== identity.browserTabId,
          );
          if (remainingIds.length > 0) {
            this.transferredBrowserTabIdsByConversationScope.set(
              conversationScopeKey,
              remainingIds,
            );
          } else {
            this.transferredBrowserTabIdsByConversationScope.delete(conversationScopeKey);
          }
        }

        this.emitBrowserUseState();
        if (hadOrdinaryTab || hadBrowserUseTab) {
          this.events.publish({
            kind: "pageClosed",
            value: { ...browserIdentity(identity), reason },
          });
        }
        yield* deletePage;
      }.bind(this),
    );
  }

  closeBrowserTabAcrossScopes(
    browserConversationId: string,
    browserTabId: string,
  ): Effect.Effect<void> {
    const identities = new Map<string, BrowserSidebarTabIdentity>();
    const collect = (identity: BrowserSidebarTabIdentity): void => {
      if (
        identity.browserConversationId !== browserConversationId ||
        identity.browserTabId !== browserTabId
      ) {
        return;
      }
      identities.set(browserTabKey(identity), browserIdentity(identity));
    };
    for (const tab of this.tabs.values()) collect(tab);
    for (const tab of this.browserUseTabs.values()) collect(tab);
    return Effect.forEach(identities.values(), (identity) => this.closeBrowserTab(identity), {
      discard: true,
    });
  }

  closeBrowserConversation(browserConversationId: string): Effect.Effect<void> {
    return Effect.gen(
      function* (this: BrowserState) {
        const identities = new Map<string, BrowserSidebarTabIdentity>();
        const appendIdentity = (identity: BrowserSidebarTabIdentity) => {
          if (identity.browserConversationId !== browserConversationId) return;
          identities.set(browserTabKey(identity), browserIdentity(identity));
        };
        for (const tab of this.tabs.values()) appendIdentity(tab);
        for (const tab of this.browserUseTabs.values()) appendIdentity(tab);
        for (const cursor of this.browserUseCursors.values()) appendIdentity(cursor);
        for (const viewport of this.browserUseViewportSizes.values()) appendIdentity(viewport);
        for (const surface of this.browserUseCaptureSurfaces.values()) appendIdentity(surface);
        for (const teardown of this.pendingTeardowns.values()) appendIdentity(teardown);
        const keyPrefix = `${browserConversationId}\0`;
        for (const key of this.tabs.keys()) {
          if (!key.startsWith(keyPrefix)) continue;
          const tab = this.tabs.get(key);
          if (tab) appendIdentity(tab);
        }

        for (const identity of identities.values()) {
          yield* this.closeBrowserTab(identity);
        }
        for (const key of this.deviceToolbarStates.keys()) {
          if (key.startsWith(keyPrefix)) this.deviceToolbarStates.delete(key);
        }
        for (const key of this.browserUseActiveTabIdsByConversationScope.keys()) {
          if (key.startsWith(keyPrefix)) {
            this.browserUseActiveTabIdsByConversationScope.delete(key);
          }
        }
        for (const key of this.transferredBrowserTabIdsByConversationScope.keys()) {
          if (key.startsWith(keyPrefix)) {
            this.transferredBrowserTabIdsByConversationScope.delete(key);
          }
        }
        this.emitBrowserUseState();
      }.bind(this),
    );
  }

  getDeviceToolbarTabState(
    identity: BrowserSidebarTabIdentity,
  ): BrowserSidebarTabSnapshot["deviceToolbarState"] {
    return (
      this.deviceToolbarStates.get(browserTabKey(identity)) ?? makeDefaultDeviceToolbarState(false)
    );
  }

  primeTransferredBrowserTabId(
    browserConversationId: string,
    browserViewScopeId: string,
    browserTabId: string,
  ): void {
    const conversationScopeKey = browserConversationScopeKey({
      browserConversationId,
      browserViewScopeId,
    });
    this.transferredBrowserTabIdsByConversationScope.set(conversationScopeKey, [
      ...(this.transferredBrowserTabIdsByConversationScope.get(conversationScopeKey) ?? []),
      browserTabId,
    ]);
  }

  openClonedBrowserTab(
    input: Omit<BrowserSidebarClonedTabInput, "deviceToolbarState">,
  ): BrowserSidebarTabSnapshot {
    const transferredIds =
      this.transferredBrowserTabIdsByConversationScope.get(browserConversationScopeKey(input)) ??
      [];
    const defaultBrowserTabId = makeDefaultBrowserSidebarTabId(input.browserConversationId);
    const browserTabId =
      input.browserTabId === defaultBrowserTabId || transferredIds.includes(input.browserTabId)
        ? input.browserTabId
        : defaultBrowserTabId;
    const identity = {
      browserConversationId: input.browserConversationId,
      browserViewScopeId: input.browserViewScopeId,
      browserTabId,
    };
    const key = browserTabKey(identity);
    const existing = this.tabs.get(key);
    const requestedUrl = normalizeBrowserNavigationUrl(input.initialUrl);
    const url = isAllowedBrowserNavigationUrl(requestedUrl) ? requestedUrl : "about:blank";
    const deviceToolbarState = this.getDeviceToolbarTabState(identity);
    const viewport = viewportFromDeviceToolbarState(
      deviceToolbarState,
      existing?.zoomPercent ?? 100,
    );
    const snapshot = this.upsertTab({
      ...(existing ?? {
        ...identity,
        browserStorageId: input.browserStorageId ?? `browser:legacy:${browserTabId}`,
        webContentsId: null,
        mountGeneration: 0,
        title: "New tab",
        isLoading: false,
        isWaitingForResponse: false,
        canGoBack: false,
        canGoForward: false,
        zoomPercent: 100,
        interactionMode: "browse" as const,
        findState: DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
        hasBrowserPage: false,
        pageActionsDisabled: true,
        presented: false,
        visible: false,
        lastSelectedAt: 0,
        audible: false,
        mediaActive: false,
        activeDownload: false,
        lifecycleState: "cold" as const,
        restoreResult: "missing" as const,
        updatedAt: Date.now(),
      }),
      projectId: input.projectId,
      url,
      pendingUrl: input.initialUrl === undefined ? undefined : url,
      errorMessage: url === requestedUrl ? undefined : "Blocked an unsupported Browser URL",
      deviceToolbarVisible: deviceToolbarState.toolbarState.isEnabled,
      viewport,
      deviceToolbarState,
      updatedAt: Date.now(),
    });
    this.emitState();
    return snapshot;
  }

  setDeviceToolbarTabState(
    identity: BrowserSidebarTabIdentity,
    deviceToolbarState: BrowserSidebarTabSnapshot["deviceToolbarState"],
  ): void {
    const key = browserTabKey(identity);
    this.deviceToolbarStates.set(key, deviceToolbarState);
    const existing = this.tabs.get(key);
    if (!existing) return;
    this.updateTab(key, {
      deviceToolbarVisible: deviceToolbarState.toolbarState.isEnabled,
      viewport: viewportFromDeviceToolbarState(deviceToolbarState, existing.zoomPercent),
      deviceToolbarState,
    });
  }

  primeClonedTab(input: BrowserSidebarClonedTabInput): BrowserSidebarTabSnapshot {
    const snapshot = this.openClonedBrowserTab(input);
    this.setDeviceToolbarTabState(input, input.deviceToolbarState);
    return snapshot;
  }

  getBrowserUseStateSnapshot(): BrowserSidebarBrowserUseStateSnapshot {
    return {
      tabs: [...this.browserUseTabs.values()],
      activeBrowserTabIdsByConversationScope: Object.fromEntries(
        this.browserUseActiveTabIdsByConversationScope,
      ),
      cursors: [...this.browserUseCursors.values()],
    };
  }

  hasPresentedBrowserUseSurfaceForThread(threadId: string, ownerWebContentsId?: number): boolean {
    for (const browserUseTab of this.browserUseTabs.values()) {
      if (browserUseTab.codexSessionId !== threadId) continue;
      if (
        ownerWebContentsId !== undefined &&
        (browserUseTab.webContentsId === null ||
          this.getOwnerWebContentsIdForGuest(browserUseTab.webContentsId) !== ownerWebContentsId)
      ) {
        continue;
      }
      const snapshot = this.tabs.get(browserTabKey(browserUseTab));
      if (snapshot?.presented === true && snapshot.visible === true) return true;
    }
    return false;
  }

  admitLocalServerThumbnail(
    input: BrowserSidebarLocalServerThumbnailRequest,
  ): BrowserLocalServerThumbnailAdmission {
    const tab = this.tabs.get(browserTabKey(input));
    if (!tab || tab.projectId !== input.projectId) {
      return {
        _tag: "Denied",
        result: {
          status: "unavailable",
          message: "Local server preview does not belong to this Browser tab",
        },
      };
    }
    if (!URL.canParse(input.url)) {
      return {
        _tag: "Denied",
        result: {
          status: "unavailable",
          message: "Local server preview URL is invalid",
        },
      };
    }
    return { _tag: "Allowed", url: input.url };
  }

  registerAttachedWebviewOwnership(
    ownerWebContentsId: number,
    guestWebContentsId: number,
    identity: BrowserSidebarTabIdentity | BrowserAttachmentRoute,
    browserStorageId?: string,
  ): void {
    this.attachedWebviewOwnership.set(guestWebContentsId, {
      ownerWebContentsId,
      identity: browserIdentity(identity),
      browserStorageId,
      ...("rendererInstanceId" in identity
        ? {
            rendererInstanceId: identity.rendererInstanceId,
            hostGeneration: identity.hostGeneration,
            mountGeneration: identity.mountGeneration,
          }
        : {}),
    });
  }

  prepareAttachedWebviewHistoryRestore(
    route: BrowserAttachmentRoute,
    guestWebContentsId: number,
  ): void {
    const contents = this.electron.webContentsFromId(guestWebContentsId);
    const preparedPage = this.preparedPagesByStorageId.get(route.browserStorageId);
    const key = browserTabKey(route);
    if (
      !contents ||
      contents.isDestroyed() ||
      !preparedPage ||
      this.tabs.get(key)?.browserStorageId !== route.browserStorageId ||
      this.earlyPageRestores.result(guestWebContentsId) !== null
    ) {
      return;
    }

    // Electron accepts navigationHistory.restore only before the guest has
    // completed its first page load. did-attach-webview is the one public
    // lifecycle boundary where the WebContents exists and restoration can
    // still begin synchronously.
    this.earlyPageRestores.start(guestWebContentsId, (lease) =>
      this.restoreSavedPage(key, contents, preparedPage, lease),
    );
  }

  isRegisteredBrowserStorage(
    identity: BrowserSidebarTabIdentity,
    browserStorageId: string | undefined,
  ): boolean {
    const snapshot = this.tabs.get(browserTabKey(identity));
    return (
      snapshot !== undefined &&
      snapshot.browserStorageId !== undefined &&
      snapshot.browserStorageId === browserStorageId
    );
  }

  clearBrowsingData(
    kind: Exclude<BrowserBrowsingDataKind, "downloads">,
  ): Effect.Effect<BrowserBrowsingDataClearResult> {
    return Effect.gen(
      function* (this: BrowserState) {
        if (kind === "history") {
          yield* Effect.all([
            this.pageStore?.clear ?? Effect.void,
            this.historyStore?.clear ?? Effect.void,
          ]);
          for (const tab of this.tabs.values()) {
            const contents = this.getAttachedWebContents(tab);
            if (!contents || contents.isDestroyed()) continue;
            contents.navigationHistory?.clear?.();
            this.fork(this.persistPageSnapshotForWebContents(tab.webContentsId ?? -1, contents));
          }
          return { ok: true as const };
        }
        const browserSession = this.electron.sessionFromPartition(BROWSER_SIDEBAR_PARTITION);
        if (kind === "cookies") {
          yield* Effect.promise(() => browserSession.clearData({ dataTypes: ["cookies"] }));
          return { ok: true as const };
        }
        if (kind === "site-data") {
          yield* Effect.promise(() =>
            browserSession.clearData({
              dataTypes: [
                "backgroundFetch",
                "cookies",
                "fileSystems",
                "indexedDB",
                "localStorage",
                "serviceWorkers",
                "webSQL",
              ],
            }),
          );
          return { ok: true as const };
        }
        yield* Effect.promise(() => browserSession.clearCache());
        return { ok: true as const };
      }.bind(this),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          ok: false as const,
          message: Cause.pretty(cause) || `Failed to clear ${kind}`,
        }),
      ),
    );
  }

  handleWebviewHostCreated(
    event: BrowserSidebarWebviewHostCreated,
    ownerWebContentsId?: number,
  ): Effect.Effect<BrowserSidebarCommandResult> {
    return Effect.gen(
      function* (this: BrowserState) {
        if (
          ownerWebContentsId !== undefined &&
          !this.isRegisteredWebviewOwner(event, ownerWebContentsId)
        ) {
          this.logger.warn("Rejected unowned Browser webview registration", {
            ...browserIdentity(event),
            ownerWebContentsId,
            guestWebContentsId: event.webContentsId,
          });
          return {
            ok: false,
            message: "Browser webview does not belong to the requesting window",
          };
        }
        const key = browserTabKey(event);
        const alreadyLive = this.tabs.get(key)?.webContentsId === event.webContentsId;
        const attachedSnapshot = this.attachWebview(event);
        if (!attachedSnapshot) {
          return { ok: false, message: "Browser tab is not registered" };
        }
        let snapshot: BrowserSidebarTabSnapshot = attachedSnapshot;
        const contents = this.electron.webContentsFromId(event.webContentsId);
        if (contents && !contents.isDestroyed()) {
          this.fork(this.pageEmulation.retainDebugger(contents).pipe(Effect.asVoid));
          const initialColorSchemeSync = this.syncPageColorScheme(
            attachedSnapshot,
            contents,
            this.themeVariantsByViewScope.get(event.browserViewScopeId) ?? "light",
          );
          const earlyRestore = this.earlyPageRestores.result(event.webContentsId);
          const restored = yield* Effect.exit(
            alreadyLive
              ? Effect.sync(() =>
                  this.updateTab(key, {
                    lifecycleState: attachedSnapshot.presented ? "live-attached" : "live-detached",
                    restoreResult: "already-live",
                  }),
                )
              : earlyRestore
                ? earlyRestore.await.pipe(
                    Effect.map((restored) => {
                      const attached = this.tabs.get(key) ?? restored;
                      return this.updateTab(key, {
                        lifecycleState: attached.presented ? "live-attached" : "live-detached",
                      });
                    }),
                  )
                : this.restoreSavedPage(key, contents),
          );
          if (restored._tag === "Failure") {
            if (earlyRestore && !earlyRestore.isActive()) {
              return {
                ok: false,
                message: "Browser webview was released during history restoration",
              };
            }
            return yield* Effect.failCause(restored.cause);
          }
          snapshot = restored.value;
          this.earlyPageRestores.release(event.webContentsId);
          if (snapshot.browserStorageId) {
            this.preparedPagesByStorageId.delete(snapshot.browserStorageId);
          }
          yield* initialColorSchemeSync;
          if (!contents.isDestroyed()) {
            yield* this.syncDeviceEmulation(snapshot, contents);
          }
        }
        this.events.publish({
          kind: "webviewAttached",
          value: {
            ...browserIdentity(event),
            mountGeneration: event.mountGeneration,
            webContentsId: event.webContentsId,
          },
        });
        this.enforceBrowserTabBudget(event.browserViewScopeId);
        return { ok: true as const, snapshot };
      }.bind(this),
    );
  }

  handleWebviewDestroyed(
    event: BrowserSidebarWebviewDestroyed,
  ): Effect.Effect<BrowserSidebarCommandResult> {
    return Effect.sync(() => {
      const key = browserTabKey(event);
      const current = this.tabs.get(key);
      const pending = this.pendingTeardowns.get(key);
      if (
        !pending ||
        pending.teardownId !== event.teardownId ||
        pending.mountGeneration !== event.mountGeneration ||
        pending.reason !== event.reason
      ) {
        this.logger.debug("Ignored stale browser webview destroyed ack", {
          ...browserIdentity(event),
          receivedTeardownId: event.teardownId,
          pendingTeardownId: pending?.teardownId ?? null,
        });
        return { ok: true, snapshot: current };
      }

      if (event.disposition !== "destroyed") {
        this.logger.warn("Browser webview teardown was not completed", {
          ...browserIdentity(event),
          disposition: event.disposition,
          mountGeneration: event.mountGeneration,
          reason: event.reason,
        });
        return {
          ok: false,
          message: `Browser webview teardown ${event.disposition}`,
        };
      }

      if (current && current.mountGeneration !== event.mountGeneration) {
        this.logger.debug("Ignored stale browser webview generation ack", {
          ...browserIdentity(event),
          currentMountGeneration: current.mountGeneration,
          receivedMountGeneration: event.mountGeneration,
        });
        return { ok: true, snapshot: current };
      }

      this.pendingTeardowns.delete(key);
      this.runtimeRegistry.markPendingTeardown(event, false);
      if (event.webContentsId !== undefined) {
        this.runtimeRegistry.releaseGuest(event.webContentsId);
        this.earlyPageRestores.release(event.webContentsId);
      }
      if (event.reason === "closed" || event.reason === "reset" || event.reason === "suspend") {
        this.runtimeRegistry.releaseHost(event);
      }
      if (event.webContentsId !== undefined) {
        this.attachedWebviewOwnership.delete(event.webContentsId);
      }
      this.detachWebview(key, event.webContentsId);
      this.logger.info("Browser webview destroyed", {
        ...browserIdentity(event),
        mountGeneration: event.mountGeneration,
        reason: event.reason,
      });
      return { ok: true, snapshot: this.tabs.get(key) };
    });
  }

  handleCommand(
    command: BrowserSidebarCommand,
    context: BrowserStateCommandContext = {},
  ): Effect.Effect<BrowserSidebarCommandResult, BrowserStateOperationError> {
    return Effect.gen(
      function* (this: BrowserState) {
        if (command.type === "sync-theme") {
          if (!context.browserViewScopeId) {
            return { ok: false, message: "Browser view scope is unavailable" };
          }
          this.setThemeVariantForViewScope(context.browserViewScopeId, command.themeVariant);
          return { ok: true };
        }

        if (command.type === "register-renderer-session") {
          if (context.ownerWebContentsId === undefined) {
            return { ok: false, message: "Browser renderer owner is unavailable" };
          }
          try {
            this.runtimeRegistry.registerRendererSession({
              browserViewScopeId: command.browserViewScopeId,
              ownerWebContentsId: context.ownerWebContentsId,
              rendererInstanceId: command.rendererInstanceId,
            });
            return { ok: true };
          } catch (error) {
            return { ok: false, message: readBoundedErrorMessage(error) };
          }
        }

        if (command.type === "register-host") {
          if (context.ownerWebContentsId === undefined) {
            return { ok: false, message: "Browser host owner is unavailable" };
          }
          if (!this.isRegisteredBrowserStorage(command, command.browserStorageId)) {
            return {
              ok: false,
              message: "Browser host registration failed: storage-identity-mismatch",
            };
          }
          const result = this.runtimeRegistry.registerHost(context.ownerWebContentsId, command);
          if (result.ok) {
            this.setThemeVariantForViewScope(command.browserViewScopeId, command.themeVariant);
            return { ok: true };
          }
          return {
            ok: false,
            message: `Browser host registration failed: ${result.reason}`,
          };
        }

        if (command.type === "sync-host") {
          const key = browserTabKey(command);
          const current = this.tabs.get(key);
          if (!current) {
            return { ok: false, message: "Browser tab is not registered" };
          }
          if (context.ownerWebContentsId === undefined) {
            return { ok: false, message: "Browser host owner is unavailable" };
          }
          const hostMatch = this.runtimeRegistry.matchHost(context.ownerWebContentsId, command);
          if (!hostMatch.ok) {
            return {
              ok: false,
              message: `Browser host sync failed: ${hostMatch.reason}`,
            };
          }
          if (hostMatch.registration.hostKind !== command.hostKind) {
            return {
              ok: false,
              message: "Browser host sync failed: host-kind-mismatch",
            };
          }
          const hasLiveGuest = current.webContentsId !== null;
          const snapshot = this.updateTab(key, {
            presented: command.presented,
            visible: command.visible,
            lastSelectedAt: command.presented ? Date.now() : current.lastSelectedAt,
            lifecycleState: hasLiveGuest
              ? command.presented
                ? "live-attached"
                : "live-detached"
              : current.lifecycleState,
          });
          this.setThemeVariantForViewScope(command.browserViewScopeId, command.themeVariant);
          if (command.presented && command.visible) {
            this.pendingBrowserUsePresentations.delete(key);
          }
          return { ok: true, snapshot };
        }

        if (command.type === "capture-browser-use-route") {
          return { ok: false, message: "Browser Use route requires the presentation runtime" };
        }

        if (command.type === "register-tab") {
          const key = browserTabKey(command);
          const existing = this.tabs.get(key);
          if (existing) {
            const requestedBrowserStorageId = command.browserStorageId?.trim();
            if (
              requestedBrowserStorageId &&
              existing.browserStorageId &&
              requestedBrowserStorageId !== existing.browserStorageId
            ) {
              if (!this.canAdoptProvisionalBrowserStorage(existing)) {
                return {
                  ok: false,
                  message: "Browser storage identity does not match the registered tab",
                };
              }
              const migrated = yield* this.adoptProvisionalBrowserStorage(
                existing,
                requestedBrowserStorageId,
              );
              const snapshot = this.updateTab(key, {
                projectId: command.projectId,
                title: migrated.hasBrowserPage
                  ? migrated.title
                  : command.title?.trim() || migrated.title,
                faviconUrl: command.faviconUrl ?? migrated.faviconUrl,
              });
              return { ok: true, snapshot };
            }
            const snapshot = this.updateTab(key, {
              projectId: command.projectId,
              title: existing.hasBrowserPage
                ? existing.title
                : command.title?.trim() || existing.title,
              faviconUrl: command.faviconUrl ?? existing.faviconUrl,
            });
            return { ok: true, snapshot };
          }
          const deviceToolbarVisible =
            command.deviceToolbarState?.toolbarState.isEnabled ??
            command.deviceToolbarVisible === true;
          const deviceToolbarState =
            command.deviceToolbarState ??
            this.deviceToolbarStates.get(key) ??
            makeDefaultDeviceToolbarState(deviceToolbarVisible);
          this.deviceToolbarStates.set(key, deviceToolbarState);
          const viewport = viewportFromDeviceToolbarState(deviceToolbarState, 100);
          const browserStorageId =
            command.browserStorageId ?? `browser:legacy:${command.browserTabId}`;
          this.invalidatedPageStorageIds.delete(browserStorageId);
          const savedPage = yield* this.readSavedPage(browserStorageId, browserIdentity(command));
          if (savedPage) {
            this.preparedPagesByStorageId.set(browserStorageId, savedPage);
          } else {
            this.preparedPagesByStorageId.delete(browserStorageId);
          }
          const requestedInitialUrl = normalizeBrowserNavigationUrl(command.initialUrl);
          const fallbackInitialUrl = isAllowedBrowserNavigationUrl(requestedInitialUrl)
            ? requestedInitialUrl
            : "about:blank";
          const initialUrl = savedPage?.url ?? fallbackInitialUrl;
          const snapshot = this.upsertTab({
            ...browserIdentity(command),
            browserStorageId,
            projectId: command.projectId,
            webContentsId: null,
            mountGeneration: 0,
            url: initialUrl,
            title: savedPage?.title ?? (command.title?.trim() || "New tab"),
            faviconUrl: savedPage?.faviconUrl ?? command.faviconUrl,
            isLoading: false,
            isWaitingForResponse: false,
            canGoBack: false,
            canGoForward: false,
            zoomPercent: 100,
            deviceToolbarVisible,
            viewport,
            deviceToolbarState,
            interactionMode: "browse",
            findState: DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
            hasBrowserPage: !isBlankBrowserUrl(initialUrl),
            pageActionsDisabled: isBlankBrowserUrl(initialUrl),
            presented: false,
            visible: false,
            lastSelectedAt: 0,
            audible: false,
            mediaActive: false,
            activeDownload: false,
            lifecycleState: "cold",
            restoreResult: savedPage ? "snapshot-ready" : "missing",
            errorMessage:
              fallbackInitialUrl === requestedInitialUrl
                ? undefined
                : "Blocked an unsupported Browser URL",
            updatedAt: Date.now(),
          });
          this.emitState();
          return { ok: true, snapshot };
        }

        if (command.type === "open-external") {
          let url = command.url;
          if (
            url === undefined &&
            "browserConversationId" in command &&
            "browserTabId" in command
          ) {
            url = this.tabs.get(browserTabKey(command))?.url;
          }
          if (isBlankBrowserUrl(url)) return { ok: false, message: "Browser tab has no page URL" };
          const externalUrl = normalizeBrowserNavigationUrl(url);
          if (!isAllowedBrowserExternalUrl(externalUrl)) {
            return { ok: false, message: "This URL cannot be opened externally" };
          }
          yield* tryPlatformPromise("open-external", () => this.electron.openExternal(externalUrl));
          return { ok: true };
        }

        if (isBrowserUseCommand(command)) {
          this.handleBrowserUseCommand(command);
          return { ok: true };
        }

        if (command.type === "browser-use-cursor-arrived") {
          this.events.publish({
            kind: "browserUseCursorArrived",
            value: {
              ...browserIdentity(command),
              moveSequence: command.moveSequence,
              ownerWebContentsId: context.ownerWebContentsId ?? null,
            },
          });
          return { ok: true };
        }

        if (command.type === "close-tab") {
          yield* this.closeBrowserTab(command, "user");
          return { ok: true };
        }

        if (
          command.type === "local-servers-refresh" ||
          command.type === "hide-local-server" ||
          command.type === "unhide-local-server" ||
          command.type === "remove-local-server-route"
        ) {
          return { ok: false, message: "Local server command is unavailable at this boundary" };
        }

        const key = browserTabKey(command);
        const tab = this.tabs.get(key);
        if (!tab) return { ok: false, message: "Browser tab is not registered" };

        if (command.type === "set-title") {
          const snapshot = this.updateTab(key, { title: command.title.trim() || "New tab" });
          return { ok: true, snapshot };
        }

        if (command.type === "set-favicon") {
          const snapshot = this.updateTab(key, { faviconUrl: command.faviconUrl });
          return { ok: true, snapshot };
        }

        if (command.type === "step-zoom") {
          const zoomPercent = stepZoomPercent(tab.zoomPercent, command.delta);
          const contents = this.getAttachedWebContents(tab);
          if (contents && !contents.isDestroyed()) contents.setZoomFactor(zoomPercent / 100);
          const snapshot = this.updateTab(key, {
            zoomPercent,
            viewport: { ...tab.viewport, zoomPercent },
          });
          return { ok: true, snapshot };
        }

        if (command.type === "set-zoom-percent") {
          const zoomPercent = clampZoomPercent(command.zoomPercent);
          const contents = this.getAttachedWebContents(tab);
          if (contents && !contents.isDestroyed()) contents.setZoomFactor(zoomPercent / 100);
          const snapshot = this.updateTab(key, {
            zoomPercent,
            viewport: { ...tab.viewport, zoomPercent },
          });
          return { ok: true, snapshot };
        }

        if (command.type === "reset-zoom") {
          const contents = this.getAttachedWebContents(tab);
          if (contents && !contents.isDestroyed()) contents.setZoomFactor(1);
          const snapshot = this.updateTab(key, {
            zoomPercent: 100,
            viewport: { ...tab.viewport, zoomPercent: 100 },
          });
          return { ok: true, snapshot };
        }

        if (command.type === "set-device-toolbar-visible") {
          const deviceToolbarState = updateDeviceToolbarState(tab.deviceToolbarState, {
            isEnabled: command.visible,
          });
          this.deviceToolbarStates.set(key, deviceToolbarState);
          const snapshot = this.updateTab(key, {
            deviceToolbarVisible: command.visible,
            deviceToolbarState,
          });
          const contents = this.getAttachedWebContents(snapshot);
          if (contents && !contents.isDestroyed()) {
            this.fork(this.syncDeviceEmulation(snapshot, contents));
          }
          return { ok: true, snapshot };
        }

        if (command.type === "set-viewport") {
          const deviceToolbarState = updateDeviceToolbarState(tab.deviceToolbarState, {
            viewport: command.viewport,
          });
          this.deviceToolbarStates.set(key, deviceToolbarState);
          const snapshot = this.updateTab(key, {
            viewport: command.viewport,
            deviceToolbarState,
          });
          const contents = this.getAttachedWebContents(snapshot);
          if (snapshot.deviceToolbarVisible && contents && !contents.isDestroyed()) {
            this.fork(this.syncDeviceEmulation(snapshot, contents));
          }
          this.syncBrowserUseViewport(command, command.viewport);
          return { ok: true, snapshot };
        }

        if (command.type === "set-interaction-mode") {
          const snapshot = this.updateTab(key, { interactionMode: command.mode });
          return { ok: true, snapshot };
        }

        if (command.type === "quick-annotate") {
          const contents = this.getAttachedWebContents(tab);
          if (!contents || contents.isDestroyed()) {
            return { ok: false, message: "Browser webview is not attached" };
          }
          const snapshot = this.updateTab(key, { interactionMode: "comment" });
          contents.send("browser-annotation-mode", {
            enabled: true,
            selectionMode: "inspect",
            sessionId: command.sessionId,
          });
          contents.send("browser-annotation-quick-select", {
            sessionId: command.sessionId,
            x: command.point.x,
            y: command.point.y,
          });
          return { ok: true, snapshot };
        }

        if (command.type === "open-find") {
          const snapshot = this.updateTab(key, { findState: { ...tab.findState, open: true } });
          return { ok: true, snapshot };
        }

        if (command.type === "close-find") {
          const contents = this.getAttachedWebContents(tab);
          contents?.stopFindInPage?.("clearSelection");
          const snapshot = this.updateTab(key, {
            findState: { ...DEFAULT_BROWSER_SIDEBAR_FIND_STATE },
          });
          return { ok: true, snapshot };
        }

        if (command.type === "set-find-query") {
          const contents = this.getAttachedWebContents(tab);
          const query = command.query;
          if (query.trim().length > 0) {
            contents?.findInPage?.(query, {
              forward: true,
              findNext: false,
              matchCase: command.caseSensitive === true,
            });
          } else {
            contents?.stopFindInPage?.("clearSelection");
          }
          const snapshot = this.updateTab(key, {
            findState: {
              open: true,
              query,
              activeMatchOrdinal: null,
              matchCount: null,
              caseSensitive: command.caseSensitive === true,
            },
          });
          return { ok: true, snapshot };
        }

        if (command.type === "find-next" || command.type === "find-previous") {
          const query = tab.findState.query.trim();
          if (query.length > 0) {
            const forward = command.type === "find-next";
            this.getAttachedWebContents(tab)?.findInPage?.(query, {
              forward,
              findNext: true,
              matchCase: tab.findState.caseSensitive,
            });
          }
          return { ok: true, snapshot: tab };
        }

        if (command.type === "navigate") {
          return yield* this.navigate(tab, command.url);
        }

        const contents = this.getAttachedWebContents(tab);
        if (!contents || contents.isDestroyed())
          return { ok: false, message: "Browser webview is not attached" };

        if (command.type === "attach-dragged-image") {
          const ownerWebContentsId = context.ownerWebContentsId;
          if (ownerWebContentsId === undefined) {
            return { ok: false, message: "Browser renderer owner is unavailable" };
          }
          const active = this.activeImageDragsByOwnerWebContentsId.get(ownerWebContentsId);
          if (
            !active ||
            browserTabKey(active) !== key ||
            active.guestWebContentsId !== tab.webContentsId
          ) {
            return {
              ok: false,
              message: "No matching Browser image drag is active",
            };
          }
          this.clearBrowserImageDrag(ownerWebContentsId);
          return yield* this.attachContextMenuImage(
            active.guestWebContentsId,
            contents,
            tab,
            active.sourceUrl,
          );
        }

        if (command.type === "go-back") {
          if (contents.canGoBack()) contents.goBack();
          return { ok: true };
        }

        if (command.type === "go-forward") {
          if (contents.canGoForward()) contents.goForward();
          return { ok: true };
        }

        if (command.type === "reload") {
          if (command.ignoreCache) contents.reloadIgnoringCache();
          else contents.reload();
          return { ok: true };
        }

        if (command.type === "stop") {
          contents.stop();
          this.refreshSnapshotFromWebContents(key, contents, {
            isLoading: false,
            isWaitingForResponse: false,
          });
          return { ok: true };
        }

        if (command.type === "capture-screenshot") {
          const image = yield* tryPlatformPromise("capture-screenshot", () =>
            contents.capturePage(),
          );
          yield* this.clipboard
            .writeImage(image)
            .pipe(
              Effect.mapError(
                (cause) => new BrowserStateOperationError({ operation: "copy-screenshot", cause }),
              ),
            );
          return { ok: true };
        }

        if (command.type === "print") {
          if (!contents.print) {
            return { ok: false, message: "Printing is unavailable" };
          }
          return yield* Effect.callback<BrowserSidebarCommandResult>((resume) => {
            contents.print?.({ printBackground: true }, (success, failureReason) => {
              resume(
                Effect.succeed(
                  success
                    ? { ok: true }
                    : {
                        ok: false,
                        message: failureReason || "Printing failed",
                      },
                ),
              );
            });
          });
        }

        return { ok: false, message: "Unsupported browser command" };
      }.bind(this),
    ).pipe(Effect.map((result) => result as BrowserSidebarCommandResult));
  }

  private showBrowserContextMenu(
    webContentsId: number,
    contents: BrowserWebContentsLike,
    params: BrowserContextMenuParams,
  ): void {
    const ownership = this.attachedWebviewOwnership.get(webContentsId);
    const tabId = this.webContentsTabIds.get(webContentsId);
    const tab = tabId ? this.tabs.get(tabId) : null;
    if (!ownership || !tab || contents.isDestroyed()) return;

    const identity = browserIdentity(ownership.identity);
    const annotationScale = Math.max(tab.zoomPercent / 100, 0.01);
    const template = buildBrowserContextMenuTemplate({
      canAnnotate: this.siteStatus.cachedCommentModeBlocked(tab.url) !== true,
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      canReload: tab.hasBrowserPage || tab.failure !== undefined,
      params,
      actions: {
        annotate: (action) => {
          this.events.publish({
            kind: "contextMenuAction",
            value: {
              ...identity,
              action,
              point: {
                x: params.x / annotationScale,
                y: params.y / annotationScale,
              },
            },
          });
        },
        attachImage: (sourceUrl) => {
          this.fork(
            this.attachContextMenuImage(webContentsId, contents, tab, sourceUrl).pipe(
              Effect.asVoid,
            ),
          );
        },
        back: () => {
          if (!contents.isDestroyed() && contents.canGoBack()) contents.goBack();
        },
        copyLink: (url) => {
          this.fork(
            this.clipboard
              .writeText(url)
              .pipe(Effect.catch(() => Effect.logWarning("Browser link could not be copied"))),
          );
        },
        forward: () => {
          if (!contents.isDestroyed() && contents.canGoForward()) contents.goForward();
        },
        inspect: (point) => {
          if (!contents.isDestroyed()) contents.inspectElement(point.x, point.y);
        },
        openExternal: (url) => {
          if (isAllowedBrowserExternalUrl(url)) {
            this.fork(Effect.promise(() => this.electron.openExternal(url)).pipe(Effect.asVoid));
          }
        },
        openLink: (url) => {
          if (!isAllowedBrowserNavigationUrl(url)) return;
          this.events.publish({
            kind: "openNewTab",
            value: { ...identity, url, background: false },
          });
        },
        reload: () => {
          if (!contents.isDestroyed()) contents.reload();
        },
      },
    });

    try {
      this.contextMenuPresenter(template, ownership.ownerWebContentsId);
    } catch (error) {
      this.logger.warn("Failed to present Browser context menu", {
        ...identity,
        error: readBoundedErrorMessage(error),
      });
    }
  }

  private clearBrowserImageDrag(ownerWebContentsId: number): void {
    const active = this.activeImageDragsByOwnerWebContentsId.get(ownerWebContentsId);
    if (!active) return;
    this.activeImageDragsByOwnerWebContentsId.delete(ownerWebContentsId);
    this.events.publish({
      kind: "imageDragState",
      value: { ...browserIdentity(active), isActive: false },
    });
  }

  private attachContextMenuImage(
    webContentsId: number,
    contents: BrowserWebContentsLike,
    tab: BrowserSidebarTabSnapshot,
    sourceUrl: string,
  ): Effect.Effect<BrowserSidebarCommandResult> {
    const identity = browserIdentity(tab);
    return Effect.gen(
      function* (this: BrowserState) {
        const fetched = yield* Effect.exit(
          Effect.promise(() =>
            fetchBrowserImage({
              fetch: contents.session.fetch.bind(contents.session),
              pageUrl: tab.url,
              sourceUrl,
            }),
          ),
        );
        if (fetched._tag === "Failure") {
          const message = Cause.pretty(fetched.cause);
          this.events.publish({
            kind: "contextMenuAction",
            value: { ...identity, action: "error", message },
          });
          this.logger.warn("Failed to attach Browser image", { ...identity, error: message });
          return { ok: false as const, message };
        }
        if (
          contents.isDestroyed() ||
          this.webContentsTabIds.get(webContentsId) !== browserTabKey(tab)
        ) {
          return {
            ok: false,
            message: "Browser page changed before the image was attached",
          };
        }
        const saved = this.saveBrowserImage({
          name: fetched.value.name,
          mimeType: fetched.value.mimeType,
          bytes: fetched.value.bytes,
        });
        this.events.publish({
          kind: "contextMenuAction",
          value: {
            ...identity,
            action: "image-attached",
            attachment: {
              id: saved.fileName,
              fileName: fetched.value.name,
              source: saved.source,
            },
          },
        });
        return { ok: true } as const;
      }.bind(this),
    );
  }

  private navigate(
    tab: BrowserSidebarTabSnapshot,
    rawUrl: string,
  ): Effect.Effect<BrowserSidebarCommandResult> {
    const key = browserTabKey(tab);
    const url = normalizeBrowserNavigationUrl(rawUrl);
    if (!isAllowedBrowserNavigationUrl(url)) {
      return Effect.succeed({
        ok: false,
        message: "This URL is not allowed in the built-in Browser",
      });
    }
    if (isBlankBrowserUrl(url)) {
      const snapshot = this.updateTab(key, {
        url: "about:blank",
        pendingUrl: undefined,
        title: "New tab",
        isLoading: false,
        isWaitingForResponse: false,
        canGoBack: false,
        canGoForward: false,
        errorMessage: undefined,
        failure: undefined,
      });
      const browserStorageId = tab.browserStorageId;
      if (browserStorageId) {
        this.invalidatedPageStorageIds.add(browserStorageId);
        if (this.pageStore) {
          this.fork(
            this.pageStore.delete(browserStorageId).pipe(
              Effect.catch((error) =>
                Effect.sync(() =>
                  this.logger.warn("Failed to reset Browser page snapshot", {
                    browserStorageId,
                    error: readBoundedErrorMessage(error),
                  }),
                ),
              ),
            ),
          );
        }
      }
      this.requestDestroyWebview(key, "reset");
      return Effect.succeed({ ok: true, snapshot });
    }

    const contents = this.getAttachedWebContents(tab);
    const snapshot = this.updateTab(key, {
      url,
      pendingUrl: url,
      isLoading: Boolean(contents && !contents.isDestroyed()),
      isWaitingForResponse: Boolean(contents && !contents.isDestroyed()),
      errorMessage: undefined,
      failure: undefined,
    });

    if (!contents || contents.isDestroyed()) {
      this.logger.info("Browser navigate queued until webview host attaches", {
        ...browserIdentity(tab),
        hasUrl: url.length > 0,
      });
      return Effect.succeed({ ok: true, snapshot });
    }

    this.logger.info("Browser navigate start", { ...browserIdentity(tab), hasUrl: url.length > 0 });
    this.fork(
      Effect.promise(() => Promise.resolve(contents.loadURL(url))).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            this.refreshSnapshotFromWebContents(key, contents, {
              isWaitingForResponse: false,
              pendingUrl: undefined,
            }),
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const message = Cause.pretty(cause);
            if (message.includes("ERR_ABORTED")) {
              this.logger.debug("Browser navigate aborted", {
                ...browserIdentity(tab),
                hasUrl: url.length > 0,
              });
              return;
            }
            this.logger.warn("Browser navigate failed", {
              ...browserIdentity(tab),
              message,
            });
            this.updateTab(key, {
              isLoading: false,
              isWaitingForResponse: false,
              pendingUrl: undefined,
              errorMessage: message || "Failed to load page",
            });
          }),
        ),
      ),
    );
    return Effect.succeed({ ok: true, snapshot });
  }

  private upsertTab(snapshot: BrowserSidebarTabSnapshot): BrowserSidebarTabSnapshot {
    const next = deriveBrowserSnapshot(snapshot);
    this.tabs.set(browserTabKey(next), next);
    return next;
  }

  private updateTab(
    key: string,
    patch: Partial<
      Omit<BrowserSidebarTabSnapshot, "browserConversationId" | "browserTabId" | "updatedAt">
    >,
  ): BrowserSidebarTabSnapshot {
    const current = this.tabs.get(key);
    if (!current) throw new Error("Browser tab is not registered");
    const next = {
      ...current,
      ...patch,
      updatedAt: Date.now(),
    } satisfies BrowserSidebarTabSnapshot;
    const derived = deriveBrowserSnapshot(next);
    this.tabs.set(key, derived);
    this.emitState();
    const browserUseTab = this.browserUseTabs.get(key);
    if (browserUseTab) {
      this.browserUseTabs.set(key, {
        ...browserUseTab,
        title: derived.title,
        url: derived.url,
        webContentsId: derived.webContentsId,
        viewport: derived.viewport,
        updatedAt: derived.updatedAt,
      });
      this.emitBrowserUseState();
    }
    return derived;
  }

  private unregisterTab(tabId: string): void {
    this.requestDestroyWebview(tabId, "closed");
    const tab = this.tabs.get(tabId);
    if (tab && tab.webContentsId !== null) {
      this.webContentsTabIds.delete(tab.webContentsId);
      this.webContentsListeners.release(tab.webContentsId);
    }
    this.tabs.delete(tabId);
    this.deviceToolbarStates.delete(tabId);
    this.emitState();
  }

  private isRegisteredWebviewOwner(
    event: BrowserSidebarWebviewHostCreated,
    ownerWebContentsId: number,
  ): boolean {
    const ownership = this.attachedWebviewOwnership.get(event.webContentsId);
    if (!ownership || ownership.ownerWebContentsId !== ownerWebContentsId) {
      return false;
    }
    const physicalHostMatches =
      ownership.identity.browserConversationId === event.browserConversationId &&
      ownership.identity.browserViewScopeId === event.browserViewScopeId &&
      ownership.identity.browserTabId === event.browserTabId &&
      ownership.browserStorageId === event.browserStorageId &&
      (ownership.rendererInstanceId === undefined ||
        (ownership.rendererInstanceId === event.rendererInstanceId &&
          ownership.hostGeneration === event.hostGeneration));
    if (!physicalHostMatches) return false;
    if (event.rendererInstanceId === undefined || event.hostGeneration === undefined) return true;
    const currentHost = this.runtimeRegistry.matchHost(ownerWebContentsId, {
      ...browserIdentity(event),
      rendererInstanceId: event.rendererInstanceId,
      hostGeneration: event.hostGeneration,
      mountGeneration: event.mountGeneration,
    });
    return currentHost.ok && currentHost.registration.hostKind === event.hostKind;
  }

  private attachWebview(event: BrowserSidebarWebviewHostCreated): BrowserSidebarTabSnapshot | null {
    const key = browserTabKey(event);
    const current = this.tabs.get(key);
    if (!current) return null;

    const existingKey = this.webContentsTabIds.get(event.webContentsId);
    if (existingKey && existingKey !== key) {
      this.detachWebview(existingKey, event.webContentsId);
    }
    if (current.webContentsId !== null && current.webContentsId !== event.webContentsId) {
      this.detachWebview(key, current.webContentsId);
    }

    this.webContentsTabIds.set(event.webContentsId, key);
    const contents = this.electron.webContentsFromId(event.webContentsId);
    if (contents) this.ensureWebContentsListeners(key, event.webContentsId, contents);

    this.pendingTeardowns.delete(key);
    const requestedInitialUrl = normalizeBrowserNavigationUrl(event.initialUrl);
    const initialUrl = isAllowedBrowserNavigationUrl(requestedInitialUrl)
      ? requestedInitialUrl
      : "about:blank";
    const snapshot = this.updateTab(key, {
      webContentsId: event.webContentsId,
      mountGeneration: event.mountGeneration,
      url: isBlankBrowserUrl(current.url) ? initialUrl : current.url,
      title: event.title?.trim() || current.title,
      errorMessage:
        initialUrl === requestedInitialUrl ? undefined : "Blocked an unsupported Browser URL",
      presented: event.hostKind === "panel",
      visible: event.hostKind === "panel",
      lastSelectedAt: event.hostKind === "panel" ? Date.now() : current.lastSelectedAt,
      lifecycleState: event.hostKind === "panel" ? "live-attached" : "live-detached",
    });
    this.logger.info("Browser webview attached", {
      ...browserIdentity(event),
      mountGeneration: event.mountGeneration,
      webContentsId: event.webContentsId,
      hostKind: event.hostKind,
    });
    return snapshot;
  }

  private detachWebview(tabId: string, webContentsId?: number): void {
    const current = this.tabs.get(tabId);
    if (!current) return;
    const detachedWebContentsId =
      typeof webContentsId === "number" ? webContentsId : current.webContentsId;
    if (detachedWebContentsId !== null && detachedWebContentsId !== undefined) {
      const contents = this.electron.webContentsFromId(detachedWebContentsId);
      if (contents) this.fork(this.pageEmulation.release(contents));
      this.webContentsTabIds.delete(detachedWebContentsId);
      this.webContentsListeners.release(detachedWebContentsId);
    }
    this.updateTab(tabId, {
      webContentsId: null,
      isLoading: false,
      isWaitingForResponse: false,
      pendingUrl: undefined,
      lifecycleState:
        current.lifecycleState === "closing"
          ? "closed"
          : current.lifecycleState === "suspending"
            ? "suspended"
            : "live-detached",
    });
  }

  private ensureWebContentsListeners(
    tabId: string,
    webContentsId: number,
    contents: BrowserWebContentsLike,
  ): void {
    if (this.webContentsListeners.has(webContentsId)) return;

    this.webContentsListeners.acquire(webContentsId, () => {
      contents.setWindowOpenHandler(({ url: targetUrl, disposition }) => {
        const ownership = this.attachedWebviewOwnership.get(webContentsId);
        const canOpenAsBrowserTab =
          isAllowedBrowserNavigationUrl(targetUrl) &&
          (targetUrl === "about:blank" ||
            ["http:", "https:"].includes(new URL(targetUrl).protocol));
        if (ownership && canOpenAsBrowserTab) {
          this.events.publish({
            kind: "openNewTab",
            value: {
              ...browserIdentity(ownership.identity),
              url: targetUrl,
              background: disposition === "background-tab",
            },
          });
        } else if (isAllowedBrowserExternalUrl(targetUrl)) {
          this.fork(
            Effect.promise(() => this.electron.openExternal(targetUrl)).pipe(Effect.asVoid),
          );
        }
        return { action: "deny" };
      });

      const disposers: Array<() => void> = [];
      const add = (eventName: string, listener: (...args: unknown[]) => void) => {
        contents.on(eventName, listener);
        disposers.push(() => contents.removeListener(eventName, listener));
      };

      add("destroyed", () => {
        const activeTabId = this.webContentsTabIds.get(webContentsId) ?? tabId;
        this.logger.info("Browser webContents destroyed", { tabId: activeTabId, webContentsId });
        const ownership = this.attachedWebviewOwnership.get(webContentsId);
        if (ownership) this.clearBrowserImageDrag(ownership.ownerWebContentsId);
        this.attachedWebviewOwnership.delete(webContentsId);
        this.fork(this.pageEmulation.release(contents));
        this.runtimeRegistry.releaseGuest(webContentsId);
        this.earlyPageRestores.release(webContentsId);
        this.detachWebview(activeTabId, webContentsId);
      });
      add("context-menu", (...args) => {
        const params = args[1] as BrowserContextMenuParams | undefined;
        if (!isBrowserContextMenuParams(params)) return;
        this.showBrowserContextMenu(webContentsId, contents, params);
      });
      add("did-start-loading", () => {
        this.updateTabForWebContents(webContentsId, contents, {
          isLoading: true,
          isWaitingForResponse: true,
          errorMessage: undefined,
          failure: undefined,
        });
      });
      const preventUnsafeTopFrameNavigation = (...args: unknown[]) => {
        const url = readUrlFromEventArgs(args, "");
        if (isAllowedBrowserNavigationUrl(url)) return;
        const event = args[0] as { preventDefault?: () => void } | undefined;
        event?.preventDefault?.();
        this.updateTabForWebContents(webContentsId, contents, {
          isLoading: false,
          isWaitingForResponse: false,
          pendingUrl: undefined,
          failure: {
            kind: "blocked",
            failedUrl: url,
            policy: "navigation-policy",
          },
          errorMessage: "This URL is blocked by the built-in Browser policy",
        });
        this.logger.warn("Blocked unsafe Browser top-frame navigation", {
          webContentsId,
          hasUrl: url.length > 0,
        });
      };
      add("will-navigate", preventUnsafeTopFrameNavigation);
      add("will-redirect", preventUnsafeTopFrameNavigation);
      add("did-stop-loading", () => {
        const snapshot = this.updateTabForWebContents(webContentsId, contents, {
          isLoading: false,
          isWaitingForResponse: false,
          pendingUrl: undefined,
        });
        if (snapshot) {
          if (this.historyStore) {
            this.fork(
              this.historyStore
                .record({ url: snapshot.url, title: snapshot.title })
                .pipe(Effect.catch(() => Effect.void)),
            );
          }
        }
        this.fork(this.persistPageSnapshotForWebContents(webContentsId, contents));
      });
      add("did-navigate", (...args) => {
        this.updateTabForWebContents(webContentsId, contents, {
          url: readUrlFromEventArgs(args, contents.getURL()),
          isWaitingForResponse: false,
          pendingUrl: undefined,
        });
        this.fork(this.persistPageSnapshotForWebContents(webContentsId, contents));
      });
      add("did-navigate-in-page", (...args) => {
        const snapshot = this.updateTabForWebContents(webContentsId, contents, {
          url: readUrlFromEventArgs(args, contents.getURL()),
          isWaitingForResponse: false,
          pendingUrl: undefined,
        });
        if (snapshot) {
          if (this.historyStore) {
            this.fork(
              this.historyStore
                .record({ url: snapshot.url, title: snapshot.title })
                .pipe(Effect.catch(() => Effect.void)),
            );
          }
        }
        this.fork(this.persistPageSnapshotForWebContents(webContentsId, contents));
      });
      add("page-title-updated", (...args) => {
        this.updateTabForWebContents(webContentsId, contents, {
          title: readTitleFromEventArgs(args, contents.getTitle()),
        });
        this.fork(this.persistPageSnapshotForWebContents(webContentsId, contents));
      });
      add("page-favicon-updated", (...args) => {
        const faviconUrl = readFaviconFromEventArgs(args);
        this.updateTabForWebContents(webContentsId, contents, { faviconUrl });
        this.fork(this.persistPageSnapshotForWebContents(webContentsId, contents));
      });
      add("found-in-page", (...args) => {
        const result = readFoundInPageResult(args);
        if (!result) return;
        this.updateTabForWebContents(webContentsId, contents, {
          findState: {
            ...(this.tabs.get(this.webContentsTabIds.get(webContentsId) ?? "")?.findState ??
              DEFAULT_BROWSER_SIDEBAR_FIND_STATE),
            activeMatchOrdinal: result.activeMatchOrdinal,
            matchCount: result.matches,
          },
        });
      });
      add("did-fail-load", (...args) => this.handleLoadFailure(webContentsId, contents, args));
      add("did-fail-provisional-load", (...args) =>
        this.handleLoadFailure(webContentsId, contents, args),
      );
      add("render-process-gone", (...args) => {
        const tabKey = this.webContentsTabIds.get(webContentsId);
        const tab = tabKey ? this.tabs.get(tabKey) : null;
        if (!tabKey || !tab) return;
        const reason = readRenderProcessGoneReason(args);
        this.updateTab(tabKey, {
          lifecycleState: "crashed",
          isLoading: false,
          isWaitingForResponse: false,
          failure: {
            kind: "crashed",
            failedUrl: tab.url,
            reason,
          },
          errorMessage: "The Browser page process stopped working",
        });
      });
      add("unresponsive", () => {
        const tabKey = this.webContentsTabIds.get(webContentsId);
        const tab = tabKey ? this.tabs.get(tabKey) : null;
        if (!tabKey || !tab) return;
        this.updateTab(tabKey, {
          failure: {
            kind: "crashed",
            failedUrl: tab.url,
            reason: "unresponsive",
          },
          errorMessage: "The Browser page is not responding",
        });
      });
      const updateMediaState = (mediaActive: boolean) => {
        this.updateTabForWebContents(webContentsId, contents, {
          mediaActive,
          audible: contents.isCurrentlyAudible?.() === true,
        });
      };
      add("media-started-playing", () => updateMediaState(true));
      add("media-paused", () => updateMediaState(false));
      add("audio-state-changed", () => {
        this.updateTabForWebContents(webContentsId, contents, {
          audible: contents.isCurrentlyAudible?.() === true,
        });
      });

      return () => {
        if (!contents.isDestroyed()) {
          contents.setWindowOpenHandler(() => ({ action: "deny" }));
        }
        for (const dispose of disposers) dispose();
      };
    });
  }

  private updateTabForWebContents(
    webContentsId: number,
    contents: BrowserWebContentsLike,
    patch: Partial<
      Omit<BrowserSidebarTabSnapshot, "browserConversationId" | "browserTabId" | "updatedAt">
    >,
  ): BrowserSidebarTabSnapshot | null {
    const tabId = this.webContentsTabIds.get(webContentsId);
    if (!tabId) return null;
    return this.refreshSnapshotFromWebContents(tabId, contents, patch);
  }

  private refreshSnapshotFromWebContents(
    tabId: string,
    contents: BrowserWebContentsLike,
    patch: Partial<
      Omit<BrowserSidebarTabSnapshot, "browserConversationId" | "browserTabId" | "updatedAt">
    > = {},
  ): BrowserSidebarTabSnapshot | null {
    const current = this.tabs.get(tabId);
    if (!current) return null;
    if (contents.isDestroyed()) return current;

    const url = typeof patch.url === "string" ? patch.url : contents.getURL() || current.url;
    const title =
      typeof patch.title === "string"
        ? patch.title
        : contents.getTitle() || current.title || "New tab";

    return this.updateTab(tabId, {
      url: normalizeBrowserNavigationUrl(url),
      title,
      isLoading: contents.isLoading(),
      canGoBack: contents.canGoBack(),
      canGoForward: contents.canGoForward(),
      ...patch,
    });
  }

  private handleLoadFailure(
    webContentsId: number,
    contents: BrowserWebContentsLike,
    args: unknown[],
  ): void {
    const errorCode = readErrorCodeFromEventArgs(args);
    const url = readUrlFromEventArgs(args, contents.getURL());
    if (errorCode === -3) {
      this.updateTabForWebContents(webContentsId, contents, {
        isLoading: false,
        isWaitingForResponse: false,
        pendingUrl: undefined,
      });
      this.logger.debug("Browser load aborted", { webContentsId, hasUrl: url.length > 0 });
      return;
    }

    this.updateTabForWebContents(webContentsId, contents, {
      url,
      isLoading: false,
      isWaitingForResponse: false,
      pendingUrl: undefined,
      failure: classifyBrowserPageFailure(errorCode, url, readErrorDescriptionFromEventArgs(args)),
      errorMessage: readErrorDescriptionFromEventArgs(args) ?? "Failed to load page",
    });
    this.logger.warn("Browser load failed", { webContentsId, errorCode, hasUrl: url.length > 0 });
  }

  private syncDeviceEmulation(
    tab: BrowserSidebarTabSnapshot,
    contents: BrowserWebContentsLike,
  ): Effect.Effect<void> {
    return (
      tab.deviceToolbarVisible
        ? this.pageEmulation.syncDeviceMetrics(contents, tab.viewport)
        : this.pageEmulation.clearDeviceMetrics(contents)
    ).pipe(
      Effect.tap((result) =>
        result.ok || result.reason === "debugger-unavailable"
          ? Effect.void
          : Effect.sync(() =>
              this.logger.warn("Browser device emulation could not be synchronized", {
                ...browserIdentity(tab),
                reason: result.reason,
              }),
            ),
      ),
      Effect.asVoid,
    );
  }

  private syncPageColorScheme(
    identity: BrowserSidebarTabIdentity,
    contents: BrowserWebContentsLike,
    themeVariant: BrowserSidebarThemeVariant,
  ): Effect.Effect<void> {
    return this.pageEmulation.syncColorScheme(contents, themeVariant).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const context = {
            ...browserIdentity(identity),
            themeVariant,
            webContentsId: contents.id,
          };
          if (result.ok) {
            this.logger.debug("Browser page color scheme synchronized", context);
            return;
          }
          this.logger.warn("Browser page color scheme could not be synchronized", {
            ...context,
            reason: result.reason,
          });
        }),
      ),
      Effect.asVoid,
    );
  }

  private setThemeVariantForViewScope(
    browserViewScopeId: string,
    themeVariant: BrowserSidebarThemeVariant,
  ): void {
    const previousThemeVariant = this.themeVariantsByViewScope.get(browserViewScopeId);
    this.themeVariantsByViewScope.set(browserViewScopeId, themeVariant);
    if (previousThemeVariant === themeVariant) return;

    for (const tab of this.tabs.values()) {
      if (tab.browserViewScopeId !== browserViewScopeId) continue;
      const contents = this.getAttachedWebContents(tab);
      if (!contents || contents.isDestroyed()) continue;
      this.fork(this.syncPageColorScheme(tab, contents, themeVariant));
    }
  }

  private readSavedPage(
    browserStorageId: string,
    identity: BrowserSidebarTabIdentity,
  ): Effect.Effect<BrowserSerializedPage | null> {
    const pageStore = this.pageStore;
    if (!pageStore) return Effect.succeed(null);
    return pageStore.get(browserStorageId).pipe(
      Effect.flatMap((page) => {
        if (!page) return Effect.succeed(null);
        const hasMatchingIdentity =
          page.identity.browserConversationId === identity.browserConversationId &&
          page.identity.browserViewScopeId === identity.browserViewScopeId &&
          page.identity.browserTabId === identity.browserTabId;
        const hasSafeNavigation =
          isAllowedBrowserNavigationUrl(page.url) &&
          page.navigation.entries.every((entry) => isAllowedBrowserNavigationUrl(entry.url));
        if (hasMatchingIdentity && hasSafeNavigation) return Effect.succeed(page);

        this.invalidatedPageStorageIds.add(browserStorageId);
        return pageStore.delete(browserStorageId).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              this.logger.warn("Failed to quarantine invalid Browser page snapshot", {
                browserStorageId,
                error: readBoundedErrorMessage(error),
              }),
            ),
          ),
          Effect.as(null),
        );
      }),
    );
  }

  private canAdoptProvisionalBrowserStorage(tab: BrowserSidebarTabSnapshot): boolean {
    return (
      tab.browserStorageId === `browser:legacy:${tab.browserTabId}` &&
      tab.webContentsId === null &&
      tab.lifecycleState === "cold"
    );
  }

  private adoptProvisionalBrowserStorage(
    tab: BrowserSidebarTabSnapshot,
    browserStorageId: string,
  ): Effect.Effect<BrowserSidebarTabSnapshot> {
    return Effect.gen(
      function* (this: BrowserState) {
        const key = browserTabKey(tab);
        const previousBrowserStorageId = tab.browserStorageId;
        if (!previousBrowserStorageId) {
          throw new Error("Provisional Browser storage identity is unavailable");
        }

        this.runtimeRegistry.releaseHost(tab);
        this.invalidatedPageStorageIds.delete(browserStorageId);
        let savedPage = yield* this.readSavedPage(browserStorageId, tab);
        if (!savedPage && this.pageStore) {
          const migration = yield* Effect.exit(
            this.pageStore.reassociate(previousBrowserStorageId, browserStorageId),
          );
          if (migration._tag === "Success") {
            savedPage = yield* this.readSavedPage(browserStorageId, tab);
          } else {
            this.logger.warn("Failed to migrate provisional Browser page storage", {
              ...browserIdentity(tab),
              error: readBoundedErrorMessage(migration.cause),
            });
          }
        }

        const preparedPage =
          savedPage ?? this.preparedPagesByStorageId.get(previousBrowserStorageId);
        this.preparedPagesByStorageId.delete(previousBrowserStorageId);
        if (preparedPage) {
          this.preparedPagesByStorageId.set(browserStorageId, {
            ...preparedPage,
            browserStorageId,
          });
        } else {
          this.preparedPagesByStorageId.delete(browserStorageId);
        }
        this.invalidatedPageStorageIds.delete(previousBrowserStorageId);

        const snapshot = this.updateTab(key, {
          browserStorageId,
          ...(savedPage
            ? {
                faviconUrl: savedPage.faviconUrl,
                hasBrowserPage: !isBlankBrowserUrl(savedPage.url),
                pageActionsDisabled: isBlankBrowserUrl(savedPage.url),
                pendingUrl: undefined,
                restoreResult: "snapshot-ready" as const,
                title: savedPage.title,
                url: savedPage.url,
              }
            : {}),
        });
        this.logger.info("Migrated provisional Browser storage identity", {
          ...browserIdentity(tab),
        });
        return snapshot;
      }.bind(this),
    );
  }

  private restoreSavedPage(
    tabId: string,
    contents: BrowserWebContentsLike,
    preparedPage?: BrowserSerializedPage,
    lease?: BrowserEarlyPageRestoreLease,
  ): Effect.Effect<BrowserSidebarTabSnapshot> {
    return Effect.gen(
      function* (this: BrowserState) {
        const current = this.tabs.get(tabId);
        if (!current) return yield* Effect.die("Browser tab is not registered");
        const isActive = lease?.isActive ?? (() => true);
        if (!isActive()) return current;
        const browserStorageId = current.browserStorageId;
        const pageStore = this.pageStore;
        const navigationHistory = contents.navigationHistory;
        if (!browserStorageId || !navigationHistory || !pageStore) {
          return this.updateTab(tabId, {
            lifecycleState: current.presented ? "live-attached" : "live-detached",
            restoreResult: "missing",
          });
        }

        const page = preparedPage ?? (yield* this.readSavedPage(browserStorageId, current));
        if (!isActive()) return this.tabs.get(tabId) ?? current;
        if (!page) {
          return this.updateTab(tabId, {
            lifecycleState: current.presented ? "live-attached" : "live-detached",
            restoreResult: "missing",
          });
        }

        this.updateTab(tabId, {
          lifecycleState: "restoring",
          restoreResult: "snapshot-ready",
        });
        const restored = yield* Effect.exit(
          Effect.promise(() =>
            navigationHistory.restore({
              entries: page.navigation.entries,
              index: page.navigation.currentIndex,
            }),
          ),
        );
        if (restored._tag === "Success") {
          if (!isActive()) return this.tabs.get(tabId) ?? current;
          return (
            this.refreshSnapshotFromWebContents(tabId, contents, {
              url: page.url,
              title: page.title,
              faviconUrl: page.faviconUrl,
              lifecycleState: current.presented ? "live-attached" : "live-detached",
              restoreResult: "snapshot-ready",
              errorMessage: undefined,
              failure: undefined,
            }) ?? current
          );
        }
        if (!isActive()) return this.tabs.get(tabId) ?? current;
        this.invalidatedPageStorageIds.add(browserStorageId);
        yield* pageStore.delete(browserStorageId).pipe(Effect.ignore);
        if (!isActive()) return this.tabs.get(tabId) ?? current;
        const description = readBoundedErrorMessage(restored.cause);
        return this.updateTab(tabId, {
          lifecycleState: current.presented ? "live-attached" : "live-detached",
          restoreResult: "missing",
          failure: {
            kind: "generic",
            failedUrl: page.url,
            code: 0,
            description,
          },
          errorMessage: "Saved Browser history could not be restored. Reload to retry.",
        });
      }.bind(this),
    );
  }

  private persistPageSnapshotForWebContents(
    webContentsId: number,
    contents: BrowserWebContentsLike,
  ): Effect.Effect<void> {
    const tabId = this.webContentsTabIds.get(webContentsId);
    const pageStore = this.pageStore;
    const navigationHistory = contents.navigationHistory;
    if (!tabId || !pageStore || !navigationHistory || contents.isDestroyed()) return Effect.void;
    const tab = this.tabs.get(tabId);
    const browserStorageId = tab?.browserStorageId;
    if (!tab || !browserStorageId || this.invalidatedPageStorageIds.has(browserStorageId)) {
      return Effect.void;
    }

    let entries: BrowserSerializedPage["navigation"]["entries"];
    let currentIndex: number;
    try {
      entries = navigationHistory.getAllEntries().map((entry) => ({
        ...(entry.pageState === undefined ? {} : { pageState: entry.pageState }),
        title: entry.title,
        url: entry.url,
      }));
      currentIndex = navigationHistory.getActiveIndex();
    } catch (error) {
      this.logger.debug("Browser navigation history is not snapshot-ready", {
        ...browserIdentity(tab),
        error: readBoundedErrorMessage(error),
      });
      return Effect.void;
    }
    if (
      entries.length === 0 ||
      currentIndex < 0 ||
      currentIndex >= entries.length ||
      entries.some((entry) => !isAllowedBrowserNavigationUrl(entry.url))
    ) {
      return Effect.void;
    }

    const latest = this.tabs.get(tabId);
    if (
      !latest ||
      latest.browserStorageId !== browserStorageId ||
      this.invalidatedPageStorageIds.has(browserStorageId)
    ) {
      return Effect.void;
    }
    return pageStore
      .set({
        schemaVersion: 1,
        runtime: "electron-webview",
        browserStorageId,
        identity: browserIdentity(latest),
        title: latest.title,
        url: latest.url,
        ...(latest.faviconUrl === undefined ? {} : { faviconUrl: latest.faviconUrl }),
        updatedAt: Date.now(),
        navigation: {
          currentIndex,
          entries,
        },
      })
      .pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            this.logger.warn("Failed to persist Browser page snapshot", {
              ...browserIdentity(latest),
              error: readBoundedErrorMessage(error),
            }),
          ),
        ),
      );
  }

  private enforceBrowserTabBudget(browserViewScopeId: string): void {
    const entries = [...this.tabs.entries()]
      .filter(([, tab]) => tab.browserViewScopeId === browserViewScopeId)
      .map(([key, tab]) => {
        const browserUseTab = this.browserUseTabs.get(key);
        const browserUseActive = browserUseTab !== undefined && !browserUseTab.released;
        return {
          ...browserIdentity(tab),
          activeDownload: tab.activeDownload === true,
          audible: tab.audible === true,
          browserUseActive,
          captureActive:
            browserUseTab?.captureActive === true ||
            Boolean(this.browserUseCaptureSurfaces.get(key)?.surfaceSize),
          isLoading: tab.isLoading,
          lastSelectedAt: tab.lastSelectedAt ?? 0,
          lifecycleState:
            tab.lifecycleState ?? (tab.webContentsId === null ? "cold" : "live-detached"),
          mediaActive: tab.mediaActive === true,
          presented: tab.presented === true,
          updatedAt: tab.updatedAt,
        };
      });
    for (const candidate of selectBrowserTabsToSuspend(entries)) {
      this.fork(this.suspendBrowserTab(browserTabKey(candidate)));
    }
  }

  private suspendBrowserTab(tabId: string): Effect.Effect<void> {
    return Effect.gen(
      function* (this: BrowserState) {
        const tab = this.tabs.get(tabId);
        if (
          !tab ||
          tab.lifecycleState !== "live-detached" ||
          tab.webContentsId === null ||
          this.pendingTeardowns.has(tabId)
        ) {
          return;
        }
        const contents = this.getAttachedWebContents(tab);
        if (!contents || contents.isDestroyed()) return;
        yield* this.persistPageSnapshotForWebContents(tab.webContentsId, contents);
        const current = this.tabs.get(tabId);
        if (
          !current ||
          current.webContentsId !== tab.webContentsId ||
          current.lifecycleState !== "live-detached"
        ) {
          return;
        }
        this.updateTab(tabId, { lifecycleState: "suspending" });
        this.requestDestroyWebview(tabId, "suspend");
      }.bind(this),
    );
  }

  private requestDestroyWebview(
    tabId: string,
    reason: BrowserSidebarDestroyWebviewRequest["reason"],
  ): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.webContentsId === null) return;

    const teardownId = `browser-webview-teardown-${++this.teardownSequence}`;
    const request: BrowserSidebarDestroyWebviewRequest = {
      ...browserIdentity(tab),
      mountGeneration: tab.mountGeneration,
      reason,
      teardownId,
    };
    this.pendingTeardowns.set(tabId, request);
    this.runtimeRegistry.markPendingTeardown(tab, true);
    this.logger.info("Browser destroy webview requested", {
      ...browserIdentity(tab),
      mountGeneration: tab.mountGeneration,
      reason,
      teardownId,
    });
    this.events.publish({ kind: "destroyWebview", value: request });
  }

  private getAttachedWebContents(tab: BrowserSidebarTabSnapshot): BrowserWebContentsLike | null {
    if (tab.webContentsId === null) return null;
    return this.electron.webContentsFromId(tab.webContentsId) ?? null;
  }

  private emitState(): void {
    this.events.publish({ kind: "state", value: this.getStateSnapshot() });
  }

  private emitBrowserUseState(): void {
    this.events.publish({ kind: "browserUseState", value: this.getBrowserUseStateSnapshot() });
  }

  private handleBrowserUseCommand(command: BrowserUseCommand): void {
    if (command.type === "browser-use-upsert-tab") {
      const key = browserTabKey(command.tab);
      const conversationScopeKey = browserConversationScopeKey(command.tab);
      this.browserUseTabs.set(key, {
        ...command.tab,
        updatedAt: Date.now(),
      });
      if (!this.browserUseActiveTabIdsByConversationScope.has(conversationScopeKey)) {
        this.browserUseActiveTabIdsByConversationScope.set(
          conversationScopeKey,
          command.tab.browserTabId,
        );
      }
      this.emitBrowserUseState();
      return;
    }

    if (command.type === "browser-use-release-tab") {
      const key = browserTabKey(command);
      const cursor = this.browserUseCursors.get(key);
      if (cursor) {
        this.events.publish({
          kind: "browserUseCursor",
          value: {
            ...cursor,
            animateMovement: false,
            visible: false,
            updatedAt: Date.now(),
          },
        });
      }
      this.browserUseTabs.delete(key);
      this.browserUseCursors.delete(key);
      this.browserUseViewportSizes.delete(key);
      this.browserUseCaptureSurfaces.delete(key);
      this.deviceToolbarStates.delete(key);
      this.pendingBrowserUsePresentations.delete(key);
      const conversationScopeKey = browserConversationScopeKey(command);
      if (
        this.browserUseActiveTabIdsByConversationScope.get(conversationScopeKey) ===
        command.browserTabId
      ) {
        this.browserUseActiveTabIdsByConversationScope.delete(conversationScopeKey);
      }
      this.events.publish({ kind: "pageReleased", value: browserIdentity(command) });
      this.emitBrowserUseState();
      return;
    }

    if (command.type === "browser-use-set-active-tab") {
      const conversationScopeKey = browserConversationScopeKey(command);
      if (command.browserTabId === null) {
        this.browserUseActiveTabIdsByConversationScope.delete(conversationScopeKey);
      } else {
        this.browserUseActiveTabIdsByConversationScope.set(
          conversationScopeKey,
          command.browserTabId,
        );
      }
      this.emitBrowserUseState();
      return;
    }

    if (command.type === "browser-use-resolve-presentation") {
      this.resolveBrowserUsePresentation(command.result);
      return;
    }

    if (command.type === "browser-use-set-cursor") {
      this.browserUseCursors.set(browserTabKey(command.cursor), command.cursor);
      this.events.publish({ kind: "browserUseCursor", value: command.cursor });
      this.emitBrowserUseState();
      return;
    }

    if (command.type === "browser-use-set-viewport") {
      const key = browserTabKey(command.event);
      this.browserUseViewportSizes.set(key, command.event);
      this.events.publish({ kind: "browserUseViewport", value: command.event });
      return;
    }

    if (command.type === "browser-use-set-capture-surface") {
      const key = browserTabKey(command.event);
      this.browserUseCaptureSurfaces.set(key, command.event);
      this.events.publish({ kind: "browserUseCaptureSurface", value: command.event });
    }
  }

  private syncBrowserUseViewport(
    identity: BrowserSidebarTabIdentity,
    viewport: BrowserSidebarViewport,
  ): void {
    const key = browserTabKey(identity);
    const browserUseTab = this.browserUseTabs.get(key);
    if (!browserUseTab) return;
    this.browserUseTabs.set(key, {
      ...browserUseTab,
      viewport,
      updatedAt: Date.now(),
    });
    const event: BrowserSidebarBrowserUseViewportEvent = {
      ...browserIdentity(identity),
      viewportSize:
        viewport.width > 0 && viewport.height > 0
          ? { width: viewport.width, height: viewport.height }
          : null,
    };
    this.browserUseViewportSizes.set(key, event);
    this.events.publish({ kind: "browserUseViewport", value: event });
    this.emitBrowserUseState();
  }
}

function clampZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(500, Math.max(25, Math.round(value)));
}

function stepZoomPercent(current: number, delta: number): number {
  const clamped = clampZoomPercent(current);
  if (delta === 0) return clamped;
  if (delta > 0) {
    return (
      BROWSER_SIDEBAR_ZOOM_OPTIONS.find((option) => option > clamped) ??
      BROWSER_SIDEBAR_ZOOM_OPTIONS.at(-1) ??
      clamped
    );
  }
  return (
    [...BROWSER_SIDEBAR_ZOOM_OPTIONS].reverse().find((option) => option < clamped) ??
    BROWSER_SIDEBAR_ZOOM_OPTIONS[0] ??
    clamped
  );
}

function deriveBrowserSnapshot(snapshot: BrowserSidebarTabSnapshot): BrowserSidebarTabSnapshot {
  const hasBrowserPage = !isBlankBrowserUrl(snapshot.url);
  return {
    ...snapshot,
    isWaitingForResponse: snapshot.isWaitingForResponse ?? false,
    hasBrowserPage,
    pageActionsDisabled: !hasBrowserPage || snapshot.url.trim().length === 0,
    interactionMode: snapshot.interactionMode ?? "browse",
    findState: snapshot.findState ?? DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
  };
}

function isBrowserUseCommand(command: BrowserSidebarCommand): command is BrowserUseCommand {
  return (
    command.type === "browser-use-upsert-tab" ||
    command.type === "browser-use-release-tab" ||
    command.type === "browser-use-set-active-tab" ||
    command.type === "browser-use-resolve-presentation" ||
    command.type === "browser-use-set-cursor" ||
    command.type === "browser-use-set-viewport" ||
    command.type === "browser-use-set-capture-surface"
  );
}

function readUrlFromEventArgs(args: unknown[], fallback: string): string {
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (
      arg.startsWith("http:") ||
      arg.startsWith("https:") ||
      arg.startsWith("file:") ||
      arg.startsWith("about:")
    ) {
      return arg;
    }
  }
  return fallback;
}

function readTitleFromEventArgs(args: unknown[], fallback: string): string {
  for (const arg of args) {
    if (typeof arg === "string" && arg.trim().length > 0) return arg.trim();
  }
  return fallback;
}

function readFaviconFromEventArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (!Array.isArray(arg)) continue;
    const favicon = arg.find((item): item is string => typeof item === "string" && item.length > 0);
    if (favicon) return favicon;
  }
  return undefined;
}

function readErrorCodeFromEventArgs(args: unknown[]): number | null {
  for (const arg of args) {
    if (typeof arg === "number" && Number.isFinite(arg)) return arg;
  }
  return null;
}

function readErrorDescriptionFromEventArgs(args: unknown[]): string | undefined {
  for (const arg of args) {
    if (typeof arg !== "string") continue;
    if (
      arg.startsWith("http:") ||
      arg.startsWith("https:") ||
      arg.startsWith("file:") ||
      arg.startsWith("about:")
    )
      continue;
    if (arg.trim().length > 0) return arg.trim();
  }
  return undefined;
}

function classifyBrowserPageFailure(
  errorCode: number | null,
  failedUrl: string,
  description: string | undefined,
): BrowserSidebarTabSnapshot["failure"] {
  const code = errorCode ?? 0;
  const normalizedDescription = description?.toLowerCase() ?? "";
  if (code === -105 || normalizedDescription.includes("name_not_resolved")) {
    return { kind: "dns", failedUrl, code };
  }
  if (code === -106 || normalizedDescription.includes("internet_disconnected")) {
    return { kind: "offline", failedUrl, code };
  }
  if (code === -102 || normalizedDescription.includes("connection_refused")) {
    return { kind: "refused", failedUrl, code };
  }
  if (code === -118 || normalizedDescription.includes("timed_out")) {
    return { kind: "timeout", failedUrl, code };
  }
  if ((code <= -200 && code >= -299) || normalizedDescription.includes("cert_")) {
    return { kind: "certificate", failedUrl, code };
  }
  return {
    kind: "generic",
    failedUrl,
    code,
    description: description?.slice(0, 512) ?? "Failed to load page",
  };
}

function readBoundedErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, "$1")
    .slice(0, 512);
}

function readFoundInPageResult(
  args: unknown[],
): { activeMatchOrdinal: number | null; matches: number | null } | null {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const record = arg as { activeMatchOrdinal?: unknown; matches?: unknown };
    return {
      activeMatchOrdinal:
        typeof record.activeMatchOrdinal === "number" ? record.activeMatchOrdinal : null,
      matches: typeof record.matches === "number" ? record.matches : null,
    };
  }
  return null;
}

function readRenderProcessGoneReason(args: unknown[]): string {
  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;
    const reason = (arg as { reason?: unknown }).reason;
    if (typeof reason === "string" && reason.length > 0) {
      return reason.slice(0, 128);
    }
  }
  return "crashed";
}
