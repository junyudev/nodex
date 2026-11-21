import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { deliverBrowserAnnotations } from "./browser-annotation-delivery";
import { waitForBrowserAnnotationEvidence } from "./browser-annotation-attachments";
import {
  browserAnnotationDefaultAction,
  browserAnnotationKeyAction,
  type BrowserAnnotationAction,
  type BrowserAnnotationFlow,
} from "../../../shared/browser-annotation-interaction";
import { useBrowserAnnotationKeymap } from "./browser-annotation-keyboard";
import {
  getCommandKeybindings,
  matchesKeyboardEventToCommand,
} from "../../../shared/command-keybindings";
import { openModal } from "@/lib/modal-registry";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { BrowserAnnotationDiscardDialog } from "./browser-annotation-discard-dialog";
import { resolveBrowserAnnotationDestination } from "../../../shared/browser-annotation";
import { BrowserAnnotationEditorPlacement } from "./browser-annotation-editor-placement";
import { permissionShortLabel } from "./browser-permission-prompt";
import type {
  BrowserPermissionAction,
  BrowserPermissionPrompt,
} from "../../../shared/browser/browser-permissions";
import type { BrowserPageDialog } from "../../../shared/browser/browser-page-dialogs";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
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
  BROWSER_SIDEBAR_DEVICE_LABEL_MESSAGES,
  BROWSER_SIDEBAR_DEVICE_PRESETS,
  DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
  DEFAULT_BROWSER_SIDEBAR_FIND_STATE,
  makeBrowserSidebarTabKey,
  matchesBrowserSidebarTabIdentity,
  type BrowserSidebarTabIdentity,
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
  type BrowserSidebarThemeVariant,
  type BrowserSidebarLocalServersSnapshot,
  type BrowserSidebarOpenSurfaceRequest,
  type BrowserPageFailure,
  type BrowserSidebarTabSnapshot,
  type BrowserSidebarViewport,
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
import { isBlankBrowserUrl, resolveBrowserTabTitle } from "../../../shared/browser-url";
import { normalizeBrowserAddressInput } from "../../../shared/browser-address-input";
import { isErrorPageExternalUrl } from "../../../shared/browser-url-policy";
import { createSecureRuntimeId } from "../../../shared/secure-runtime-id";
import { useTheme } from "@/lib/use-theme";
import { openLink } from "@/lib/link-opening";
import { useLinkOpening } from "@/lib/web-link-navigation";
import { BrowserPageDialogOverlay, type BrowserPageDialogAnswer } from "./browser-page-dialog";
import { BrowserPageOverlay } from "./browser-page-overlay";
import {
  browserSidebarRendererWebviewManager,
  type BrowserSidebarHostClaimInput,
  type BrowserSidebarHostLease,
} from "./browser-sidebar-webview-manager";
import { BrowserUseCursorPortal } from "./browser-use-cursor-portal";
import { useBrowserSidebarRendererState } from "./browser-sidebar-renderer-state-store";
import { computeBrowserViewportLayout } from "./browser-viewport-layout";
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
  updateBrowserViewportDimension,
  type BrowserLocalServerSettings,
} from "./browser-sidebar-ui-model";
import type { WorkbenchTabProjection, WorkbenchTabUpdateInput } from "@/lib/types";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { useRegisterContentSearchBrowserTarget } from "@/features/content-search/content-search-context";
import {
  RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE,
  RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE,
} from "@/lib/right-panel-composer-overlay-reserve";
import { cn } from "@/lib/utils";
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
  SendToChatIcon,
  VisibilityIcon,
  VisibilityOffIcon,
  SettingsGeneralIcon,
  SidePanelBrowserIcon,
} from "@/components/shared/icons";
import { TrashIcon } from "@/components/shared/icons/customize-action-icons";
import {
  buildBrowserAddressSuggestions,
  type BrowserAddressSuggestion,
} from "./browser-address-suggestions";
import { BrowserAddressField, type BrowserAddressWorkspaceOption } from "./browser-address-field";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexPopover, NodexPopoverContent } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ViewerButton,
  ViewerControlDivider,
  ViewerControlGroup,
} from "@/components/ui/viewer-header";
import { BrowserProfileImportDialog } from "./browser-profile-import-dialog";
import type { BrowserSettingsDestination } from "./browser-settings-pages";
import {
  invokeBrowserSidebarCommand,
  readBrowserLocalServerPreferences,
  readBrowserLocalServerThumbnail,
  updateBrowserLocalServerPreferences,
} from "./browser-sidebar-commands";
import {
  actOnBrowserCredentialCandidate,
  clearBrowserData,
  clearBrowserDownloadHistory,
  fillBrowserContactInfo,
  fillBrowserCredential,
  generateAndFillBrowserCredential,
  readBrowserContactInfo,
  readBrowserCredentials,
  readBrowserDownloads,
  readBrowserSiteInfo,
  runBrowserDownloadAction,
} from "./browser-profile-runtime";

type BrowserTab = WorkbenchTabProjection & { preview?: true };

export interface BrowserSurfaceContext {
  /** Stable presentation owner used to isolate Browser hosts and snapshots. */
  readonly browserConversationId: string;
  /** Present only when Browser annotations/attachments target a real Codex conversation. */
  readonly codexSessionId: string | null;
  readonly annotationSessionId?: string | null;
  readonly annotationProjectDraft?: { projectId: string; draftId: string } | null;
}

const BROWSER_CHROME_CLASS =
  "relative z-10 h-toolbar-pane min-w-0 shrink-0 border-b border-token-border bg-token-main-surface-primary";
const BROWSER_CHROME_ROW_CLASS =
  "draggable flex h-full min-w-0 items-center gap-1.5 px-2 text-token-description-foreground";
const BROWSER_COLLAPSIBLE_ACTION_CLASS =
  "grid min-w-0 overflow-hidden transition-[max-width,opacity,transform] duration-150 ease-out";
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

export type { BrowserAddressWorkspaceOption } from "./browser-address-field";

export interface BrowserAddressSuggestionsSource {
  readonly useWorkspaceSuggestions: (query: string) => readonly BrowserAddressWorkspaceOption[];
}

const EMPTY_ADDRESS_SUGGESTIONS: BrowserAddressSuggestionsSource = {
  useWorkspaceSuggestions: () => [],
};

export function BrowserSidebarPanel({
  tab,
  activeSession,
  surfaceContext,
  browserViewScopeId,
  onUpdateTab = ignoreBrowserTabUpdate,
  onOpenBrowserSettings,
  boundsSyncTrigger,
  activeForContentSearch = false,
  isVisible,
  renderNewTabPage,
  addressSuggestions = EMPTY_ADDRESS_SUGGESTIONS,
}: {
  tab: BrowserTab;
  activeSession?: WorkbenchSessionRenderProjection;
  surfaceContext?: BrowserSurfaceContext;
  browserViewScopeId: string;
  onRefreshSessions: (projectId: string | null) => Promise<WorkbenchSessionRenderProjection[]>;
  onUpdateTab?: (tabId: string, patch: WorkbenchTabUpdateInput) => WorkbenchTabProjection | null;
  onOpenBrowserSettings?: (sectionId: BrowserSettingsDestination) => void;
  boundsSyncTrigger?: MotionValue<number>;
  activeForContentSearch?: boolean;
  isVisible: boolean;
  /** Composes a blank tab with the Browser's search field and local servers. */
  renderNewTabPage?: (sections: BrowserNewTabSections) => ReactNode;
  addressSuggestions?: BrowserAddressSuggestionsSource;
}) {
  const intl = useIntl();
  const browserConversationId =
    surfaceContext?.browserConversationId ?? activeSession?.id ?? browserViewScopeId;
  const fallbackCodexSessionId = surfaceContext
    ? surfaceContext.codexSessionId
    : (activeSession?.thread?.threadId ?? activeSession?.id ?? null);
  const browserRuntimeAvailable = typeof window !== "undefined" && Boolean(window.api);
  const browserRuntime = useBrowserSidebarRendererState();
  const linkOpening = useLinkOpening();
  const { resolved: themeVariant } = useTheme();
  const panelRef = useRef<HTMLDivElement>(null);
  const webviewHostRef = useRef<HTMLDivElement | null>(null);
  const syncWebviewPresentationRef = useRef<
    | ((presentation?: { isVisible: boolean; themeVariant: BrowserSidebarThemeVariant }) => void)
    | null
  >(null);
  const webviewHostLeaseRef = useRef<BrowserSidebarHostLease | null>(null);
  const readPresentation = useEffectEvent(() => ({ isVisible, themeVariant }));
  const [snapshot, setSnapshot] = useState<BrowserSidebarTabSnapshot>(() =>
    makeInitialSnapshot(tab, browserConversationId, browserViewScopeId),
  );
  const [addressValue, setAddressValue] = useState(readBrowserAddressValue(snapshot.url));
  const [addressFocused, setAddressFocused] = useState(false);
  const [addressSuggestionsDismissed, setAddressSuggestionsDismissed] = useState(false);
  const [highlightedAddressSuggestionId, setHighlightedAddressSuggestionId] = useState<
    string | null
  >(null);
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
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [profileImportOpen, setProfileImportOpen] = useState(false);
  const [siteInfo, setSiteInfo] = useState<BrowserSiteInfo | null>(null);
  const [siteInfoRevision, setSiteInfoRevision] = useState(0);
  const [chromeElement, setChromeElement] = useState<HTMLDivElement | null>(null);
  const [credentialCandidate, setCredentialCandidate] =
    useState<BrowserCredentialSaveCandidate | null>(null);
  const [downloadsSnapshot, setDownloadsSnapshot] = useState<BrowserDownloadsSnapshot>({
    downloads: [],
  });
  const [editingAnnotationId, setEditingAnnotationId] = useState<string | undefined>();
  const editorIdRef = useRef(createSecureRuntimeId("annotation-editor"));
  const submittingAnnotationRef = useRef(false);
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
  const annotationCount =
    snapshot.annotations?.filter((annotation) => annotation.deliveryState !== "sending").length ??
    0;
  const annotationFlow = snapshot.annotationFlow ?? "batch";
  const annotationAgentControlled = snapshot.annotationAgentControlled === true;
  const annotationKeymap = useBrowserAnnotationKeymap();
  const annotationShortcuts = useMemo(
    () => ({
      bindings: getCommandKeybindings(annotationKeymap, "toggleBrowserAnnotation").flatMap(
        (binding) => (binding.key ? [binding.key] : []),
      ),
      platform: annotationKeymap.platform,
    }),
    [annotationKeymap],
  );
  const [annotationSending, setAnnotationSending] = useState(false);
  const pageActionsDisabled = snapshot.pageActionsDisabled || isBlank;
  const canOpenExternally = !snapshot.failure || isErrorPageExternalUrl(snapshot.failure.failedUrl);
  const [initialWebviewUrl, setInitialWebviewUrl] = useState(snapshot.url);
  if (isBlank && initialWebviewUrl !== "about:blank") {
    setInitialWebviewUrl("about:blank");
  } else if (!isBlank && isBlankBrowserUrl(initialWebviewUrl)) {
    setInitialWebviewUrl(snapshot.url);
  }
  const readInitialWebviewUrl = useEffectEvent(() => initialWebviewUrl);

  const command = useCallback(
    async (input: BrowserSidebarCommand): Promise<BrowserSidebarCommandResult> => {
      return invokeBrowserSidebarCommand(input);
    },
    [],
  );
  const updateLocalServerPreferences = useCallback(
    async (update: BrowserLocalServerPreferencesUpdate) => {
      const preferences = await updateBrowserLocalServerPreferences(update);
      setLocalServerPreferences(preferences);
    },
    [],
  );
  const browserTabId = requireWorkbenchBrowserTabProjectionId(tab);
  const tabInitialUrl = readBrowserConfigUrl(tab);
  const tabFaviconUrl = readBrowserConfigFavicon(tab);
  const tabDeviceToolbarVisible = readBrowserConfigDeviceToolbarVisible(tab);
  const tabDeviceToolbarStateKey = JSON.stringify(readBrowserConfigDeviceToolbarState(tab) ?? null);
  // Registration follows the serialized configuration, even when validation returns a fresh object.
  const tabDeviceToolbarState = useMemo(
    () =>
      (JSON.parse(tabDeviceToolbarStateKey) ?? undefined) as ReturnType<
        typeof readBrowserConfigDeviceToolbarState
      >,
    [tabDeviceToolbarStateKey],
  );
  const readDeviceToolbarState = useEffectEvent(() => tabDeviceToolbarState);
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
  const respondToPermissionPrompt = async (
    prompt: BrowserPermissionPrompt,
    action: BrowserPermissionAction,
  ) =>
    (
      await command({
        type: "respond-permission",
        ...browserIdentity,
        promptId: prompt.id,
        mountGeneration: prompt.mountGeneration,
        action,
      })
    ).ok;
  const respondToPageDialog = async (dialog: BrowserPageDialog, answer: BrowserPageDialogAnswer) =>
    (
      await command({
        type: "respond-page-dialog",
        ...browserIdentity,
        dialogId: dialog.id,
        accept: answer.accept,
        ...(answer.suppress ? { suppress: true } : {}),
      })
    ).ok;
  const openPermissionSystemSettings = async (prompt: BrowserPermissionPrompt) =>
    (
      await command({
        type: "open-permission-system-settings",
        ...browserIdentity,
        promptId: prompt.id,
        mountGeneration: prompt.mountGeneration,
      })
    ).ok;
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
  const annotationDestination = resolveBrowserAnnotationDestination({
    projectDraft: surfaceContext?.annotationProjectDraft,
    sessionId: surfaceContext ? surfaceContext.annotationSessionId : activeSession?.id,
    threadId: codexSessionId,
  });
  useEffect(() => {
    if (!registeredBrowserKey) return;
    void command({
      type: "configure-annotations",
      ...browserIdentity,
      destination: annotationDestination,
      sessionId: annotationSessionIdRef.current,
    })
      .then((result) => {
        if (!result.ok) showBrowserStatus(result.message);
      })
      .catch((error: unknown) =>
        showBrowserStatus(
          error instanceof Error
            ? error.message
            : getIntl().formatMessage({
                id: "browser.browserSidebarPanel.connectAnnotationsFailed",
                defaultMessage: "Could not connect Browser annotations to chat",
              }),
        ),
      );
  }, [annotationDestination, browserIdentity, command, registeredBrowserKey]);
  useEffect(
    () =>
      window.api?.on("browser-annotation-open", (payload) => {
        const event = payload as BrowserSidebarTabIdentity & {
          annotationId: string;
          anchor?: BrowserAnnotationAnchor;
        };
        if (
          event.browserConversationId !== browserIdentity.browserConversationId ||
          event.browserViewScopeId !== browserIdentity.browserViewScopeId ||
          event.browserTabId !== browserIdentity.browserTabId
        )
          return;
        const annotation = snapshot.annotations?.find((item) => item.id === event.annotationId);
        if (!annotation) {
          showBrowserStatus(
            getIntl().formatMessage({
              id: "browser.browserSidebarPanel.annotationUnavailable",
              defaultMessage: "This annotation is no longer available",
            }),
          );
          return;
        }
        if (annotation.pageUrl !== snapshot.url) {
          showBrowserStatus(
            getIntl().formatMessage({
              id: "browser.browserSidebarPanel.annotationWrongPage",
              defaultMessage: "This annotation belongs to another page",
            }),
          );
          return;
        }
        editorIdRef.current = createSecureRuntimeId("annotation-editor");
        setEditingAnnotationId(annotation.id);
        setAnnotationDraft({
          ...createBrowserAnnotationDraftState(annotation.pageUrl),
          anchors: annotation.anchors.map((anchor) =>
            anchor.id === event.anchor?.id ? event.anchor : anchor,
          ),
          note: annotation.note,
          intent: annotation.intent ?? "comment",
          designChange: annotation.designChanges?.[0] ?? null,
        });
        void command({ type: "set-interaction-mode", ...browserIdentity, mode: "comment" })
          .then((result) => {
            if (!result.ok) showBrowserStatus(result.message);
          })
          .catch((error: unknown) =>
            showBrowserStatus(
              error instanceof Error
                ? error.message
                : getIntl().formatMessage({
                    id: "browser.browserSidebarPanel.openAnnotationFailed",
                    defaultMessage: "Could not open annotation",
                  }),
            ),
          );
      }),
    [browserIdentity, command, snapshot.annotations, snapshot.url],
  );

  const sendSavedAnnotations = async (ids: readonly string[]) => {
    if (!annotationDestination) {
      showBrowserStatus(
        intl.formatMessage({
          id: "browser.browserSidebarPanel.annotationChatUnavailable",
          defaultMessage: "The chat is unavailable. Your annotations are saved",
        }),
      );
      return false;
    }
    const annotations = await waitForBrowserAnnotationEvidence(annotationDestination, ids);
    const result = await deliverBrowserAnnotations({
      destination: annotationDestination,
      annotations,
      consume: async (admittedIds) => {
        const cleared = await command({
          type: "consume-annotations",
          destination: annotationDestination,
          ids: [...admittedIds],
        });
        if (!cleared.ok) throw new Error(cleared.message);
      },
    });
    if (!result.admitted) {
      const retained = await command({
        type: "retain-annotations",
        ...browserIdentity,
        ids: [...ids],
      });
      if (!retained.ok) showBrowserStatus(retained.message);
    }
    if (result.reason) showBrowserStatus(result.reason);
    return result.admitted;
  };
  const submitBrowserAnnotation = (action: BrowserAnnotationAction) => {
    if (submittingAnnotationRef.current) return;
    if (!annotationDestination) {
      showBrowserStatus(
        intl.formatMessage({
          id: "browser.browserSidebarPanel.annotateNeedsChat",
          defaultMessage: "Open a chat or Agent Dock to annotate",
        }),
      );
      return;
    }
    submittingAnnotationRef.current = true;
    setAnnotationSending(true);
    const submittedEditorId = editorIdRef.current;
    // A promise chain rather than try/finally keeps this component compilable.
    const submit = async () => {
      const result = await command({
        type: "save-annotation",
        ...browserIdentity,
        input: {
          editorId: submittedEditorId,
          annotationId: editingAnnotationId,
          deliveryState: action === "send" ? "sending" : "saved",
          sessionId: annotationSessionIdRef.current,
          destination: annotationDestination,
          pageUrl: annotationDraft.pageUrl,
          anchors: annotationAnchors,
          note: annotationNote,
          intent: annotationIntent,
          designChanges:
            annotationIntent === "designChange" && annotationDesignChange
              ? [annotationDesignChange]
              : [],
        },
      });
      if (!result.ok) {
        showBrowserStatus(result.message);
        return;
      }
      const idleEditorId = createSecureRuntimeId("annotation-editor");
      if (editorIdRef.current === submittedEditorId) {
        setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
        setEditingAnnotationId(undefined);
        editorIdRef.current = idleEditorId;
      }
      if (action !== "send" || !result.annotation) return;
      const admitted = await sendSavedAnnotations([result.annotation.id]);
      if (admitted && annotationFlow === "quick" && editorIdRef.current === idleEditorId)
        await command({ type: "set-interaction-mode", ...browserIdentity, mode: "browse" });
    };
    return submit()
      .catch((error: unknown) =>
        showBrowserStatus(
          error instanceof Error
            ? error.message
            : intl.formatMessage({
                id: "browser.browserSidebarPanel.submitAnnotationFailed",
                defaultMessage: "Could not submit annotation",
              }),
        ),
      )
      .finally(() => {
        submittingAnnotationRef.current = false;
        setAnnotationSending(false);
      });
  };
  useEffect(() => {
    if (!isVisible) return;
    const toggle = () => {
      void command({
        type: "set-interaction-mode",
        ...browserIdentity,
        mode: commentMode ? "browse" : "comment",
        flow: "batch",
      }).then((result) => {
        if (!result.ok) showBrowserStatus(result.message);
      });
    };
    const stop = window.api?.on("browser-annotation-toggle", (payload) => {
      if (matchesBrowserSidebarTabIdentity(payload as BrowserSidebarTabIdentity, browserIdentity))
        toggle();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        event.repeat ||
        !matchesKeyboardEventToCommand(event, annotationKeymap, "toggleBrowserAnnotation")
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      stop?.();
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [annotationKeymap, browserIdentity, command, commentMode, isVisible]);
  useEffect(() => {
    if (!commentMode || !isVisible) return;
    const change = (event: KeyboardEvent) => {
      if (
        event.code !== "Space" ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        (event.target instanceof HTMLElement &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      event.preventDefault();
      void command({
        type: "set-annotation-presentation",
        ...browserIdentity,
        suspended: event.type === "keydown",
      });
    };
    const release = () => {
      void command({ type: "set-annotation-presentation", ...browserIdentity, suspended: false });
    };
    window.addEventListener("keydown", change, true);
    window.addEventListener("keyup", change, true);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", change, true);
      window.removeEventListener("keyup", change, true);
      window.removeEventListener("blur", release);
    };
  }, [browserIdentity, command, commentMode, isVisible]);

  const shouldMountWebview = !isBlank || activeBrowserUseTab !== null;
  const showsNewTabPage = !downloadsOpen && !snapshot.failure && !shouldMountWebview;
  const workspaceAddressCandidates = addressSuggestions.useWorkspaceSuggestions(
    !shouldMountWebview && addressFocused ? addressValue : "",
  );
  const addressRows = buildBrowserAddressSuggestions(addressValue, workspaceAddressCandidates);
  const addressSuggestionsOpen =
    !shouldMountWebview && addressFocused && !addressSuggestionsDismissed && addressRows.length > 0;
  const highlightedAddressIndex = findHighlightedAddressIndex(
    addressRows,
    highlightedAddressSuggestionId,
  );
  const browserPagePersistence = exactBrowserUseTab ? "browser-use" : "durable";

  useEffect(() => {
    if (!isVisible || !showsNewTabPage || !browserRuntimeAvailable) return;
    const panel = panelRef.current;
    if (!panel) return;
    const activeElement = panel.ownerDocument.activeElement;
    if (
      activeElement?.closest(
        'input, textarea, select, [contenteditable="true"], [data-terminal]',
      ) &&
      !panel.contains(activeElement)
    )
      return;
    panel
      .querySelector<HTMLInputElement>("[data-browser-sidebar-address-input='true']")
      ?.focus({ preventScroll: true });
  }, [browserRuntimeAvailable, isVisible, showsNewTabPage]);

  const handleOpenSurface = useEffectEvent((request: BrowserSidebarOpenSurfaceRequest) => {
    if (request.surface === "downloads") {
      setDownloadsOpen(true);
      return;
    }
    if (request.surface === "history") {
      onOpenBrowserSettings?.("history");
      return;
    }
  });

  const openExternally = async () => {
    if (snapshot.failure) {
      if (!isErrorPageExternalUrl(snapshot.failure.failedUrl)) return;
      await command({
        type: "open-external",
        ...browserIdentity,
        fromErrorPage: true,
      });
      return;
    }
    await (linkOpening?.openLink ?? openLink)({
      url: snapshot.pendingUrl ?? snapshot.url,
      initiator: "open_in_browser_bridge",
      openTarget: "external-browser",
    });
  };

  const siteInfoAvailable =
    browserRuntimeAvailable && !isBlank && registeredBrowserKey === browserIdentityKey;
  const siteInfoKey = JSON.stringify([
    browserIdentityKey,
    siteInfoAvailable,
    snapshot.url,
    snapshot.permissionPrompts?.length,
    siteInfoRevision,
  ]);
  const [siteInfoRequest, setSiteInfoRequest] = useState({
    key: siteInfoKey,
    identity: browserIdentity,
    available: siteInfoAvailable,
  });
  if (siteInfoRequest.key !== siteInfoKey) {
    setSiteInfoRequest({
      key: siteInfoKey,
      identity: browserIdentity,
      available: siteInfoAvailable,
    });
    if (!siteInfoAvailable) setSiteInfo(null);
  }
  useEffect(() => {
    if (!siteInfoRequest.available) return;
    let cancelled = false;
    void readBrowserSiteInfo(siteInfoRequest.identity)
      .then((nextSiteInfo) => {
        if (!cancelled) setSiteInfo(nextSiteInfo);
      })
      .catch(() => {
        if (!cancelled) setSiteInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [siteInfoRequest]);

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
    const timeout = window.setTimeout(() => setCredentialCandidate(null), Math.max(0, remaining));
    return () => window.clearTimeout(timeout);
  }, [credentialCandidate]);

  const actOnCredentialCandidate = useCallback(
    async (action: "dismiss" | "save") => {
      if (!credentialCandidate) return;
      const result = await actOnBrowserCredentialCandidate({
        candidateId: credentialCandidate.candidateId,
        action,
      });
      setCredentialCandidate(null);
      if (!result.ok)
        showBrowserStatus(
          result.message ??
            getIntl().formatMessage({
              id: "browser.browserSidebarPanel.savePasswordFailed",
              defaultMessage: "Unable to save password",
            }),
        );
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
    void readBrowserLocalServerPreferences()
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
    void readBrowserDownloads().then((snapshot) => {
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
      annotationShortcuts,
    );
    return () => {
      browserSidebarRendererWebviewManager.setAnnotationMode(
        browserIdentity,
        false,
        annotationSessionId,
        annotationSelectionMode,
      );
    };
  }, [
    annotationSelectionMode,
    annotationShortcuts,
    browserIdentity,
    browserRuntimeAvailable,
    commentMode,
    isBlank,
  ]);

  useEffect(() => {
    if (!browserRuntimeAvailable) return undefined;
    return window.api?.on("browser-annotation-selection", (payload) => {
      const event = payload as BrowserAnnotationRoutedSelectionEvent;
      if (!matchesBrowserSidebarTabIdentity(event, browserIdentity)) return;
      if (event.selection.sessionId !== annotationSessionIdRef.current) return;
      editorIdRef.current = createSecureRuntimeId("annotation-editor");
      setEditingAnnotationId(undefined);
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
      commentMode &&
        !annotationAgentControlled &&
        !snapshot.annotationSuspended &&
        annotationIntent === "designChange"
        ? annotationDesignChange
        : null,
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
    annotationAgentControlled,
    snapshot.annotationSuspended,
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
          showBrowserStatus(
            getIntl().formatMessage({
              id: "browser.browserSidebarPanel.addContextNeedsChat",
              defaultMessage: "Open a Conversation to add browser context",
            }),
          );
          return;
        }
        publishBrowserImageAttachment(codexSessionId, {
          id: event.attachment.id,
          filename: event.attachment.fileName,
          source: event.attachment.source,
        });
        showBrowserStatus(
          getIntl().formatMessage({
            id: "browser.browserSidebarPanel.imageAdded",
            defaultMessage: "Browser image added to composer",
          }),
        );
        return;
      }
      if (event.action === "error") {
        showBrowserStatus(event.message);
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
        if (!result.ok) showBrowserStatus(result.message);
      });
    });
  }, [browserIdentity, browserRuntimeAvailable, codexSessionId, command]);

  useEffect(
    () =>
      window.api?.on("browser-annotation-cancel", (payload) => {
        const event = payload as BrowserSidebarTabIdentity;
        if (
          event.browserConversationId !== browserIdentity.browserConversationId ||
          event.browserViewScopeId !== browserIdentity.browserViewScopeId ||
          event.browserTabId !== browserIdentity.browserTabId
        )
          return;
        if (annotationAnchors.length) {
          setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
          return;
        }
        void command({ type: "set-interaction-mode", ...browserIdentity, mode: "browse" });
      }),
    [annotationAnchors.length, browserIdentity, command],
  );

  const [annotationUrl, setAnnotationUrl] = useState(snapshot.url);
  if (annotationUrl !== snapshot.url) {
    setAnnotationUrl(snapshot.url);
    setAnnotationDraft(navigateBrowserAnnotationDraft(annotationDraft, snapshot.url));
  }

  useEffect(() => {
    if (!commentMode) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat)
        return;
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
        deviceToolbarState: tabDeviceToolbarState,
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
    tabDeviceToolbarState,
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
    const unsubscribeOpenSurface = window.api?.on("browser-sidebar-open-surface", (payload) => {
      const request = payload as BrowserSidebarOpenSurfaceRequest;
      if (!matchesBrowserSidebarTabIdentity(request, browserIdentity)) return;
      handleOpenSurface(request);
    });
    return () => {
      unsubscribeState?.();
      unsubscribeLocalServers?.();
      unsubscribeBrowserUse?.();
      unsubscribeBrowserUseViewport?.();
      unsubscribeBrowserUseCursor?.();
      unsubscribeOpenSurface?.();
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

    let disposed = false;
    let animationFrame: number | null = null;
    const makeClaimInput = (presentation = readPresentation()): BrowserSidebarHostClaimInput => {
      const { isVisible: visible, themeVariant } = presentation;
      return {
        ...browserIdentity,
        browserStorageId,
        projectId: tab.projectId,
        hostKind: "panel",
        initialUrl: readInitialWebviewUrl(),
        title: tabTitle,
        faviconUrl: tabFaviconUrl,
        deviceToolbarVisible: tabDeviceToolbarVisible,
        deviceToolbarState: readDeviceToolbarState(),
        pagePersistence: browserPagePersistence,
        // The route effect above owns registration and snapshot installation for a panel.
        tabRegistration: "preestablished",
        presentation: {
          bounds: visible ? readWebviewHostBounds(container) : null,
          isVisible: visible,
          shouldPaint: visible,
        },
        themeVariant,
      };
    };
    const lease = browserSidebarRendererWebviewManager.claimHost(makeClaimInput());
    webviewHostLeaseRef.current = lease;
    const syncCurrentPresentation = (presentation?: {
      isVisible: boolean;
      themeVariant: BrowserSidebarThemeVariant;
    }) => {
      if (disposed) return;
      lease.update(makeClaimInput(presentation));
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
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleSyncBounds);
    resizeObserver?.observe(container);
    const unsubscribeBoundsSyncTrigger = boundsSyncTrigger?.on("change", scheduleSyncBounds);
    window.addEventListener("resize", scheduleSyncBounds);
    window.addEventListener("scroll", scheduleSyncBounds, true);
    scheduleSyncBounds();

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
      if (webviewHostLeaseRef.current === lease) webviewHostLeaseRef.current = null;
      lease.release();
    };
  }, [
    browserIdentity,
    browserIdentityKey,
    browserPagePersistence,
    browserStorageId,
    boundsSyncTrigger,
    browserRuntimeAvailable,
    downloadsOpen,
    profileImportOpen,
    registeredBrowserKey,
    shouldMountWebview,
    snapshot.failure,
    tab.projectId,
    tabDeviceToolbarVisible,
    tabFaviconUrl,
    tabTitle,
  ]);

  useLayoutEffect(() => {
    syncWebviewPresentationRef.current?.({ isVisible, themeVariant });
  }, [isVisible, themeVariant]);

  const [addressInput, setAddressInput] = useState({
    focused: addressFocused,
    showsNewTabPage,
    url: snapshot.url,
  });
  const addressFieldMoved = addressInput.showsNewTabPage !== showsNewTabPage;
  if (
    addressFieldMoved ||
    addressInput.focused !== addressFocused ||
    addressInput.url !== snapshot.url
  ) {
    const focused = addressFocused && !addressFieldMoved;
    setAddressInput({ focused, showsNewTabPage, url: snapshot.url });
    // Replacing the input can remove focus without a blur event.
    if (addressFieldMoved) setAddressFocused(false);
    // A New tab keeps its typed draft when focus leaves; a page's address shows its URL again.
    if (!focused && (!showsNewTabPage || addressInput.url !== snapshot.url)) {
      setAddressValue(readBrowserAddressValue(snapshot.url));
    }
  }

  useEffect(() => {
    if (tab.preview) return undefined;
    const title = resolveBrowserTabTitle(snapshot.url, snapshot.title);
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
    (url: string, originalUrl = url) => {
      if (!url) return;
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
        originalUrl,
      });
    },
    [browserIdentity, command],
  );

  const commitAddress = () => {
    if (!shouldCommitBrowserAddressEdit(snapshot.url, addressValue)) {
      setAddressValue(readBrowserAddressValue(snapshot.url));
      return;
    }
    navigateTo(normalizeBrowserAddressInput(addressValue), addressValue);
  };

  const acceptAddressSuggestion = (
    row: BrowserAddressSuggestion<BrowserAddressWorkspaceOption>,
  ) => {
    setAddressSuggestionsDismissed(true);
    if (row.kind !== "workspace") {
      commitAddress();
      return;
    }
    setAddressValue(readBrowserAddressValue(snapshot.url));
    row.candidate.onSelect();
  };

  const resetAddressSuggestions = () => {
    setAddressSuggestionsDismissed(false);
    setHighlightedAddressSuggestionId(null);
  };

  const addressFieldProps = {
    value: addressValue,
    focused: addressFocused,
    isCombobox: !shouldMountWebview,
    suggestions: {
      rows: addressRows,
      open: addressSuggestionsOpen,
      highlightedIndex: highlightedAddressIndex,
      onHighlight: setHighlightedAddressSuggestionId,
      onDismiss: () => setAddressSuggestionsDismissed(true),
      onSelect: acceptAddressSuggestion,
    },
    onChange: (value: string) => {
      setAddressValue(value);
      resetAddressSuggestions();
    },
    onFocusChange: (focused: boolean) => {
      if (focused) resetAddressSuggestions();
      setAddressFocused(focused);
    },
    onCommit: commitAddress,
    onReset: () => setAddressValue(readBrowserAddressValue(snapshot.url)),
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
    const result = await clearBrowserData(kind);
    if (result.ok) {
      const labels: Record<BrowserBrowsingDataKind, string> = {
        cookies: intl.formatMessage({
          id: "browser.browserSidebarPanel.cookiesCleared",
          defaultMessage: "Cookies cleared",
        }),
        cache: intl.formatMessage({
          id: "browser.browserSidebarPanel.cacheCleared",
          defaultMessage: "Cache cleared",
        }),
        "site-data": intl.formatMessage({
          id: "browser.browserSidebarPanel.siteDataCleared",
          defaultMessage: "Site data cleared",
        }),
        history: intl.formatMessage({
          id: "browser.browserSidebarPanel.historyCleared",
          defaultMessage: "Browser history cleared",
        }),
        downloads: intl.formatMessage({
          id: "browser.browserSidebarPanel.downloadHistoryCleared",
          defaultMessage: "Download history cleared",
        }),
      };
      showBrowserStatus(labels[kind]);
      return;
    }
    showBrowserStatus(
      result.message ??
        intl.formatMessage(
          {
            id: "browser.browserSidebarPanel.clearFailed",
            defaultMessage:
              "{kind, select, cookies {Failed to clear cookies} cache {Failed to clear cache} siteData {Failed to clear site-data} history {Failed to clear history} downloads {Failed to clear downloads} other {Failed to clear browsing data}}",
          },
          { kind: kind === "site-data" ? "siteData" : kind },
        ),
    );
  };

  const captureScreenshot = async () => {
    const result = await command({ type: "capture-screenshot", ...browserIdentity });
    if (result.ok) {
      showBrowserStatus(
        intl.formatMessage({
          id: "browser.browserSidebarPanel.screenshotCopied",
          defaultMessage: "Screenshot copied",
        }),
      );
      return;
    }
    showBrowserStatus(result.message);
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
    <div
      ref={panelRef}
      className="relative h-full min-h-0 overflow-hidden bg-token-main-surface-primary text-token-text-primary"
    >
      {!showsNewTabPage ? (
        <div
          ref={setChromeElement}
          className={cn(BROWSER_CHROME_CLASS, addressSuggestionsOpen && "z-30")}
        >
          <div className={BROWSER_CHROME_ROW_CLASS} data-viewer-density="compact">
            <ViewerControlGroup
              label={intl.formatMessage({
                id: "browser.browserSidebarPanel.navigation",
                defaultMessage: "Navigation",
              })}
              className="no-drag"
            >
              <BrowserToolbarButton
                label={intl.formatMessage({
                  id: "browser.browserSidebarPanel.back",
                  defaultMessage: "Back",
                })}
                disabled={!snapshot.canGoBack}
                onClick={() => {
                  void command({ type: "go-back", ...browserIdentity });
                }}
              >
                <BrowserBackIcon className="icon-sm" />
              </BrowserToolbarButton>
              <BrowserToolbarButton
                label={intl.formatMessage({
                  id: "browser.browserSidebarPanel.forward",
                  defaultMessage: "Forward",
                })}
                disabled={!snapshot.canGoForward}
                onClick={() => {
                  void command({ type: "go-forward", ...browserIdentity });
                }}
              >
                <BrowserBackIcon className="icon-sm rotate-180" />
              </BrowserToolbarButton>
              <ViewerControlDivider />
              <BrowserToolbarButton
                label={
                  snapshot.isLoading
                    ? intl.formatMessage({
                        id: "browser.browserSidebarPanel.stop",
                        defaultMessage: "Stop",
                      })
                    : intl.formatMessage({
                        id: "browser.browserSidebarPanel.reload",
                        defaultMessage: "Reload",
                      })
                }
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
            </ViewerControlGroup>
            <BrowserAddressField
              {...addressFieldProps}
              variant="toolbar"
              siteInfo={
                <BrowserSiteInfoMenu
                  url={snapshot.url}
                  siteInfo={siteInfo}
                  disabled={pageActionsDisabled}
                  onClearSiteData={() => clearBrowsingData("site-data")}
                  onResetPermissions={(origin) =>
                    void command({
                      type: "reset-site-permissions",
                      ...browserIdentity,
                      origin,
                    }).then(() => setSiteInfoRevision((revision) => revision + 1))
                  }
                />
              }
              openExternally={
                canOpenExternally ? (
                  <button
                    type="button"
                    data-browser-sidebar-open-external
                    data-browser-sidebar-skip-address-commit
                    className={cn(
                      "mr-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-token-text-tertiary transition-opacity",
                      pageActionsDisabled
                        ? "cursor-default opacity-0"
                        : "cursor-interaction opacity-0 hover:bg-token-foreground/5 hover:text-token-text-primary focus-visible:bg-token-foreground/5 group-hover/address-bar:opacity-100 group-focus-within/address-bar:opacity-100",
                    )}
                    disabled={pageActionsDisabled}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => void openExternally()}
                    aria-label={intl.formatMessage({
                      id: "browser.browserSidebarPanel.openExternally",
                      defaultMessage: "Open externally",
                    })}
                  >
                    <BrowserExternalIcon className="icon-xs" />
                  </button>
                ) : null
              }
              permission={{
                prompt: snapshot.permissionPrompts?.[0] ?? null,
                onRespond: respondToPermissionPrompt,
                onOpenSystemSettings: openPermissionSystemSettings,
              }}
            />
            {!pageActionsDisabled || activeDownloadCount > 0 ? (
              <ViewerControlGroup
                label={intl.formatMessage({
                  id: "browser.browserSidebarPanel.browserActions",
                  defaultMessage: "Browser actions",
                })}
                className="no-drag"
              >
                <div
                  className={cn(
                    BROWSER_COLLAPSIBLE_ACTION_CLASS,
                    pageActionsDisabled
                      ? "pointer-events-none max-w-0 opacity-0"
                      : "max-w-7 opacity-100",
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
                    label={intl.formatMessage({
                      id: "browser.browserSidebarPanel.captureScreenshot",
                      defaultMessage: "Capture screenshot",
                    })}
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
                        ? "max-w-[132px] opacity-100 translate-y-0"
                        : annotationCount > 0
                          ? "max-w-12 opacity-100 translate-y-0"
                          : "max-w-7 opacity-100 translate-y-0",
                  )}
                >
                  <BrowserToolbarButton
                    label={
                      annotationAgentControlled
                        ? intl.formatMessage({
                            id: "browser.browserSidebarPanel.agentControlsPage",
                            defaultMessage:
                              "The Agent controls this page. Annotating resumes when control ends",
                          })
                        : commentMode
                          ? intl.formatMessage({
                              id: "browser.browserSidebarPanel.exitComment",
                              defaultMessage: "Exit comment mode",
                            })
                          : annotationDestination
                            ? intl.formatMessage({
                                id: "browser.browserSidebarPanel.annotate",
                                defaultMessage: "Annotate",
                              })
                            : intl.formatMessage({
                                id: "browser.browserSidebarPanel.annotateNeedsChat",
                                defaultMessage: "Open a chat or Agent Dock to annotate",
                              })
                    }
                    disabled={
                      pageActionsDisabled || !annotationDestination || annotationAgentControlled
                    }
                    active={commentMode}
                    className={cn((commentMode || annotationCount > 0) && "aspect-auto !px-2")}
                    onClick={() => {
                      void command({
                        type: "set-interaction-mode",
                        ...browserIdentity,
                        mode: commentMode ? "browse" : "comment",
                      }).then((result) => {
                        if (result.ok) return;
                        showBrowserStatus(
                          result.message ??
                            intl.formatMessage({
                              id: "browser.browserSidebarPanel.commentUnavailable",
                              defaultMessage: "Comment mode is unavailable for this site.",
                            }),
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
                      {intl.formatMessage({
                        id: "browser.browserSidebarPanel.annotating",
                        defaultMessage: "Annotating",
                      })}
                    </span>
                    {annotationCount > 0 ? (
                      <span className="shrink-0 text-xs tabular-nums text-token-text-secondary">
                        {intl.formatNumber(annotationCount)}
                      </span>
                    ) : null}
                  </BrowserToolbarButton>
                </div>
                {annotationCount > 0 ? (
                  <>
                    <BrowserToolbarButton
                      label={intl.formatMessage(
                        {
                          id: "browser.browserSidebarPanel.sendAnnotations",
                          defaultMessage:
                            "{count, plural, one {Send annotation to chat} other {Send # annotations to chat}}",
                        },
                        { count: annotationCount },
                      )}
                      disabled={annotationSending}
                      onClick={() => {
                        if (submittingAnnotationRef.current) return;
                        submittingAnnotationRef.current = true;
                        setAnnotationSending(true);
                        void sendSavedAnnotations(
                          (snapshot.annotations ?? []).map((annotation) => annotation.id),
                        )
                          .catch((error: unknown) =>
                            showBrowserStatus(
                              error instanceof Error
                                ? error.message
                                : intl.formatMessage({
                                    id: "browser.browserSidebarPanel.sendAnnotationsFailed",
                                    defaultMessage: "Could not send annotations",
                                  }),
                            ),
                          )
                          .finally(() => {
                            submittingAnnotationRef.current = false;
                            setAnnotationSending(false);
                          });
                      }}
                    >
                      <SendToChatIcon className="icon-sm" />
                    </BrowserToolbarButton>
                    <BrowserToolbarButton
                      label={
                        snapshot.annotationPinsVisible === false
                          ? intl.formatMessage({
                              id: "browser.browserSidebarPanel.showPins",
                              defaultMessage: "Show annotation pins",
                            })
                          : intl.formatMessage({
                              id: "browser.browserSidebarPanel.hidePins",
                              defaultMessage: "Hide annotation pins",
                            })
                      }
                      onClick={() => {
                        void command({
                          type: "set-annotation-presentation",
                          ...browserIdentity,
                          pinsVisible: snapshot.annotationPinsVisible === false,
                        });
                      }}
                    >
                      {snapshot.annotationPinsVisible === false ? (
                        <VisibilityOffIcon className="icon-sm" />
                      ) : (
                        <VisibilityIcon className="icon-sm" />
                      )}
                    </BrowserToolbarButton>
                  </>
                ) : null}
                {annotationCount > 0 ? (
                  <BrowserAnnotationDiscardAction
                    count={annotationCount}
                    onDiscard={() => {
                      void command({
                        type: "remove-annotations",
                        ...browserIdentity,
                        ids: (snapshot.annotations ?? []).map((annotation) => annotation.id),
                      })
                        .then((result) => {
                          if (!result.ok) showBrowserStatus(result.message);
                        })
                        .catch((error: unknown) =>
                          showBrowserStatus(
                            error instanceof Error
                              ? error.message
                              : intl.formatMessage({
                                  id: "browser.browserSidebarPanel.discardAnnotationsFailed",
                                  defaultMessage: "Could not discard annotations",
                                }),
                          ),
                        );
                    }}
                  />
                ) : null}
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
              </ViewerControlGroup>
            ) : null}
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
          {credentialCandidate && chromeElement && isVisible ? (
            <BrowserCredentialSavePrompt
              anchor={chromeElement}
              candidate={credentialCandidate}
              onDismiss={() => void actOnCredentialCandidate("dismiss")}
              onSave={() => void actOnCredentialCandidate("save")}
            />
          ) : null}
        </div>
      ) : null}

      <div
        className="relative min-h-0 overflow-hidden bg-token-main-surface-primary"
        style={{
          height: `calc(100% - ${showsNewTabPage ? "" : "var(--height-toolbar-pane) - "}${RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE})`,
          scrollPaddingBottom: RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE,
        }}
      >
        {downloadsOpen ? (
          <BrowserDownloadsPage
            snapshot={downloadsSnapshot}
            onClose={() => setDownloadsOpen(false)}
            onAction={async (downloadId, action) => {
              const result = await runBrowserDownloadAction({
                downloadId,
                action,
              });
              if (!result.ok) showBrowserStatus(result.message);
            }}
            onClearHistory={async () => {
              const result = await clearBrowserDownloadHistory();
              if (!result.ok) showBrowserStatus(result.message);
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
        ) : showsNewTabPage ? (
          <BrowserNewTabSurface
            renderNewTabPage={renderNewTabPage}
            search={<BrowserAddressField {...addressFieldProps} variant="new-tab" />}
          >
            <BrowserLocalServersSection
              projectId={tab.projectId}
              localServers={localServers}
              preferences={localServerPreferences}
              onPreferencesChange={(update) => {
                void updateLocalServerPreferences(update).catch((error) => {
                  showBrowserStatus(
                    error instanceof Error
                      ? error.message
                      : intl.formatMessage({
                          id: "browser.browserSidebarPanel.saveServerPreferencesFailed",
                          defaultMessage: "Could not save local server preferences",
                        }),
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
                return await readBrowserLocalServerThumbnail({
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
            />
          </BrowserNewTabSurface>
        ) : (
          <BrowserWebviewStage
            activeSessionId={browserConversationId}
            tabId={tab.id}
            deviceToolbarVisible={snapshot.deviceToolbarVisible}
            viewport={snapshot.viewport}
            browserIdentity={browserIdentity}
            webviewHostRef={webviewHostRef}
            onViewportChange={updateViewport}
            onCloseDeviceToolbar={toggleDeviceToolbar}
          >
            {commentMode && !snapshot.annotationSuspended && !annotationAgentControlled ? (
              <BrowserCommentOverlay identity={browserIdentity}>
                <BrowserAnnotationEditorPlacement
                  identity={browserIdentity}
                  anchor={annotationAnchors[0]}
                >
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
                    editing={editingAnnotationId !== undefined}
                    onRemove={() => {
                      if (!editingAnnotationId) return;
                      void command({
                        type: "remove-annotations",
                        ...browserIdentity,
                        ids: [editingAnnotationId],
                      })
                        .then((result) => {
                          if (!result.ok) {
                            showBrowserStatus(result.message);
                            return;
                          }
                          setEditingAnnotationId(undefined);
                          setAnnotationDraft((current) => resetBrowserAnnotationDraft(current));
                        })
                        .catch((error: unknown) =>
                          showBrowserStatus(
                            error instanceof Error
                              ? error.message
                              : intl.formatMessage({
                                  id: "browser.browserSidebarPanel.removeAnnotationFailed",
                                  defaultMessage: "Could not remove annotation",
                                }),
                          ),
                        );
                    }}
                    flow={annotationFlow}
                    pending={annotationSending}
                    onSubmit={(action) => {
                      void submitBrowserAnnotation(action);
                    }}
                  />
                </BrowserAnnotationEditorPlacement>
              </BrowserCommentOverlay>
            ) : null}
            <BrowserUseCursorPortal
              cursor={cursor}
              fallbackViewportSize={browserUseViewportSize}
              identity={browserIdentity}
              isVisible={isVisible && activeBrowserUseTab !== null}
              onArrived={handleBrowserUseCursorArrived}
            />
            <BrowserPageDialogOverlay
              identity={browserIdentity}
              dialog={snapshot.pageDialog ?? null}
              onRespond={respondToPageDialog}
            />
          </BrowserWebviewStage>
        )}
      </div>
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
      <ViewerButton
        uniform
        variant={active ? "selected" : "default"}
        className={className}
        disabled={disabled}
        aria-label={label}
        onClick={onClick}
      >
        {children}
      </ViewerButton>
    </NodexTooltip>
  );
}

function BrowserSiteInfoMenu({
  url,
  siteInfo,
  disabled,
  onClearSiteData,
  onResetPermissions,
}: {
  url: string;
  siteInfo: BrowserSiteInfo | null;
  disabled: boolean;
  onClearSiteData: () => void;
  onResetPermissions: (origin: string) => void;
}) {
  const intl = useIntl();
  const fallbackOrigin = readBrowserOriginLabel(url, intl);
  const origin = siteInfo?.origin ?? fallbackOrigin;
  const secure = siteInfo?.connection === "secure";
  const connectionLabel = siteInfo?.connection
    ? browserConnectionLabel(siteInfo.connection, intl)
    : intl.formatMessage({
        id: "browser.browserSidebarPanel.checkingConnection",
        defaultMessage: "Checking connection…",
      });
  const decided = siteInfo?.permissions?.filter((permission) => permission.state !== "ask") ?? [];
  const siteOrigin = siteInfo?.origin ?? null;
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="menuWide"
      triggerButton={
        <button
          type="button"
          data-browser-sidebar-skip-address-commit
          className="inline-flex size-7 items-center justify-center rounded-full text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-text-primary disabled:pointer-events-none disabled:opacity-0"
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.siteInformation",
            defaultMessage: "Site information",
          })}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
        >
          {secure ? <LockKeyhole className="icon-xs" /> : <InfoIcon className="icon-xs" />}
        </button>
      }
    >
      <div className="px-[var(--padding-row-x)] py-2">
        <div className="truncate text-sm font-medium text-token-text-primary">{origin}</div>
        <div className="mt-1 text-xs text-token-text-secondary">
          {connectionLabel}
          {siteInfo
            ? intl.formatMessage(
                {
                  id: "browser.browserSidebarPanel.cookieCount",
                  defaultMessage: "{count, plural, one { · # cookie} other { · # cookies}}",
                },
                { count: siteInfo.cookieCount },
              )
            : null}
        </div>
      </div>
      {decided.length > 0 ? (
        <>
          <NodexDropdownSeparator />
          <div className="flex flex-col gap-1 px-[var(--padding-row-x)] py-2">
            {decided.map(({ permission, state }) => (
              <div key={permission} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-token-text-primary">
                  {permissionShortLabel(permission, intl)}
                </span>
                <span className="shrink-0 text-token-text-secondary">
                  {state === "allow"
                    ? intl.formatMessage({
                        id: "browser.browserSidebarPanel.permissionAllowed",
                        defaultMessage: "Allowed",
                      })
                    : intl.formatMessage({
                        id: "browser.browserSidebarPanel.permissionBlocked",
                        defaultMessage: "Blocked",
                      })}
                </span>
              </div>
            ))}
          </div>
          {siteOrigin ? (
            <NodexDropdownItem onSelect={() => onResetPermissions(siteOrigin)}>
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.resetPermissions",
                defaultMessage: "Reset permissions",
              })}
            </NodexDropdownItem>
          ) : null}
        </>
      ) : null}
      <NodexDropdownSeparator />
      <NodexDropdownItem onSelect={onClearSiteData}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearBuiltInSiteData",
          defaultMessage: "Clear built-in Browser site data",
        })}
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

function readBrowserOriginLabel(url: string, intl: IntlShape): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === "null" ? parsed.href : parsed.origin;
  } catch {
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.newTab",
      defaultMessage: "New tab",
    });
  }
}

function browserConnectionLabel(
  connection: BrowserSiteInfo["connection"],
  intl: IntlShape,
): string {
  if (connection === "secure")
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.secureConnection",
      defaultMessage: "Connection is secure",
    });
  if (connection === "local")
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.localConnection",
      defaultMessage: "Local connection",
    });
  if (connection === "insecure")
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.insecureConnection",
      defaultMessage: "Connection is not secure",
    });
  return intl.formatMessage({
    id: "browser.browserSidebarPanel.noConnection",
    defaultMessage: "No site connection",
  });
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
  const intl = useIntl();
  const [credentials, setCredentials] = useState<BrowserCredentialSummary[]>([]);
  const [contacts, setContacts] = useState<BrowserContactInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (!open || disabled) return;
    void Promise.all([readBrowserCredentials(identity), readBrowserContactInfo()])
      .then(([nextCredentials, nextContacts]) => {
        setCredentials(nextCredentials);
        setContacts(nextContacts);
        setMessage(null);
      })
      .catch((error: unknown) => {
        setCredentials([]);
        setContacts([]);
        setMessage(
          error instanceof Error
            ? error.message
            : getIntl().formatMessage({
                id: "browser.browserSidebarPanel.passwordsUnavailable",
                defaultMessage: "Passwords unavailable",
              }),
        );
      });
  }, [disabled, open, identity]);

  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="panel"
      disabled={disabled}
      open={open}
      onOpenChange={setOpen}
      triggerButton={
        <ViewerButton
          uniform
          data-browser-sidebar-skip-address-commit
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.passwordsAndAutofill",
            defaultMessage: "Passwords and autofill",
          })}
        >
          <KeyRound className="icon-sm" />
        </ViewerButton>
      }
    >
      <div className="px-[var(--padding-row-x)] py-2">
        <div className="text-sm font-medium text-token-text-primary">
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.passwordsAndAutofill",
            defaultMessage: "Passwords and autofill",
          })}
        </div>
        <div className="mt-1 text-xs text-token-text-secondary">
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.fillCurrentSiteOnly",
            defaultMessage: "Fill only into the current site.",
          })}
        </div>
      </div>
      <NodexDropdownSeparator />
      {credentials.length === 0 ? (
        <div className="px-[var(--padding-row-x)] py-2 text-xs text-token-text-secondary">
          {message ??
            intl.formatMessage({
              id: "browser.browserSidebarPanel.noSavedSitePassword",
              defaultMessage: "No saved password for this site.",
            })}
        </div>
      ) : (
        credentials.map((credential) => (
          <NodexDropdownItem
            key={credential.id}
            leftSlot={<KeyRound className="icon-xs" />}
            onSelect={() => {
              void fillBrowserCredential({
                ...identity,
                credentialId: credential.id,
              }).then((result) => {
                if (!result.ok)
                  setMessage(
                    result.message ??
                      intl.formatMessage({
                        id: "browser.browserSidebarPanel.fillPasswordFailed",
                        defaultMessage: "Unable to fill password",
                      }),
                  );
              });
            }}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{credential.label}</span>
              <span className="truncate text-xs text-token-text-secondary">
                {credential.username ||
                  intl.formatMessage({
                    id: "browser.browserSidebarPanel.noUsername",
                    defaultMessage: "No username",
                  })}
              </span>
            </span>
          </NodexDropdownItem>
        ))
      )}
      <NodexDropdownItem
        leftSlot={<KeyRound className="icon-xs" />}
        onSelect={() => {
          void generateAndFillBrowserCredential(identity).then((result) => {
            if (!result.ok)
              setMessage(
                result.message ??
                  intl.formatMessage({
                    id: "browser.browserSidebarPanel.generatePasswordFailed",
                    defaultMessage: "Unable to generate password",
                  }),
              );
          });
        }}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.generatePassword",
          defaultMessage: "Generate strong password",
        })}
      </NodexDropdownItem>
      {contacts.length > 0 ? <NodexDropdownSeparator /> : null}
      {contacts.map((contact) => (
        <NodexDropdownItem
          key={contact.id}
          leftSlot={<ContactRound className="icon-xs" />}
          onSelect={() => {
            void fillBrowserContactInfo({
              ...identity,
              contactInfoId: contact.id,
            }).then((result) => {
              if (!result.ok)
                setMessage(
                  result.message ??
                    intl.formatMessage({
                      id: "browser.browserSidebarPanel.fillContactFailed",
                      defaultMessage: "Unable to fill contact info",
                    }),
                );
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
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.managePasswords",
          defaultMessage: "Manage passwords",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ContactRound className="icon-xs" />}
        onSelect={onOpenContactInfo}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.contactInfo",
          defaultMessage: "Contact info",
        })}
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

/** Hangs below the Browser toolbar, over the page, until the offer is answered or expires. */
function BrowserCredentialSavePrompt({
  anchor,
  candidate,
  onDismiss,
  onSave,
}: {
  anchor: HTMLElement | null;
  candidate: BrowserCredentialSaveCandidate;
  onDismiss: () => void;
  onSave: () => void;
}) {
  const intl = useIntl();
  return (
    <NodexPopover
      open
      onOpenChange={(open, details) => {
        if (!open && details.reason === "escape") onDismiss();
      }}
    >
      <NodexPopoverContent
        anchor={anchor}
        side="bottom"
        align="end"
        sideOffset={6}
        alignOffset={8}
        // The offer arrives while the person is using the page; it must not take their focus.
        initialFocus={false}
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.savePassword",
          defaultMessage: "Save password",
        })}
        className="w-[300px] p-3"
      >
        <div className="flex items-start gap-2">
          <KeyRound className="mt-0.5 size-4 shrink-0 text-token-text-secondary" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-token-text-primary">
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.confirmSavePassword",
                defaultMessage: "Save password?",
              })}
            </div>
            <div className="mt-1 truncate text-xs text-token-text-secondary">
              {candidate.username ||
                intl.formatMessage({
                  id: "browser.browserSidebarPanel.noUsername",
                  defaultMessage: "No username",
                })}{" "}
              · {candidate.origin}
            </div>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-token-text-secondary hover:bg-token-list-hover-background"
            onClick={onDismiss}
          >
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.notNow",
              defaultMessage: "Not now",
            })}
          </button>
          <button
            type="button"
            className="rounded-lg bg-token-foreground px-3 py-1.5 text-sm text-token-background hover:opacity-90"
            onClick={onSave}
          >
            {intl.formatMessage({ id: "browser.browserSidebarPanel.save", defaultMessage: "Save" })}
          </button>
        </div>
      </NodexPopoverContent>
    </NodexPopover>
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
  const intl = useIntl();
  const zoomOptions = resolveBrowserZoomOptions(snapshot.zoomPercent);
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menuWide"
      triggerButton={
        <ViewerButton
          uniform
          data-browser-sidebar-skip-address-commit
          className="size-8"
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.browserOptions",
            defaultMessage: "Browser options",
          })}
        >
          <BrowserMoreIcon className="icon-sm" />
        </ViewerButton>
      }
    >
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<BrowserReloadIcon className="icon-xs" />}
        onSelect={onHardReload}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.forceReload",
          defaultMessage: "Force reload",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<Smartphone className="icon-xs" />}
        onSelect={onToggleDeviceToolbar}
      >
        {snapshot.deviceToolbarVisible
          ? intl.formatMessage({
              id: "browser.browserSidebarPanel.hideDeviceToolbar",
              defaultMessage: "Hide device toolbar",
            })
          : intl.formatMessage({
              id: "browser.browserSidebarPanel.showDeviceToolbar",
              defaultMessage: "Show device toolbar",
            })}
      </NodexDropdownItem>
      <NodexDropdownItem
        disabled={disabled}
        leftSlot={<Printer className="icon-xs" />}
        onSelect={onPrint}
      >
        {intl.formatMessage({ id: "browser.browserSidebarPanel.print", defaultMessage: "Print" })}
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <div
        data-browser-sidebar-skip-address-commit
        className={cn(
          "flex items-center gap-1 rounded-lg px-[var(--padding-row-x)] py-1 text-sm text-token-foreground",
          disabled && "cursor-default opacity-50",
        )}
      >
        <span className="min-w-0 flex-1 truncate text-token-description-foreground">
          {intl.formatMessage({ id: "browser.browserSidebarPanel.zoom", defaultMessage: "Zoom" })}
        </span>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={() => onStepZoom(-25)}
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.zoomOut",
            defaultMessage: "Zoom out",
          })}
        >
          <Minus className="icon-xs" />
        </button>
        <select
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.zoomPercent",
            defaultMessage: "Zoom percent",
          })}
          disabled={disabled}
          className="h-6 min-w-16 rounded-md border border-token-border bg-token-foreground/5 px-1 text-center text-xs tabular-nums outline-none hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          value={snapshot.zoomPercent}
          onChange={(event) => onSetZoom(Number.parseInt(event.target.value, 10))}
        >
          {zoomOptions.map((zoom) => (
            <option key={zoom} value={zoom}>
              {intl.formatNumber(zoom / 100, { style: "percent" })}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={() => onStepZoom(25)}
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.zoomIn",
            defaultMessage: "Zoom in",
          })}
        >
          <PlusIcon className="icon-xs" />
        </button>
        <button
          type="button"
          disabled={disabled || snapshot.zoomPercent === 100}
          className="inline-flex size-6 items-center justify-center rounded-md hover:bg-token-list-hover-background disabled:cursor-default disabled:opacity-40"
          onClick={onResetZoom}
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.resetZoom",
            defaultMessage: "Reset zoom",
          })}
        >
          <ResetIcon className="icon-xs" />
        </button>
      </div>
      <NodexDropdownSeparator />
      <NodexDropdownItem leftSlot={<DownloadIcon className="icon-xs" />} onSelect={onOpenDownloads}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.downloads",
          defaultMessage: "Downloads",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<DownloadIcon className="icon-xs" />}
        onSelect={onOpenProfileImport}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.importBrowserData",
          defaultMessage: "Import browser data",
        })}
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        leftSlot={<KeyRound className="icon-xs" />}
        onSelect={() => onOpenSettings("passwords")}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.passwords",
          defaultMessage: "Passwords",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ContactRound className="icon-xs" />}
        onSelect={() => onOpenSettings("contact-info")}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.contactInfo",
          defaultMessage: "Contact info",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<HistoryIcon className="icon-xs" />}
        onSelect={() => onOpenSettings("history")}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.history",
          defaultMessage: "History",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<Puzzle className="icon-xs" />}
        onSelect={() => onOpenSettings("extensions")}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.extensions",
          defaultMessage: "Extensions",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<SettingsGeneralIcon className="icon-xs" />}
        onSelect={() => onOpenSettings("browser")}
      >
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.browserSettings",
          defaultMessage: "Browser settings",
        })}
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem disabled={disabled} onSelect={() => onClearBrowsingData("cookies")}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearCookies",
          defaultMessage: "Clear cookies",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem disabled={disabled} onSelect={() => onClearBrowsingData("cache")}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearCache",
          defaultMessage: "Clear cache",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("site-data")}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearSiteData",
          defaultMessage: "Clear site data",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("history")}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearHistory",
          defaultMessage: "Clear history",
        })}
      </NodexDropdownItem>
      <NodexDropdownItem onSelect={() => onClearBrowsingData("downloads")}>
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.clearDownloadHistory",
          defaultMessage: "Clear download history",
        })}
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
  const intl = useIntl();
  const content = browserFailureContent(failure, intl);
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
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.goBack",
              defaultMessage: "Go back",
            })}
          </button>
          <button
            type="button"
            className="rounded-lg bg-token-foreground px-3 py-1.5 text-sm font-medium text-token-background hover:opacity-90"
            onClick={onRetry}
          >
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.retry",
              defaultMessage: "Try again",
            })}
          </button>
        </div>
        <div className="mt-5 truncate font-mono text-[11px] text-token-text-tertiary">
          {failure.failedUrl}
        </div>
      </div>
    </section>
  );
}

function browserFailureContent(
  failure: BrowserPageFailure,
  intl: IntlShape = getIntl(),
): {
  title: string;
  description: string;
} {
  if (failure.kind === "dns") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.dnsError",
        defaultMessage: "This site can’t be reached",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.dnsDescription",
        defaultMessage: "Check the address for typing errors, then try again.",
      }),
    };
  }
  if (failure.kind === "offline") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.offlineError",
        defaultMessage: "You’re offline",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.offlineDescription",
        defaultMessage: "Reconnect to the internet and try loading this page again.",
      }),
    };
  }
  if (failure.kind === "refused") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.refusedError",
        defaultMessage: "The connection was refused",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.refusedDescription",
        defaultMessage: "The site or local server is not accepting connections.",
      }),
    };
  }
  if (failure.kind === "timeout") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.timeoutError",
        defaultMessage: "The site took too long to respond",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.timeoutDescription",
        defaultMessage: "The server may be unavailable or your connection may be slow.",
      }),
    };
  }
  if (failure.kind === "certificate") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.certificateError",
        defaultMessage: "Your connection isn’t private",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.certificateDescription",
        defaultMessage: "Nodex stopped this page because its certificate could not be verified.",
      }),
    };
  }
  if (failure.kind === "blocked") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.blockedError",
        defaultMessage: "Navigation blocked",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.blockedDescription",
        defaultMessage: "A Browser security or organization policy blocked this page.",
      }),
    };
  }
  if (failure.kind === "crashed") {
    return {
      title: intl.formatMessage({
        id: "browser.browserSidebarPanel.crashedError",
        defaultMessage: "This page stopped working",
      }),
      description: intl.formatMessage({
        id: "browser.browserSidebarPanel.crashedDescription",
        defaultMessage: "Reload the page to start it in a fresh Browser process.",
      }),
    };
  }
  return {
    title: intl.formatMessage({
      id: "browser.browserSidebarPanel.loadError",
      defaultMessage: "This page couldn’t be loaded",
    }),
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
  const intl = useIntl();
  return (
    <section className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-token-border px-4">
        <DownloadIcon className="icon-sm text-token-text-tertiary" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-token-text-primary">
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.downloads",
            defaultMessage: "Downloads",
          })}
        </h2>
        <button
          type="button"
          className="rounded-md px-2 py-1 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          disabled={snapshot.downloads.length === 0}
          onClick={() => void onClearHistory()}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.clearHistory",
            defaultMessage: "Clear history",
          })}
        </button>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary"
          aria-label={intl.formatMessage({
            id: "browser.browserSidebarPanel.closeDownloads",
            defaultMessage: "Close downloads",
          })}
          onClick={onClose}
        >
          <CloseIcon className="icon-sm" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {snapshot.downloads.length === 0 ? (
          <div className="grid h-full place-items-center px-6 text-center text-sm text-token-text-secondary">
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.noDownloads",
              defaultMessage: "Downloaded files will appear here.",
            })}
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
  const intl = useIntl();
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
          <span className="shrink-0">{formatDownloadProgress(download, intl)}</span>
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
              label={
                download.status === "paused"
                  ? intl.formatMessage({
                      id: "browser.browserSidebarPanel.resume",
                      defaultMessage: "Resume",
                    })
                  : intl.formatMessage({
                      id: "browser.browserSidebarPanel.pause",
                      defaultMessage: "Pause",
                    })
              }
              onClick={() => action(download.status === "paused" ? "resume" : "pause")}
            >
              {download.status === "paused" ? (
                <PlayIcon className="icon-xs" />
              ) : (
                <PauseIcon className="icon-xs" />
              )}
            </BrowserDownloadActionButton>
            <BrowserDownloadActionButton
              label={intl.formatMessage({
                id: "browser.browserSidebarPanel.cancel",
                defaultMessage: "Cancel",
              })}
              onClick={() => action("cancel")}
            >
              <CloseIcon className="icon-xs" />
            </BrowserDownloadActionButton>
          </>
        ) : (
          <>
            {download.status === "completed" ? (
              <>
                <BrowserDownloadActionButton
                  label={intl.formatMessage({
                    id: "browser.browserSidebarPanel.open",
                    defaultMessage: "Open",
                  })}
                  onClick={() => action("open")}
                >
                  <OpenInIcon className="icon-xs" />
                </BrowserDownloadActionButton>
                <BrowserDownloadActionButton
                  label={intl.formatMessage({
                    id: "browser.browserSidebarPanel.showInFolder",
                    defaultMessage: "Show in folder",
                  })}
                  onClick={() => action("show-in-folder")}
                >
                  <FolderOpenIcon className="icon-xs" />
                </BrowserDownloadActionButton>
              </>
            ) : null}
            <BrowserDownloadActionButton
              label={intl.formatMessage({
                id: "browser.browserSidebarPanel.removeFromHistory",
                defaultMessage: "Remove from history",
              })}
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

function formatDownloadProgress(
  download: BrowserDownloadRecord,
  intl: IntlShape = getIntl(),
): string {
  if (download.status === "completed") return formatBytes(download.totalBytes, intl);
  if (download.status === "cancelled")
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.downloadCancelled",
      defaultMessage: "Cancelled",
    });
  if (download.status === "interrupted")
    return intl.formatMessage({
      id: "browser.browserSidebarPanel.downloadInterrupted",
      defaultMessage: "Interrupted",
    });
  if (download.status === "paused")
    return intl.formatMessage(
      { id: "browser.browserSidebarPanel.downloadPaused", defaultMessage: "Paused · {received}" },
      { received: formatBytes(download.receivedBytes, intl) },
    );
  if (download.totalBytes <= 0) return formatBytes(download.receivedBytes, intl);
  return intl.formatMessage(
    { id: "browser.browserSidebarPanel.downloadProgress", defaultMessage: "{received} of {total}" },
    {
      received: formatBytes(download.receivedBytes, intl),
      total: formatBytes(download.totalBytes, intl),
    },
  );
}

function formatBytes(value: number, intl: IntlShape = getIntl()): string {
  const format = (amount: number, digits: number) =>
    intl.formatNumber(amount, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      useGrouping: false,
    });
  if (value < 1_024) return `${format(value, 0)} B`;
  if (value < 1_048_576) return `${format(value / 1_024, 1)} KB`;
  if (value < 1_073_741_824) {
    return `${format(value / 1_048_576, 1)} MB`;
  }
  return `${format(value / 1_073_741_824, 1)} GB`;
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
  const intl = useIntl();
  const selectedPreset =
    BROWSER_SIDEBAR_DEVICE_PRESETS.find((preset) => preset.id === viewport.presetId) ??
    BROWSER_SIDEBAR_DEVICE_PRESETS[0];
  const zoomOptions = resolveBrowserZoomOptions(viewport.zoomPercent);
  const presetLabel = (preset: (typeof BROWSER_SIDEBAR_DEVICE_PRESETS)[number]) => {
    const descriptor = BROWSER_SIDEBAR_DEVICE_LABEL_MESSAGES[preset.id];
    return descriptor ? intl.formatMessage(descriptor) : preset.label;
  };

  return (
    <div className="absolute inset-x-0 top-0 z-30 flex h-[34px] items-center gap-2 border-b border-token-border bg-token-bg-secondary px-2.5 text-sm text-token-foreground">
      <NodexDropdownMenu
        align="start"
        contentWidth="menuWide"
        triggerButton={
          <NodexDropdownButtonTrigger
            size="xs"
            chrome="transparent"
            className="h-6 min-w-[138px] justify-between rounded-lg text-token-foreground"
          >
            {presetLabel(selectedPreset)}
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
            {presetLabel(preset)}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
      <DimensionInput
        label={intl.formatMessage({
          id: "browser.browserSidebarPanel.width",
          defaultMessage: "Width",
        })}
        value={viewport.width}
        placeholder={intl.formatMessage({
          id: "browser.browserSidebarPanel.auto",
          defaultMessage: "auto",
        })}
        onChange={(width) =>
          onViewportChange(updateBrowserViewportDimension(viewport, "width", width))
        }
      />
      <span className="text-token-description-foreground">x</span>
      <DimensionInput
        label={intl.formatMessage({
          id: "browser.browserSidebarPanel.height",
          defaultMessage: "Height",
        })}
        value={viewport.height}
        placeholder={intl.formatMessage({
          id: "browser.browserSidebarPanel.auto",
          defaultMessage: "auto",
        })}
        onChange={(height) =>
          onViewportChange(updateBrowserViewportDimension(viewport, "height", height))
        }
      />
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.rotate",
          defaultMessage: "Rotate",
        })}
        onClick={() => onViewportChange(rotateBrowserViewport(viewport))}
      >
        <RotateCcw className="icon-xs" />
      </button>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.responsive",
          defaultMessage: "Responsive",
        })}
        onClick={() =>
          onViewportChange({ width: 0, height: 0, zoomPercent: 100, presetId: "responsive" })
        }
      >
        <Maximize2 className="icon-xs" />
      </button>
      <select
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.viewportZoom",
          defaultMessage: "Viewport zoom",
        })}
        className="ml-auto h-6 rounded-lg border border-transparent bg-token-foreground/5 px-2 text-center text-xs font-semibold text-token-foreground tabular-nums outline-none hover:bg-token-list-hover-background focus:border-token-focus-border focus:bg-token-bg-primary"
        value={viewport.zoomPercent}
        onChange={(event) =>
          onViewportChange({ ...viewport, zoomPercent: Number.parseInt(event.target.value, 10) })
        }
      >
        {zoomOptions.map((zoom) => (
          <option key={zoom} value={zoom}>
            {intl.formatNumber(zoom / 100, { style: "percent" })}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="inline-flex size-6 items-center justify-center rounded-lg hover:bg-token-list-hover-background"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.closeToolbar",
          defaultMessage: "Close device toolbar",
        })}
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
  browserIdentity,
  webviewHostRef,
  onViewportChange,
  onCloseDeviceToolbar,
  children,
}: {
  activeSessionId: string;
  tabId: string;
  browserIdentity: BrowserSidebarTabIdentity;
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
                <BrowserPageOverlay identity={browserIdentity}>
                  <BrowserViewportResizeHandles
                    viewport={viewport}
                    onViewportChange={onViewportChange}
                  />
                </BrowserPageOverlay>
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
  const intl = useIntl();
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
        className="pointer-events-auto absolute inset-y-8 left-0 w-1 cursor-ew-resize opacity-0 focus-visible:opacity-100"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.narrowViewport",
          defaultMessage: "Narrow viewport",
        })}
        onPointerDown={beginDrag("width", -1)}
        onKeyDown={onResizeKeyDown("width", -1)}
      />
      <button
        type="button"
        className="pointer-events-auto absolute inset-y-8 right-0 w-1 cursor-ew-resize opacity-0 focus-visible:opacity-100"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.widenViewport",
          defaultMessage: "Widen viewport",
        })}
        onPointerDown={beginDrag("width", 1)}
        onKeyDown={onResizeKeyDown("width", 1)}
      />
      <button
        type="button"
        className="pointer-events-auto absolute inset-x-8 bottom-0 h-1 cursor-ns-resize opacity-0 focus-visible:opacity-100"
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.tallerViewport",
          defaultMessage: "Taller viewport",
        })}
        onPointerDown={beginDrag("height", 1)}
        onKeyDown={onResizeKeyDown("height", 1)}
      />
    </>
  );
}

export interface BrowserNewTabSections {
  /** The New tab search field, displayed first in the page column. */
  readonly search: ReactNode;
  /** Local development servers found for the tab's Project, or null when there are none. */
  readonly localServers: ReactNode;
}

function BrowserNewTabSurface({
  renderNewTabPage,
  search,
  children,
}: {
  readonly renderNewTabPage?: (sections: BrowserNewTabSections) => ReactNode;
  readonly search: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="absolute inset-0 z-10 bg-token-main-surface-primary">
      {renderNewTabPage ? (
        renderNewTabPage({ search, localServers: children })
      ) : (
        <div className="@container h-full overflow-y-auto px-panel py-8 select-none">
          <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
            {search}
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

const LOCAL_SERVER_ICON_BUTTON_CLASS =
  "inline-flex size-7 items-center justify-center rounded-lg text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-text-primary";

/** The New tab's suggested sites: local servers running for the tab's Project. */
export function BrowserLocalServersSection({
  projectId,
  localServers,
  preferences,
  onPreferencesChange,
  onRefresh,
  onOpen,
  onRequestThumbnail,
  onHideServer,
  onUnhideServer,
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
}) {
  const intl = useIntl();
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
  const hiddenMode = settings.showMode === "hidden";
  const servers = hiddenMode ? visible.hiddenServers : visible.servers;
  const knownServerCount = visible.servers.length + visible.hiddenServers.length;
  // A Project without local servers shows nothing; a filter that hides every server still
  // keeps its heading so the filter can be changed back.
  if (localServers?.isLoading || knownServerCount === 0) return null;

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
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-token-text-secondary">
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.localServers",
            defaultMessage: "Local servers",
          })}
        </h3>
        <div className="flex items-center gap-1">
          <NodexTooltip
            tooltipContent={intl.formatMessage({
              id: "browser.browserSidebarPanel.refreshLocalServers",
              defaultMessage: "Refresh local servers",
            })}
          >
            <button
              type="button"
              className={LOCAL_SERVER_ICON_BUTTON_CLASS}
              onClick={onRefresh}
              aria-label={intl.formatMessage({
                id: "browser.browserSidebarPanel.refreshLocalServers",
                defaultMessage: "Refresh local servers",
              })}
            >
              <BrowserReloadIcon className="icon-xs" />
            </button>
          </NodexTooltip>
          <NodexDropdownMenu
            align="end"
            contentWidth="menuWide"
            triggerTooltipContent={intl.formatMessage({
              id: "browser.browserSidebarPanel.localServerOptions",
              defaultMessage: "Local server options",
            })}
            triggerButton={
              <button
                type="button"
                className={LOCAL_SERVER_ICON_BUTTON_CLASS}
                aria-label={intl.formatMessage({
                  id: "browser.browserSidebarPanel.localServerOptions",
                  defaultMessage: "Local server options",
                })}
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
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.online",
                defaultMessage: "Online",
              })}
            </NodexDropdownItem>
            <NodexDropdownItem
              rightSlot={settings.showMode === "all" ? <CheckmarkIcon className="icon-xs" /> : null}
              onSelect={() => setShowMode("all")}
            >
              {intl.formatMessage({ id: "browser.browserSidebarPanel.all", defaultMessage: "All" })}
            </NodexDropdownItem>
            <NodexDropdownItem
              rightSlot={hiddenMode ? <CheckmarkIcon className="icon-xs" /> : null}
              onSelect={() => setShowMode("hidden")}
            >
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.hidden",
                defaultMessage: "Hidden",
              })}
            </NodexDropdownItem>
            <NodexDropdownSeparator />
            <NodexDropdownItem
              rightSlot={
                settings.sortMode === "recently-used" ? <CheckmarkIcon className="icon-xs" /> : null
              }
              onSelect={() => setSortMode("recently-used")}
            >
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.recentlyUsed",
                defaultMessage: "Recently used",
              })}
            </NodexDropdownItem>
            <NodexDropdownItem
              rightSlot={
                settings.sortMode === "origin" ? <CheckmarkIcon className="icon-xs" /> : null
              }
              onSelect={() => setSortMode("origin")}
            >
              {intl.formatMessage({
                id: "browser.browserSidebarPanel.origin",
                defaultMessage: "Origin",
              })}
            </NodexDropdownItem>
          </NodexDropdownMenu>
        </div>
      </div>
      {servers.length === 0 ? (
        <p className="px-1 text-sm text-token-text-secondary">
          {intl.formatMessage(
            {
              id: "browser.browserSidebarPanel.noLocalServers",
              defaultMessage:
                "{mode, select, online {No online local servers.} hidden {No hidden local servers.} other {No known local servers.}}",
            },
            { mode: settings.showMode },
          )}
        </p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 @md:grid-cols-4">
          {servers.map((server) => (
            <LocalServerTile
              key={server.id}
              server={server}
              hiddenMode={hiddenMode}
              onOpen={onOpen}
              onRequestThumbnail={onRequestThumbnail}
              onHide={() => onHideServer(server)}
              onUnhide={() => onUnhideServer(server.origin)}
            />
          ))}
        </ul>
      )}
      {visible.hasMore ? (
        <button
          type="button"
          className="h-8 self-start rounded-lg px-2 text-sm text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          onClick={expandProject}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.showMore",
            defaultMessage: "Show more",
          })}
        </button>
      ) : null}
    </section>
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
  const intl = useIntl();
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(online && onRequest));
  const [request, setRequest] = useState({ origin, online, onRequest, lastSeenAt });
  if (
    request.origin !== origin ||
    request.online !== online ||
    request.onRequest !== onRequest ||
    request.lastSeenAt !== lastSeenAt
  ) {
    setRequest({ origin, online, onRequest, lastSeenAt });
    setLoading(Boolean(online && onRequest));
    if (!online || !onRequest) setDataUrl(null);
  }
  useEffect(() => {
    if (!request.online || !request.onRequest) return;
    let cancelled = false;
    void request
      .onRequest(request.origin)
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
  }, [request]);

  const frameClass =
    "aspect-[16/10] w-full shrink-0 overflow-hidden rounded-lg border border-token-border-light";
  if (dataUrl) {
    return (
      <img
        alt={intl.formatMessage(
          { id: "browser.browserSidebarPanel.previewAlt", defaultMessage: "Preview of {origin}" },
          { origin },
        )}
        draggable={false}
        src={dataUrl}
        className={cn(frameClass, "object-cover object-top")}
      />
    );
  }

  return (
    <span
      aria-label={
        online
          ? intl.formatMessage(
              {
                id: "browser.browserSidebarPanel.previewUnavailable",
                defaultMessage: "Preview unavailable for {origin}",
              },
              { origin },
            )
          : intl.formatMessage(
              {
                id: "browser.browserSidebarPanel.previewOffline",
                defaultMessage: "{origin} is offline",
              },
              { origin },
            )
      }
      className={cn(
        frameClass,
        "flex items-center justify-center bg-[var(--color-background-primary-soft-alpha)] text-token-text-tertiary",
      )}
      role="img"
    >
      {loading ? (
        <ActivitySpinnerIcon className="icon-xs" icon={BrowserReloadIcon} />
      ) : online ? (
        <SidePanelBrowserIcon className="icon-sm" />
      ) : (
        <WifiOff className="icon-xs" />
      )}
    </span>
  );
}

function LocalServerTile({
  server,
  hiddenMode,
  onOpen,
  onRequestThumbnail,
  onHide,
  onUnhide,
}: {
  server: BrowserSidebarLocalServer;
  hiddenMode: boolean;
  onOpen: (url: string) => void;
  onRequestThumbnail?: (url: string) => Promise<BrowserSidebarLocalServerThumbnailResult>;
  onHide: () => void;
  onUnhide: () => void;
}) {
  const intl = useIntl();
  const title = formatLocalServerTitle(server.origin);
  return (
    <li className="group/local-server relative min-w-0">
      <NodexTooltip tooltipContent={server.origin} delayOpen>
        <button
          type="button"
          aria-label={intl.formatMessage(
            { id: "browser.browserSidebarPanel.openServer", defaultMessage: "Open {title}" },
            { title },
          )}
          className="cursor-interaction flex w-full min-w-0 flex-col items-center gap-2.5 rounded-xl p-2.5 outline-none select-none group-hover/local-server:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset"
          onClick={() => onOpen(server.origin)}
        >
          <LocalServerThumbnail
            origin={server.origin}
            online={server.online}
            lastSeenAt={server.lastSeenAt}
            onRequest={onRequestThumbnail}
          />
          <span className="flex w-full min-w-0 items-center justify-center gap-1.5">
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                server.online ? "bg-emerald-500" : "bg-token-text-tertiary",
              )}
            />
            <span className="min-w-0 truncate text-sm text-token-text-primary">{title}</span>
          </span>
        </button>
      </NodexTooltip>
      <div className="absolute end-1 top-1">
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md bg-token-main-surface-primary/80 text-token-text-tertiary opacity-0 backdrop-blur-sm transition-opacity hover:text-token-text-primary group-hover/local-server:opacity-100 group-hover/local-server:delay-300 focus-visible:opacity-100 group-has-[:focus-visible]/local-server:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={
            hiddenMode
              ? intl.formatMessage(
                  {
                    id: "browser.browserSidebarPanel.unhideServer",
                    defaultMessage: "Unhide {origin}",
                  },
                  { origin: server.origin },
                )
              : intl.formatMessage(
                  { id: "browser.browserSidebarPanel.hideServer", defaultMessage: "Hide {origin}" },
                  { origin: server.origin },
                )
          }
          onClick={hiddenMode ? onUnhide : onHide}
        >
          {hiddenMode ? <CheckmarkIcon className="icon-xs" /> : <CloseIcon className="icon-2xs" />}
        </button>
      </div>
    </li>
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

function BrowserCommentOverlay({
  identity,
  children,
}: {
  identity: BrowserSidebarTabIdentity;
  children?: ReactNode;
}) {
  return (
    <BrowserPageOverlay identity={identity}>
      <div id="browser-sidebar-comment-popup-root" className="absolute inset-0">
        {children}
      </div>
    </BrowserPageOverlay>
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
  onSubmit,
  flow = "batch",
  pending = false,
  editing = false,
  onRemove,
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
  onSubmit: (action: BrowserAnnotationAction) => void;
  flow?: BrowserAnnotationFlow;
  pending?: boolean;
  editing?: boolean;
  onRemove?: () => void;
}) {
  const intl = useIntl();
  if (anchors.length === 0) {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-token-dropdown-background/90 p-1 text-xs text-token-text-secondary shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-sm">
          <AnnotationModeButton
            active={selectionMode === "inspect"}
            onClick={() => onSelectionModeChange("inspect")}
          >
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.elementOrText",
              defaultMessage: "Element or text",
            })}
          </AnnotationModeButton>
          <AnnotationModeButton
            active={selectionMode === "region"}
            onClick={() => onSelectionModeChange("region")}
          >
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.region",
              defaultMessage: "Region",
            })}
          </AnnotationModeButton>
          <span className="px-2">
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.selectMultiple",
              defaultMessage: "Hold Shift for multiple.",
            })}
          </span>
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
    <div className="pointer-events-auto m-px rounded-xl bg-token-dropdown-background/95 p-3 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-md">
      <div className="mb-2 flex items-center gap-1">
        <AnnotationModeButton
          active={intent === "comment"}
          onClick={() => onIntentChange("comment")}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.comment",
            defaultMessage: "Comment",
          })}
        </AnnotationModeButton>
        <AnnotationModeButton
          active={intent === "designChange"}
          onClick={() => onIntentChange("designChange")}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.designChange",
            defaultMessage: "Design change",
          })}
        </AnnotationModeButton>
        <div className="flex-1" />
        <AnnotationModeButton
          active={selectionMode === "inspect"}
          onClick={() => onSelectionModeChange("inspect")}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.element",
            defaultMessage: "Element",
          })}
        </AnnotationModeButton>
        <AnnotationModeButton
          active={selectionMode === "region"}
          onClick={() => onSelectionModeChange("region")}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.region",
            defaultMessage: "Region",
          })}
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
                  ? anchor.textExcerpt ||
                    intl.formatMessage(
                      {
                        id: "browser.browserSidebarPanel.numberedText",
                        defaultMessage: "Text {index}",
                      },
                      { index: index + 1 },
                    )
                  : anchor.kind === "region"
                    ? intl.formatMessage(
                        {
                          id: "browser.browserSidebarPanel.numberedRegion",
                          defaultMessage: "Region {index}",
                        },
                        { index: index + 1 },
                      )
                    : anchor.selector ||
                      intl.formatMessage(
                        {
                          id: "browser.browserSidebarPanel.numberedElement",
                          defaultMessage: "Element {index}",
                        },
                        { index: index + 1 },
                      )}
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
              <span>
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.target",
                  defaultMessage: "Target",
                })}
              </span>
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
                    {anchor.selector ||
                      intl.formatMessage(
                        {
                          id: "browser.browserSidebarPanel.numberedElement",
                          defaultMessage: "Element {index}",
                        },
                        { index: index + 1 },
                      )}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-token-text-tertiary">
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.property",
              defaultMessage: "Property",
            })}
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
              <option value="color">
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.textColor",
                  defaultMessage: "Text color",
                })}
              </option>
              <option value="backgroundColor">
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.background",
                  defaultMessage: "Background",
                })}
              </option>
              <option value="fontSize">
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.fontSize",
                  defaultMessage: "Font size",
                })}
              </option>
              <option value="borderRadius">
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.cornerRadius",
                  defaultMessage: "Corner radius",
                })}
              </option>
              <option value="opacity">
                {intl.formatMessage({
                  id: "browser.browserSidebarPanel.opacity",
                  defaultMessage: "Opacity",
                })}
              </option>
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] text-token-text-tertiary">
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.after",
              defaultMessage: "After",
            })}
            <input
              className="h-7 min-w-0 rounded-md border border-token-border bg-token-main-surface-primary px-2 text-xs text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border"
              value={designAfter}
              disabled={!designAnchor}
              maxLength={512}
              placeholder={
                designBefore ||
                intl.formatMessage({
                  id: "browser.browserSidebarPanel.newValue",
                  defaultMessage: "New value",
                })
              }
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
              <span className="truncate">
                {intl.formatMessage(
                  { id: "browser.browserSidebarPanel.before", defaultMessage: "Before: {value}" },
                  {
                    value:
                      designBefore ||
                      intl.formatMessage({
                        id: "browser.browserSidebarPanel.unavailable",
                        defaultMessage: "Unavailable",
                      }),
                  },
                )}
              </span>
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
              {originalView
                ? intl.formatMessage({
                    id: "browser.browserSidebarPanel.showChange",
                    defaultMessage: "Show change",
                  })
                : intl.formatMessage({
                    id: "browser.browserSidebarPanel.originalView",
                    defaultMessage: "Original view",
                  })}
            </button>
          </div>
        </div>
      ) : null}
      <textarea
        className="mt-2 min-h-16 w-full resize-none rounded-lg border border-token-border bg-token-main-surface-primary px-2.5 py-2 text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border"
        autoFocus
        aria-label={intl.formatMessage({
          id: "browser.browserSidebarPanel.annotationNote",
          defaultMessage: "Annotation note",
        })}
        onKeyDown={(event) => {
          const action = browserAnnotationKeyAction({
            flow,
            key: event.key,
            shiftKey: event.shiftKey,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            isComposing: event.nativeEvent.isComposing,
            repeat: event.repeat,
          });
          if (!action || pending) return;
          event.preventDefault();
          onSubmit(action);
        }}
        value={note}
        maxLength={8_192}
        placeholder={
          intent === "designChange"
            ? intl.formatMessage({
                id: "browser.browserSidebarPanel.designChangePlaceholder",
                defaultMessage: "Describe the design change…",
              })
            : intl.formatMessage({
                id: "browser.browserSidebarPanel.commentPlaceholder",
                defaultMessage: "Leave a comment…",
              })
        }
        onChange={(event) => onNoteChange(event.target.value)}
      />
      <div className="mt-2 flex items-center gap-2">
        {editing ? (
          <button
            type="button"
            className="rounded-lg px-2.5 py-1.5 text-xs text-danger hover:bg-token-list-hover-background"
            onClick={onRemove}
          >
            {intl.formatMessage({
              id: "browser.browserSidebarPanel.remove",
              defaultMessage: "Remove",
            })}
          </button>
        ) : null}
        <div className="flex-1" />
        <button
          type="button"
          className="rounded-lg px-2.5 py-1.5 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          onClick={onDiscard}
        >
          {intl.formatMessage({
            id: "browser.browserSidebarPanel.cancel",
            defaultMessage: "Cancel",
          })}
        </button>
        {(
          [
            browserAnnotationDefaultAction(flow),
            browserAnnotationDefaultAction(flow) === "save" ? "send" : "save",
          ] as const
        ).map((action, index) => (
          <button
            key={action}
            type="button"
            aria-label={
              action === "save"
                ? intl.formatMessage({
                    id: "browser.browserSidebarPanel.save",
                    defaultMessage: "Save",
                  })
                : intl.formatMessage({
                    id: "browser.browserSidebarPanel.sendNow",
                    defaultMessage: "Send now",
                  })
            }
            disabled={pending}
            className={cn(
              "inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs",
              index === 0
                ? "bg-token-foreground font-medium text-token-background hover:opacity-90"
                : "text-token-text-secondary hover:bg-token-list-hover-background",
            )}
            onClick={() => onSubmit(action)}
          >
            {action === "save"
              ? intl.formatMessage({
                  id: "browser.browserSidebarPanel.save",
                  defaultMessage: "Save",
                })
              : intl.formatMessage({
                  id: "browser.browserSidebarPanel.send",
                  defaultMessage: "Send",
                })}
            <span aria-hidden="true" className="opacity-60">
              {index === 0
                ? "↵"
                : navigator.platform.toUpperCase().includes("MAC")
                  ? "⌘↵"
                  : "Ctrl↵"}
            </span>
          </button>
        ))}
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
        "shrink-0 rounded-full px-2 py-1 text-xs whitespace-nowrap transition-colors",
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
  const intl = useIntl();
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-token-main-surface-primary p-6 text-center">
      <div className="text-base font-medium text-token-text-primary">
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.desktopOnly",
          defaultMessage: "Browser is available in the desktop app",
        })}
      </div>
      <div className="mt-1 max-w-sm text-sm text-token-text-secondary">
        {intl.formatMessage({
          id: "browser.browserSidebarPanel.desktopOnlyDescription",
          defaultMessage:
            "The browser tab uses Electron webview isolation and cannot run in this renderer.",
        })}
      </div>
    </div>
  );
}

function makeInitialSnapshot(
  tab: BrowserTab,
  browserConversationId: string,
  browserViewScopeId = "unassigned-window-session",
): BrowserSidebarTabSnapshot {
  const initialUrl = readBrowserConfigUrl(tab);
  const url = isBlankBrowserUrl(initialUrl) ? "about:blank" : initialUrl;
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

/** Reports the outcome of a Browser action; a newer outcome replaces the one still showing. */
function showBrowserStatus(message: string): void {
  toast.info(message, { id: "browser-status" });
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

function findHighlightedAddressIndex(
  rows: readonly { id: string }[],
  highlightedId: string | null,
): number {
  const index = rows.findIndex((row) => row.id === highlightedId);
  return index < 0 ? 0 : index;
}

function BrowserAnnotationDiscardAction({
  count,
  onDiscard,
}: {
  count: number;
  onDiscard: () => void;
}) {
  const intl = useIntl();
  const appHandle = useScopeHandle(appScope);
  return (
    <BrowserToolbarButton
      label={intl.formatMessage(
        {
          id: "browser.browserSidebarPanel.discardAnnotations",
          defaultMessage: "{count, plural, one {Discard annotation} other {Discard # annotations}}",
        },
        { count },
      )}
      onClick={() => openModal(appHandle, BrowserAnnotationDiscardDialog, { onDiscard })}
    >
      <TrashIcon className="icon-sm" />
    </BrowserToolbarButton>
  );
}
