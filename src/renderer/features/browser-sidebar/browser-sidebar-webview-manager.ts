import {
  makeBrowserSidebarRoutePartition,
  makeBrowserSidebarTabKey,
  type BrowserSidebarBrowserUseCaptureSurfaceEvent,
  type BrowserSidebarDestroyWebviewRequest,
  type BrowserSidebarSize,
  type BrowserSidebarTabIdentity,
  type BrowserSidebarTabSnapshot,
  type BrowserSidebarThemeVariant,
  type BrowserSidebarWebviewDestroyed,
  type BrowserSidebarWebviewHostCreated,
  type BrowserSidebarWebviewHostKind,
} from "../../../shared/browser-sidebar";
import type { BrowserAnnotationDesignChange } from "../../../shared/browser-annotation";
import { createSecureUuid } from "../../../shared/secure-runtime-id";
import { APP_SHELL_BROWSER_WEBVIEW_LAYER_INDEX } from "../../lib/app-shell-layers";
import {
  isAllowedBrowserNavigationUrl,
  isBlankBrowserUrl,
  normalizeBrowserNavigationUrl,
} from "../../../shared/browser-url";
import {
  invokeBrowserSidebarCommand,
  notifyBrowserWebviewHostCreated,
} from "./browser-sidebar-commands";

export const BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX = 2147483647;
export const BROWSER_SIDEBAR_WEBVIEW_LAYER_Z_INDEX = APP_SHELL_BROWSER_WEBVIEW_LAYER_INDEX;

export type BrowserSidebarWebviewElement = HTMLElement & {
  executeJavaScript?: (code: string, userGesture?: boolean) => Promise<unknown>;
  getWebContentsId?: () => number;
  getTitle?: () => string;
  getURL?: () => string;
  send?: (channel: string, ...args: unknown[]) => void;
};

export interface BrowserSidebarWebviewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

type WebviewHostKey = BrowserSidebarTabIdentity;

interface ManagedWebviewInput extends WebviewHostKey {
  browserStorageId?: string;
  projectId: string | null;
  hostKind: BrowserSidebarWebviewHostKind;
  initialUrl: string;
}

interface SyncWebviewInput extends ManagedWebviewInput {
  bounds: BrowserSidebarWebviewBounds | null;
  mountGeneration: number;
  isVisible?: boolean;
  shouldPaint?: boolean;
  scale?: number;
  windowZoom?: number;
  onHostCreated: (event: BrowserSidebarWebviewHostCreated) => void;
}

export interface BrowserSidebarHostPresentation {
  readonly bounds: BrowserSidebarWebviewBounds | null;
  readonly isVisible: boolean;
  readonly scale?: number;
  readonly shouldPaint: boolean;
  readonly windowZoom?: number;
}

export interface BrowserSidebarHostClaimInput extends ManagedWebviewInput {
  readonly browserStorageId: string;
  readonly deviceToolbarState?: BrowserSidebarTabSnapshot["deviceToolbarState"];
  readonly deviceToolbarVisible?: boolean;
  readonly faviconUrl?: string;
  readonly pagePersistence: "browser-use" | "durable";
  readonly presentation: BrowserSidebarHostPresentation;
  /** Whether this claim owns creating the Main-side tab route before it registers a host. */
  readonly tabRegistration: "ensure" | "preestablished";
  readonly themeVariant: BrowserSidebarThemeVariant;
  readonly title?: string;
}

export interface BrowserSidebarHostLease {
  readonly update: (input: BrowserSidebarHostClaimInput) => void;
  readonly release: () => void;
}

interface BrowserSidebarHostClaim {
  readonly claimId: string;
  readonly sequence: number;
  input: BrowserSidebarHostClaimInput;
}

interface BrowserSidebarHostReconciliation {
  activeClaimId: string | null;
  activeInput: BrowserSidebarHostClaimInput | null;
  hostGeneration: number | null;
  lifecycleEpoch: number;
  mountGeneration: number | null;
  reconciledRevision: number;
  retryAttempt: number;
  retryTimeout: ReturnType<typeof setTimeout> | null;
  revision: number;
  running: boolean;
}

type BrowserSidebarHostReconciliationOutcome = "applied" | "retry" | "stale";

const HOST_RECONCILIATION_INITIAL_RETRY_MS = 50;
const HOST_RECONCILIATION_MAX_RETRY_MS = 2_000;

interface ResolvedSyncWebviewInput extends SyncWebviewInput {
  rendererInstanceId: string;
  hostGeneration: number;
}

interface ManagedBrowserWebviewHost {
  container: HTMLDivElement;
  cursorOverlayHost: HTMLDivElement;
  disposed: boolean;
  hostKind: BrowserSidebarWebviewHostKind;
  hostGeneration: number;
  isVisible: boolean;
  mountGeneration: number;
  webview: BrowserSidebarWebviewElement;
  detach(mountGeneration: number): void;
  dispose(): void;
  resync(): void;
  shouldDestroyForHostRequest(request: BrowserSidebarDestroyWebviewRequest): boolean;
  send(channel: string, ...args: unknown[]): void;
  setBrowserUseCaptureSurfaceSize(size: BrowserSidebarSize | null): void;
  sync(input: ResolvedSyncWebviewInput): void;
}

class BrowserSidebarRendererWebviewHost implements ManagedBrowserWebviewHost {
  readonly container = document.createElement("div");
  readonly cursorOverlayHost = document.createElement("div");
  readonly webview: BrowserSidebarWebviewElement;
  disposed = false;
  hostKind: BrowserSidebarWebviewHostKind;
  readonly hostGeneration: number;
  isVisible = false;
  mountGeneration = 0;
  private bounds: BrowserSidebarWebviewBounds | null = null;
  private browserUseCaptureSurfaceSize: BrowserSidebarSize | null = null;
  private readonly disposers: Array<() => void> = [];
  private readonly pendingMessages = new Map<string, unknown[]>();
  private domReady = false;
  private notifiedMountGeneration: number | null = null;
  private latestInput: ResolvedSyncWebviewInput | null = null;
  private scale = 1;
  private shouldPaint = true;
  private windowZoom = 1;

  constructor(private readonly input: ResolvedSyncWebviewInput) {
    this.hostKind = input.hostKind;
    this.hostGeneration = input.hostGeneration;
    this.webview = document.createElement("webview") as BrowserSidebarWebviewElement;
    this.container.setAttribute("data-browser-sidebar-webview-manager-root", "");
    this.container.setAttribute(
      "data-browser-sidebar-conversation-id",
      input.browserConversationId,
    );
    this.container.setAttribute("data-browser-sidebar-view-scope-id", input.browserViewScopeId);
    this.container.setAttribute("data-browser-sidebar-browser-tab-id", input.browserTabId);
    this.container.setAttribute("data-browser-sidebar-webview-host-kind", input.hostKind);
    this.webview.className = "h-full w-full";
    this.webview.style.display = "flex";
    this.webview.style.width = "100%";
    this.webview.style.height = "100%";
    this.webview.setAttribute("partition", makeBrowserSidebarRoutePartition(input, input));
    this.webview.setAttribute("src", normalizeInitialWebviewUrl(input.initialUrl));
    this.webview.setAttribute("data-browser-sidebar-conversation-id", input.browserConversationId);
    this.webview.setAttribute("data-browser-sidebar-view-scope-id", input.browserViewScopeId);
    this.webview.setAttribute("data-browser-sidebar-browser-tab-id", input.browserTabId);
    this.webview.setAttribute(
      "data-browser-sidebar-page-storage-id",
      resolveBrowserStorageId(input),
    );
    this.webview.setAttribute("data-browser-sidebar-webview-host-root", "");
    this.webview.setAttribute("data-browser-sidebar-webview-host-kind", input.hostKind);
    this.webview.setAttribute("allowpopups", "false");

    this.cursorOverlayHost.className = "pointer-events-none absolute inset-0";
    this.cursorOverlayHost.setAttribute("data-browser-sidebar-cursor-overlay-host", "");
    this.container.append(this.webview, this.cursorOverlayHost);
    this.ensureLifecycleListeners();
    this.syncContainerStyle();
    document.body.append(this.container);
  }

  sync(input: ResolvedSyncWebviewInput): void {
    if (this.disposed) return;
    this.hostKind = input.hostKind;
    this.isVisible = input.isVisible !== false;
    this.mountGeneration = input.mountGeneration;
    this.bounds = input.bounds;
    this.latestInput = input;
    this.scale = input.scale ?? 1;
    this.shouldPaint = input.shouldPaint !== false;
    this.windowZoom = input.windowZoom ?? 1;
    this.container.setAttribute(
      "data-browser-sidebar-conversation-id",
      input.browserConversationId,
    );
    this.container.setAttribute("data-browser-sidebar-view-scope-id", input.browserViewScopeId);
    this.container.setAttribute("data-browser-sidebar-browser-tab-id", input.browserTabId);
    this.container.setAttribute("data-browser-sidebar-webview-host-kind", input.hostKind);
    this.webview.setAttribute(
      "data-browser-sidebar-mount-generation",
      String(input.mountGeneration),
    );
    if (input.projectId === null) {
      this.webview.removeAttribute("data-browser-sidebar-project-id");
    } else {
      this.webview.setAttribute("data-browser-sidebar-project-id", input.projectId);
    }
    this.webview.setAttribute("data-browser-sidebar-webview-host-kind", input.hostKind);

    this.syncContainerStyle();

    queueMicrotask(() => this.notifyHostCreated(input));
  }

  detach(mountGeneration: number): void {
    queueMicrotask(() => {
      if (this.disposed) return;
      if (this.mountGeneration !== mountGeneration) return;
      this.background();
    });
  }

  shouldDestroyForHostRequest(request: BrowserSidebarDestroyWebviewRequest): boolean {
    if (this.mountGeneration !== request.mountGeneration) return false;
    return request.reason === "closed" || !this.isVisible;
  }

  dispose(): void {
    if (this.disposed) return;
    for (const dispose of this.disposers.splice(0)) dispose();
    this.pendingMessages.clear();
    this.container.remove();
    this.disposed = true;
  }

  resync(): void {
    if (this.disposed) return;
    this.syncContainerStyle();
  }

  send(channel: string, ...args: unknown[]): void {
    if (this.disposed) return;
    if (!this.domReady) {
      this.pendingMessages.set(channel, args);
      return;
    }
    try {
      this.webview.send?.(channel, ...args);
    } catch {
      this.domReady = false;
      this.pendingMessages.set(channel, args);
    }
  }

  setBrowserUseCaptureSurfaceSize(size: BrowserSidebarSize | null): void {
    if (this.disposed) return;
    this.browserUseCaptureSurfaceSize = size;
    this.syncContainerStyle();
  }

  private background(): void {
    this.isVisible = false;
    this.syncContainerStyle();
  }

  private syncContainerStyle(): void {
    const captureSurfaceSize = this.browserUseCaptureSurfaceSize;
    const isCapturing =
      captureSurfaceSize !== null && captureSurfaceSize.width > 0 && captureSurfaceSize.height > 0;
    const bounds = isCapturing
      ? {
          height: captureSurfaceSize.height,
          width: captureSurfaceSize.width,
          x: 0,
          y: 0,
        }
      : this.bounds;
    const shouldPaint =
      (this.shouldPaint || isCapturing) && bounds !== null && bounds.width > 0 && bounds.height > 0;
    const shouldPresent = shouldPaint && this.isVisible && !isCapturing;
    const shouldPaintHidden =
      shouldPaint && (isCapturing || (!this.isVisible && this.hostKind === "retained"));
    if ((shouldPresent || shouldPaintHidden) && bounds) {
      Object.assign(this.container.style, {
        position: "fixed",
        left: `${shouldPaintHidden ? 0 : bounds.x}px`,
        top: `${shouldPaintHidden ? 0 : bounds.y}px`,
        width: `${bounds.width}px`,
        height: `${bounds.height}px`,
        visibility: "visible",
        opacity: shouldPaintHidden ? "0.001" : "1",
        pointerEvents: shouldPaintHidden ? "none" : "auto",
        overflow: "hidden",
        zIndex: shouldPaintHidden
          ? String(BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX)
          : resolveBrowserSidebarVisibleWebviewZIndex(this.hostKind),
        contain: shouldPaintHidden ? "layout paint size style" : "layout style paint",
        transform: shouldPaintHidden
          ? "translate3d(0, 0, 0)"
          : this.scale === 1
            ? ""
            : `scale(${this.scale})`,
        transformOrigin: "top left",
      });
    } else {
      Object.assign(this.container.style, {
        position: "fixed",
        left: "-10000px",
        top: "0px",
        width: "1px",
        height: "1px",
        visibility: "hidden",
        opacity: "0",
        pointerEvents: "none",
        overflow: "hidden",
        zIndex: "",
        contain: "",
        transform: "",
        transformOrigin: "",
      });
    }
    const paintsPage = shouldPresent || shouldPaintHidden;
    const size = paintsPage ? "100%" : "1px";
    this.webview.className = paintsPage ? "h-full w-full" : "";
    this.webview.style.display = "flex";
    this.webview.style.width = size;
    this.webview.style.height = size;
    this.webview.style.visibility = paintsPage ? "" : "hidden";
    this.webview.style.opacity = paintsPage ? "" : "0";
    this.webview.style.pointerEvents = shouldPresent ? "" : "none";
    this.webview.style.backgroundColor = "";
    this.cursorOverlayHost.className = shouldPresent
      ? "pointer-events-none absolute inset-0"
      : "pointer-events-none";
    this.container.setAttribute(
      "data-browser-sidebar-webview-visible",
      shouldPresent ? "true" : "false",
    );
    this.container.setAttribute(
      "data-browser-sidebar-webview-painting",
      paintsPage ? "true" : "false",
    );
    this.container.setAttribute("data-browser-sidebar-window-zoom", String(this.windowZoom));
  }

  private ensureLifecycleListeners(): void {
    if (this.disposers.length > 0) return;

    const notify = () => this.notifyHostCreated();
    const ready = () => {
      this.domReady = true;
      this.flushPendingMessages();
      this.notifyHostCreated();
    };
    const disposed = () => {
      this.disposed = true;
      this.domReady = false;
      this.pendingMessages.clear();
      this.container.remove();
    };
    this.webview.addEventListener("did-attach", notify);
    this.webview.addEventListener("dom-ready", ready);
    this.webview.addEventListener("destroyed", disposed);
    this.disposers.push(
      () => this.webview.removeEventListener("did-attach", notify),
      () => this.webview.removeEventListener("dom-ready", ready),
      () => this.webview.removeEventListener("destroyed", disposed),
    );
  }

  private flushPendingMessages(): void {
    if (!this.domReady || this.disposed) return;
    const pending = [...this.pendingMessages];
    this.pendingMessages.clear();
    for (const [channel, args] of pending) {
      this.send(channel, ...args);
      if (!this.domReady) return;
    }
  }

  private notifyHostCreated(input?: ResolvedSyncWebviewInput): void {
    const latestInput = this.latestInput ?? input;
    if (!latestInput) return;
    let webContentsId: number | undefined;
    try {
      webContentsId = this.webview.getWebContentsId?.();
    } catch {
      return;
    }
    if (typeof webContentsId !== "number") return;
    if (this.notifiedMountGeneration === latestInput.mountGeneration) return;
    this.notifiedMountGeneration = latestInput.mountGeneration;
    let title: string | undefined;
    try {
      title = this.webview.getTitle?.();
    } catch {
      title = undefined;
    }
    latestInput.onHostCreated({
      browserConversationId: latestInput.browserConversationId,
      browserViewScopeId: latestInput.browserViewScopeId,
      browserTabId: latestInput.browserTabId,
      browserStorageId: resolveBrowserStorageId(latestInput),
      rendererInstanceId: latestInput.rendererInstanceId,
      hostGeneration: latestInput.hostGeneration,
      projectId: latestInput.projectId,
      hostKind: latestInput.hostKind,
      mountGeneration: latestInput.mountGeneration,
      webContentsId,
      initialUrl: normalizeInitialWebviewUrl(latestInput.initialUrl),
      title,
    });
  }
}

export class BrowserSidebarRendererWebviewManager {
  private readonly browserUseCaptureSurfaceSizes = new Map<string, BrowserSidebarSize>();
  private readonly hosts = new Map<string, ManagedBrowserWebviewHost>();
  private readonly mountGenerations = new Map<string, number>();
  private readonly hostGenerations = new Map<string, number>();
  private readonly reservedHostGenerations = new Map<string, number>();
  private readonly annotationModes = new Map<
    string,
    {
      enabled: boolean;
      selectionMode: "inspect" | "region";
      sessionId: string;
    }
  >();
  private readonly annotationDesignPreviews = new Map<
    string,
    {
      change: BrowserAnnotationDesignChange | null;
      originalView: boolean;
      sessionId: string;
    }
  >();
  private readonly cursorOverlayHostListeners = new Set<() => void>();
  private readonly hostClaims = new Map<string, Map<string, BrowserSidebarHostClaim>>();
  private readonly hostReconciliations = new Map<string, BrowserSidebarHostReconciliation>();
  private hostClaimEpoch = 0;
  private nextHostClaimSequence = 1;
  private readonly rendererInstanceId = makeRendererInstanceId();

  readonly subscribeCursorOverlayHosts = (listener: () => void): (() => void) => {
    this.cursorOverlayHostListeners.add(listener);
    return () => this.cursorOverlayHostListeners.delete(listener);
  };

  /**
   * Claims one route-keyed guest. Overlapping panel, retained, and background claims share one
   * physical mount generation; the highest-priority presentation wins without detaching the guest.
   */
  claimHost(input: BrowserSidebarHostClaimInput): BrowserSidebarHostLease {
    const key = makeHostKey(input);
    const claimId = createSecureUuid();
    const claims = this.hostClaims.get(key) ?? new Map<string, BrowserSidebarHostClaim>();
    claims.set(claimId, {
      claimId,
      input,
      sequence: this.nextHostClaimSequence++,
    });
    this.hostClaims.set(key, claims);
    this.scheduleHostReconciliation(key);

    let released = false;
    return {
      update: (nextInput) => {
        if (released) return;
        if (makeHostKey(nextInput) !== key) {
          throw new Error("A Browser host lease cannot change route identity");
        }
        const claim = this.hostClaims.get(key)?.get(claimId);
        if (!claim) return;
        claim.input = nextInput;
        this.scheduleHostReconciliation(key);
      },
      release: () => {
        if (released) return;
        released = true;
        const current = this.hostClaims.get(key);
        if (!current?.delete(claimId)) return;
        if (current.size === 0) this.hostClaims.delete(key);
        this.scheduleHostReconciliation(key);
      },
    };
  }

  getRendererInstanceId(): string {
    return this.rendererInstanceId;
  }

  claimHostGeneration(input: WebviewHostKey): number {
    const key = makeHostKey(input);
    const existing = this.hosts.get(key);
    if (existing && !existing.disposed) return existing.hostGeneration;
    const reserved = this.reservedHostGenerations.get(key);
    if (reserved) return reserved;
    const next = (this.hostGenerations.get(key) ?? 0) + 1;
    this.hostGenerations.set(key, next);
    this.reservedHostGenerations.set(key, next);
    return next;
  }

  claimMountGeneration(input: WebviewHostKey): number {
    const key = makeHostKey(input);
    const next = (this.mountGenerations.get(key) ?? 0) + 1;
    this.mountGenerations.set(key, next);
    return next;
  }

  releaseMountGeneration(input: WebviewHostKey): number {
    return this.mountGenerations.get(makeHostKey(input)) ?? 0;
  }

  private getWebview(input: ResolvedSyncWebviewInput): ManagedBrowserWebviewHost {
    const key = makeHostKey(input);
    const existing = this.hosts.get(key);
    if (existing && !existing.disposed) return existing;
    existing?.dispose();
    const host = new BrowserSidebarRendererWebviewHost(input);
    this.hosts.set(key, host);
    this.emitCursorOverlayHostsChanged();
    return host;
  }

  syncWebview(input: SyncWebviewInput): ManagedBrowserWebviewHost {
    const key = makeHostKey(input);
    const resolvedInput: ResolvedSyncWebviewInput = {
      ...input,
      rendererInstanceId: this.rendererInstanceId,
      hostGeneration: this.claimHostGeneration(input),
    };
    const host = this.getWebview(resolvedInput);
    this.reservedHostGenerations.delete(key);
    host.setBrowserUseCaptureSurfaceSize(this.browserUseCaptureSurfaceSizes.get(key) ?? null);
    host.sync(resolvedInput);
    const annotationMode = this.annotationModes.get(key);
    if (annotationMode) {
      host.send("browser-annotation-mode", annotationMode);
    }
    const designPreview = this.annotationDesignPreviews.get(key);
    if (designPreview) {
      host.send("browser-annotation-design-preview", {
        after: designPreview.change?.after ?? "",
        anchorId: designPreview.change?.anchorId ?? "",
        originalView: designPreview.originalView,
        property: designPreview.change?.property ?? "",
        sessionId: designPreview.sessionId,
      });
    }
    return host;
  }

  detachWebview(input: WebviewHostKey, mountGeneration: number): void {
    this.hosts.get(makeHostKey(input))?.detach(mountGeneration);
  }

  private scheduleHostReconciliation(key: string): void {
    const state =
      this.hostReconciliations.get(key) ??
      ({
        activeClaimId: null,
        activeInput: null,
        hostGeneration: null,
        lifecycleEpoch: 0,
        mountGeneration: null,
        reconciledRevision: 0,
        retryAttempt: 0,
        retryTimeout: null,
        revision: 0,
        running: false,
      } satisfies BrowserSidebarHostReconciliation);
    if (state.retryTimeout !== null) {
      clearTimeout(state.retryTimeout);
      state.retryTimeout = null;
      state.retryAttempt = 0;
    }
    state.revision += 1;
    this.hostReconciliations.set(key, state);
    this.startHostReconciliation(key, state);
  }

  private startHostReconciliation(key: string, state: BrowserSidebarHostReconciliation): void {
    if (state.running) return;
    state.running = true;
    const epoch = this.hostClaimEpoch;
    queueMicrotask(() => {
      void this.reconcileHostClaims(key, state, epoch)
        .catch(() => "retry" as const)
        .then((outcome) => {
          state.running = false;
          if (epoch !== this.hostClaimEpoch) return;
          if (outcome === "retry") {
            this.scheduleHostReconciliationRetry(key, state, epoch);
            return;
          }
          if (outcome === "applied") state.retryAttempt = 0;
          if (state.reconciledRevision !== state.revision) {
            this.startHostReconciliation(key, state);
          }
        });
    });
  }

  private scheduleHostReconciliationRetry(
    key: string,
    state: BrowserSidebarHostReconciliation,
    epoch: number,
  ): void {
    if (epoch !== this.hostClaimEpoch || state.retryTimeout !== null) return;
    const delayMs = Math.min(
      HOST_RECONCILIATION_INITIAL_RETRY_MS * 2 ** state.retryAttempt,
      HOST_RECONCILIATION_MAX_RETRY_MS,
    );
    state.retryAttempt += 1;
    state.retryTimeout = setTimeout(() => {
      state.retryTimeout = null;
      if (epoch !== this.hostClaimEpoch) return;
      this.startHostReconciliation(key, state);
    }, delayMs);
  }

  private async reconcileHostClaims(
    key: string,
    state: BrowserSidebarHostReconciliation,
    epoch: number,
  ): Promise<BrowserSidebarHostReconciliationOutcome> {
    while (epoch === this.hostClaimEpoch && state.reconciledRevision !== state.revision) {
      const revision = state.revision;
      const winner = selectBrowserSidebarHostClaim(this.hostClaims.get(key));
      if (!winner) {
        const outcome = await this.releaseActiveHostClaim(state, epoch);
        if (outcome !== "applied") return outcome;
        state.reconciledRevision = revision;
        continue;
      }

      const outcome = await this.applyHostClaimWinner(state, winner, epoch);
      if (outcome !== "applied") return outcome;
      state.reconciledRevision = revision;
    }
    return epoch === this.hostClaimEpoch ? "applied" : "stale";
  }

  private async applyHostClaimWinner(
    state: BrowserSidebarHostReconciliation,
    winner: BrowserSidebarHostClaim,
    epoch: number,
  ): Promise<BrowserSidebarHostReconciliationOutcome> {
    const input = winner.input;
    const lifecycleEpoch = state.lifecycleEpoch;
    const isCurrent = () =>
      epoch === this.hostClaimEpoch && lifecycleEpoch === state.lifecycleEpoch;
    const winnerChanged =
      state.activeClaimId !== winner.claimId ||
      state.activeInput === null ||
      state.hostGeneration === null ||
      state.mountGeneration === null;
    const mountGeneration = state.mountGeneration ?? this.claimMountGeneration(input);
    const hostGeneration = state.hostGeneration ?? this.claimHostGeneration(input);

    if (winnerChanged) {
      const rendererResult = await invokeBrowserSidebarCommand({
        type: "register-renderer-session",
        browserViewScopeId: input.browserViewScopeId,
        rendererInstanceId: this.rendererInstanceId,
      });
      if (!isCurrent()) return "stale";
      if (!rendererResult.ok) return "retry";
      if (input.tabRegistration === "ensure") {
        const tabResult = await invokeBrowserSidebarCommand({
          type: "register-tab",
          browserConversationId: input.browserConversationId,
          browserViewScopeId: input.browserViewScopeId,
          browserTabId: input.browserTabId,
          browserStorageId: input.browserStorageId,
          projectId: input.projectId,
          initialUrl: input.initialUrl,
          title: input.title,
          faviconUrl: input.faviconUrl,
          deviceToolbarVisible: input.deviceToolbarVisible,
          deviceToolbarState: input.deviceToolbarState,
        });
        if (!isCurrent()) return "stale";
        if (!tabResult.ok) return "retry";
      }
      const hostResult = await invokeBrowserSidebarCommand({
        type: "register-host",
        browserConversationId: input.browserConversationId,
        browserViewScopeId: input.browserViewScopeId,
        browserTabId: input.browserTabId,
        browserStorageId: input.browserStorageId,
        rendererInstanceId: this.rendererInstanceId,
        hostGeneration,
        mountGeneration,
        hostKind: input.hostKind,
        pagePersistence: input.pagePersistence,
        themeVariant: input.themeVariant,
      });
      if (!isCurrent()) return "stale";
      if (!hostResult.ok) return "retry";
      state.activeClaimId = winner.claimId;
      state.activeInput = input;
      state.hostGeneration = hostGeneration;
      state.mountGeneration = mountGeneration;
    }

    const presentation = input.presentation;
    this.syncWebview({
      browserConversationId: input.browserConversationId,
      browserViewScopeId: input.browserViewScopeId,
      browserTabId: input.browserTabId,
      browserStorageId: input.browserStorageId,
      projectId: input.projectId,
      hostKind: input.hostKind,
      initialUrl: input.initialUrl,
      bounds: presentation.bounds,
      mountGeneration,
      isVisible: presentation.isVisible,
      shouldPaint: presentation.shouldPaint,
      scale: presentation.scale,
      windowZoom: presentation.windowZoom,
      onHostCreated: (event) => {
        void notifyBrowserWebviewHostCreated(event);
      },
    });
    const presented = Boolean(
      input.hostKind === "panel" &&
      presentation.isVisible &&
      presentation.bounds &&
      presentation.bounds.width > 0 &&
      presentation.bounds.height > 0,
    );
    const syncResult = await invokeBrowserSidebarCommand({
      type: "sync-host",
      browserConversationId: input.browserConversationId,
      browserViewScopeId: input.browserViewScopeId,
      browserTabId: input.browserTabId,
      rendererInstanceId: this.rendererInstanceId,
      hostGeneration,
      mountGeneration,
      hostKind: input.hostKind,
      presented,
      themeVariant: input.themeVariant,
      visible: presentation.isVisible,
    });
    if (!isCurrent()) return "stale";
    if (!syncResult.ok) {
      state.activeClaimId = null;
      return "retry";
    }
    state.activeInput = input;
    return "applied";
  }

  private async releaseActiveHostClaim(
    state: BrowserSidebarHostReconciliation,
    epoch: number,
  ): Promise<BrowserSidebarHostReconciliationOutcome> {
    const lifecycleEpoch = state.lifecycleEpoch;
    const input = state.activeInput;
    const hostGeneration = state.hostGeneration;
    const mountGeneration = state.mountGeneration;
    if (!input || hostGeneration === null || mountGeneration === null) {
      state.activeClaimId = null;
      state.activeInput = null;
      state.hostGeneration = null;
      state.mountGeneration = null;
      return "applied";
    }
    const syncResult = await invokeBrowserSidebarCommand({
      type: "sync-host",
      browserConversationId: input.browserConversationId,
      browserViewScopeId: input.browserViewScopeId,
      browserTabId: input.browserTabId,
      rendererInstanceId: this.rendererInstanceId,
      hostGeneration,
      mountGeneration,
      hostKind: input.hostKind,
      presented: false,
      themeVariant: input.themeVariant,
      visible: false,
    });
    if (epoch !== this.hostClaimEpoch || lifecycleEpoch !== state.lifecycleEpoch) return "stale";
    if (!syncResult.ok) return "retry";
    this.detachWebview(input, mountGeneration);
    state.activeClaimId = null;
    state.activeInput = null;
    state.hostGeneration = null;
    state.mountGeneration = null;
    return "applied";
  }

  setBrowserUseCaptureSurface(event: BrowserSidebarBrowserUseCaptureSurfaceEvent): void {
    const key = makeHostKey(event);
    if (event.surfaceSize) {
      this.browserUseCaptureSurfaceSizes.set(key, event.surfaceSize);
    } else {
      this.browserUseCaptureSurfaceSizes.delete(key);
    }
    this.hosts.get(key)?.setBrowserUseCaptureSurfaceSize(event.surfaceSize);
  }

  destroyWebviewAtHostRequest(
    request: BrowserSidebarDestroyWebviewRequest,
    onDestroyed: (event: BrowserSidebarWebviewDestroyed) => void,
  ): void {
    const key = makeHostKey(request);
    const managedHost = this.hosts.get(key);
    const shouldDestroy = managedHost?.shouldDestroyForHostRequest(request) ?? false;
    let webContentsId: number | undefined;
    try {
      webContentsId = managedHost?.webview.getWebContentsId?.();
    } catch {
      webContentsId = undefined;
    }
    if (shouldDestroy && managedHost) {
      managedHost.dispose();
      this.hosts.delete(key);
      this.emitCursorOverlayHostsChanged();
      const reconciliation = this.hostReconciliations.get(key);
      if (reconciliation?.mountGeneration === request.mountGeneration) {
        reconciliation.lifecycleEpoch += 1;
        reconciliation.activeClaimId = null;
        reconciliation.activeInput = null;
        reconciliation.hostGeneration = null;
        reconciliation.mountGeneration = null;
        reconciliation.reconciledRevision = reconciliation.revision;
        reconciliation.retryAttempt = 0;
        if (reconciliation.retryTimeout !== null) {
          clearTimeout(reconciliation.retryTimeout);
          reconciliation.retryTimeout = null;
        }
      }
    }
    onDestroyed({
      browserConversationId: request.browserConversationId,
      browserViewScopeId: request.browserViewScopeId,
      browserTabId: request.browserTabId,
      mountGeneration: request.mountGeneration,
      reason: request.reason,
      teardownId: request.teardownId,
      disposition: shouldDestroy ? "destroyed" : "rejected",
      webContentsId,
    });
    if (shouldDestroy) {
      this.reservedHostGenerations.delete(key);
      this.annotationModes.delete(key);
      this.annotationDesignPreviews.delete(key);
      this.browserUseCaptureSurfaceSizes.delete(key);
    }
  }

  getCursorOverlayHost(input: WebviewHostKey): HTMLElement | null {
    return this.hosts.get(makeHostKey(input))?.cursorOverlayHost ?? null;
  }

  resyncAttachedHosts(): void {
    for (const host of this.hosts.values()) host.resync();
  }

  setAnnotationMode(
    input: WebviewHostKey,
    enabled: boolean,
    sessionId: string,
    selectionMode: "inspect" | "region" = "inspect",
  ): void {
    const key = makeHostKey(input);
    this.annotationModes.set(key, { enabled, sessionId, selectionMode });
    const host = this.hosts.get(key);
    if (!host || host.disposed) return;
    host.send("browser-annotation-mode", {
      enabled,
      selectionMode,
      sessionId,
    });
  }

  setAnnotationDesignPreview(
    input: WebviewHostKey,
    sessionId: string,
    change: BrowserAnnotationDesignChange | null,
    originalView: boolean,
  ): void {
    const key = makeHostKey(input);
    this.annotationDesignPreviews.set(key, {
      change,
      originalView,
      sessionId,
    });
    const host = this.hosts.get(key);
    if (!host || host.disposed) return;
    host.send("browser-annotation-design-preview", {
      after: change?.after ?? "",
      anchorId: change?.anchorId ?? "",
      originalView,
      property: change?.property ?? "",
      sessionId,
    });
  }

  async readIsAtDocumentBottom(input: WebviewHostKey): Promise<boolean | null> {
    const host = this.hosts.get(makeHostKey(input));
    if (!host || host.disposed || !host.isVisible) return null;

    try {
      const result = await host.webview.executeJavaScript?.(
        `(() => {
          const root = document.scrollingElement ?? document.documentElement;
          const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
          return root.scrollHeight <= root.scrollTop + viewportHeight + 1;
        })()`,
      );
      return typeof result === "boolean" ? result : null;
    } catch {
      return null;
    }
  }

  disposeAll(): void {
    const hadHosts = this.hosts.size > 0;
    this.hostClaimEpoch += 1;
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
    this.mountGenerations.clear();
    this.hostGenerations.clear();
    this.reservedHostGenerations.clear();
    this.annotationModes.clear();
    this.annotationDesignPreviews.clear();
    this.browserUseCaptureSurfaceSizes.clear();
    this.hostClaims.clear();
    for (const state of this.hostReconciliations.values()) {
      if (state.retryTimeout !== null) clearTimeout(state.retryTimeout);
    }
    this.hostReconciliations.clear();
    if (hadHosts) this.emitCursorOverlayHostsChanged();
  }

  private emitCursorOverlayHostsChanged(): void {
    for (const listener of this.cursorOverlayHostListeners) listener();
  }
}

function selectBrowserSidebarHostClaim(
  claims: ReadonlyMap<string, BrowserSidebarHostClaim> | undefined,
): BrowserSidebarHostClaim | null {
  if (!claims || claims.size === 0) return null;
  return [...claims.values()].sort((left, right) => {
    const priorityDelta = hostClaimPriority(right.input) - hostClaimPriority(left.input);
    return priorityDelta !== 0 ? priorityDelta : right.sequence - left.sequence;
  })[0]!;
}

function hostClaimPriority(input: BrowserSidebarHostClaimInput): number {
  if (input.hostKind === "panel" && input.presentation.isVisible) return 3;
  if (input.hostKind === "retained") return 2;
  if (input.hostKind === "panel") return 1;
  return 1;
}

function normalizeInitialWebviewUrl(url: string): string {
  if (isBlankBrowserUrl(url)) return "about:blank";
  const normalizedUrl = normalizeBrowserNavigationUrl(url);
  return isAllowedBrowserNavigationUrl(normalizedUrl) ? normalizedUrl : "about:blank";
}

function resolveBrowserStorageId(
  input: WebviewHostKey & {
    browserStorageId?: string;
  },
): string {
  return input.browserStorageId ?? `browser:legacy:${input.browserTabId}`;
}

function makeHostKey(input: WebviewHostKey): string {
  return makeBrowserSidebarTabKey(input);
}

function resolveBrowserSidebarVisibleWebviewZIndex(
  hostKind: BrowserSidebarWebviewHostKind,
): string {
  return String(
    hostKind === "retained"
      ? BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX
      : BROWSER_SIDEBAR_WEBVIEW_LAYER_Z_INDEX,
  );
}

export const browserSidebarRendererWebviewManager = new BrowserSidebarRendererWebviewManager();

function makeRendererInstanceId(): string {
  return createSecureUuid();
}
