import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type RefObject,
  type ReactNode,
} from "react";
import type { MotionValue } from "motion/react";
import {
  AlertTriangle,
  ContactRound,
  KeyRound,
  LockKeyhole,
  Maximize2,
  Minus,
  Printer,
  Puzzle,
  RotateCcw,
  Smartphone,
  WifiOff,
} from "@/components/shared/icons/generic-icons";
import {
  BROWSER_SIDEBAR_DEVICE_PRESETS,
  DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
  DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
  makeBrowserSidebarTabKey,
  matchesBrowserSidebarTabIdentity,
  requireWorkbenchBrowserTabProjectionId,
  type BrowserBrowsingDataKind,
  type BrowserLocalServerPreferences,
  type BrowserLocalServerPreferencesUpdate,
  type BrowserLocalServerShowMode,
  type BrowserLocalServerSortMode,
  type BrowserSidebarBrowserUseViewportEvent,
  type BrowserSidebarBrowserUseStateSnapshot,
  type BrowserSidebarCommand,
  type BrowserSidebarCommandResult,
  type BrowserSidebarContextMenuActionEvent,
  type BrowserSidebarImageDragStateEvent,
  type BrowserSidebarLocalServer,
  type BrowserSidebarLocalServerThumbnailResult,
  type BrowserSidebarLocalServersSnapshot,
  type BrowserSidebarOpenNewTabRequest,
  type BrowserPageFailure,
  type BrowserSidebarTabSnapshot,
  type BrowserSidebarViewport,
  type BrowserSidebarWebviewHostCreated,
  type BrowserUseCursorState,
} from "../../../shared/browser-sidebar";
import type {
  BrowserDownloadAction,
  BrowserDownloadRecord,
  BrowserDownloadsSnapshot,
} from "../../../shared/browser-download";
import type {
  BrowserAnnotationAnchor,
  BrowserAnnotationDesignChange,
  BrowserAnnotationRoutedAnchorUpdateEvent,
  BrowserAnnotationRoutedSelectionEvent,
} from "../../../shared/browser-annotation";
import type {
  BrowserContactInfo,
  BrowserCredentialSaveCandidate,
  BrowserCredentialSummary,
  BrowserSiteInfo,
} from "../../../shared/browser-profile";
import { isBlankBrowserUrl, normalizeBrowserNavigationUrl } from "../../../shared/browser-url";
import { createSecureRuntimeId } from "../../../shared/secure-runtime-id";
import { useTheme } from "@/lib/use-theme";
import {
  BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX,
  browserSidebarRendererWebviewManager,
} from "./browser-sidebar-webview-manager";
import { BrowserUseCursorPortal } from "./browser-use-cursor-portal";
import { useBrowserSidebarRendererState } from "./browser-sidebar-renderer-state-store";
import { computeBrowserViewportLayout } from "./browser-viewport-layout";
import {
  clearBrowserDocumentBottom,
  publishBrowserDocumentBottom,
} from "./browser-document-bottom-store";
import {
  readBrowserConfigDeviceToolbarState,
  readBrowserConfigDeviceToolbarVisible,
  readBrowserConfigFavicon,
  readBrowserConfigStorageId,
  readBrowserConfigTitle,
  readBrowserConfigUrl,
} from "./browser-sidebar-tab-config";
import {
  readBrowserAddressValue,
  resolveBrowserLocalServerSettings,
  resolveBrowserZoomOptions,
  resolveVisibleLocalServers,
  rotateBrowserViewport,
  shouldCommitBrowserAddressEdit,
  shouldSkipBrowserAddressCommit,
  updateBrowserViewportDimension,
  type BrowserLocalServerSettings,
} from "./browser-sidebar-ui-model";
import type { WorkbenchTabProjection, WorkbenchTabUpdateInput } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { invoke } from "@/lib/api";
import { useRegisterContentSearchBrowserTarget } from "@/features/content-search/content-search-context";
import {
  RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE,
  RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE,
} from "@/lib/right-panel-composer-overlay-reserve";
import { cn } from "@/lib/utils";
import { publishBrowserAnnotationAttachment } from "./browser-annotation-attachments";
import {
  applyBrowserAnnotationAnchorUpdate,
  applyBrowserAnnotationSelection,
  createBrowserAnnotationDraftState,
  navigateBrowserAnnotationDraft,
  removeBrowserAnnotationAnchor,
  resetBrowserAnnotationDraft,
  updateBrowserAnnotationDesignChange,
} from "./browser-annotation-state";
import { publishBrowserImageAttachment } from "./browser-image-attachments";
import { publishBrowserImageDragState } from "./browser-image-drag-state";
import {
  BrowserAnnotateIcon,
  ActivitySpinnerIcon,
  BrowserBackIcon,
  DeleteIcon,
  DownloadIcon,
  BrowserExternalIcon,
  BrowserHideIcon,
  BrowserLocalServerFilterIcon,
  BrowserMoreIcon,
  BrowserReloadIcon,
  BrowserScreenshotIcon,
  CheckmarkIcon,
  CloseIcon,
  StopIcon,
  FolderOpenIcon,
  HistoryIcon,
  InfoIcon,
  OpenInIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  ResetIcon,
  SettingsGeneralIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { BrowserProfileImportDialog } from "./browser-profile-import-dialog";
import type { BrowserSettingsDestination } from "./browser-settings-pages";

type BrowserTab = WorkbenchTabProjection & { preview?: true };

export interface BrowserSurfaceContext {
  /** Stable presentation owner used to isolate Browser hosts and snapshots. */
  readonly browserConversationId: string;
  /** Present only when Browser annotations/attachments target a real Codex conversation. */
  readonly codexSessionId: string | null;
}

const BROWSER_CHROME_CLASS =
  "relative z-10 h-toolbar-pane min-w-0 shrink-0 border-b border-token-border bg-token-main-surface-primary";
const BROWSER_CHROME_ROW_CLASS =
  "draggable flex h-full min-w-0 items-center gap-1 px-2 text-token-description-foreground";
const BROWSER_TOOL_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex shrink-0 items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-lg text-token-text-tertiary enabled:hover:bg-token-list-hover-background enabled:hover:text-token-text-primary data-[state=open]:bg-token-list-hover-background border-transparent h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square justify-center !px-0";
const BROWSER_ADDRESS_BAR_CLASS =
  "group/address-bar flex h-[28px] min-w-0 w-full max-w-[770px] items-center overflow-hidden rounded-[10px] transition-[background-color,box-shadow] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-colors cursor-text bg-transparent hover:bg-token-list-hover-background focus-within:bg-transparent focus-within:ring-1 focus-within:ring-inset focus-within:ring-token-border";
const BROWSER_COLLAPSIBLE_ACTION_CLASS =
  "grid min-w-0 overflow-hidden transition-[max-width,opacity,transform] duration-150 ease-out";
const BROWSER_DROPDOWN_CONTENT_STYLE: CSSProperties = {
  zIndex: BROWSER_SIDEBAR_VISIBLE_WEBVIEW_Z_INDEX,
};
const DEFAULT_BROWSER_SNAPSHOT: Omit<
  BrowserSidebarTabSnapshot,
  "browserConversationId" | "browserViewScopeId" | "browserTabId" | "projectId" | "updatedAt"
> = {
  webContentsId: null,
  mountGeneration: 0,
  url: "about:blank",
  title: "New tab",
  isLoading: false,
  isWaitingForResponse: false,
  canGoBack: false,
  canGoForward: false,
  zoomPercent: 100,
  deviceToolbarVisible: false,
  viewport: {
    width: 390,
    height: 844,
    zoomPercent: 100,
    presetId: "responsive",
  },
  deviceToolbarState: {
    responsiveViewportSize: null,
    toolbarState: {
      isEnabled: false,
      presetId: "responsive",
      width: 390,
      height: 844,
    },
  },
  interactionMode: "browse",
  findState: DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
  hasBrowserPage: false,
  pageActionsDisabled: true,
};

const ignoreBrowserTabUpdate = (): null => null;

export function BrowserSidebarPanel({
  tab,
  activeSession,
  surfaceContext,
  browserViewScopeId,
  onRefreshSessions,
  onUpdateTab = ignoreBrowserTabUpdate,
  onOpenNewTab,
  onOpenBrowserSettings,
  boundsSyncTrigger,
  activeForContentSearch = false,
  isVisible,
}: {
  tab: BrowserTab;
  activeSession?: WorkbenchSessionRenderProjection;
  surfaceContext?: BrowserSurfaceContext;
  browserViewScopeId: string;
  onRefreshSessions: (projectId: string | null) => Promise<WorkbenchSessionRenderProjection[]>;
  onUpdateTab?: (tabId: string, patch: WorkbenchTabUpdateInput) => WorkbenchTabProjection | null;
  onOpenNewTab?: (request: BrowserSidebarOpenNewTabRequest) => void | Promise<void>;
  onOpenBrowserSettings?: (sectionId: BrowserSettingsDestination) => void;
  boundsSyncTrigger?: MotionValue<number>;
  activeForContentSearch?: boolean;
  isVisible: boolean;
}) {
  const browserConversationId =
    surfaceContext?.browserConversationId ?? activeSession?.id ?? browserViewScopeId;
  const fallbackCodexSessionId = surfaceContext
    ? surfaceContext.codexSessionId
    : (activeSession?.thread?.threadId ?? activeSession?.id ?? null);
  const browserRuntimeAvailable = typeof window !== "undefined" && Boolean(window.api);
  const browserRuntime = useBrowserSidebarRendererState();
  const { resolved: themeVariant } = useTheme();
  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const syncWebviewPresentationRef = useRef<(() => void) | null>(null);
  const isVisibleRef = useRef(isVisible);
  const themeVariantRef = useRef(themeVariant);
  isVisibleRef.current = isVisible;
  themeVariantRef.current = themeVariant;
  const [snapshot, setSnapshot] = useState<BrowserSidebarTabSnapshot>(() =>
    makeInitialSnapshot(tab, browserConversationId, browserViewScopeId),
  );
  const [addressValue, setAddressValue] = useState(readBrowserAddressValue(snapshot.url));
  const [addressFocused, setAddressFocused] = useState(false);
  const [localServers, setLocalServers] = useState<BrowserSidebarLocalServersSnapshot | null>(null);
  const [localServerPreferences, setLocalServerPreferences] =
    useState<BrowserLocalServerPreferences>(() => ({
      ...DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
      expandedProjectIds: [],
    }));
  const [eventBrowserUseState, setEventBrowserUseState] =
    useState<BrowserSidebarBrowserUseStateSnapshot | null>(null);
  const [browserUseCursor, setBrowserUseCursor] = useState<BrowserUseCursorState | null>(null);
  const [browserUseViewport, setBrowserUseViewport] =
    useState<BrowserSidebarBrowserUseViewportEvent | null>(null);
  const [registeredBrowserKey, setRegisteredBrowserKey] = useState<string | null>(null);
  const [clearDataStatus, setClearDataStatus] = useState<string | null>(null);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [profileImportOpen, setProfileImportOpen] = useState(false);
  const [siteInfo, setSiteInfo] = useState<BrowserSiteInfo | null>(null);
  const [credentialCandidate, setCredentialCandidate] =
    useState<BrowserCredentialSaveCandidate | null>(null);
  const [downloadsSnapshot, setDownloadsSnapshot] = useState<BrowserDownloadsSnapshot>({
    downloads: [],
  });
  const annotationSessionIdRef = useRef(createSecureRuntimeId("browser-annotation"));
  const [annotationDraft, setAnnotationDraft] = useState(() =>
    createBrowserAnnotationDraftState(snapshot.url),
  );
  const {
    anchors: annotationAnchors,
    designChange: annotationDesignChange,
    intent: annotationIntent,
    note: annotationNote,
    originalView: annotationOriginalView,
    selectionMode: annotationSelectionMode,
  } = annotationDraft;
  const isBlank = !snapshot.hasBrowserPage || isBlankBrowserUrl(snapshot.url);
  const commentMode = snapshot.interactionMode === "comment";
  const pageActionsDisabled = snapshot.pageActionsDisabled || isBlank;
  const initialWebviewUrlRef = useRef(snapshot.url);
  if (isBlank) {
    initialWebviewUrlRef.current = "about:blank";
  } else if (isBlankBrowserUrl(initialWebviewUrlRef.current)) {
    initialWebviewUrlRef.current = snapshot.url;
  }

  const command = useCallback(
    async (input: BrowserSidebarCommand): Promise<BrowserSidebarCommandResult> => {
      return invoke("browser-sidebar-command", input) as Promise<BrowserSidebarCommandResult>;
    },
    [],
  );
  const updateLocalServerPreferences = useCallback(
    async (update: BrowserLocalServerPreferencesUpdate) => {
      const preferences = await invoke("browser-local-server-preferences-update", update);
      setLocalServerPreferences(preferences);
    },
    [],
  );
  const browserTabId = requireWorkbenchBrowserTabProjectionId(tab);
  const tabInitialUrl = readBrowserConfigUrl(tab);
  const tabFaviconUrl = readBrowserConfigFavicon(tab);
  const tabDeviceToolbarVisible = readBrowserConfigDeviceToolbarVisible(tab);
  const tabDeviceToolbarState = readBrowserConfigDeviceToolbarState(tab);
  const tabDeviceToolbarStateRef = useRef(tabDeviceToolbarState);
  tabDeviceToolbarStateRef.current = tabDeviceToolbarState;
  const tabDeviceToolbarStateKey = JSON.stringify(tabDeviceToolbarState ?? null);
  const browserStorageId = readBrowserConfigStorageId(tab) ?? `browser:legacy:${browserTabId}`;
  const tabProjectId = tab.projectId;
  const tabTitle = tab.title;
  const browserIdentity = useMemo(
    () => ({
      browserConversationId,
      browserViewScopeId,
      browserTabId,
    }),
    [browserConversationId, browserTabId, browserViewScopeId],
  );
  const browserIdentityKey = makeBrowserSidebarTabKey(browserIdentity);
  const browserUseState = eventBrowserUseState ?? browserRuntime.browserUseState;
  const activeBrowserUseTabId =
    browserUseState.activeBrowserTabIdsByConversationScope[
      `${browserIdentity.browserConversationId}\0${browserIdentity.browserViewScopeId}`
    ] ?? null;
  const exactBrowserUseTab =
    browserUseState.tabs.find((item) => matchesBrowserSidebarTabIdentity(item, browserIdentity)) ??
    null;
  const activeBrowserUseTab =
    activeBrowserUseTabId === browserIdentity.browserTabId ? exactBrowserUseTab : null;
  const codexSessionId =
    exactBrowserUseTab?.codexSessionId ??
    (tab.kind === "browser" ? tab.config.browserUseSource?.codexSessionId : null) ??
    fallbackCodexSessionId;
  const shouldMountWebview = !isBlank || activeBrowserUseTab !== null;
  const handleOpenNewTab = useEffectEvent((request: BrowserSidebarOpenNewTabRequest) => {
    void onOpenNewTab?.(request);
  });

  useEffect(() => {
    if (!browserRuntimeAvailable || isBlank || registeredBrowserKey !== browserIdentityKey) {
      setSiteInfo(null);
      return;
    }
    let cancelled = false;
    void invoke("browser-site-info", browserIdentity)
      .then((nextSiteInfo) => {
        if (!cancelled) setSiteInfo(nextSiteInfo);
      })
      .catch(() => {
        if (!cancelled) setSiteInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    browserIdentity,
    browserIdentityKey,
    browserRuntimeAvailable,
    isBlank,
    registeredBrowserKey,
    snapshot.url,
  ]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    const unsubscribe = window.api?.on("browser-credential-save-candidate", (payload) => {
      const candidate = payload as BrowserCredentialSaveCandidate | undefined;
      if (!matchesBrowserSidebarTabIdentity(candidate, browserIdentity)) return;
      setCredentialCandidate(candidate);
    });
    return () => unsubscribe?.();
  }, [browserIdentity, browserRuntimeAvailable]);

  useEffect(() => {
    if (!credentialCandidate) return undefined;
    const remaining = credentialCandidate.expiresAt - Date.now();
    if (remaining <= 0) {
      setCredentialCandidate(null);
      return undefined;
    }
    const timeout = window.setTimeout(() => setCredentialCandidate(null), remaining);
    return () => window.clearTimeout(timeout);
  }, [credentialCandidate]);

  const actOnCredentialCandidate = useCallback(
    async (action: "dismiss" | "save") => {
      if (!credentialCandidate) return;
      const result = await invoke("browser-credential-candidate-action", {
        candidateId: credentialCandidate.candidateId,
        action,
      });
      setCredentialCandidate(null);
      if (!result.ok) setClearDataStatus(result.message ?? "Unable to save password");
    },
    [credentialCandidate],
  );
  const contentSearchBrowserTarget = useMemo(() => {
    if (!activeForContentSearch || pageActionsDisabled) return null;
    return {
      ...browserIdentity,
      available: snapshot.hasBrowserPage && !isBlank,
      findState: snapshot.findState,
      command,
    };
  }, [
    activeForContentSearch,
    browserIdentity,
    command,
    isBlank,
    pageActionsDisabled,
    snapshot.findState,
    snapshot.hasBrowserPage,
  ]);
  useRegisterContentSearchBrowserTarget(contentSearchBrowserTarget);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    void invoke("browser-local-server-preferences-get")
      .then((preferences) => {
        if (preferences) setLocalServerPreferences(preferences);
      })
      .catch(() => undefined);
    return window.api?.on("browser-local-server-preferences-changed", (preferences) => {
      setLocalServerPreferences(preferences as BrowserLocalServerPreferences);
    });
  }, [browserRuntimeAvailable]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    void invoke("browser-downloads-list").then((snapshot) => {
      if (snapshot && Array.isArray(snapshot.downloads)) {
        setDownloadsSnapshot(snapshot);
      }
    });
    return window.api?.on("browser-downloads-state", (payload) => {
      const snapshot = payload as BrowserDownloadsSnapshot | null | undefined;
      if (snapshot && Array.isArray(snapshot.downloads)) {
        setDownloadsSnapshot(snapshot);
      }
    });
  }, [browserRuntimeAvailable]);

  useEffect(() => {
    if (!browserRuntimeAvailable || isBlank) return undefined;
    const annotationSessionId = annotationSessionIdRef.current;
    browserSidebarRendererWebviewManager.setAnnotationMode(
      browserIdentity,
      commentMode,
      annotationSessionId,
      annotationSelectionMode,
    );
    return () => {
      browserSidebarRendererWebviewManager.setAnnotationMode(
        browserIdentity,
        false,
        annotationSessionId,
        annotationSelectionMode,
      );
    };
  }, [annotationSelectionMode, browserIdentity, browserRuntimeAvailable, commentMode, isBlank]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    return window.api?.on("browser-annotation-selection", (payload) => {
      const event = payload as BrowserAnnotationRoutedSelectionEvent;
      if (!matchesBrowserSidebarTabIdentity(event, browserIdentity)) return;
      if (event.selection.sessionId !== annotationSessionIdRef.current) return;
      setAnnotationDraft((current) => applyBrowserAnnotationSelection(current, event.selection));
    });
  }, [browserIdentity, browserRuntimeAvailable]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    return window.api?.on("browser-annotation-anchor-update", (payload) => {
      const event = payload as BrowserAnnotationRoutedAnchorUpdateEvent;
      if (!matchesBrowserSidebarTabIdentity(event, browserIdentity)) return;
      if (event.update.sessionId !== annotationSessionIdRef.current) return;
      setAnnotationDraft((current) =>
        applyBrowserAnnotationAnchorUpdate(current, event.update.anchor),
      );
    });
  }, [browserIdentity, browserRuntimeAvailable]);

  useEffect(() => {
    if (!browserRuntimeAvailable || isBlank) return undefined;
    const annotationSessionId = annotationSessionIdRef.current;
    browserSidebarRendererWebviewManager.setAnnotationDesignPreview(
      browserIdentity,
      annotationSessionId,
      commentMode && annotationIntent === "designChange" ? annotationDesignChange : null,
      annotationOriginalView,
    );
    return () => {
      browserSidebarRendererWebviewManager.setAnnotationDesignPreview(
        browserIdentity,
        annotationSessionId,
        null,
        true,
      );
    };
  }, [
    annotationDesignChange,
    annotationIntent,
    annotationOriginalView,
    browserIdentity,
    browserRuntimeAvailable,
    commentMode,
    isBlank,
  ]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    return window.api?.on("browser-sidebar-image-drag-state", (payload) => {
      const event = payload as BrowserSidebarImageDragStateEvent;
      if (!matchesBrowserSidebarTabIdentity(event, browserIdentity)) return;
      if (!codexSessionId) return;
      publishBrowserImageDragState(codexSessionId, event);
    });
  }, [browserIdentity, browserRuntimeAvailable, codexSessionId]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    return window.api?.on("browser-sidebar-context-menu-action", (payload) => {
      const event = payload as BrowserSidebarContextMenuActionEvent;
      if (!matchesBrowserSidebarTabIdentity(event, browserIdentity)) return;
      if (event.action === "image-attached") {
        if (!codexSessionId) {
          setClearDataStatus("Open a Conversation to add browser context");
          return;
        }
        publishBrowserImageAttachment(codexSessionId, {
          id: event.attachment.id,
          filename: event.attachment.fileName,
          source: event.attachment.source,
        });
        setClearDataStatus("Browser image added to composer");
        return;
      }
      if (event.action === "error") {
        setClearDataStatus(event.message);
        return;
      }

      setAnnotationDraft((current) => ({
        ...current,
        selectionMode: "inspect",
      }));
      void command(
        event.action === "quick-annotate"
          ? {
              type: "quick-annotate",
              ...browserIdentity,
              sessionId: annotationSessionIdRef.current,
              point: event.point,
            }
          : {
              type: "set-interaction-mode",
              ...browserIdentity,
              mode: "comment",
            },
      ).then((result) => {
        if (!result.ok) setClearDataStatus(result.message);
      });
    });
  }, [browserIdentity, browserRuntimeAvailable, codexSessionId, command]);

  useEffect(() => {
    setAnnotationDraft((current) => navigateBrowserAnnotationDraft(current, snapshot.url));
  }, [snapshot.url]);

  useEffect(() => {
    if (!commentMode) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (annotationAnchors.length > 0) {
        setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
        return;
      }
      void command({
        type: "set-interaction-mode",
        ...browserIdentity,
        mode: "browse",
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [annotationAnchors.length, browserIdentity, command, commentMode]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;

    let cancelled = false;
    void (async () => {
      const rendererResult = await command({
        type: "register-renderer-session",
        browserViewScopeId,
        rendererInstanceId: browserSidebarRendererWebviewManager.getRendererInstanceId(),
      });
      if (!rendererResult.ok || cancelled) return;
      const result = await command({
        type: "register-tab",
        ...browserIdentity,
        projectId: tabProjectId,
        initialUrl: tabInitialUrl,
        title: tabTitle,
        faviconUrl: tabFaviconUrl,
        deviceToolbarVisible: tabDeviceToolbarVisible,
        deviceToolbarState: tabDeviceToolbarStateRef.current,
        browserStorageId,
      });
      if (!result.ok || cancelled) return;
      setRegisteredBrowserKey(browserIdentityKey);
      if (result.snapshot) setSnapshot(result.snapshot);
    })();
    if (tabProjectId !== null) {
      void command({ type: "local-servers-refresh", projectId: tabProjectId });
    }

    return () => {
      cancelled = true;
    };
  }, [
    browserIdentity,
    browserIdentityKey,
    browserRuntimeAvailable,
    browserStorageId,
    browserViewScopeId,
    command,
    tabDeviceToolbarStateKey,
    tabDeviceToolbarVisible,
    tabFaviconUrl,
    tabInitialUrl,
    tabProjectId,
    tabTitle,
  ]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    const unsubscribeState = window.api?.on("browser-sidebar-state", (payload) => {
      const state = payload as { tabs?: BrowserSidebarTabSnapshot[] } | undefined;
      const next = state?.tabs?.find((item) =>
        matchesBrowserSidebarTabIdentity(item, browserIdentity),
      );
      if (!next) return;
      setSnapshot(next);
    });
    const unsubscribeLocalServers = window.api?.on("browser-sidebar-local-servers", (payload) => {
      const next = payload as BrowserSidebarLocalServersSnapshot | undefined;
      if (tabProjectId === null || next?.projectId !== tabProjectId) return;
      setLocalServers(next);
    });
    const unsubscribeBrowserUse = window.api?.on("browser-sidebar-browser-use-state", (payload) => {
      const next = payload as BrowserSidebarBrowserUseStateSnapshot;
      setEventBrowserUseState(next);
      if (
        next.cursors.some((candidate) =>
          matchesBrowserSidebarTabIdentity(candidate, browserIdentity),
        )
      ) {
        return;
      }
      setBrowserUseCursor((current) =>
        matchesBrowserSidebarTabIdentity(current, browserIdentity) ? null : current,
      );
    });
    const unsubscribeBrowserUseViewport = window.api?.on(
      "browser-sidebar-browser-use-viewport",
      (payload) => {
        const next = payload as BrowserSidebarBrowserUseViewportEvent | undefined;
        if (!matchesBrowserSidebarTabIdentity(next, browserIdentity)) return;
        setBrowserUseViewport(next);
      },
    );
    const unsubscribeBrowserUseCursor = window.api?.on(
      "browser-sidebar-browser-use-cursor-state",
      (payload) => {
        const next = payload as BrowserUseCursorState | undefined;
        if (!matchesBrowserSidebarTabIdentity(next, browserIdentity)) return;
        setBrowserUseCursor(next);
      },
    );
    const unsubscribeOpenNewTab = window.api?.on("browser-sidebar-open-new-tab", (payload) => {
      const request = payload as BrowserSidebarOpenNewTabRequest;
      if (!matchesBrowserSidebarTabIdentity(request, browserIdentity)) return;
      handleOpenNewTab(request);
    });
    return () => {
      unsubscribeState?.();
      unsubscribeLocalServers?.();
      unsubscribeBrowserUse?.();
      unsubscribeBrowserUseViewport?.();
      unsubscribeBrowserUseCursor?.();
      unsubscribeOpenNewTab?.();
    };
  }, [browserIdentity, browserRuntimeAvailable, tabProjectId]);

  useLayoutEffect(() => {
    if (
      !browserRuntimeAvailable ||
      registeredBrowserKey !== browserIdentityKey ||
      !shouldMountWebview ||
      downloadsOpen ||
      profileImportOpen ||
      snapshot.failure !== undefined
    ) {
      return undefined;
    }
    const container = webviewHostRef.current;
    if (!container) return undefined;

    const mountGeneration = browserSidebarRendererWebviewManager.claimMountGeneration({
      ...browserIdentity,
    });
    const hostGeneration = browserSidebarRendererWebviewManager.claimHostGeneration({
      ...browserIdentity,
    });
    const rendererInstanceId = browserSidebarRendererWebviewManager.getRendererInstanceId();
    let disposed = false;
    let started = false;
    let lastHostStateKey: string | null = null;
    let animationFrame: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let unsubscribeBoundsSyncTrigger: (() => void) | undefined;
    const syncCurrentPresentation = () => {
      if (!started || disposed) return;
      const visible = isVisibleRef.current;
      const bounds = visible ? readWebviewHostBounds(container) : null;
      const presented = Boolean(visible && bounds && bounds.width > 0 && bounds.height > 0);
      browserSidebarRendererWebviewManager.syncWebview({
        ...browserIdentity,
        browserStorageId,
        projectId: tab.projectId,
        hostKind: "panel",
        initialUrl: initialWebviewUrlRef.current,
        bounds,
        mountGeneration,
        isVisible: visible,
        shouldPaint: visible,
        onHostCreated: (event: BrowserSidebarWebviewHostCreated) => {
          void invoke("browser-sidebar-webview-host-created", event);
        },
      });
      const nextHostStateKey = `${visible}:${presented}:${themeVariantRef.current}`;
      if (lastHostStateKey === nextHostStateKey) return;
      lastHostStateKey = nextHostStateKey;
      void command({
        type: "sync-host",
        ...browserIdentity,
        rendererInstanceId,
        hostGeneration,
        mountGeneration,
        hostKind: "panel",
        presented,
        themeVariant: themeVariantRef.current,
        visible,
      });
    };
    syncWebviewPresentationRef.current = syncCurrentPresentation;
    const syncBounds = () => {
      animationFrame = null;
      syncCurrentPresentation();
    };
    const scheduleSyncBounds = () => {
      if (animationFrame !== null) return;
      animationFrame = window.requestAnimationFrame(syncBounds);
    };
    void command({
      type: "register-host",
      ...browserIdentity,
      browserStorageId,
      rendererInstanceId,
      hostGeneration,
      mountGeneration,
      hostKind: "panel",
      pagePersistence: "durable",
      themeVariant: themeVariantRef.current,
    }).then((result) => {
      if (!result.ok || disposed) return;
      started = true;
      syncCurrentPresentation();
      resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSyncBounds);
      resizeObserver?.observe(container);
      unsubscribeBoundsSyncTrigger = boundsSyncTrigger?.on("change", scheduleSyncBounds);
      window.addEventListener("resize", scheduleSyncBounds);
      window.addEventListener("scroll", scheduleSyncBounds, true);
      scheduleSyncBounds();
    });

    return () => {
      disposed = true;
      if (syncWebviewPresentationRef.current === syncCurrentPresentation) {
        syncWebviewPresentationRef.current = null;
      }
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame);
      }
      unsubscribeBoundsSyncTrigger?.();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleSyncBounds);
      window.removeEventListener("scroll", scheduleSyncBounds, true);
      if (!started) return;
      void command({
        type: "sync-host",
        ...browserIdentity,
        rendererInstanceId,
        hostGeneration,
        mountGeneration,
        hostKind: "panel",
        presented: false,
        themeVariant: themeVariantRef.current,
        visible: false,
      });
      browserSidebarRendererWebviewManager.detachWebview(
        {
          ...browserIdentity,
        },
        mountGeneration,
      );
    };
  }, [
    browserIdentity,
    browserIdentityKey,
    browserStorageId,
    boundsSyncTrigger,
    browserRuntimeAvailable,
    command,
    downloadsOpen,
    profileImportOpen,
    registeredBrowserKey,
    shouldMountWebview,
    snapshot.deviceToolbarVisible,
    snapshot.failure,
    snapshot.viewport.height,
    snapshot.viewport.presetId,
    snapshot.viewport.width,
    snapshot.viewport.zoomPercent,
    tab.projectId,
  ]);

  useLayoutEffect(() => {
    syncWebviewPresentationRef.current?.();
  }, [isVisible, themeVariant]);

  useEffect(() => {
    if (
      !browserRuntimeAvailable ||
      !activeForContentSearch ||
      isBlank ||
      snapshot.deviceToolbarVisible
    ) {
      publishBrowserDocumentBottom(browserIdentity, false);
      return;
    }

    let disposed = false;
    const sampleDocumentBottom = async () => {
      const isAtDocumentBottom =
        await browserSidebarRendererWebviewManager.readIsAtDocumentBottom(browserIdentity);
      if (disposed || isAtDocumentBottom === null) return;
      publishBrowserDocumentBottom(browserIdentity, isAtDocumentBottom);
    };
    void sampleDocumentBottom();
    const timer = window.setInterval(() => {
      void sampleDocumentBottom();
    }, 200);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      clearBrowserDocumentBottom(browserIdentity);
    };
  }, [
    activeForContentSearch,
    browserIdentity,
    browserRuntimeAvailable,
    isBlank,
    snapshot.deviceToolbarVisible,
  ]);

  useEffect(() => {
    if (addressFocused) return;
    setAddressValue(readBrowserAddressValue(snapshot.url));
  }, [addressFocused, snapshot.url]);

  useEffect(() => {
    if (tab.preview) return undefined;
    const title = snapshot.title || "Browser";
    const url = isBlankBrowserUrl(snapshot.url) ? undefined : snapshot.url;
    const timeout = window.setTimeout(() => {
      onUpdateTab(tab.id, {
        title,
        config: {
          projectId: tab.projectId,
          browserStorageId,
          ...(url ? { url } : {}),
          ...(title ? { title } : {}),
          ...(snapshot.faviconUrl ? { faviconUrl: snapshot.faviconUrl } : {}),
          deviceToolbarVisible: snapshot.deviceToolbarVisible,
          deviceToolbarState: snapshot.deviceToolbarState,
        },
      });
    }, 650);
    return () => window.clearTimeout(timeout);
  }, [
    onRefreshSessions,
    onUpdateTab,
    browserStorageId,
    snapshot.deviceToolbarVisible,
    snapshot.deviceToolbarState,
    snapshot.faviconUrl,
    snapshot.title,
    snapshot.url,
    tab.id,
    tab.preview,
    tab.projectId,
  ]);

  const navigateTo = useCallback(
    (rawUrl: string) => {
      const url = normalizeBrowserNavigationUrl(rawUrl);
      const hasBrowserPage = !isBlankBrowserUrl(url);
      setSnapshot((current) => ({
        ...current,
        url,
        pendingUrl: hasBrowserPage ? url : undefined,
        hasBrowserPage,
        pageActionsDisabled: !hasBrowserPage,
        isLoading: hasBrowserPage,
        updatedAt: Date.now(),
      }));
      setAddressValue(readBrowserAddressValue(url));
      void command({
        type: "navigate",
        ...browserIdentity,
        url,
        source: "manual",
        initiator: "address_bar",
        originalUrl: rawUrl,
      });
    },
    [browserIdentity, command],
  );

  const submitAddress = (event: FormEvent) => {
    event.preventDefault();
    if (!shouldCommitBrowserAddressEdit(snapshot.url, addressValue)) {
      setAddressValue(readBrowserAddressValue(snapshot.url));
      return;
    }
    navigateTo(addressValue);
  };

  const setZoom = (zoomPercent: number) => {
    setSnapshot((current) => ({
      ...current,
      zoomPercent,
      viewport: { ...current.viewport, zoomPercent },
      updatedAt: Date.now(),
    }));
    void command({ type: "set-zoom-percent", ...browserIdentity, zoomPercent, showBanner: true });
  };

  const stepZoom = (delta: number) => {
    void command({ type: "step-zoom", ...browserIdentity, delta, showBanner: true });
  };

  const resetZoom = () => {
    void command({ type: "reset-zoom", ...browserIdentity, showBanner: true });
  };

  const toggleDeviceToolbar = () => {
    const visible = !snapshot.deviceToolbarVisible;
    setSnapshot((current) => ({
      ...current,
      deviceToolbarVisible: visible,
      updatedAt: Date.now(),
    }));
    void command({ type: "set-device-toolbar-visible", ...browserIdentity, visible });
  };

  const updateViewport = (viewport: BrowserSidebarViewport) => {
    setSnapshot((current) => ({
      ...current,
      viewport,
      zoomPercent: viewport.zoomPercent,
      updatedAt: Date.now(),
    }));
    void command({ type: "set-viewport", ...browserIdentity, viewport });
  };

  const clearBrowsingData = async (kind: BrowserBrowsingDataKind) => {
    setClearDataStatus(null);
    const result = (await invoke("browser-browsing-data-clear", kind)) as {
      ok: boolean;
      message?: string;
    };
    if (result.ok) {
      const labels: Record<BrowserBrowsingDataKind, string> = {
        cookies: "Cookies cleared",
        cache: "Cache cleared",
        "site-data": "Site data cleared",
        history: "Browser history cleared",
        downloads: "Download history cleared",
      };
      setClearDataStatus(labels[kind]);
      return;
    }
    setClearDataStatus(result.message ?? `Failed to clear ${kind}`);
  };

  const captureScreenshot = async () => {
    const result = await command({ type: "capture-screenshot", ...browserIdentity });
    if (result.ok) {
      setClearDataStatus("Screenshot copied");
      return;
    }
    setClearDataStatus(result.message);
  };

  const cursor =
    (matchesBrowserSidebarTabIdentity(browserUseCursor, browserIdentity)
      ? browserUseCursor
      : browserUseState.cursors.find((candidate) =>
          matchesBrowserSidebarTabIdentity(candidate, browserIdentity),
        )) ?? null;
  const reportedBrowserUseViewportSize = matchesBrowserSidebarTabIdentity(
    browserUseViewport,
    browserIdentity,
  )
    ? browserUseViewport.viewportSize
    : null;
  const browserUseViewportSize =
    reportedBrowserUseViewportSize ??
    (activeBrowserUseTab
      ? {
          width: activeBrowserUseTab.viewport.width,
          height: activeBrowserUseTab.viewport.height,
        }
      : null);
  const activeDownloadCount = downloadsSnapshot.downloads.filter(
    (download) => download.status === "progressing" || download.status === "paused",
  ).length;

  const handleBrowserUseCursorArrived = useCallback(
    (moveSequence: number) => {
      void command({
        type: "browser-use-cursor-arrived",
        ...browserIdentity,
        moveSequence,
      });
    },
    [browserIdentity, command],
  );

  if (!browserRuntimeAvailable) {
    return <BrowserUnavailableState />;
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden bg-token-main-surface-primary text-token-text-primary">
      <div className={BROWSER_CHROME_CLASS}>
        <div className={BROWSER_CHROME_ROW_CLASS}>
          <BrowserToolbarButton
            label="Back"
            disabled={!snapshot.canGoBack}
            onClick={() => {
              void command({ type: "go-back", ...browserIdentity });
            }}
          >
            <BrowserBackIcon className="icon-sm" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            label="Forward"
            disabled={!snapshot.canGoForward}
            onClick={() => {
              void command({ type: "go-forward", ...browserIdentity });
            }}
          >
            <BrowserBackIcon className="icon-sm rotate-180" />
          </BrowserToolbarButton>
          <BrowserToolbarButton
            label={snapshot.isLoading ? "Stop" : "Reload"}
            disabled={pageActionsDisabled}
            onClick={() => {
              if (snapshot.isLoading) {
                void command({ type: "stop", ...browserIdentity });
                return;
              }
              void command({ type: "reload", ...browserIdentity });
            }}
          >
            {snapshot.isLoading ? (
              <StopIcon className="icon-sm" />
            ) : (
              <BrowserReloadIcon className="icon-sm" />
            )}
          </BrowserToolbarButton>
          <form
            className="no-drag flex min-w-0 flex-1 items-center justify-center px-1 text-sm text-token-text-primary"
            onSubmit={submitAddress}
          >
            <div className={BROWSER_ADDRESS_BAR_CLASS}>
              <div
                className={cn(
                  "shrink-0 overflow-hidden transition-[width,opacity] duration-150",
                  addressFocused ? "w-0 opacity-0" : "w-7 opacity-100",
                )}
              >
                <BrowserSiteInfoMenu
                  url={snapshot.url}
                  siteInfo={siteInfo}
                  disabled={pageActionsDisabled}
                  onClearSiteData={() => clearBrowsingData("site-data")}
                />
              </div>
              <input
                data-browser-sidebar-address-input="true"
                className={cn(
                  "h-full min-w-0 flex-1 bg-transparent px-1 text-sm outline-none text-token-input-foreground placeholder:text-token-input-placeholder-foreground focus:pl-2 focus:text-left",
                  !addressFocused && "text-center",
                  addressValue.trim().length > 0 && "pr-3",
                )}
                style={
                  addressValue.trim().length > 0
                    ? {
                        WebkitMaskImage:
                          "linear-gradient(to right, black calc(100% - 18px), transparent)",
                        maskImage:
                          "linear-gradient(to right, black calc(100% - 18px), transparent)",
                      }
                    : undefined
                }
                value={addressValue}
                placeholder="Enter a URL"
                onFocus={() => setAddressFocused(true)}
                onBlur={(event) => {
                  setAddressFocused(false);
                  if (shouldSkipBrowserAddressCommit(event.relatedTarget)) return;
                  if (!shouldCommitBrowserAddressEdit(snapshot.url, addressValue)) {
                    setAddressValue(readBrowserAddressValue(snapshot.url));
                    return;
                  }
                  navigateTo(addressValue);
                }}
                onChange={(event) => setAddressValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  event.preventDefault();
                  event.currentTarget.blur();
                  setAddressValue(readBrowserAddressValue(snapshot.url));
                }}
              />
              <button
                type="button"
                data-browser-sidebar-open-external
                data-browser-sidebar-skip-address-commit
                className={cn(
                  "mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-token-text-tertiary transition-opacity",
                  pageActionsDisabled
                    ? "cursor-default opacity-0"
                    : "cursor-interaction opacity-0 hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:bg-token-foreground/5 group-hover/address-bar:opacity-100 group-focus-within/address-bar:opacity-100",
                )}
                disabled={pageActionsDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => void command({ type: "open-external", ...browserIdentity })}
                aria-label="Open externally"
              >
                <BrowserExternalIcon className="icon-xs" />
              </button>
            </div>
          </form>
          <div
            className={cn(
              BROWSER_COLLAPSIBLE_ACTION_CLASS,
              pageActionsDisabled ? "pointer-events-none max-w-0 opacity-0" : "max-w-7 opacity-100",
            )}
          >
            <BrowserCredentialMenu
              identity={browserIdentity}
              disabled={pageActionsDisabled}
              onOpenPasswords={() => onOpenBrowserSettings?.("passwords")}
              onOpenContactInfo={() => onOpenBrowserSettings?.("contact-info")}
            />
          </div>
          <div
            className={cn(
              BROWSER_COLLAPSIBLE_ACTION_CLASS,
              pageActionsDisabled
                ? "pointer-events-none max-w-0 opacity-0 -translate-y-0.5"
                : "max-w-7 opacity-100 translate-y-0",
            )}
          >
            <BrowserToolbarButton
              label="Capture screenshot"
              disabled={pageActionsDisabled}
              onClick={() => void captureScreenshot()}
            >
              <BrowserScreenshotIcon className="icon-sm" />
            </BrowserToolbarButton>
          </div>
          <div
            className={cn(
              BROWSER_COLLAPSIBLE_ACTION_CLASS,
              pageActionsDisabled
                ? "pointer-events-none max-w-0 opacity-0 -translate-y-0.5"
                : commentMode
                  ? "max-w-[112px] opacity-100 translate-y-0"
                  : "max-w-7 opacity-100 translate-y-0",
            )}
          >
            <BrowserToolbarButton
              label={commentMode ? "Exit comment mode" : "Annotate"}
              disabled={pageActionsDisabled}
              active={commentMode}
              className={cn(commentMode && "aspect-auto !px-2")}
              onClick={() => {
                void command({
                  type: "set-interaction-mode",
                  ...browserIdentity,
                  mode: commentMode ? "browse" : "comment",
                }).then((result) => {
                  if (result.ok) return;
                  setClearDataStatus(
                    result.message ?? "Comment mode is unavailable for this site.",
                  );
                });
              }}
            >
              <BrowserAnnotateIcon className="icon-sm shrink-0" />
              <span
                className={cn(
                  "overflow-hidden whitespace-nowrap text-sm transition-[max-width,opacity] duration-150",
                  commentMode ? "max-w-20 opacity-100" : "max-w-0 opacity-0",
                )}
              >
                Annotating
              </span>
            </BrowserToolbarButton>
          </div>
          <div
            className={cn(
              BROWSER_COLLAPSIBLE_ACTION_CLASS,
              activeDownloadCount > 0
                ? "max-w-7 opacity-100"
                : "pointer-events-none max-w-0 opacity-0",
            )}
          >
            <BrowserToolbarButton
              label={`${activeDownloadCount} active ${
                activeDownloadCount === 1 ? "download" : "downloads"
              }`}
              active
              onClick={() => setDownloadsOpen(true)}
            >
              <span className="relative">
                <DownloadIcon className="icon-sm" />
                <span className="absolute -right-1 -bottom-1 size-1.5 rounded-full bg-token-text-link-foreground ring-2 ring-token-main-surface-primary" />
              </span>
            </BrowserToolbarButton>
          </div>
          <BrowserOverflowMenu
            snapshot={snapshot}
            disabled={pageActionsDisabled}
            onHardReload={() => {
              void command({ type: "reload", ...browserIdentity, ignoreCache: true });
            }}
            onToggleDeviceToolbar={toggleDeviceToolbar}
            onSetZoom={setZoom}
            onStepZoom={stepZoom}
            onResetZoom={resetZoom}
            onClearBrowsingData={clearBrowsingData}
            onOpenDownloads={() => setDownloadsOpen(true)}
            onOpenProfileImport={() => setProfileImportOpen(true)}
            onOpenSettings={(sectionId) => onOpenBrowserSettings?.(sectionId)}
            onPrint={() => {
              void command({ type: "print", ...browserIdentity });
            }}
          />
        </div>
        {credentialCandidate ? (
          <BrowserCredentialSavePrompt
            candidate={credentialCandidate}
            onDismiss={() => void actOnCredentialCandidate("dismiss")}
            onSave={() => void actOnCredentialCandidate("save")}
          />
        ) : null}
      </div>

      <div
        className="relative min-h-0 overflow-hidden bg-token-main-surface-primary"
        style={{
          height: `calc(100% - var(--height-toolbar-pane) - ${RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE})`,
          scrollPaddingBottom: RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE,
        }}
      >
        {downloadsOpen ? (
          <BrowserDownloadsPage
            snapshot={downloadsSnapshot}
            onClose={() => setDownloadsOpen(false)}
            onAction={async (downloadId, action) => {
              const result = await invoke("browser-download-action", {
                downloadId,
                action,
              });
              if (!result.ok) setClearDataStatus(result.message);
            }}
            onClearHistory={async () => {
              const result = await invoke("browser-download-history-clear");
              if (!result.ok) setClearDataStatus(result.message);
            }}
          />
        ) : snapshot.failure ? (
          <BrowserPageFailureState
            failure={snapshot.failure}
            onBack={() => {
              void command({ type: "go-back", ...browserIdentity });
            }}
            onRetry={() => {
              void command({ type: "reload", ...browserIdentity });
            }}
          />
        ) : !shouldMountWebview ? (
          <BrowserNewTabState
            projectId={tab.projectId}
            localServers={localServers}
            preferences={localServerPreferences}
            onPreferencesChange={(update) => {
              void updateLocalServerPreferences(update).catch((error) => {
                setClearDataStatus(
                  error instanceof Error
                    ? error.message
                    : "Could not save local server preferences",
                );
              });
            }}
            onRefresh={() => {
              if (tab.projectId !== null) {
                void command({ type: "local-servers-refresh", projectId: tab.projectId });
              }
            }}
            onOpen={navigateTo}
            onRequestThumbnail={async (url) => {
              if (tab.projectId === null) {
                return {
                  status: "unavailable",
                  message: "Local server preview has no project",
                };
              }
              return await invoke("browser-local-server-thumbnail", {
                ...browserIdentity,
                projectId: tab.projectId,
                url,
              });
            }}
            onHideServer={(server) => {
              if (tab.projectId !== null) {
                void command({ type: "hide-local-server", projectId: tab.projectId, server });
              }
            }}
            onUnhideServer={(url) => {
              if (tab.projectId !== null) {
                void command({ type: "unhide-local-server", projectId: tab.projectId, url });
              }
            }}
            onRemoveRoute={(serverUrl, routeUrl) => {
              if (tab.projectId !== null) {
                void command({
                  type: "remove-local-server-route",
                  projectId: tab.projectId,
                  serverUrl,
                  routeUrl,
                });
              }
            }}
          />
        ) : (
          <BrowserWebviewStage
            activeSessionId={browserConversationId}
            tabId={tab.id}
            deviceToolbarVisible={snapshot.deviceToolbarVisible}
            viewport={snapshot.viewport}
            webviewHostRef={webviewHostRef}
            onViewportChange={updateViewport}
            onCloseDeviceToolbar={toggleDeviceToolbar}
          >
            {commentMode ? (
              <BrowserCommentOverlay>
                <BrowserAnnotationComposer
                  anchors={annotationAnchors}
                  designChange={annotationDesignChange}
                  intent={annotationIntent}
                  note={annotationNote}
                  originalView={annotationOriginalView}
                  selectionMode={annotationSelectionMode}
                  onDesignChange={(input) => {
                    setAnnotationDraft((current) =>
                      updateBrowserAnnotationDesignChange(current, input),
                    );
                  }}
                  onIntentChange={(intent) => {
                    setAnnotationDraft((current) => ({
                      ...current,
                      intent,
                      originalView: false,
                    }));
                  }}
                  onNoteChange={(note) => {
                    setAnnotationDraft((current) => ({ ...current, note }));
                  }}
                  onOriginalViewChange={(originalView) => {
                    setAnnotationDraft((current) => ({
                      ...current,
                      originalView,
                    }));
                  }}
                  onSelectionModeChange={(selectionMode) => {
                    setAnnotationDraft((current) => ({
                      ...current,
                      selectionMode,
                    }));
                  }}
                  onRemoveAnchor={(anchorId) => {
                    setAnnotationDraft((current) =>
                      removeBrowserAnnotationAnchor(current, anchorId),
                    );
                  }}
                  onDiscard={() => {
                    setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
                  }}
                  onAddToComposer={() => {
                    if (!codexSessionId) {
                      setClearDataStatus("Open a Conversation to add browser context");
                      return;
                    }
                    if (annotationAnchors.length === 0) return;
                    if (
                      annotationIntent === "designChange" &&
                      (!annotationDesignChange?.after.trim() ||
                        !annotationAnchors.some(
                          (anchor) => anchor.id === annotationDesignChange.anchorId,
                        ))
                    ) {
                      setClearDataStatus("Choose a design property and value");
                      return;
                    }
                    void invoke("browser-annotation-capture-evidence", {
                      ...browserIdentity,
                      anchors: annotationAnchors,
                    })
                      .then((evidence) => {
                        publishBrowserAnnotationAttachment(codexSessionId, {
                          schemaVersion: 1,
                          id: createSecureRuntimeId("browser-annotation"),
                          browserTabId,
                          createdAt: Date.now(),
                          intent: annotationIntent,
                          ...(annotationIntent === "designChange" && annotationDesignChange
                            ? { designChange: annotationDesignChange }
                            : {}),
                          note: annotationNote.trim(),
                          pageTitle: snapshot.title,
                          pageUrl: snapshot.url,
                          anchors: annotationAnchors,
                          evidence,
                        });
                        setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
                        setClearDataStatus(
                          annotationIntent === "designChange"
                            ? "Browser design change added to composer"
                            : "Browser annotation added to composer",
                        );
                      })
                      .catch((error) => {
                        setClearDataStatus(
                          error instanceof Error
                            ? error.message
                            : "Could not capture Browser annotation evidence",
                        );
                      });
                  }}
                />
              </BrowserCommentOverlay>
            ) : null}
            <BrowserUseCursorPortal
              cursor={cursor}
              fallbackViewportSize={browserUseViewportSize}
              identity={browserIdentity}
              isVisible={isVisible && activeBrowserUseTab !== null}
              onArrived={handleBrowserUseCursorArrived}
            />
          </BrowserWebviewStage>
        )}
      </div>
      {clearDataStatus ? (
        <div
          className={cn(
            "pointer-events-none absolute left-1/2 z-40 -translate-x-1/2 rounded-full bg-token-dropdown-background/90 px-3 py-1 text-xs text-token-text-secondary shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm",
            snapshot.deviceToolbarVisible ? "bottom-[46px]" : "bottom-3",
          )}
        >
          {clearDataStatus}
        </div>
      ) : null}
      <BrowserProfileImportDialog open={profileImportOpen} onOpenChange={setProfileImportOpen} />
    </div>
  );
}

function BrowserToolbarButton({
  label,
  disabled,
  active,
  className,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  className?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        type="button"
        className={cn(
          BROWSER_TOOL_BUTTON_CLASS,
          active && "bg-token-list-hover-background text-token-text-primary",
          className,
        )}
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function BrowserSiteInfoMenu({
  url,
  siteInfo,
  disabled,
  onClearSiteData,
}: {
  url: string;
  siteInfo: BrowserSiteInfo | null;
  disabled: boolean;
  onClearSiteData: () => void;
}) {
  const fallbackOrigin = readBrowserOriginLabel(url);
  const origin = siteInfo?.origin ?? fallbackOrigin;
  const secure = siteInfo?.connection === "secure";
  const connectionLabel = siteInfo?.connection
    ? browserConnectionLabel(siteInfo.connection)
    : "Checking connection…";
  const allowedPermissions =
    siteInfo?.permissions
      ?.filter((permission) => permission.state === "allow")
      .map((permission) => permission.permission) ?? [];
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="menuWide"
      contentStyle={BROWSER_DROPDOWN_CONTENT_STYLE}
      triggerButton={
        <button
          type="button"
          data-browser-sidebar-skip-address-commit
          className="inline-flex size-7 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-text-primary disabled:pointer-events-none disabled:opacity-0"
          aria-label="Site information"
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
        >
          {secure ? <LockKeyhole className="icon-xs" /> : <InfoIcon className="icon-xs" />}
        </button>
      }
    >
      <div className="px-[var(--padding-row-x)] py-2">
        <div className="truncate text-sm font-medium text-token-text-primary">{origin}</div>
        <div className="mt-1 text-xs text-token-text-secondary">{connectionLabel}</div>
      </div>
      <NodexDropdownSeparator />
      <div className="px-[var(--padding-row-x)] py-2 text-xs leading-5 text-token-text-secondary">
        {siteInfo && typeof siteInfo.cookieCount === "number"
          ? `${siteInfo.cookieCount} cookie${siteInfo.cookieCount === 1 ? "" : "s"} · ${
              allowedPermissions.length > 0
                ? `Allowed: ${allowedPermissions.join(", ")}`
                : "Sensitive permissions are blocked by default"
            }.`
          : "Sensitive permissions are blocked by default."}
      </div>
      <NodexDropdownSeparator />
      <NodexDropdownItem onSelect={onClearSiteData}>
        Clear built-in Browser site data
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

function readBrowserOriginLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.href : parsed.origin;
  } catch {
    return "New tab";
  }
}

function browserConnectionLabel(connection: BrowserSiteInfo["connection"]): string {
  if (connection === "secure") return "Connection is secure";
  if (connection === "local") return "Local connection";
  if (connection === "insecure") return "Connection is not secure";
  return "No site connection";
}

function BrowserCredentialMenu({
  identity,
  disabled,
  onOpenContactInfo,
  onOpenPasswords,
}: {
  identity: {
    browserConversationId: string;
    browserViewScopeId: string;
    browserTabId: string;
  };
  disabled: boolean;
  onOpenContactInfo: () => void;
  onOpenPasswords: () => void;
}) {
  const [credentials, setCredentials] = useState<BrowserCredentialSummary[]>([]);
  const [contacts, setContacts] = useState<BrowserContactInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [nextCredentials, nextContacts] = await Promise.all([
        invoke("browser-credentials-list", identity),
        invoke("browser-contact-info-list"),
      ]);
      setCredentials(nextCredentials);
      setContacts(nextContacts);
      setMessage(null);
    } catch (error) {
      setCredentials([]);
      setContacts([]);
      setMessage(error instanceof Error ? error.message : "Passwords unavailable");
    }
  }, [identity]);
  useEffect(() => {
    if (open && !disabled) void refresh();
  }, [disabled, open, refresh]);

  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="panel"
      contentStyle={BROWSER_DROPDOWN_CONTENT_STYLE}
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      triggerButton={
        <button
          type="button"
          data-browser-sidebar-skip-address-commit
          className={BROWSER_TOOL_BUTTON_CLASS}
          aria-label="Passwords and autofill"
        >
          <KeyRound className="icon-sm" />
        </button>
      }
    >
      <div className="px-[var(--padding-row-x)] py-2">
        <div className="text-sm font-medium text-token-text-primary">Passwords and autofill</div>
        <div className="mt-1 text-xs text-token-text-secondary">
          Fill only into the current site.
        </div>
      </div>
      <NodexDropdownSeparator />
      {credentials.length === 0 ? (
        <div className="px-[var(--padding-row-x)] py-2 text-xs text-token-text-secondary">
          {message ?? "No saved password for this site."}
        </div>
      ) : (
        credentials.map((credential) => (
          <NodexDropdownItem
            key={credential.id}
            leftSlot={<KeyRound className="icon-xs" />}
            onSelect={() => {
              void invoke("browser-credential-fill", {
                ...identity,
                credentialId: credential.id,
              }).then((result) => {
                if (!result.ok) setMessage(result.message ?? "Unable to fill password");
              });
            }}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{credential.label}</span>
              <span className="truncate text-xs text-token-text-secondary">
                {credential.username || "No username"}
              </span>
            </span>
          </NodexDropdownItem>
        ))
      )}
      <NodexDropdownItem
        leftSlot={<KeyRound className="icon-xs" />}
        onSelect={() => {
          void invoke<"browser-credential-generate-fill">(
            "browser-credential-generate-fill",
            identity,
          ).then((result) => {
            if (!result.ok) setMessage(result.message ?? "Unable to generate password");
          });
        }}
      >
        Generate strong password
      </NodexDropdownItem>
      {contacts.length > 0 ? <NodexDropdownSeparator /> : null}
      {contacts.map((contact) => (
        <NodexDropdownItem
          key={contact.id}
          leftSlot={<ContactRound className="icon-xs" />}
          onSelect={() => {
            void invoke("browser-contact-info-fill", {
              ...identity,
              contactInfoId: contact.id,
            }).then((result) => {
              if (!result.ok) setMessage(result.message ?? "Unable to fill contact info");
            });
          }}
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate">{contact.label}</span>
            <span className="truncate text-xs text-token-text-secondary">
              {[contact.fullName, contact.email, contact.phone].filter(Boolean).join(" · ")}
            </span>
          </span>
        </NodexDropdownItem>
      ))}
      <NodexDropdownSeparator />
      <NodexDropdownItem leftSlot={<KeyRound className="icon-xs" />} onSelect={onOpenPasswords}>
        Manage passwords
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ContactRound className="icon-xs" />}
        onSelect={onOpenContactInfo}
      >
        Contact info
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

function BrowserCredentialSavePrompt({
  candidate,
  onDismiss,
  onSave,
}: {
  candidate: BrowserCredentialSaveCandidate;
  onDismiss: () => void;
  onSave: () => void;
}) {
  return (
    <div
      className="no-drag absolute right-2 top-[calc(var(--height-toolbar-pane)+6px)] w-[300px] rounded-xl bg-token-dropdown-background/95 p-3 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
      style={BROWSER_DROPDOWN_CONTENT_STYLE}
      role="dialog"
      aria-label="Save password"
    >
      <div className="flex items-start gap-2">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-token-text-secondary" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-token-text-primary">Save password?</div>
          <div className="mt-1 truncate text-xs text-token-text-secondary">
            {candidate.username || "No username"} · {candidate.origin}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-3 py-1.5 text-sm text-token-text-secondary hover:bg-token-list-hover-background"
          onClick={onDismiss}
        >
          Not now
        </button>
        <button
          type="button"
          className="rounded-lg bg-token-foreground px-3 py-1.5 text-sm text-token-background hover:opacity-90"
          onClick={onSave}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function BrowserOverflowMenu({
  snapshot,
  disabled,
  onHardReload,
  onToggleDeviceToolbar,
  onSetZoom,
  onStepZoom,
  onResetZoom,
  onClearBrowsingData,
  onOpenDownloads,
  onOpenProfileImport,
  onOpenSettings,
  onPrint,
}: {
  snapshot: BrowserSidebarTabSnapshot;
  disabled: boolean;
  onHardReload: () => void;
  onToggleDeviceToolbar: () => void;
  onSetZoom: (zoomPercent: number) => void;
  onStepZoom: (delta: number) => void;
  onResetZoom: () => void;
  onClearBrowsingData: (kind: BrowserBrowsingDataKind) => void;
  onOpenDownloads: () => void;
  onOpenProfileImport: () => void;
  onOpenSettings: (sectionId: BrowserSettingsDestination) => void;
  onPrint: () => void;
}) {
  const zoomOptions = resolveBrowserZoomOptions(snapshot.zoomPercent);
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menuWide"
      contentStyle={BROWSER_DROPDOWN_CONTENT_STYLE}
      triggerButton={
        <button
          type="button"
          data-browser-sidebar-skip-address-commit
          className={cn(BROWSER_TOOL_BUTTON_CLASS, disabled && "cursor-default opacity-40")}
          aria-label="Browser options"
        >
          <BrowserMoreIcon className="icon-sm" />
        </button>
      }
    >
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<BrowserReloadIcon className="icon-xs" />}
        onSelect={onHardReload}
      >
        Force reload
      </NodexDropdownItem>
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<Smartphone className="icon-xs" />}
        onSelect={onToggleDeviceToolbar}
      >
        {snapshot.deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
      </NodexDropdownItem>
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<Printer className="icon-xs" />}
        onSelect={onPrint}
      >
        Print
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <div
        data-browser-sidebar-skip-address-commit
        className={cn(
          "flex items-center gap-1 rounded-lg px-[var(--padding-row-x)] py-1 text-sm text-token-foreground",
          disabled && "cursor-default opacity-50",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-token-description-foreground">Zoom</span>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={() => onStepZoom(-25)}
          aria-label="Zoom out"
        >
          <Minus className="icon-xs" />
        </button>
        <select
          aria-label="Zoom percent"
          disabled={disabled}
          className="h-6 min-w-16 rounded-md border border-token-border bg-token-foreground/5 px-1 text-center text-xs tabular-nums outline-none hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          value={snapshot.zoomPercent}
          onChange={(event) => onSetZoom(Number.parseInt(event.target.value, 10))}
        >
          {zoomOptions.map((zoom) => (
            <option key={zoom} value={zoom}>
              {zoom}%
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={() => onStepZoom(25)}
          aria-label="Zoom in"
        >
          <PlusIcon className="icon-xs" />
        </button>
        <button
          type="button"
          disabled={disabled || snapshot.zoomPercent === 100}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={onResetZoom}
          aria-label="Reset zoom"
        >
          <ResetIcon className="icon-xs" />
        </button>
      </div>
      <NodexDropdownSeparator />
      <NodexDropdownItem leftSlot={<DownloadIcon className="icon-xs" />} onSelect={onOpenDownloads}>
        Downloads
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<DownloadIcon className="icon-xs" />}
        onSelect={onOpenProfileImport}
      >
        Import browser data
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        leftSlot={<KeyRound className="icon-xs" />}
        onSelect={() => onOpenSettings("passwords")}
      >
        Passwords
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ContactRound className="icon-xs" />}
        onSelect={() => onOpenSettings("contact-info")}
      >
        Contact info
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<HistoryIcon className="icon-xs" />}
        onSelect={() => onOpenSettings("history")}
      >
        History
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<Puzzle className="icon-xs" />}
        onSelect={() => onOpenSettings("extensions")}
      >
        Extensions
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<SettingsGeneralIcon className="icon-xs" />}
        onSelect={() => onOpenSettings("browser")}
      >
        Browser settings
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem disabled={disabled} onSelect={() => onClearBrowsingData("cookies")}>
        Clear cookies
      </NodexDropdownItem>
      <NodexDropdownItem disabled={disabled} onSelect={() => onClearBrowsingData("cache")}>
        Clear cache
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("site-data")}>
        Clear site data
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("history")}>
        Clear history
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("downloads")}>
        Clear download history
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

export function BrowserPageFailureState({
  failure,
  onRetry,
  onBack,
}: {
  failure: BrowserPageFailure;
  onRetry: () => void;
  onBack: () => void;
}) {
  const content = browserFailureContent(failure);
  const Icon = failure.kind === "offline" ? WifiOff : AlertTriangle;
  return (
    <section className="grid h-full place-items-center bg-token-main-surface-primary px-6 py-10">
      <div className="w-full max-w-md text-center">
        <Icon className="mx-auto size-8 text-token-text-tertiary" />
        <h2 className="mt-4 text-lg font-semibold text-token-text-primary">{content.title}</h2>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-token-text-secondary">
          {content.description}
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            className="rounded-lg border border-token-border px-3 py-1.5 text-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
            onClick={onBack}
          >
            Go back
          </button>
          <button
            type="button"
            className="rounded-lg bg-token-foreground px-3 py-1.5 text-sm font-medium text-token-background hover:opacity-90"
            onClick={onRetry}
          >
            Try again
          </button>
        </div>
        <div className="mt-5 truncate font-mono text-[11px] text-token-text-tertiary">
          {failure.failedUrl}
        </div>
      </div>
    </section>
  );
}

function browserFailureContent(failure: BrowserPageFailure): {
  title: string;
  description: string;
} {
  if (failure.kind === "dns") {
    return {
      title: "This site can’t be reached",
      description: "Check the address for typing errors, then try again.",
    };
  }
  if (failure.kind === "offline") {
    return {
      title: "You’re offline",
      description: "Reconnect to the internet and try loading this page again.",
    };
  }
  if (failure.kind === "refused") {
    return {
      title: "The connection was refused",
      description: "The site or local server is not accepting connections.",
    };
  }
  if (failure.kind === "timeout") {
    return {
      title: "The site took too long to respond",
      description: "The server may be unavailable or your connection may be slow.",
    };
  }
  if (failure.kind === "certificate") {
    return {
      title: "Your connection isn’t private",
      description: "Nodex stopped this page because its certificate could not be verified.",
    };
  }
  if (failure.kind === "blocked") {
    return {
      title: "Navigation blocked",
      description: "A Browser security or organization policy blocked this page.",
    };
  }
  if (failure.kind === "crashed") {
    return {
      title: "This page stopped working",
      description: "Reload the page to start it in a fresh Browser process.",
    };
  }
  return {
    title: "This page couldn’t be loaded",
    description: failure.description,
  };
}

export function BrowserDownloadsPage({
  snapshot,
  onClose,
  onAction,
  onClearHistory,
}: {
  snapshot: BrowserDownloadsSnapshot;
  onClose: () => void;
  onAction: (downloadId: string, action: BrowserDownloadAction) => Promise<void>;
  onClearHistory: () => Promise<void>;
}) {
  return (
    <section className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-token-border px-4">
        <DownloadIcon className="icon-sm text-token-text-tertiary" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-token-text-primary">Downloads</h2>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          disabled={snapshot.downloads.length === 0}
          onClick={() => void onClearHistory()}
        >
          Clear history
        </button>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
          aria-label="Close downloads"
          onClick={onClose}
        >
          <CloseIcon className="icon-sm" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.downloads.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-token-text-secondary">
            Downloaded files will appear here.
          </div>
        ) : (
          <div className="divide-y divide-token-border">
            {snapshot.downloads.map((download) => (
              <BrowserDownloadRow key={download.id} download={download} onAction={onAction} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function BrowserDownloadRow({
  download,
  onAction,
}: {
  download: BrowserDownloadRecord;
  onAction: (downloadId: string, action: BrowserDownloadAction) => Promise<void>;
}) {
  const active =
    download.status === "starting" ||
    download.status === "progressing" ||
    download.status === "paused";
  const progress =
    download.totalBytes > 0
      ? Math.min(100, (download.receivedBytes / download.totalBytes) * 100)
      : 0;
  const action = (nextAction: BrowserDownloadAction) => {
    void onAction(download.id, nextAction);
  };
  return (
    <article className="flex min-w-0 items-center gap-3 px-4 py-3">
      <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-token-foreground/5 text-token-text-tertiary">
        <DownloadIcon className="icon-sm" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-token-text-primary">
          {download.fileName}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-token-text-tertiary">
          <span className="truncate">{download.sourceOrigin}</span>
          <span aria-hidden>·</span>
          <span className="shrink-0">{formatDownloadProgress(download)}</span>
        </div>
        {active ? (
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-token-foreground/10">
            <div
              className="h-full rounded-full bg-token-text-primary/55 transition-[width]"
              style={{ width: `${progress}%` }}
            />
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {active ? (
          <>
            <BrowserDownloadActionButton
              label={download.status === "paused" ? "Resume" : "Pause"}
              onClick={() => action(download.status === "paused" ? "resume" : "pause")}
            >
              {download.status === "paused" ? (
                <PlayIcon className="icon-xs" />
              ) : (
                <PauseIcon className="icon-xs" />
              )}
            </BrowserDownloadActionButton>
            <BrowserDownloadActionButton label="Cancel" onClick={() => action("cancel")}>
              <CloseIcon className="icon-xs" />
            </BrowserDownloadActionButton>
          </>
        ) : (
          <>
            {download.status === "completed" ? (
              <>
                <BrowserDownloadActionButton label="Open" onClick={() => action("open")}>
                  <OpenInIcon className="icon-xs" />
                </BrowserDownloadActionButton>
                <BrowserDownloadActionButton
                  label="Show in folder"
                  onClick={() => action("show-in-folder")}
                >
                  <FolderOpenIcon className="icon-xs" />
                </BrowserDownloadActionButton>
              </>
            ) : null}
            <BrowserDownloadActionButton
              label="Remove from history"
              onClick={() => action("remove")}
            >
              <DeleteIcon className="icon-xs" />
            </BrowserDownloadActionButton>
          </>
        )}
      </div>
    </article>
  );
}

function BrowserDownloadActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function formatDownloadProgress(download: BrowserDownloadRecord): string {
  if (download.status === "completed") return formatBytes(download.totalBytes);
  if (download.status === "cancelled") return "Cancelled";
  if (download.status === "interrupted") return "Interrupted";
  if (download.status === "paused") return `Paused · ${formatBytes(download.receivedBytes)}`;
  if (download.totalBytes <= 0) return formatBytes(download.receivedBytes);
  return `${formatBytes(download.receivedBytes)} of ${formatBytes(download.totalBytes)}`;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${Math.round(value)} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  if (value < 1_073_741_824) {
    return `${(value / 1_048_576).toFixed(1)} MB`;
  }
  return `${(value / 1_073_741_824).toFixed(1)} GB`;
}

export function BrowserDeviceToolbar({
  viewport,
  onViewportChange,
  onClose,
}: {
  viewport: BrowserSidebarViewport;
  onViewportChange: (viewport: BrowserSidebarViewport) => void;
  onClose: () => void;
}) {
  const selectedPreset =
    BROWSER_SIDEBAR_DEVICE_PRESETS.find((preset) => preset.id === viewport.presetId) ??
    BROWSER_SIDEBAR_DEVICE_PRESETS[0];
  const zoomOptions = resolveBrowserZoomOptions(viewport.zoomPercent);

  return (
    <div className="absolute inset-x-0 top-0 z-30 flex h-[34px] items-center gap-2 border-b border-token-border bg-token-bg-secondary px-2.5 text-sm text-token-foreground">
      <NodexDropdownMenu
        align="start"
        contentWidth="menuWide"
        contentStyle={BROWSER_DROPDOWN_CONTENT_STYLE}
        triggerButton={
          <NodexDropdownButtonTrigger
            size="xs"
            chrome="transparent"
            className="h-6 min-w-[138px] justify-between rounded-lg text-token-foreground"
          >
            {selectedPreset.label}
          </NodexDropdownButtonTrigger>
        }
      >
        {BROWSER_SIDEBAR_DEVICE_PRESETS.map((preset) => (
          <NodexDropdownItem
            key={preset.id}
            rightSlot={
              preset.id === selectedPreset.id ? <CheckmarkIcon className="icon-xs" /> : null
            }
            onSelect={() =>
              onViewportChange({
                width: preset.width,
                height: preset.height,
                zoomPercent: viewport.zoomPercent,
                presetId: preset.id,
              })
            }
          >
            {preset.label}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
      <DimensionInput
        label="Width"
        value={viewport.width}
        placeholder="auto"
        onChange={(width) =>
          onViewportChange(updateBrowserViewportDimension(viewport, "width", width))
        }
      />
      <span className="text-token-description-foreground">x</span>
      <DimensionInput
        label="Height"
        value={viewport.height}
        placeholder="auto"
        onChange={(height) =>
          onViewportChange(updateBrowserViewportDimension(viewport, "height", height))
        }
      />
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label="Rotate"
        onClick={() => onViewportChange(rotateBrowserViewport(viewport))}
      >
        <RotateCcw className="icon-xs" />
      </button>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label="Responsive"
        onClick={() =>
          onViewportChange({ width: 0, height: 0, zoomPercent: 100, presetId: "responsive" })
        }
      >
        <Maximize2 className="icon-xs" />
      </button>
      <select
        aria-label="Viewport zoom"
        className="ml-auto h-6 rounded-lg border border-transparent bg-token-foreground/5 px-2 text-center text-xs font-semibold text-token-foreground tabular-nums outline-none hover:bg-token-list-hover-background focus:border-token-focus-border focus:bg-token-bg-primary"
        value={viewport.zoomPercent}
        onChange={(event) =>
          onViewportChange({ ...viewport, zoomPercent: Number.parseInt(event.target.value, 10) })
        }
      >
        {zoomOptions.map((zoom) => (
          <option key={zoom} value={zoom}>
            {zoom}%
          </option>
        ))}
      </select>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label="Close device toolbar"
        onClick={onClose}
      >
        <CloseIcon className="icon-xs" />
      </button>
    </div>
  );
}

function DimensionInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: number;
  placeholder?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1">
      <span className="sr-only">{label}</span>
      <input
        className="h-6 w-[72px] rounded-lg border border-transparent bg-token-foreground/5 px-2 text-center text-xs font-semibold text-token-foreground tabular-nums outline-none hover:bg-token-list-hover-background focus:border-token-focus-border focus:bg-token-bg-primary"
        value={value || ""}
        placeholder={placeholder}
        onChange={(event) => {
          const next = Number.parseInt(event.target.value, 10);
          if (!Number.isFinite(next)) return;
          onChange(next);
        }}
      />
    </label>
  );
}

export function BrowserWebviewStage({
  activeSessionId,
  tabId,
  deviceToolbarVisible,
  viewport,
  webviewHostRef,
  onViewportChange,
  onCloseDeviceToolbar,
  children,
}: {
  activeSessionId: string;
  tabId: string;
  deviceToolbarVisible: boolean;
  viewport: BrowserSidebarViewport;
  webviewHostRef: RefObject<HTMLDivElement | null>;
  onViewportChange: (viewport: BrowserSidebarViewport) => void;
  onCloseDeviceToolbar: () => void;
  children: ReactNode;
}) {
  const viewportAreaRef = useRef<HTMLDivElement | null>(null);
  const [viewportAreaSize, setViewportAreaSize] = useState({
    width: 0,
    height: 0,
  });
  useLayoutEffect(() => {
    const element = viewportAreaRef.current;
    if (!element) return undefined;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setViewportAreaSize({ width: rect.width, height: rect.height });
    };
    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const viewportLayout = computeBrowserViewportLayout({
    containerWidth: viewportAreaSize.width,
    containerHeight: viewportAreaSize.height,
    deviceToolbarVisible,
    composerReserve: 0,
    viewport,
    windowZoom: 1,
  });
  const showDeviceFrame =
    deviceToolbarVisible && viewportAreaSize.width > 0 && viewportAreaSize.height > 0;
  const visualFrameStyle: CSSProperties | undefined = showDeviceFrame
    ? {
        width: viewportLayout.visualWidth,
        height: viewportLayout.visualHeight,
      }
    : undefined;
  const logicalFrameStyle: CSSProperties | undefined = showDeviceFrame
    ? {
        width: viewportLayout.logicalWidth,
        height: viewportLayout.logicalHeight,
        transform: `scale(${viewportLayout.scale})`,
        transformOrigin: "top left",
      }
    : undefined;

  return (
    <div className="absolute inset-0 min-h-0 min-w-0 overflow-hidden bg-token-main-surface-primary">
      {deviceToolbarVisible ? (
        <BrowserDeviceToolbar
          viewport={viewport}
          onViewportChange={onViewportChange}
          onClose={onCloseDeviceToolbar}
        />
      ) : null}
      <div
        className={cn(
          "relative h-full min-h-0 min-w-0 overflow-hidden",
          deviceToolbarVisible && "pt-[34px]",
          deviceToolbarVisible && "bg-token-bg-secondary/40",
        )}
      >
        <div
          ref={viewportAreaRef}
          className={cn(
            "relative h-full w-full overflow-hidden",
            deviceToolbarVisible && "flex items-center justify-center overflow-auto p-6",
          )}
          style={
            deviceToolbarVisible ? RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE : undefined
          }
        >
          <div
            className={cn(
              "relative shrink-0 overflow-hidden bg-token-main-surface-primary",
              deviceToolbarVisible ? "shadow-sm ring-[0.5px] ring-token-border" : "h-full w-full",
            )}
            style={visualFrameStyle}
          >
            <div
              className={cn(
                "relative h-full w-full overflow-hidden",
                showDeviceFrame && "absolute left-0 top-0",
              )}
              style={logicalFrameStyle}
            >
              <div
                ref={webviewHostRef}
                className="absolute inset-0 overflow-hidden"
                data-browser-sidebar-webview-host-root
                data-browser-sidebar-conversation-id={activeSessionId}
                data-browser-sidebar-browser-tab-id={tabId}
              />
              {children}
              {deviceToolbarVisible && viewport.presetId === "responsive" ? (
                <BrowserViewportResizeHandles
                  viewport={viewport}
                  onViewportChange={onViewportChange}
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function BrowserViewportResizeHandles({
  viewport,
  onViewportChange,
}: {
  viewport: BrowserSidebarViewport;
  onViewportChange: (viewport: BrowserSidebarViewport) => void;
}) {
  const activeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => activeCleanupRef.current?.(), []);
  const bump = (dimension: "width" | "height", delta: number) => {
    const current = dimension === "width" ? viewport.width || 1024 : viewport.height || 768;
    onViewportChange(updateBrowserViewportDimension(viewport, dimension, current + delta));
  };
  const beginDrag =
    (dimension: "width" | "height", direction: -1 | 1) =>
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      activeCleanupRef.current?.();
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const startPointer = dimension === "width" ? event.clientX : event.clientY;
      const startValue = dimension === "width" ? viewport.width : viewport.height;
      const previousCursor = document.body.style.cursor;
      const previousUserSelect = document.body.style.userSelect;
      document.body.style.cursor = dimension === "width" ? "ew-resize" : "ns-resize";
      document.body.style.userSelect = "none";
      target.setPointerCapture?.(pointerId);
      let latestPointer = startPointer;
      let frame: number | null = null;
      const commit = () => {
        frame = null;
        const delta = (latestPointer - startPointer) * direction;
        onViewportChange(updateBrowserViewportDimension(viewport, dimension, startValue + delta));
      };
      const onPointerMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        latestPointer = dimension === "width" ? moveEvent.clientX : moveEvent.clientY;
        if (frame === null) frame = window.requestAnimationFrame(commit);
      };
      const cleanup = () => {
        if (frame !== null) window.cancelAnimationFrame(frame);
        target.removeEventListener("pointermove", onPointerMove);
        target.removeEventListener("pointerup", cleanup);
        target.removeEventListener("pointercancel", cleanup);
        if (target.hasPointerCapture?.(pointerId)) {
          target.releasePointerCapture?.(pointerId);
        }
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousUserSelect;
        if (activeCleanupRef.current === cleanup) {
          activeCleanupRef.current = null;
        }
      };
      activeCleanupRef.current = cleanup;
      target.addEventListener("pointermove", onPointerMove);
      target.addEventListener("pointerup", cleanup);
      target.addEventListener("pointercancel", cleanup);
    };
  const onResizeKeyDown =
    (dimension: "width" | "height", direction: -1 | 1) =>
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        return;
      }
      event.preventDefault();
      bump(dimension, direction * 10);
    };

  return (
    <>
      <button
        type="button"
        className="absolute inset-y-8 left-0 z-20 w-1 cursor-ew-resize opacity-0 focus-visible:opacity-100"
        aria-label="Narrow viewport"
        onPointerDown={beginDrag("width", -1)}
        onKeyDown={onResizeKeyDown("width", -1)}
      />
      <button
        type="button"
        className="absolute inset-y-8 right-0 z-20 w-1 cursor-ew-resize opacity-0 focus-visible:opacity-100"
        aria-label="Widen viewport"
        onPointerDown={beginDrag("width", 1)}
        onKeyDown={onResizeKeyDown("width", 1)}
      />
      <button
        type="button"
        className="absolute inset-x-8 bottom-0 z-20 h-1 cursor-ns-resize opacity-0 focus-visible:opacity-100"
        aria-label="Taller viewport"
        onPointerDown={beginDrag("height", 1)}
        onKeyDown={onResizeKeyDown("height", 1)}
      />
    </>
  );
}

export function BrowserNewTabState({
  projectId,
  localServers,
  preferences,
  onPreferencesChange,
  onRefresh,
  onOpen,
  onRequestThumbnail,
  onHideServer,
  onUnhideServer,
  onRemoveRoute,
}: {
  projectId: string | null;
  localServers: BrowserSidebarLocalServersSnapshot | null;
  preferences?: BrowserLocalServerPreferences;
  onPreferencesChange?: (update: BrowserLocalServerPreferencesUpdate) => void;
  onRefresh: () => void;
  onOpen: (url: string) => void;
  onRequestThumbnail?: (url: string) => Promise<BrowserSidebarLocalServerThumbnailResult>;
  onHideServer: (server: BrowserSidebarLocalServer) => void;
  onUnhideServer: (url: string) => void;
  onRemoveRoute: (serverUrl: string, routeUrl: string) => void;
}) {
  const [fallbackPreferences, setFallbackPreferences] = useState<BrowserLocalServerPreferences>(
    () => ({
      ...DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
      expandedProjectIds: [],
    }),
  );
  const resolvedPreferences = preferences ?? fallbackPreferences;
  const settings: BrowserLocalServerSettings =
    resolveBrowserLocalServerSettings(resolvedPreferences);
  const updatePreferences = (update: BrowserLocalServerPreferencesUpdate) => {
    if (onPreferencesChange) {
      onPreferencesChange(update);
      return;
    }
    setFallbackPreferences((current) => ({
      ...current,
      ...update,
      expandedProjectIds: update.expandedProjectIds ?? current.expandedProjectIds,
    }));
  };
  const visible = useMemo(
    () => resolveVisibleLocalServers(localServers, settings),
    [localServers, settings],
  );
  const servers = settings.showMode === "hidden" ? visible.hiddenServers : visible.servers;
  const showModeLabel =
    settings.showMode === "online" ? "Online" : settings.showMode === "hidden" ? "Hidden" : "All";
  const setShowMode = (showMode: BrowserLocalServerShowMode) => {
    updatePreferences({ showMode });
  };
  const setSortMode = (sortMode: BrowserLocalServerSortMode) => {
    updatePreferences({ sortMode });
  };
  const expandProject = () => {
    if (projectId === null) return;
    updatePreferences({
      expandedProjectIds: [...new Set([...resolvedPreferences.expandedProjectIds, projectId])],
    });
  };

  return (
    <div className="absolute inset-0 z-10 flex h-full w-full overflow-y-auto bg-token-main-surface-primary px-4 py-8 select-none">
      <div className="m-auto flex w-full max-w-[420px] flex-col gap-5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-token-text-primary">Local</h2>
          <div className="flex items-center gap-1">
            <NodexTooltip tooltipContent="Refresh local servers">
              <button
                type="button"
                className="inline-flex size-6 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
                onClick={onRefresh}
                aria-label="Refresh local servers"
              >
                <BrowserReloadIcon className="icon-xs" />
              </button>
            </NodexTooltip>
            <NodexDropdownMenu
              align="end"
              contentWidth="menuWide"
              triggerTooltipContent="Local server options"
              triggerButton={
                <button
                  type="button"
                  className="inline-flex size-6 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
                  aria-label="Local server options"
                >
                  <BrowserLocalServerFilterIcon className="icon-xs" />
                </button>
              }
            >
              <NodexDropdownItem
                rightSlot={
                  settings.showMode === "online" ? <CheckmarkIcon className="icon-xs" /> : null
                }
                onSelect={() => setShowMode("online")}
              >
                Online
              </NodexDropdownItem>
              <NodexDropdownItem
                rightSlot={
                  settings.showMode === "all" ? <CheckmarkIcon className="icon-xs" /> : null
                }
                onSelect={() => setShowMode("all")}
              >
                All
              </NodexDropdownItem>
              <NodexDropdownItem
                rightSlot={
                  settings.showMode === "hidden" ? <CheckmarkIcon className="icon-xs" /> : null
                }
                onSelect={() => setShowMode("hidden")}
              >
                Hidden
              </NodexDropdownItem>
              <NodexDropdownSeparator />
              <NodexDropdownItem
                rightSlot={
                  settings.sortMode === "recently-used" ? (
                    <CheckmarkIcon className="icon-xs" />
                  ) : null
                }
                onSelect={() => setSortMode("recently-used")}
              >
                Recently used
              </NodexDropdownItem>
              <NodexDropdownItem
                rightSlot={
                  settings.sortMode === "origin" ? <CheckmarkIcon className="icon-xs" /> : null
                }
                onSelect={() => setSortMode("origin")}
              >
                Origin
              </NodexDropdownItem>
            </NodexDropdownMenu>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-2">
          {localServers?.isLoading ? (
            <div className="rounded-lg border border-token-border bg-token-main-surface-primary px-3 py-3 text-sm text-token-text-secondary">
              Finding local servers...
            </div>
          ) : servers.length === 0 ? (
            <div className="rounded-lg border border-token-border bg-token-main-surface-primary px-3 py-3 text-sm text-token-text-secondary">
              {settings.showMode === "hidden"
                ? "No hidden local servers."
                : `No ${showModeLabel.toLowerCase()} local servers.`}
            </div>
          ) : (
            servers.map((server) => (
              <LocalServerCard
                key={server.id}
                server={server}
                hiddenMode={settings.showMode === "hidden"}
                onOpen={onOpen}
                onRequestThumbnail={onRequestThumbnail}
                onHide={() => onHideServer(server)}
                onUnhide={() => onUnhideServer(server.origin)}
                onRemoveRoute={(routePath) => onRemoveRoute(server.origin, routePath)}
              />
            ))
          )}
          {visible.hasMore ? (
            <button
              type="button"
              className="h-8 rounded-lg text-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
              onClick={expandProject}
            >
              Show more
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function LocalServerThumbnail({
  origin,
  online,
  lastSeenAt,
  onRequest,
}: {
  origin: string;
  online: boolean;
  lastSeenAt: number;
  onRequest?: (url: string) => Promise<BrowserSidebarLocalServerThumbnailResult>;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!online || !onRequest) {
      setDataUrl(null);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void onRequest(origin)
      .then((result) => {
        if (cancelled) return;
        setDataUrl(result.status === "ready" ? result.dataUrl : null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setDataUrl(null);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [lastSeenAt, onRequest, online, origin]);

  if (dataUrl) {
    return (
      <img
        alt={`Preview of ${origin}`}
        draggable={false}
        src={dataUrl}
        className="h-[52px] w-[84px] shrink-0 rounded-[10px] border border-token-border object-cover"
      />
    );
  }

  return (
    <span
      aria-label={online ? `Preview unavailable for ${origin}` : `${origin} is offline`}
      className="flex h-[52px] w-[84px] shrink-0 items-center justify-center rounded-[10px] border border-token-border bg-[radial-gradient(circle_at_35%_25%,var(--color-token-list-hover-background),transparent_70%)] text-token-text-tertiary"
      role="img"
    >
      {loading ? (
        <ActivitySpinnerIcon className="icon-xs" icon={BrowserReloadIcon} />
      ) : online ? (
        <span className="size-1.5 rounded-full bg-token-text-tertiary/50" />
      ) : (
        <WifiOff className="icon-xs" />
      )}
    </span>
  );
}

function LocalServerCard({
  server,
  hiddenMode,
  onOpen,
  onRequestThumbnail,
  onHide,
  onUnhide,
  onRemoveRoute,
}: {
  server: BrowserSidebarLocalServer;
  hiddenMode: boolean;
  onOpen: (url: string) => void;
  onRequestThumbnail?: (url: string) => Promise<BrowserSidebarLocalServerThumbnailResult>;
  onHide: () => void;
  onUnhide: () => void;
  onRemoveRoute: (routePath: string) => void;
}) {
  const visibleRoutes = server.routes.filter((route) => !route.hidden).slice(0, 5);
  return (
    <div className="group/local-server overflow-hidden rounded-lg border border-token-border bg-token-main-surface-primary text-token-text-primary transition-colors hover:bg-token-list-hover-background">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left"
        onClick={() => onOpen(server.origin)}
      >
        <LocalServerThumbnail
          origin={server.origin}
          online={server.online}
          lastSeenAt={server.lastSeenAt}
          onRequest={onRequestThumbnail}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                server.online ? "bg-emerald-500" : "bg-token-text-tertiary",
              )}
            />
            <span className="truncate text-sm font-medium text-token-text-primary">
              {formatLocalServerTitle(server.origin)}
            </span>
          </span>
          <span className="mt-1 block truncate text-xs text-token-text-secondary">
            {server.origin}
          </span>
        </span>
      </button>
      <div className="flex items-center justify-between gap-2 px-3 pb-2">
        <div className="min-w-0 flex-1">
          {visibleRoutes.length > 0 ? (
            visibleRoutes.map((route) => (
              <div
                key={route.id}
                className="flex min-w-0 items-center gap-1 text-xs text-token-text-secondary"
              >
                <button
                  type="button"
                  className="min-w-0 truncate text-left hover:text-token-text-primary"
                  onClick={() => onOpen(`${server.origin}${route.path}`)}
                >
                  {route.path}
                </button>
                <button
                  type="button"
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-md opacity-0 hover:bg-token-foreground/5 group-hover/local-server:opacity-100"
                  aria-label={`Remove route ${route.path}`}
                  onClick={() => onRemoveRoute(route.path)}
                >
                  <CloseIcon className="icon-2xs" />
                </button>
              </div>
            ))
          ) : (
            <div className="truncate text-xs text-token-text-secondary">/</div>
          )}
        </div>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-lg text-token-text-tertiary opacity-0 transition-opacity hover:bg-token-foreground/5 hover:text-token-text-primary group-hover/local-server:opacity-100 focus-visible:opacity-100"
          aria-label={hiddenMode ? `Unhide ${server.origin}` : `Hide ${server.origin}`}
          onClick={hiddenMode ? onUnhide : onHide}
        >
          {hiddenMode ? (
            <CheckmarkIcon className="icon-xs" />
          ) : (
            <BrowserHideIcon className="icon-xs" />
          )}
        </button>
      </div>
    </div>
  );
}

function formatLocalServerTitle(origin: string): string {
  try {
    const parsed = new URL(origin);
    return `${parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

export function BrowserCommentOverlay({ children }: { children?: ReactNode }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-20 cursor-crosshair">
      <div id="browser-sidebar-comment-popup-root" className="absolute inset-0">
        {children}
      </div>
    </div>
  );
}

export function BrowserAnnotationComposer({
  anchors,
  designChange,
  intent,
  note,
  originalView,
  selectionMode,
  onDesignChange,
  onIntentChange,
  onNoteChange,
  onOriginalViewChange,
  onSelectionModeChange,
  onRemoveAnchor,
  onDiscard,
  onAddToComposer,
}: {
  anchors: BrowserAnnotationAnchor[];
  designChange: BrowserAnnotationDesignChange | null;
  intent: "comment" | "designChange";
  note: string;
  originalView: boolean;
  selectionMode: "inspect" | "region";
  onDesignChange: (input: {
    anchorId: string;
    property: BrowserAnnotationDesignChange["property"];
    after: string;
  }) => void;
  onIntentChange: (intent: "comment" | "designChange") => void;
  onNoteChange: (note: string) => void;
  onOriginalViewChange: (originalView: boolean) => void;
  onSelectionModeChange: (mode: "inspect" | "region") => void;
  onRemoveAnchor: (anchorId: string) => void;
  onDiscard: () => void;
  onAddToComposer: () => void;
}) {
  if (anchors.length === 0) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-token-dropdown-background/90 p-1 text-xs text-token-text-secondary shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm">
          <AnnotationModeButton
            active={selectionMode === "inspect"}
            onClick={() => onSelectionModeChange("inspect")}
          >
            Element or text
          </AnnotationModeButton>
          <AnnotationModeButton
            active={selectionMode === "region"}
            onClick={() => onSelectionModeChange("region")}
          >
            Region
          </AnnotationModeButton>
          <span className="px-2">Hold Shift for multiple.</span>
        </div>
      </div>
    );
  }
  const designableAnchors = anchors.filter((anchor) => anchor.kind === "element");
  const designAnchor =
    designableAnchors.find((anchor) => anchor.id === designChange?.anchorId) ??
    designableAnchors[0] ??
    null;
  const designProperty = designChange?.property ?? "color";
  const designBefore = designAnchor?.computedStyle?.[designProperty] ?? "";
  const designAfter = designChange?.after ?? "";
  return (
    <div className="pointer-events-auto absolute inset-x-3 bottom-3 mx-auto max-w-lg rounded-xl bg-token-dropdown-background/95 p-3 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-md">
      <div className="mb-2 flex items-center gap-1">
        <AnnotationModeButton
          active={intent === "comment"}
          onClick={() => onIntentChange("comment")}
        >
          Comment
        </AnnotationModeButton>
        <AnnotationModeButton
          active={intent === "designChange"}
          onClick={() => onIntentChange("designChange")}
        >
          Design change
        </AnnotationModeButton>
        <div className="flex-1" />
        <AnnotationModeButton
          active={selectionMode === "inspect"}
          onClick={() => onSelectionModeChange("inspect")}
        >
          Inspect
        </AnnotationModeButton>
        <AnnotationModeButton
          active={selectionMode === "region"}
          onClick={() => onSelectionModeChange("region")}
        >
          Region
        </AnnotationModeButton>
      </div>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {anchors.map((anchor, index) => (
          <NodexTooltip key={anchor.id} tooltipContent={anchor.selector ?? anchor.textExcerpt}>
            <button
              type="button"
              className="inline-flex max-w-full items-center gap-1 rounded-md bg-token-foreground/5 px-2 py-1 text-xs text-token-text-secondary hover:bg-token-list-hover-background"
              onClick={() => onRemoveAnchor(anchor.id)}
            >
              <span className="truncate">
                {anchor.kind === "text"
                  ? anchor.textExcerpt || `Text ${index + 1}`
                  : anchor.kind === "region"
                    ? `Region ${index + 1}`
                    : anchor.selector || `Element ${index + 1}`}
              </span>
              <CloseIcon className="icon-xs shrink-0" />
            </button>
          </NodexTooltip>
        ))}
      </div>
      {intent === "designChange" ? (
        <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 rounded-lg bg-token-foreground/5 p-2">
          {designableAnchors.length > 1 ? (
            <label className="col-span-2 grid grid-cols-[76px_minmax(0,1fr)] items-center gap-2 text-xs text-token-text-secondary">
              <span>Target</span>
              <select
                className="h-7 min-w-0 rounded-md border border-token-border bg-token-main-surface-primary px-2 text-xs text-token-text-primary outline-none focus:border-token-focus-border"
                value={designAnchor?.id ?? ""}
                onChange={(event) => {
                  onDesignChange({
                    anchorId: event.target.value,
                    property: designProperty,
                    after: designAfter,
                  });
                }}
              >
                {designableAnchors.map((anchor, index) => (
                  <option key={anchor.id} value={anchor.id}>
                    {anchor.selector || `Element ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-token-text-tertiary">
            Property
            <select
              className="h-7 min-w-0 rounded-md border border-token-border bg-token-main-surface-primary px-2 text-xs text-token-text-primary outline-none focus:border-token-focus-border"
              value={designProperty}
              disabled={!designAnchor}
              onChange={(event) => {
                if (!designAnchor) return;
                const property = event.target.value as BrowserAnnotationDesignChange["property"];
                onDesignChange({
                  anchorId: designAnchor.id,
                  property,
                  after: designAnchor.computedStyle?.[property] ?? "",
                });
              }}
            >
              <option value="color">Text color</option>
              <option value="backgroundColor">Background</option>
              <option value="fontSize">Font size</option>
              <option value="borderRadius">Corner radius</option>
              <option value="opacity">Opacity</option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-token-text-tertiary">
            After
            <input
              className="h-7 min-w-0 rounded-md border border-token-border bg-token-main-surface-primary px-2 text-xs text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border"
              value={designAfter}
              disabled={!designAnchor}
              maxLength={512}
              placeholder={designBefore || "New value"}
              onChange={(event) => {
                if (!designAnchor) return;
                onDesignChange({
                  anchorId: designAnchor.id,
                  property: designProperty,
                  after: event.target.value,
                });
              }}
            />
          </label>
          <div className="col-span-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-token-text-tertiary">
            <NodexTooltip tooltipContent={designBefore}>
              <span className="truncate">Before: {designBefore || "Unavailable"}</span>
            </NodexTooltip>
            <button
              type="button"
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-xs",
                originalView
                  ? "bg-token-foreground text-token-background"
                  : "text-token-text-secondary hover:bg-token-list-hover-background",
              )}
              disabled={!designChange?.after.trim()}
              onClick={() => onOriginalViewChange(!originalView)}
            >
              {originalView ? "Show change" : "Original view"}
            </button>
          </div>
        </div>
      ) : null}
      <textarea
        className="mt-2 min-h-16 w-full resize-none rounded-lg border border-token-border bg-token-main-surface-primary px-2.5 py-2 text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border"
        value={note}
        maxLength={8_192}
        placeholder={intent === "designChange" ? "Describe the design change…" : "Leave a comment…"}
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          className="rounded-lg px-2.5 py-1.5 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          onClick={onDiscard}
        >
          Discard
        </button>
        <button
          type="button"
          className="rounded-lg bg-token-foreground px-2.5 py-1.5 text-xs font-medium text-token-background hover:opacity-90"
          onClick={onAddToComposer}
        >
          Add to composer
        </button>
      </div>
    </div>
  );
}

function AnnotationModeButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "rounded-full px-2 py-1 text-xs transition-colors",
        active
          ? "bg-token-foreground text-token-background"
          : "text-token-text-secondary hover:bg-token-list-hover-background",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function BrowserUnavailableState() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-token-main-surface-primary p-6 text-center">
      <div className="text-base font-medium text-token-text-primary">
        Browser is available in the desktop app
      </div>
      <div className="mt-1 max-w-sm text-sm text-token-text-secondary">
        The browser tab uses Electron webview isolation and cannot run in this renderer.
      </div>
    </div>
  );
}

function makeInitialSnapshot(
  tab: BrowserTab,
  browserConversationId: string,
  browserViewScopeId = "unassigned-window-session",
): BrowserSidebarTabSnapshot {
  const url = normalizeBrowserNavigationUrl(readBrowserConfigUrl(tab));
  const persistedDeviceToolbarState = readBrowserConfigDeviceToolbarState(tab);
  const deviceToolbarVisible =
    persistedDeviceToolbarState?.toolbarState.isEnabled ??
    readBrowserConfigDeviceToolbarVisible(tab);
  return {
    ...DEFAULT_BROWSER_SNAPSHOT,
    browserConversationId,
    browserViewScopeId,
    browserTabId: requireWorkbenchBrowserTabProjectionId(tab),
    projectId: tab.projectId,
    url,
    title: readBrowserConfigTitle(tab) || tab.title || "New tab",
    faviconUrl: readBrowserConfigFavicon(tab),
    deviceToolbarVisible,
    deviceToolbarState: persistedDeviceToolbarState ?? {
      ...DEFAULT_BROWSER_SNAPSHOT.deviceToolbarState,
      toolbarState: {
        ...DEFAULT_BROWSER_SNAPSHOT.deviceToolbarState.toolbarState,
        isEnabled: deviceToolbarVisible,
      },
    },
    viewport: persistedDeviceToolbarState
      ? {
          width:
            persistedDeviceToolbarState.toolbarState.presetId === "responsive"
              ? (persistedDeviceToolbarState.responsiveViewportSize?.width ??
                persistedDeviceToolbarState.toolbarState.width)
              : persistedDeviceToolbarState.toolbarState.width,
          height:
            persistedDeviceToolbarState.toolbarState.presetId === "responsive"
              ? (persistedDeviceToolbarState.responsiveViewportSize?.height ??
                persistedDeviceToolbarState.toolbarState.height)
              : persistedDeviceToolbarState.toolbarState.height,
          presetId: persistedDeviceToolbarState.toolbarState.presetId,
          zoomPercent: 100,
        }
      : DEFAULT_BROWSER_SNAPSHOT.viewport,
    hasBrowserPage: !isBlankBrowserUrl(url),
    pageActionsDisabled: isBlankBrowserUrl(url),
    updatedAt: Date.now(),
  };
}

function readWebviewHostBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}
