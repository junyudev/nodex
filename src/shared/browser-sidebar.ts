export const BROWSER_SIDEBAR_PARTITION = "persist:codex-browser-app";
export const BROWSER_SIDEBAR_ROUTE_PARTITION_PREFIX = "persist:codex-browser-app-route:";

export const BROWSER_SIDEBAR_ZOOM_OPTIONS = [
  25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500,
] as const;

export interface BrowserSidebarViewport {
  width: number;
  height: number;
  zoomPercent: number;
  presetId: string;
}

export interface BrowserSidebarSize {
  width: number;
  height: number;
}

export interface BrowserSidebarTabIdentity {
  browserConversationId: string;
  browserViewScopeId: string;
  browserTabId: string;
}

export interface BrowserSidebarOpenNewTabRequest extends BrowserSidebarTabIdentity {
  url: string;
  background: boolean;
}

export interface BrowserSidebarImageDragStateEvent extends BrowserSidebarTabIdentity {
  isActive: boolean;
}

export type BrowserSidebarContextMenuActionEvent =
  | (BrowserSidebarTabIdentity & {
      action: "annotate" | "quick-annotate";
      point: {
        x: number;
        y: number;
      };
    })
  | (BrowserSidebarTabIdentity & {
      action: "image-attached";
      attachment: {
        id: string;
        fileName: string;
        source: string;
      };
    })
  | (BrowserSidebarTabIdentity & {
      action: "error";
      message: string;
    });

export function matchesBrowserSidebarTabIdentity<Identity extends BrowserSidebarTabIdentity>(
  candidate: Identity | null | undefined,
  expected: BrowserSidebarTabIdentity,
): candidate is Identity {
  if (!candidate) return false;
  return (
    candidate.browserConversationId === expected.browserConversationId &&
    candidate.browserViewScopeId === expected.browserViewScopeId &&
    candidate.browserTabId === expected.browserTabId
  );
}

export function makeBrowserSidebarConversationScopeKey(
  identity: Pick<BrowserSidebarTabIdentity, "browserConversationId" | "browserViewScopeId">,
): string {
  return `${identity.browserConversationId}\0${identity.browserViewScopeId}`;
}

export function makeBrowserSidebarTabKey(identity: BrowserSidebarTabIdentity): string {
  return `${makeBrowserSidebarConversationScopeKey(identity)}\0${identity.browserTabId}`;
}

export function makeDefaultBrowserSidebarTabId(browserConversationId: string): string {
  return `${browserConversationId}:legacy`;
}

export interface BrowserSidebarPhysicalHostIdentity extends BrowserSidebarTabIdentity {
  rendererInstanceId: string;
  hostGeneration: number;
}

export interface BrowserSidebarHostRouteIdentity extends BrowserSidebarPhysicalHostIdentity {
  mountGeneration: number;
}

export function requireWorkbenchBrowserTabProjectionId(tab: {
  readonly browserTabId: string | null;
  readonly kind: string;
}): string {
  const browserTabId = tab.browserTabId?.trim();
  if (tab.kind !== "browser" || !browserTabId) {
    throw new Error("Expected a browser tab with a logical browser identity");
  }
  return browserTabId;
}

export function makeBrowserSidebarRoutePartition(
  identity: BrowserSidebarTabIdentity,
  host?: Pick<BrowserSidebarPhysicalHostIdentity, "rendererInstanceId" | "hostGeneration">,
): string {
  const route = `${BROWSER_SIDEBAR_ROUTE_PARTITION_PREFIX}${encodeURIComponent(
    makeBrowserSidebarTabKey(identity),
  )}`;
  if (!host) return route;
  return `${route}:host:${encodeURIComponent(host.rendererInstanceId)}:${host.hostGeneration}`;
}

export function parseBrowserSidebarRoutePartition(
  partition: string | null | undefined,
): BrowserSidebarTabIdentity | null {
  if (!partition?.startsWith(BROWSER_SIDEBAR_ROUTE_PARTITION_PREFIX)) return null;
  try {
    const encodedRoute = partition
      .slice(BROWSER_SIDEBAR_ROUTE_PARTITION_PREFIX.length)
      .split(":host:", 1)[0];
    const decoded = decodeURIComponent(encodedRoute);
    const firstSeparatorIndex = decoded.indexOf("\0");
    const secondSeparatorIndex = decoded.indexOf("\0", firstSeparatorIndex + 1);
    if (
      firstSeparatorIndex <= 0 ||
      secondSeparatorIndex <= firstSeparatorIndex + 1 ||
      secondSeparatorIndex === decoded.length - 1
    ) {
      return null;
    }
    return {
      browserConversationId: decoded.slice(0, firstSeparatorIndex),
      browserViewScopeId: decoded.slice(firstSeparatorIndex + 1, secondSeparatorIndex),
      browserTabId: decoded.slice(secondSeparatorIndex + 1),
    };
  } catch {
    return null;
  }
}

export function parseBrowserSidebarHostRoutePartition(
  partition: string | null | undefined,
): BrowserSidebarPhysicalHostIdentity | null {
  const identity = parseBrowserSidebarRoutePartition(partition);
  if (!identity || !partition) return null;
  try {
    const hostMarkerIndex = partition.indexOf(":host:");
    if (hostMarkerIndex < 0) return null;
    const hostParts = partition.slice(hostMarkerIndex + ":host:".length).split(":");
    if (hostParts.length !== 2) return null;
    const rendererInstanceId = decodeURIComponent(hostParts[0] ?? "").trim();
    const hostGeneration = Number.parseInt(hostParts[1] ?? "", 10);
    if (
      rendererInstanceId.length === 0 ||
      !Number.isSafeInteger(hostGeneration) ||
      hostGeneration <= 0
    ) {
      return null;
    }
    return {
      ...identity,
      rendererInstanceId,
      hostGeneration,
    };
  } catch {
    return null;
  }
}

export interface BrowserSidebarDeviceToolbarState {
  responsiveViewportSize: BrowserSidebarSize | null;
  toolbarState: {
    isEnabled: boolean;
    presetId: string;
    width: number;
    height: number;
  };
}

export interface BrowserSidebarDevicePreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const BROWSER_SIDEBAR_DEVICE_PRESETS: readonly BrowserSidebarDevicePreset[] = [
  { id: "responsive", label: "Responsive", width: 390, height: 844 },
  { id: "4k", label: "4K", width: 2560, height: 1440 },
  { id: "laptop-l", label: "Laptop L", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1024, height: 768 },
  { id: "surface-pro-7", label: "Surface Pro 7", width: 912, height: 1368 },
  { id: "ipad-air", label: "iPad Air", width: 820, height: 1180 },
  { id: "ipad-mini", label: "iPad Mini", width: 768, height: 1024 },
  { id: "surface-duo", label: "Surface Duo", width: 540, height: 720 },
  { id: "iphone-15-pro-max", label: "iPhone 15 Pro Max", width: 430, height: 932 },
  { id: "pixel-8", label: "Pixel 8", width: 412, height: 915 },
  { id: "iphone-15-pro", label: "iPhone 15 Pro", width: 393, height: 852 },
  { id: "samsung-galaxy-s24-ultra", label: "Samsung Galaxy S24 Ultra", width: 384, height: 824 },
  { id: "iphone-se", label: "iPhone SE", width: 375, height: 667 },
];

export type BrowserSidebarInteractionMode = "browse" | "comment";

export interface BrowserSidebarFindState {
  open: boolean;
  query: string;
  activeMatchOrdinal: number | null;
  matchCount: number | null;
  caseSensitive: boolean;
}

export type BrowserPageLifecycleState =
  | "cold"
  | "restoring"
  | "live-attached"
  | "live-detached"
  | "suspending"
  | "suspended"
  | "closing"
  | "closed"
  | "crashed";

export type BrowserPageRestoreResult =
  | "already-live"
  | "snapshot-ready"
  | "missing"
  | "owned-by-another-window";

export type BrowserPageFailure =
  | { kind: "dns"; failedUrl: string; code: number }
  | { kind: "offline"; failedUrl: string; code: number }
  | { kind: "refused"; failedUrl: string; code: number }
  | { kind: "timeout"; failedUrl: string; code: number }
  | { kind: "certificate"; failedUrl: string; code: number }
  | { kind: "crashed"; failedUrl: string; reason: string }
  | { kind: "blocked"; failedUrl: string; policy: string }
  | {
      kind: "generic";
      failedUrl: string;
      code: number;
      description: string;
    };

export const DEFAULT_BROWSER_SIDEBAR_FIND_STATE: BrowserSidebarFindState = {
  open: false,
  query: "",
  activeMatchOrdinal: null,
  matchCount: null,
  caseSensitive: false,
};

export interface BrowserSidebarTabSnapshot extends BrowserSidebarTabIdentity {
  browserStorageId?: string;
  projectId: string | null;
  webContentsId: number | null;
  mountGeneration: number;
  url: string;
  pendingUrl?: string;
  title: string;
  faviconUrl?: string;
  isLoading: boolean;
  isWaitingForResponse: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomPercent: number;
  deviceToolbarVisible: boolean;
  viewport: BrowserSidebarViewport;
  deviceToolbarState: BrowserSidebarDeviceToolbarState;
  interactionMode: BrowserSidebarInteractionMode;
  findState: BrowserSidebarFindState;
  hasBrowserPage: boolean;
  pageActionsDisabled: boolean;
  presented?: boolean;
  visible?: boolean;
  lastSelectedAt?: number;
  audible?: boolean;
  mediaActive?: boolean;
  activeDownload?: boolean;
  lifecycleState?: BrowserPageLifecycleState;
  restoreResult?: BrowserPageRestoreResult;
  failure?: BrowserPageFailure;
  errorMessage?: string;
  updatedAt: number;
}

export interface BrowserSidebarStateSnapshot {
  tabs: BrowserSidebarTabSnapshot[];
}

export interface BrowserSidebarClonedTabInput extends BrowserSidebarTabIdentity {
  browserStorageId?: string;
  projectId: string | null;
  initialUrl?: string;
  deviceToolbarState: BrowserSidebarDeviceToolbarState;
}

export interface BrowserSidebarLocalServerRoute {
  id: string;
  path: string;
  title: string;
  lastSeenAt: number;
  hidden: boolean;
}

export interface BrowserSidebarLocalServer {
  id: string;
  origin: string;
  host: string;
  port: number;
  protocol: "http:" | "https:";
  lastSeenAt: number;
  online: boolean;
  hidden: boolean;
  routes: BrowserSidebarLocalServerRoute[];
}

export interface BrowserSidebarLocalServersSnapshot {
  projectId: string;
  isLoading: boolean;
  servers: BrowserSidebarLocalServer[];
  hiddenServerIds: string[];
  hiddenRouteIds: string[];
  updatedAt: number;
}

export type BrowserLocalServerShowMode = "online" | "all" | "hidden";
export type BrowserLocalServerSortMode = "recently-used" | "origin";

export interface BrowserLocalServerPreferences {
  showMode: BrowserLocalServerShowMode;
  sortMode: BrowserLocalServerSortMode;
  expandedProjectIds: string[];
}

export interface BrowserLocalServerPreferencesUpdate {
  showMode?: BrowserLocalServerShowMode;
  sortMode?: BrowserLocalServerSortMode;
  expandedProjectIds?: string[];
}

export const DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES: BrowserLocalServerPreferences = {
  showMode: "online",
  sortMode: "recently-used",
  expandedProjectIds: [],
};

export interface BrowserSidebarLocalServerThumbnailRequest extends BrowserSidebarTabIdentity {
  projectId: string;
  url: string;
}

export type BrowserSidebarLocalServerThumbnailResult =
  | {
      status: "ready";
      dataUrl: string;
      capturedAt: number;
    }
  | {
      status: "unavailable";
      message: string;
    };

export interface BrowserUseCursorState extends BrowserSidebarTabIdentity {
  animateMovement?: boolean;
  moveSequence: number;
  x: number;
  y: number;
  visible: boolean;
  updatedAt: number;
}

export interface BrowserUseTabState extends BrowserSidebarTabIdentity {
  /** Exact Codex thread (or provisional project Session) that owns this runtime tab. */
  codexSessionId: string;
  projectId: string | null;
  title: string;
  url: string;
  webContentsId: number | null;
  viewport: BrowserSidebarViewport;
  captureActive: boolean;
  released: boolean;
  updatedAt: number;
}

/** Stable Session presentation namespace that owns an agent turn's Browser output. */
export interface BrowserUsePresentationOrigin {
  browserConversationId: string;
  browserViewScopeId: string;
}

export interface BrowserSidebarBrowserUseStateSnapshot {
  tabs: BrowserUseTabState[];
  activeBrowserTabIdsByConversationScope: Record<string, string>;
  cursors: BrowserUseCursorState[];
}

export type BrowserUsePresentationTransition = "default" | "none";

export interface BrowserUsePresentationRequest extends BrowserSidebarTabIdentity {
  requestId: string;
  codexSessionId: string;
  projectId: string | null;
  visible: boolean;
  transition: BrowserUsePresentationTransition;
  source: "browser-use";
}

export interface BrowserUsePresentationResult extends BrowserSidebarTabIdentity {
  requestId: string;
  outcome: "accepted" | "unavailable" | "stale";
  message?: string;
}

export interface BrowserUsePageClosedEvent extends BrowserSidebarTabIdentity {
  reason: "agent" | "user" | "web-contents-destroyed";
}

export interface BrowserSidebarRuntimeSnapshot {
  state: BrowserSidebarStateSnapshot;
  browserUseState: BrowserSidebarBrowserUseStateSnapshot;
  presentationRequests: BrowserUsePresentationRequest[];
}

export interface BrowserSidebarBrowserUseViewportEvent extends BrowserSidebarTabIdentity {
  viewportSize: BrowserSidebarSize | null;
}

export interface BrowserSidebarBrowserUseCaptureSurfaceEvent extends BrowserSidebarTabIdentity {
  surfaceSize: BrowserSidebarSize | null;
}

export type BrowserBrowsingDataKind = "cookies" | "cache" | "site-data" | "history" | "downloads";

export type BrowserSidebarWebviewHostKind = "panel" | "background" | "retained";
export type BrowserSidebarThemeVariant = "light" | "dark";
export type BrowserSidebarWebviewDestroyReason =
  | "closed"
  | "reset"
  | "replaced"
  | "stale"
  | "unmounted"
  | "suspend";

export interface BrowserSidebarWebviewHostCreated extends BrowserSidebarTabIdentity {
  browserStorageId?: string;
  rendererInstanceId?: string;
  hostGeneration?: number;
  projectId: string | null;
  hostKind: BrowserSidebarWebviewHostKind;
  mountGeneration: number;
  webContentsId: number;
  initialUrl: string;
  title?: string;
}

export interface BrowserSidebarWebviewAttached extends BrowserSidebarTabIdentity {
  mountGeneration: number;
  webContentsId: number;
}

export interface BrowserSidebarDestroyWebviewRequest extends BrowserSidebarTabIdentity {
  mountGeneration: number;
  reason: BrowserSidebarWebviewDestroyReason;
  teardownId: string;
}

export interface BrowserSidebarWebviewDestroyed extends BrowserSidebarTabIdentity {
  mountGeneration: number;
  reason: BrowserSidebarWebviewDestroyReason;
  teardownId: string;
  disposition: "destroyed" | "rejected" | "cancelled";
  webContentsId?: number;
}

type BrowserSidebarTargetedCommand<Command> = Command & BrowserSidebarTabIdentity;

export type BrowserSidebarCommand =
  | {
      type: "register-renderer-session";
      browserViewScopeId: string;
      rendererInstanceId: string;
    }
  | {
      type: "sync-theme";
      themeVariant: BrowserSidebarThemeVariant;
    }
  | {
      type: "capture-browser-use-route";
      browserConversationId: string;
      browserViewScopeId: string;
      codexSessionId: string;
      projectId: string | null;
    }
  | BrowserSidebarTargetedCommand<{
      type: "register-host";
      browserStorageId: string;
      rendererInstanceId: string;
      hostGeneration: number;
      mountGeneration: number;
      hostKind: BrowserSidebarWebviewHostKind;
      pagePersistence: "durable" | "browser-use";
      themeVariant: BrowserSidebarThemeVariant;
    }>
  | BrowserSidebarTargetedCommand<{
      type: "sync-host";
      rendererInstanceId: string;
      hostGeneration: number;
      mountGeneration: number;
      hostKind: BrowserSidebarWebviewHostKind;
      presented: boolean;
      themeVariant: BrowserSidebarThemeVariant;
      visible: boolean;
    }>
  | BrowserSidebarTargetedCommand<{
      type: "register-tab";
      projectId: string | null;
      initialUrl?: string;
      title?: string;
      faviconUrl?: string;
      deviceToolbarVisible?: boolean;
      deviceToolbarState?: BrowserSidebarDeviceToolbarState;
      browserStorageId?: string;
    }>
  | BrowserSidebarTargetedCommand<{
      type: "navigate";
      url: string;
      hostId?: string;
      source?: "manual" | "local-server" | "browser-use";
      initiator?: string;
      originalUrl?: string;
    }>
  | BrowserSidebarTargetedCommand<{ type: "go-back" }>
  | BrowserSidebarTargetedCommand<{ type: "go-forward" }>
  | BrowserSidebarTargetedCommand<{ type: "reload"; ignoreCache?: boolean }>
  | BrowserSidebarTargetedCommand<{ type: "stop" }>
  | { type: "open-external"; url: string }
  | BrowserSidebarTargetedCommand<{ type: "open-external"; url?: undefined }>
  | BrowserSidebarTargetedCommand<{ type: "close-tab" }>
  | BrowserSidebarTargetedCommand<{ type: "set-title"; title: string }>
  | BrowserSidebarTargetedCommand<{ type: "set-favicon"; faviconUrl?: string }>
  | BrowserSidebarTargetedCommand<{ type: "step-zoom"; delta: number; showBanner?: boolean }>
  | BrowserSidebarTargetedCommand<{
      type: "set-zoom-percent";
      zoomPercent: number;
      showBanner?: boolean;
    }>
  | BrowserSidebarTargetedCommand<{ type: "reset-zoom"; showBanner?: boolean }>
  | BrowserSidebarTargetedCommand<{ type: "set-device-toolbar-visible"; visible: boolean }>
  | BrowserSidebarTargetedCommand<{ type: "set-viewport"; viewport: BrowserSidebarViewport }>
  | BrowserSidebarTargetedCommand<{
      type: "set-interaction-mode";
      mode: BrowserSidebarInteractionMode;
    }>
  | BrowserSidebarTargetedCommand<{
      type: "quick-annotate";
      sessionId: string;
      point: {
        x: number;
        y: number;
      };
    }>
  | BrowserSidebarTargetedCommand<{ type: "open-find" }>
  | BrowserSidebarTargetedCommand<{ type: "close-find" }>
  | BrowserSidebarTargetedCommand<{
      type: "set-find-query";
      query: string;
      caseSensitive?: boolean;
    }>
  | BrowserSidebarTargetedCommand<{ type: "find-next" }>
  | BrowserSidebarTargetedCommand<{ type: "find-previous" }>
  | BrowserSidebarTargetedCommand<{ type: "capture-screenshot" }>
  | BrowserSidebarTargetedCommand<{ type: "print" }>
  | BrowserSidebarTargetedCommand<{ type: "attach-dragged-image" }>
  | BrowserSidebarTargetedCommand<{
      type: "browser-use-cursor-arrived";
      moveSequence: number;
    }>
  | { type: "local-servers-refresh"; projectId: string }
  | { type: "hide-local-server"; projectId: string; server: BrowserSidebarLocalServer }
  | { type: "unhide-local-server"; projectId: string; url: string }
  | { type: "remove-local-server-route"; projectId: string; serverUrl: string; routeUrl: string }
  | { type: "browser-use-upsert-tab"; tab: BrowserUseTabState }
  | BrowserSidebarTargetedCommand<{ type: "browser-use-release-tab" }>
  | {
      type: "browser-use-set-active-tab";
      browserConversationId: string;
      browserViewScopeId: string;
      browserTabId: string | null;
    }
  | {
      type: "browser-use-resolve-presentation";
      result: BrowserUsePresentationResult;
    }
  | { type: "browser-use-set-cursor"; cursor: BrowserUseCursorState }
  | { type: "browser-use-set-viewport"; event: BrowserSidebarBrowserUseViewportEvent }
  | { type: "browser-use-set-capture-surface"; event: BrowserSidebarBrowserUseCaptureSurfaceEvent };

export type BrowserSidebarCommandResult =
  | { ok: true; dataUrl?: string; snapshot?: BrowserSidebarTabSnapshot }
  | { ok: false; message: string };

export type BrowserBrowsingDataClearResult = { ok: true } | { ok: false; message: string };
