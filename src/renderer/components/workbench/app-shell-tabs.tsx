import {
  dropTargetForElements,
  draggable,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/utils/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/utils/set-custom-native-drag-preview";
import { AnimatePresence, motion } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip, NodexTooltipProvider } from "@/components/ui/tooltip";
import { CloseIcon } from "@/components/shared/icons";
import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import { canShowNativeContextMenu, showNativeContextMenu } from "@/lib/native-context-menu";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { PanelId } from "@/lib/types";
import type {
  NativeContextMenuIconKey,
  NativeContextMenuItem,
} from "../../../shared/native-context-menu";
import { cn } from "@/lib/utils";
import {
  resolveContentTabPaneMoves,
  type SessionWorkspacePresentation,
  type WorkbenchPanelSide,
} from "@/lib/workbench-session-workspace";
import { WorkbenchPaneTitlebar } from "./workbench-titlebar-context";
import {
  buildPanelGroupBodyDropData,
  buildPanelTabDragData,
  buildPanelTabRowDropData,
  isPanelTabDragData,
  type PanelTabDropIntent,
} from "./panel-tab-dnd";
import { createPanelTabDragPreviewElement } from "./panel-tab-drag-preview";
import { PanelTabInsertionIndicator } from "./panel-tab-insertion-indicator";
import {
  APP_SHELL_TAB_GAP_PX,
  APP_SHELL_TAB_MAX_WIDTH_PX,
  APP_SHELL_TAB_MIN_WIDTH_PX,
  buildAppShellLeadingTabStripSizing,
  buildAppShellTabFlexSizing,
  buildAppShellTabListWidth,
} from "./app-shell-tab-sizing";
import { resolveAppShellTabLocationDetails } from "./app-shell-tab-location";

export type AppShellTabSplitSide = "left" | "right" | "up" | "down";

/**
 * A Session's content pane: where its content tabs can be presented beside the Conversation,
 * and the side bottom tabs move into. Scenes without a Conversation provide none.
 */
export interface AppShellContentPane {
  readonly presentation: SessionWorkspacePresentation;
  /** Selects a content tab and presents it in the pane on `side`, beside the Conversation. */
  readonly presentTab: (tabId: string, side: WorkbenchPanelSide) => void;
}

export const AppShellContentPaneContext = createContext<AppShellContentPane | null>(null);

const APP_SHELL_SPLIT_ACTIONS: {
  side: AppShellTabSplitSide;
  label: string;
  iconKey: NativeContextMenuIconKey;
}[] = [
  { side: "left", label: "left", iconKey: "splitLeft" },
  { side: "right", label: "right", iconKey: "splitRight" },
  { side: "up", label: "up", iconKey: "splitUp" },
  { side: "down", label: "down", iconKey: "splitDown" },
];
const APP_SHELL_TAB_ROW_WHEEL_LINE_HEIGHT_PX = 16;
const APP_SHELL_TAB_ROW_WHEEL_DELTA_LINE = 1;
const APP_SHELL_TAB_ROW_WHEEL_DELTA_PAGE = 2;
const APP_SHELL_PREVIEW_PIN_EXEMPT_ATTRIBUTE = "data-tab-preview-pin-exempt";
const APP_SHELL_TAB_COLLAPSED_MOTION = {
  "--app-shell-tab-separator-gutter": "0px",
  maxWidth: 0,
  minWidth: 0,
} as const;
const APP_SHELL_TAB_EXPANDED_MOTION = {
  "--app-shell-tab-separator-gutter": "4px",
  maxWidth: APP_SHELL_TAB_MAX_WIDTH_PX,
  minWidth: APP_SHELL_TAB_MIN_WIDTH_PX,
} as const;
const APP_SHELL_TAB_WIDTH_TRANSITION = {
  duration: 0.15,
  ease: [0.23, 1, 0.32, 1],
} as const;

export interface AppShellTabItem {
  id: string;
  presentationId?: string;
  domTabId?: string;
  title: string;
  titleSource?: AppShellTabTitleSource;
  /**
   * Where the tab's content lives, outermost first: the Library or a Project, or a file's folders.
   * The default tooltip shows it under the title, and a tab sharing its title with another shows
   * the trailing parts that tell them apart.
   */
  location?: readonly string[];
  icon?: ComponentType<{ className?: string }>;
  iconElement?: ReactNode;
  actions?: ReactNode;
  closable?: boolean;
  preview?: boolean;
  pinBehavior?: "automatic" | "disabled";
  reorderable?: boolean;
  splittable?: boolean;
  isLabel?: boolean;
  disabled?: boolean;
  titleLabel?: string | ((title: string) => string);
  tooltip?: ReactNode;
  renderTooltip?: (title: string) => ReactNode;
  contextMenuItems?: AppShellTabContextMenuItem[];
  renderPanel: (closeTab: () => void, context: AppShellTabPanelRenderContext) => ReactNode;
}

export interface AppShellTabTitleSource {
  readonly getSnapshot: () => string;
  readonly subscribe: (listener: () => void) => () => void;
}

export type AppShellTabPresentation = Pick<
  AppShellTabItem,
  "id" | "title" | "titleSource" | "icon" | "iconElement" | "disabled" | "titleLabel" | "preview"
>;

/**
 * A fixed tab before a strip's own tabs, such as a full-view Session's Chat. It is never
 * closed, dragged, or reordered, and its panel renders outside the strip.
 */
export interface AppShellLeadingTab {
  readonly id: string;
  readonly title: string;
  readonly icon: ReactNode;
  readonly selected: boolean;
  /** The element this tab controls while selected. */
  readonly panelId?: string;
  /** Always-visible trailing actions, such as the Chat actions menu. */
  readonly actions?: ReactNode;
  /** Names a live status the icon shows, such as a running chat, for assistive technology. */
  readonly statusLabel?: string;
  readonly contextMenuItems?: readonly AppShellTabContextMenuActionItem[];
  readonly onSelect: () => void;
  readonly onDoubleClick?: () => void;
}

export interface AppShellTabPanelRenderContext {
  active: boolean;
}

export function makeAppShellTabAccessibleLabel(
  tab: AppShellTabPresentation,
  title: string,
  locationDetail?: string,
): string {
  if (typeof tab.titleLabel === "function") return tab.titleLabel(title);
  if (tab.titleLabel) return tab.titleLabel;
  return locationDetail ? `${title}, ${locationDetail}` : title;
}

/** A tab's title above where its content lives. */
export function AppShellTabLocationTooltip({
  title,
  location,
}: {
  readonly title: string;
  readonly location: readonly string[];
}) {
  return (
    <div className="flex max-w-80 flex-col gap-0.5">
      <div className="truncate font-medium">{title}</div>
      {location.length > 0 ? (
        <div className="line-clamp-2 text-xs break-words text-token-description-foreground">
          {location.join(" / ")}
        </div>
      ) : null}
    </div>
  );
}

function makeAppShellTabTooltip(tab: AppShellTabItem, title: string): ReactNode {
  if (tab.renderTooltip) return tab.renderTooltip(title);
  if (tab.tooltip !== undefined) return tab.tooltip;
  if (tab.location?.length)
    return <AppShellTabLocationTooltip title={title} location={tab.location} />;
  return title;
}

const subscribeToNoTabTitles = (): (() => void) => () => undefined;

/**
 * Which tabs show a location beside their title, following live titles so a rename that makes
 * two titles match, or tells them apart again, updates the strip.
 */
function useAppShellTabLocationDetails(tabs: readonly AppShellTabItem[]) {
  const located = tabs.filter((tab) => tab.location?.length);
  const subscribe = (listener: () => void) => {
    const unsubscribes = located.map((tab) => tab.titleSource?.subscribe(listener));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe?.();
    };
  };
  const readTitles = () =>
    JSON.stringify(located.map((tab) => tab.titleSource?.getSnapshot() ?? tab.title));
  const titles = useSyncExternalStore(
    located.length > 1 ? subscribe : subscribeToNoTabTitles,
    readTitles,
    readTitles,
  );
  const liveTitles = JSON.parse(titles) as string[];
  return resolveAppShellTabLocationDetails(
    located.map((tab, index) => ({
      id: tab.id,
      title: liveTitles[index] ?? tab.title,
      location: tab.location,
    })),
  );
}

export function makeAppShellTabIcon(tab: AppShellTabPresentation): ReactNode {
  const Icon = tab.icon;
  return tab.iconElement ?? (Icon ? <Icon className="icon-xs shrink-0" /> : null);
}

const subscribeToStaticAppShellTabTitle = (): (() => void) => () => undefined;

export function useAppShellTabTitle(tab: AppShellTabPresentation): string {
  const getStaticSnapshot = useCallback(() => tab.title, [tab.title]);
  return useSyncExternalStore(
    tab.titleSource?.subscribe ?? subscribeToStaticAppShellTabTitle,
    tab.titleSource?.getSnapshot ?? getStaticSnapshot,
    tab.titleSource?.getSnapshot ?? getStaticSnapshot,
  );
}

function isPreviewPinExemptEvent(event: Event): boolean {
  return event
    .composedPath()
    .some(
      (target) =>
        target instanceof Element && target.hasAttribute(APP_SHELL_PREVIEW_PIN_EXEMPT_ATTRIBUTE),
    );
}

export type AppShellTabContextMenuItem =
  | AppShellTabContextMenuActionItem
  | AppShellTabContextMenuSeparatorItem;

export interface AppShellTabContextMenuActionItem {
  id: string;
  type?: "item";
  label: string;
  /** Shown beside the label, natively on the desktop and in the page menu elsewhere. */
  iconKey?: NativeContextMenuIconKey;
  disabled?: boolean;
  tone?: "default" | "destructive";
  onSelect: () => void;
}

export interface AppShellTabContextMenuSeparatorItem {
  id: string;
  type: "separator";
}

interface AppShellTabsProps {
  tabs: AppShellTabItem[];
  /** `null` selects none of `tabs`, as while a selected leading tab presents elsewhere. */
  activeTabId: string | null;
  leadingTab?: AppShellLeadingTab;
  panelId?: string;
  controllerId?: string;
  onSelect: (tabId: string) => void;
  onCloseTab?: (tabId: string) => void;
  onDirectCloseTab?: (tabId: string) => void;
  onPinTab?: (tabId: string) => void;
  onMoveTab?: (tabId: string, targetPanelId: string) => void;
  onSplitTab?: (tabId: string, side: AppShellTabSplitSide) => void;
  panelTabDnd?: {
    sessionId: string;
    panelId: PanelId;
    leafId: string;
    activeDragId: string | null;
    previewIntent: PanelTabDropIntent | null;
  };
  beforeList?: ReactNode;
  afterTabsInline?: ReactNode;
  afterListSticky?: ReactNode;
  afterList?: ReactNode;
  bodyOverlay?: ReactNode;
  /** Shown while no tab or selected leading tab presents a body, as for a group without tabs. */
  emptyBody?: ReactNode;
  headerEndInsetPx?: number;
  headerHeight?: "pane" | "toolbar";
  titlebar?: boolean;
  className?: string;
}

export function shouldShowAppShellTabSeparator({
  index,
  tabCount,
  activeIndex,
  draggingIndex,
  isActive,
  isDragging,
}: {
  index: number;
  tabCount: number;
  activeIndex: number;
  draggingIndex: number;
  isActive: boolean;
  isDragging: boolean;
}): boolean {
  if (index < 0 || index >= tabCount - 1) return false;
  if (isActive || isDragging) return false;
  if (index === activeIndex || index === activeIndex - 1) return false;
  if (index === draggingIndex || index === draggingIndex - 1) return false;

  return true;
}

const APP_SHELL_TAB_CONTEXT_MENU_ITEM_CLASS =
  "cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background";
const TAB_ROW_EDGE_FADE_PX = 40;
const TAB_TITLE_FADE_MASK = "linear-gradient(to right, #000 calc(100% - 28px), transparent 100%)";

export function resolveTabRowEdgeFade(
  startClipped: boolean,
  endClipped: boolean,
): "none" | "start" | "end" | "both" {
  if (startClipped && endClipped) return "both";
  if (startClipped) return "start";
  return endClipped ? "end" : "none";
}

/**
 * Overflowing tabs fade through an alpha mask, so the row blends with whatever
 * surface hosts it: the pane header or the translucent window titlebar.
 */
export function buildTabRowEdgeMask(startClipped: boolean, endClipped: boolean): string {
  if (!startClipped && !endClipped) return "none";
  const start = startClipped ? `transparent 0, #000 ${TAB_ROW_EDGE_FADE_PX}px` : "#000 0";
  const end = endClipped
    ? `#000 calc(100% - ${TAB_ROW_EDGE_FADE_PX}px), transparent 100%`
    : "#000 100%";
  return `linear-gradient(to right, ${start}, ${end})`;
}

export function AppShellTabs({
  tabs,
  activeTabId,
  leadingTab,
  panelId,
  controllerId = "pages",
  onSelect,
  onCloseTab,
  onDirectCloseTab,
  onPinTab,
  onMoveTab,
  onSplitTab,
  panelTabDnd,
  beforeList,
  afterTabsInline,
  afterListSticky,
  afterList,
  bodyOverlay,
  emptyBody,
  headerEndInsetPx = 0,
  headerHeight = "pane",
  titlebar = false,
  className,
}: AppShellTabsProps) {
  const tabRowRef = useRef<HTMLDivElement | null>(null);
  const leftEdgeSentinelRef = useRef<HTMLSpanElement | null>(null);
  const rightEdgeSentinelRef = useRef<HTMLSpanElement | null>(null);
  const tabNodesRef = useRef(new Map<string, HTMLDivElement>());
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [lockedTabWidthPx, setLockedTabWidthPx] = useState<number | null>(null);
  const [retainedTabCount, setRetainedTabCount] = useState(tabs.length);
  const [leftEdgeClipped, setLeftEdgeClipped] = useState(false);
  const [rightEdgeClipped, setRightEdgeClipped] = useState(false);
  const reducedMotion = useResolvedReducedMotion();
  const { elementRef: afterTabsInlineRef, elementWidthPx: afterTabsInlineWidthPx } =
    useMeasuredElementWidth();
  const locationDetails = useAppShellTabLocationDetails(tabs);
  const activeTab =
    activeTabId === null ? null : (tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null);
  const resolvedActiveTabId = activeTab?.id ?? null;
  const activePanelId = activeTab ? makeTabPanelId(controllerId, activeTab.id) : undefined;
  const activeIndex = activeTab ? tabs.findIndex((tab) => tab.id === activeTab.id) : -1;
  const draggingIndex = panelTabDnd?.activeDragId
    ? tabs.findIndex((tab) => tab.id === panelTabDnd.activeDragId)
    : -1;
  const tabRowPreview =
    panelTabDnd?.previewIntent?.kind === "tab-row" &&
    panelTabDnd.previewIntent.panelId === panelTabDnd.panelId &&
    panelTabDnd.previewIntent.leafId === panelTabDnd.leafId
      ? panelTabDnd.previewIntent
      : null;
  const dndSessionId = panelTabDnd?.sessionId;
  const dndPanelId = panelTabDnd?.panelId;
  const dndLeafId = panelTabDnd?.leafId;
  if (tabs.length > retainedTabCount) {
    setRetainedTabCount(tabs.length);
  }
  const layoutTabCount = Math.max(tabs.length, retainedTabCount);
  const leadingStripSizing = leadingTab
    ? buildAppShellLeadingTabStripSizing({
        tabCount: layoutTabCount,
        trailingWidthPx: afterTabsInlineWidthPx,
        lockedWidthPx: lockedTabWidthPx,
      })
    : null;
  const tabListWidth =
    leadingStripSizing?.listWidth ??
    buildAppShellTabListWidth({
      tabCount: layoutTabCount,
      trailingWidthPx: afterTabsInlineWidthPx,
      lockedWidthPx: lockedTabWidthPx,
    });
  const leadingTabDomId = leadingTab ? makeTabId(controllerId, leadingTab.id) : undefined;
  const exitTabCloseMode = useCallback(() => {
    setLockedTabWidthPx(null);
  }, []);

  const handleTabListMouseDownCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof Element)) return;
    if (event.button !== 1 && !event.target.closest("[data-app-shell-tab-close-button]")) return;

    const tabElement = event.target.closest<HTMLElement>("[data-app-shell-tab-controller]");
    if (!tabElement) return;
    if (tabElement.offsetWidth <= 0) return;
    setLockedTabWidthPx(tabElement.offsetWidth);
  }, []);

  useEffect(() => {
    if (!dndSessionId || !dndPanelId || !dndLeafId) return undefined;
    const element = tabRowRef.current;
    if (!element) return undefined;

    return dropTargetForElements({
      element,
      canDrop: ({ source }) =>
        isPanelTabDragData(source.data) && source.data.sessionId === dndSessionId,
      getIsSticky: () => true,
      getData: () =>
        buildPanelTabRowDropData({
          sessionId: dndSessionId,
          panelId: dndPanelId,
          leafId: dndLeafId,
        }),
    });
  }, [dndLeafId, dndPanelId, dndSessionId]);

  useEffect(() => {
    const element = tabRowRef.current;
    if (!element) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (handleAppShellTabRowWheel(element, event)) {
        exitTabCloseMode();
      }
    };

    element.addEventListener("wheel", handleWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", handleWheel);
    };
  }, [exitTabCloseMode]);

  useLayoutEffect(() => {
    const tabRow = tabRowRef.current;
    const leftSentinel = leftEdgeSentinelRef.current;
    const rightSentinel = rightEdgeSentinelRef.current;
    if (!tabRow || !leftSentinel || !rightSentinel) return undefined;

    if (typeof IntersectionObserver === "undefined") {
      const updateClippedEdges = () => {
        const maxScrollLeft = Math.max(0, tabRow.scrollWidth - tabRow.clientWidth);
        setLeftEdgeClipped(tabRow.scrollLeft > 1);
        setRightEdgeClipped(tabRow.scrollLeft < maxScrollLeft - 1);
      };
      updateClippedEdges();
      tabRow.addEventListener("scroll", updateClippedEdges, { passive: true });
      window.addEventListener("resize", updateClippedEdges);
      return () => {
        tabRow.removeEventListener("scroll", updateClippedEdges);
        window.removeEventListener("resize", updateClippedEdges);
      };
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === leftSentinel) {
            setLeftEdgeClipped(!entry.isIntersecting);
          }
          if (entry.target === rightSentinel) {
            setRightEdgeClipped(!entry.isIntersecting);
          }
        }
      },
      {
        root: tabRow,
        threshold: 0.99,
      },
    );
    observer.observe(leftSentinel);
    observer.observe(rightSentinel);
    return () => {
      observer.disconnect();
    };
  }, [tabs.length]);

  useLayoutEffect(() => {
    if (!resolvedActiveTabId) return;
    const tabNode = tabNodesRef.current.get(resolvedActiveTabId);
    tabNode?.scrollIntoView?.({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [reducedMotion, resolvedActiveTabId]);

  const registerTabNode = useCallback((tabId: string, element: HTMLDivElement | null) => {
    if (element) {
      tabNodesRef.current.set(tabId, element);
      return;
    }
    tabNodesRef.current.delete(tabId);
  }, []);

  useEffect(() => {
    if (!panelTabDnd?.activeDragId) return;
    exitTabCloseMode();
  }, [exitTabCloseMode, panelTabDnd?.activeDragId]);

  useEffect(() => {
    if (!dndSessionId || !dndPanelId || !dndLeafId) return undefined;
    const element = bodyRef.current;
    if (!element) return undefined;

    return dropTargetForElements({
      element,
      canDrop: ({ source }) =>
        isPanelTabDragData(source.data) && source.data.sessionId === dndSessionId,
      getIsSticky: () => true,
      getData: () =>
        buildPanelGroupBodyDropData({
          sessionId: dndSessionId,
          panelId: dndPanelId,
          leafId: dndLeafId,
        }),
    });
  }, [dndLeafId, dndPanelId, dndSessionId]);

  const closeTab = (tabId: string) => {
    onCloseTab?.(tabId);
  };
  const closeTabFromDirectInteraction = (tabId: string) => {
    if (onDirectCloseTab) {
      onDirectCloseTab(tabId);
      return;
    }
    onCloseTab?.(tabId);
  };

  const pinTab = (tabId: string) => {
    onPinTab?.(tabId);
  };

  const pinPreviewTabFromPanelEvent = (event: SyntheticEvent<HTMLElement>) => {
    if (!activeTab?.preview) return;
    if (activeTab.pinBehavior === "disabled") return;
    if (isPreviewPinExemptEvent(event.nativeEvent)) return;
    pinTab(activeTab.id);
  };

  const renderPanel = (tab: AppShellTabItem) => {
    const panelId = makeTabPanelId(controllerId, tab.id);
    const dataTabId = tab.domTabId ?? tab.id;

    return (
      <AppShellTabPanel
        key={`panel:${tab.id}`}
        tab={tab}
        panelId={panelId}
        controllerId={panelTabDnd?.panelId ?? controllerId}
        dataTabId={dataTabId}
        bodyOverlay={bodyOverlay}
        onPointerDownCapture={pinPreviewTabFromPanelEvent}
        onKeyDownCapture={pinPreviewTabFromPanelEvent}
      >
        {tab.renderPanel(() => closeTab(tab.id), { active: true })}
      </AppShellTabPanel>
    );
  };

  const tabList = (
    <div
      role="tablist"
      aria-owns={leadingTabDomId}
      className="relative z-0 flex shrink-0"
      onMouseDownCapture={handleTabListMouseDownCapture}
      style={{ gap: APP_SHELL_TAB_GAP_PX, width: tabListWidth }}
    >
      <AnimatePresence initial={false} onExitComplete={() => setRetainedTabCount(tabs.length)}>
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTab?.id;
          return (
            <AppShellTab
              key={tab.presentationId ?? tab.id}
              tab={tab}
              locationDetail={locationDetails.get(tab.id)}
              controllerId={controllerId}
              panelTabDnd={panelTabDnd}
              isActive={isActive}
              isDragging={panelTabDnd?.activeDragId === tab.id}
              lockedWidthPx={lockedTabWidthPx}
              panelId={activePanelId}
              separatorIndex={index}
              activeTabIndex={activeIndex}
              draggingIndex={draggingIndex}
              tabCount={tabs.length}
              tabs={tabs}
              onSelect={onSelect}
              onClose={tab.closable ? closeTab : undefined}
              onDirectClose={tab.closable ? closeTabFromDirectInteraction : undefined}
              onCloseModeExit={exitTabCloseMode}
              onTabNodeChange={registerTabNode}
              onPin={tab.preview && tab.pinBehavior !== "disabled" ? pinTab : undefined}
              onMove={onMoveTab}
              onSplit={onSplitTab}
              reducedMotion={Boolean(reducedMotion)}
            />
          );
        })}
      </AnimatePresence>
    </div>
  );

  return (
    <NodexTooltipProvider>
      <div
        data-app-shell-panel-id={panelId}
        className={cn("flex h-full min-h-0 flex-col bg-token-main-surface-primary", className)}
      >
        <WorkbenchPaneTitlebar enabled={titlebar}>
          <div
            className={cn(
              "isolate flex min-w-0 shrink-0 select-none items-center px-2 [contain:layout_paint]",
              titlebar ? "bg-transparent" : "bg-(--color-background-panel)",
              headerHeight === "toolbar" ? "h-toolbar" : "h-toolbar-pane",
            )}
          >
            {beforeList ? (
              <div role="presentation" className="my-auto flex shrink-0 items-center">
                {beforeList}
              </div>
            ) : null}
            <div className="flex h-full min-w-0 flex-1 items-center [container-type:inline-size]">
              {leadingTab && leadingStripSizing ? (
                <AppShellLeadingTabChrome
                  tab={leadingTab}
                  domId={leadingTabDomId}
                  width={leadingStripSizing.leadingTabWidth}
                  separatorVisible={!leadingTab.selected && activeIndex !== 0}
                  onContextMenuOpen={exitTabCloseMode}
                />
              ) : null}
              <div
                ref={tabRowRef}
                data-panel-tab-row={
                  panelTabDnd ? `${panelTabDnd.panelId}:${panelTabDnd.leafId}` : undefined
                }
                data-app-shell-tab-close-mode={lockedTabWidthPx !== null ? "true" : undefined}
                data-app-shell-tab-edge-fade={resolveTabRowEdgeFade(
                  leftEdgeClipped,
                  rightEdgeClipped,
                )}
                className="hide-scrollbar relative isolate flex h-full min-w-0 flex-initial scroll-px-1 items-center overflow-x-auto overflow-y-hidden [contain:layout_paint]"
                style={{ maskImage: buildTabRowEdgeMask(leftEdgeClipped, rightEdgeClipped) }}
                onPointerLeave={exitTabCloseMode}
              >
                <span ref={leftEdgeSentinelRef} aria-hidden="true" className="h-px w-px shrink-0" />
                {tabList}
                <span
                  ref={rightEdgeSentinelRef}
                  aria-hidden="true"
                  className="h-px w-px shrink-0"
                />
                {tabRowPreview ? <PanelTabInsertionIndicator intent={tabRowPreview} /> : null}
              </div>
              {afterTabsInline ? (
                <div
                  ref={afterTabsInlineRef}
                  role="presentation"
                  className="flex h-full shrink-0 items-center"
                >
                  {afterTabsInline}
                </div>
              ) : null}
            </div>
            {afterListSticky ? (
              <div role="presentation" className="my-auto flex shrink-0 items-center">
                {afterListSticky}
              </div>
            ) : null}
            {afterList ? (
              <div role="presentation" className="my-auto flex shrink-0 items-center">
                {afterList}
              </div>
            ) : null}
            {headerEndInsetPx > 0 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none h-full shrink-0"
                style={{ width: headerEndInsetPx }}
              />
            ) : null}
          </div>
        </WorkbenchPaneTitlebar>

        {activeTab ? (
          <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden">
            {renderPanel(activeTab)}
          </div>
        ) : leadingTab?.selected ? null : (
          emptyBody
        )}
      </div>
    </NodexTooltipProvider>
  );
}

function AppShellTabPanel({
  tab,
  panelId,
  controllerId,
  dataTabId,
  bodyOverlay,
  onPointerDownCapture,
  onKeyDownCapture,
  children,
}: {
  tab: AppShellTabItem;
  panelId: string;
  controllerId: string;
  dataTabId: string;
  bodyOverlay?: ReactNode;
  onPointerDownCapture?: ComponentPropsWithoutRef<"div">["onPointerDownCapture"];
  onKeyDownCapture?: ComponentPropsWithoutRef<"div">["onKeyDownCapture"];
  children: ReactNode;
}) {
  const title = useAppShellTabTitle(tab);

  return (
    <div
      role="tabpanel"
      id={panelId}
      aria-label={makeAppShellTabAccessibleLabel(tab, title)}
      data-app-shell-tab-panel-controller={controllerId}
      data-tab-id={dataTabId}
      data-app-shell-tabpanel-preview={tab.preview ? "true" : undefined}
      className="relative h-full min-h-0"
      onPointerDownCapture={onPointerDownCapture}
      onKeyDownCapture={onKeyDownCapture}
    >
      {bodyOverlay}
      {children}
    </div>
  );
}

function useMeasuredElementWidth(): {
  elementRef: (element: HTMLDivElement | null) => void;
  elementWidthPx: number;
} {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [elementWidthPx, setElementWidthPx] = useState(0);

  const elementRef = useCallback((nextElement: HTMLDivElement | null) => {
    setElement(nextElement);
  }, []);

  useLayoutEffect(() => {
    if (!element) {
      setElementWidthPx(0);
      return undefined;
    }

    const measure = () => {
      const nextWidthPx = Math.ceil(element.getBoundingClientRect().width);
      setElementWidthPx((currentWidthPx) =>
        currentWidthPx === nextWidthPx ? currentWidthPx : nextWidthPx,
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") return undefined;

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    return () => {
      resizeObserver.disconnect();
    };
  }, [element]);

  return {
    elementRef,
    elementWidthPx,
  };
}

function handleAppShellTabRowWheel(element: HTMLElement, event: WheelEvent): boolean {
  if (event.ctrlKey || event.metaKey) return false;

  const maxScrollLeft = element.scrollWidth - element.clientWidth;
  if (maxScrollLeft <= 0) return false;

  const deltaPx = normalizeAppShellTabRowWheelDeltaPx(event, element.clientWidth);
  if (deltaPx === 0) return false;

  const currentScrollLeft = element.scrollLeft;
  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, currentScrollLeft + deltaPx));
  if (nextScrollLeft === currentScrollLeft) return false;

  event.stopPropagation();
  if (event.cancelable) event.preventDefault();
  element.scrollLeft = nextScrollLeft;
  return true;
}

function normalizeAppShellTabRowWheelDeltaPx(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY">,
  pageWidthPx: number,
): number {
  const rawDelta = getDominantAppShellTabRowWheelDelta(event);
  if (rawDelta === 0) return 0;

  if (event.deltaMode === APP_SHELL_TAB_ROW_WHEEL_DELTA_LINE) {
    return rawDelta * APP_SHELL_TAB_ROW_WHEEL_LINE_HEIGHT_PX;
  }
  if (event.deltaMode === APP_SHELL_TAB_ROW_WHEEL_DELTA_PAGE && pageWidthPx > 0) {
    return rawDelta * pageWidthPx;
  }
  return rawDelta;
}

function getDominantAppShellTabRowWheelDelta({
  deltaX,
  deltaY,
}: Pick<WheelEvent, "deltaX" | "deltaY">): number {
  if (Math.abs(deltaY) <= Math.abs(deltaX)) return 0;
  return deltaY;
}

function blurActiveElementWithin(element: HTMLElement): void {
  const activeElement = element.ownerDocument.activeElement;
  if (!(activeElement instanceof HTMLElement)) return;
  if (!element.contains(activeElement)) return;

  activeElement.blur();
}

function AppShellTab({
  tab,
  locationDetail,
  controllerId,
  panelTabDnd,
  isActive,
  isDragging,
  lockedWidthPx,
  panelId,
  separatorIndex,
  activeTabIndex,
  draggingIndex,
  tabCount,
  tabs,
  onSelect,
  onClose,
  onDirectClose,
  onCloseModeExit,
  onTabNodeChange,
  onPin,
  onMove,
  onSplit,
  reducedMotion,
}: {
  tab: AppShellTabItem;
  /** Where the content lives, shown when another tab shares its title. */
  locationDetail: string | undefined;
  controllerId: string;
  panelTabDnd?: AppShellTabsProps["panelTabDnd"];
  isActive: boolean;
  isDragging: boolean;
  lockedWidthPx: number | null;
  panelId?: string;
  separatorIndex: number;
  activeTabIndex: number;
  draggingIndex: number;
  tabCount: number;
  tabs: AppShellTabItem[];
  onSelect: (tabId: string) => void;
  onClose?: (tabId: string) => void;
  onDirectClose?: (tabId: string) => void;
  onCloseModeExit: () => void;
  onTabNodeChange: (tabId: string, element: HTMLDivElement | null) => void;
  onPin?: (tabId: string) => void;
  onMove?: (tabId: string, targetPanelId: string) => void;
  onSplit?: (tabId: string, side: AppShellTabSplitSide) => void;
  reducedMotion: boolean;
}) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const setTabRef = useCallback(
    (element: HTMLDivElement | null) => {
      tabRef.current = element;
      onTabNodeChange(tab.id, element);
    },
    [onTabNodeChange, tab.id],
  );
  const resolvedTitle = useAppShellTabTitle(tab);
  const iconElement = makeAppShellTabIcon(tab);
  const dataTabId = tab.domTabId ?? tab.id;
  const tabId = makeTabId(controllerId, tab.id);
  const accessibleLabel = makeAppShellTabAccessibleLabel(tab, resolvedTitle, locationDetail);
  const tooltipContent = makeAppShellTabTooltip(tab, resolvedTitle);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const titleOverflows = useAppShellTabTitleOverflow(titleRef, resolvedTitle);
  // The title fades on its own, so a location telling same-titled tabs apart stays readable.
  const title = (
    <span
      ref={titleRef}
      data-app-shell-tab-title={tab.id}
      data-app-shell-tab-title-fade={titleOverflows ? tab.id : undefined}
      className={cn(
        "block min-w-0 overflow-hidden whitespace-nowrap text-start",
        tab.preview && "italic",
      )}
      style={titleOverflows ? { maskImage: TAB_TITLE_FADE_MASK } : undefined}
    >
      {resolvedTitle}
    </span>
  );
  const label = (
    <span className="relative flex min-w-0 flex-1 items-baseline overflow-hidden">
      <NodexTooltip
        tooltipContent={tooltipContent}
        disabled={isDragging}
        delayOpen
        side="bottom"
        align="start"
        style={{
          maxWidth: "min(32rem, var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
        }}
      >
        {title}
      </NodexTooltip>
      {locationDetail ? (
        <span
          data-app-shell-tab-location={tab.id}
          className="ms-1 max-w-1/2 shrink-0 truncate text-xs opacity-60"
        >
          {locationDetail}
        </span>
      ) : null}
    </span>
  );

  const closeCurrentTab = () => {
    onClose?.(tab.id);
  };
  const closeCurrentTabFromDirectInteraction = () => {
    if (onDirectClose) {
      onDirectClose(tab.id);
      return;
    }
    closeCurrentTab();
  };
  const closeOtherTabs = () => {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      const candidate = tabs[index];
      if (!candidate) continue;
      if (candidate.id === tab.id) continue;
      if (candidate.closable !== true) continue;
      onClose?.(candidate.id);
    }
  };
  const closeTabsToRight = () => {
    const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
    if (tabIndex === -1) return;
    for (let index = tabs.length - 1; index > tabIndex; index -= 1) {
      const candidate = tabs[index];
      if (!candidate) continue;
      if (candidate.closable !== true) continue;
      onClose?.(candidate.id);
    }
  };
  const closeAllTabs = () => {
    for (let index = tabs.length - 1; index >= 0; index -= 1) {
      const candidate = tabs[index];
      if (candidate?.closable !== true) continue;
      onClose?.(candidate.id);
    }
  };
  const [confirmingCloseAll, setConfirmingCloseAll] = useState(false);
  const targetPanelId = controllerId.includes("bottom") ? "right" : "bottom";
  const contentPane = useContext(AppShellContentPaneContext);
  const contentPanelSide = contentPane?.presentation.contentSide ?? "right";
  const paneMoves =
    contentPane && targetPanelId === "bottom"
      ? resolveContentTabPaneMoves({
          presentation: contentPane.presentation,
          tabSelected: isActive,
        }).map((side) => ({ side, onSelect: () => contentPane.presentTab(tab.id, side) }))
      : [];
  const moveCurrentTab = () => {
    onMove?.(tab.id, targetPanelId);
  };
  const pinCurrentTab = () => {
    onPin?.(tab.id);
  };
  const splitCurrentTab = (side: AppShellTabSplitSide) => {
    onSplit?.(tab.id, side);
  };
  const showSeparator = shouldShowAppShellTabSeparator({
    index: separatorIndex,
    tabCount,
    activeIndex: activeTabIndex,
    draggingIndex,
    isActive,
    isDragging,
  });
  const dndSessionId = panelTabDnd?.sessionId;
  const dndPanelId = panelTabDnd?.panelId;
  const dndLeafId = panelTabDnd?.leafId;
  const isDraggable = Boolean(panelTabDnd && tab.isLabel !== true && tab.reorderable !== false);
  const tabIndex = tabs.findIndex((candidate) => candidate.id === tab.id);
  const hasOtherClosableTabs = tabs.some(
    (candidate) => candidate.id !== tab.id && candidate.closable === true,
  );
  const hasClosableTabsToRight =
    tabIndex !== -1 && tabs.slice(tabIndex + 1).some((candidate) => candidate.closable === true);
  const canCloseAllTabs = tabs.length > 1 && tabs.some((candidate) => candidate.closable === true);
  const flexSizing = buildAppShellTabFlexSizing(lockedWidthPx);

  useEffect(() => {
    if (!dndSessionId || !dndPanelId || !dndLeafId) return undefined;
    if (tab.isLabel === true || tab.reorderable === false) return undefined;
    const element = tabRef.current;
    if (!element) return undefined;

    return draggable({
      element,
      canDrag: ({ input }) => {
        const target = element.ownerDocument.elementFromPoint(input.clientX, input.clientY);
        if (target?.closest("[data-app-shell-tab-no-drag='true']")) return false;
        return true;
      },
      getInitialData: () =>
        buildPanelTabDragData({
          sessionId: dndSessionId,
          panelId: dndPanelId,
          leafId: dndLeafId,
          tabId: tab.id,
        }),
      onGenerateDragPreview: ({ location, nativeSetDragImage, source }) => {
        setCustomNativeDragPreview({
          nativeSetDragImage,
          getOffset: preserveOffsetOnSource({
            element: source.element,
            input: location.current.input,
          }),
          render: ({ container }) => {
            const preview = createPanelTabDragPreviewElement(source.element);
            if (!preview) return () => undefined;

            container.append(preview);
            return () => preview.remove();
          },
        });
      },
      onDragStart: () => {
        onCloseModeExit();
        blurActiveElementWithin(element);
      },
    });
  }, [dndLeafId, dndPanelId, dndSessionId, onCloseModeExit, tab.id, tab.isLabel, tab.reorderable]);

  const chrome = (
    <motion.div
      ref={setTabRef}
      data-app-shell-tab-controller={controllerId}
      data-tab-id={dataTabId}
      data-panel-tab-id={tab.id}
      data-app-shell-tab-preview={tab.preview ? "true" : undefined}
      data-app-shell-tab-locked-width={lockedWidthPx ?? undefined}
      className={cn(
        "no-drag relative my-auto flex shrink-0 items-center gap-0.5 overflow-hidden pe-(--app-shell-tab-separator-gutter) contain-content",
        isDraggable && "cursor-grab",
        isDragging && "pointer-events-none z-10 cursor-grabbing opacity-20",
      )}
      initial={reducedMotion || isDragging ? false : APP_SHELL_TAB_COLLAPSED_MOTION}
      animate={APP_SHELL_TAB_EXPANDED_MOTION}
      exit={
        reducedMotion || isDragging
          ? {
              ...APP_SHELL_TAB_EXPANDED_MOTION,
              transition: { duration: 0 },
            }
          : APP_SHELL_TAB_COLLAPSED_MOTION
      }
      transition={reducedMotion ? { duration: 0 } : APP_SHELL_TAB_WIDTH_TRANSITION}
      style={{ flexBasis: flexSizing.flexBasis, flexGrow: flexSizing.flexGrow }}
    >
      <div
        data-tab-id={dataTabId}
        data-app-shell-tab-surface="true"
        className="group group/tab relative flex h-8 w-full max-w-39 shrink-0 items-center overflow-hidden rounded-lg"
        onMouseDown={(event) => {
          if (event.button !== 1 || !onClose) return;
          event.preventDefault();
          event.stopPropagation();
          closeCurrentTabFromDirectInteraction();
        }}
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-0 rounded-md border-[length:var(--border-width-hairline)]",
            isActive || isDragging
              ? "border-(--color-border) bg-(--app-shell-tab-selected-background) shadow-[0px_1px_2px_-1px_#00000014]"
              : "border-transparent group-hover/tab:bg-(--color-background-primary-ghost-hover)",
          )}
        />
        <button
          type="button"
          id={tabId}
          role="tab"
          aria-selected={isActive}
          aria-controls={isActive ? panelId : undefined}
          aria-label={accessibleLabel}
          disabled={tab.disabled}
          className={cn(
            "no-drag relative z-10 flex h-full min-w-0 flex-1 items-center gap-2 py-1 ps-2.5 pe-1.75 text-sm",
            onClose && (isActive ? "pe-8" : "group-focus-within/tab:pe-8 group-hover/tab:pe-8"),
            tab.actions && "pe-14",
            isActive ? "text-(--color-text)" : "text-tertiary",
          )}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            if (tab.disabled) return;
            onSelect(tab.id);
          }}
          onClick={(event) => {
            if (event.detail !== 0) return;
            if (tab.disabled) return;
            onSelect(tab.id);
          }}
          onDoubleClick={(event) => {
            if (event.button !== 0) return;
            if (tab.disabled) return;
            if (tab.preview !== true || !onPin) return;
            event.preventDefault();
            event.stopPropagation();
            pinCurrentTab();
          }}
        >
          {iconElement ? (
            <span
              aria-hidden="true"
              className="icon-xs relative flex shrink-0 items-center justify-center overflow-visible"
            >
              {iconElement}
            </span>
          ) : null}
          {label}
        </button>
        {tab.actions ? (
          <div
            data-app-shell-tab-no-drag="true"
            className="no-drag absolute end-7 top-1/2 z-30 -translate-y-1/2"
            onMouseDown={(event) => {
              event.stopPropagation();
              onSelect(tab.id);
            }}
            onClick={(event) => event.stopPropagation()}
          >
            {tab.actions}
          </div>
        ) : null}
        {onClose ? (
          <button
            type="button"
            data-app-shell-tab-close-button="true"
            data-app-shell-tab-no-drag="true"
            aria-label={`Close ${accessibleLabel} tab`}
            className={cn(
              "no-drag absolute end-1.75 top-1/2 z-30 flex size-5 -translate-y-1/2 cursor-interaction items-center justify-center rounded-md p-0.5 text-tertiary hover:bg-(--color-background-primary-ghost-hover) hover:text-(--color-text) focus-visible:bg-(--color-background-primary-ghost-hover) focus-visible:text-(--color-text)",
              !isActive &&
                "pointer-events-none opacity-0 group-focus-within/tab:pointer-events-auto group-focus-within/tab:opacity-100 group-hover/tab:pointer-events-auto group-hover/tab:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100",
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeCurrentTabFromDirectInteraction();
            }}
          >
            <CloseIcon className="icon-2xs relative" />
          </button>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        data-app-shell-tab-separator={tab.id}
        data-app-shell-tab-separator-index={separatorIndex}
        className={cn(
          "absolute end-0 h-3 w-px shrink-0 bg-token-border transition-opacity duration-150",
          showSeparator ? "opacity-100" : "opacity-0",
        )}
      />
    </motion.div>
  );

  if (!onClose) {
    return chrome;
  }

  const contextMenuItems = buildAppShellTabContextMenuItems({
    customItems: tab.contextMenuItems,
    canCloseOtherTabs: hasOtherClosableTabs,
    canCloseTabsToRight: hasClosableTabsToRight,
    canCloseAllTabs,
    canPinTab: tab.preview === true && Boolean(onPin),
    canMoveTab: Boolean(onMove) && tab.preview !== true,
    canSplitTab: Boolean(onSplit) && tab.splittable === true,
    moveTarget:
      targetPanelId === "bottom"
        ? { label: "bottom panel", iconKey: "moveDown" }
        : {
            label: `${contentPanelSide} panel`,
            iconKey: contentPanelSide === "left" ? "moveLeft" : "moveRight",
          },
    onClose: closeCurrentTab,
    onCloseOtherTabs: closeOtherTabs,
    onCloseTabsToRight: closeTabsToRight,
    onCloseAllTabs: () => setConfirmingCloseAll(true),
    onPin: pinCurrentTab,
    paneMoves,
    onMove: moveCurrentTab,
    onSplit: splitCurrentTab,
  });

  return (
    <>
      <AppShellTabContextMenu items={contextMenuItems} onOpen={onCloseModeExit}>
        {chrome}
      </AppShellTabContextMenu>
      {confirmingCloseAll ? (
        <CloseAllTabsDialog
          onCancel={() => setConfirmingCloseAll(false)}
          onConfirm={() => {
            setConfirmingCloseAll(false);
            closeAllTabs();
          }}
        />
      ) : null}
    </>
  );
}

/** Closing every tab at once is confirmed, as one stray click would otherwise clear the group. */
function CloseAllTabsDialog({
  onCancel,
  onConfirm,
}: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <NodexDialogContent size="narrow" showCloseButton={false}>
        <NodexDialogFrame>
          <NodexDialogHeader>
            <NodexDialogTitle>Close all tabs?</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody>
            <NodexDialogDescription>All tabs in this group will close.</NodexDialogDescription>
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction onClick={onCancel}>Cancel</NodexDialogAction>
            <NodexDialogAction tone="primary" onClick={onConfirm} autoFocus>
              Close
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogFrame>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function toNativeContextMenuItem(item: AppShellTabContextMenuItem): NativeContextMenuItem {
  if (item.type === "separator") return { type: "separator", id: item.id };
  return {
    id: item.id,
    label: item.label,
    enabled: item.disabled !== true,
    ...(item.iconKey ? { iconKey: item.iconKey } : {}),
  };
}

/**
 * A tab's context menu: native on the desktop, as the platform's tab menus are, and an
 * equivalent page menu elsewhere. Both show each item's icon.
 */
function AppShellTabContextMenu({
  items,
  onOpen,
  children,
}: {
  items: readonly AppShellTabContextMenuItem[];
  onOpen: () => void;
  children: ReactElement;
}) {
  if (items.length === 0) return children;
  if (canShowNativeContextMenu()) {
    const openNativeMenu = async () => {
      onOpen();
      try {
        const selectedId = await showNativeContextMenu(items.map(toNativeContextMenuItem));
        for (const item of items) {
          if (item.type !== "separator" && item.id === selectedId && item.disabled !== true) {
            item.onSelect();
          }
        }
      } catch {
        // The menu could not open; nothing changes.
      }
    };
    return (
      <div
        className="contents"
        onContextMenu={(event) => {
          event.preventDefault();
          void openNativeMenu();
        }}
      >
        {children}
      </div>
    );
  }
  return (
    <NodexContextMenuRoot
      onOpenChange={(open) => {
        if (open) onOpen();
      }}
    >
      <NodexContextMenuTrigger>{children}</NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent className="min-w-36">
          {items.map((item) =>
            item.type === "separator" ? (
              <ContextMenuDivider key={item.id} />
            ) : (
              <NodexContextMenuItem
                key={item.id}
                disabled={item.disabled}
                className={cn(
                  APP_SHELL_TAB_CONTEXT_MENU_ITEM_CLASS,
                  "flex items-center gap-2",
                  item.tone === "destructive" && "text-token-error-foreground",
                  item.disabled && "cursor-default opacity-50",
                )}
                onSelect={item.disabled ? undefined : item.onSelect}
              >
                {item.iconKey ? <NativeMenuIcon iconKey={item.iconKey} /> : null}
                {item.label}
              </NodexContextMenuItem>
            ),
          )}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}

function AppShellLeadingTabChrome({
  tab,
  domId,
  width,
  separatorVisible,
  onContextMenuOpen,
}: {
  tab: AppShellLeadingTab;
  domId: string | undefined;
  width: string;
  separatorVisible: boolean;
  onContextMenuOpen: () => void;
}) {
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const titleOverflows = useAppShellTabTitleOverflow(titleRef, tab.title);
  const chrome = (
    <div
      data-app-shell-leading-tab={tab.id}
      className="no-drag relative my-auto flex shrink-0 items-center overflow-hidden pe-(--app-shell-tab-separator-gutter)"
      style={{ width, marginInlineEnd: APP_SHELL_TAB_GAP_PX }}
    >
      <div
        data-app-shell-tab-surface="true"
        className="group/tab relative flex h-8 w-full max-w-39 shrink-0 items-center overflow-hidden rounded-lg pe-1.75"
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-0 rounded-md border-[length:var(--border-width-hairline)]",
            tab.selected
              ? "border-(--color-border) bg-(--app-shell-tab-selected-background) shadow-[0px_1px_2px_-1px_#00000014]"
              : "border-transparent group-hover/tab:bg-(--color-background-primary-ghost-hover)",
          )}
        />
        <button
          type="button"
          id={domId}
          role="tab"
          aria-selected={tab.selected}
          aria-controls={tab.selected ? tab.panelId : undefined}
          aria-label={tab.statusLabel ? `${tab.title}, ${tab.statusLabel}` : tab.title}
          className={cn(
            "no-drag relative z-10 flex h-full min-w-0 flex-1 items-center gap-2 py-1 ps-2.5 pe-1 text-sm",
            tab.selected ? "text-(--color-text)" : "text-tertiary",
          )}
          onMouseDown={(event) => {
            if (event.button !== 0) return;
            tab.onSelect();
          }}
          onClick={(event) => {
            if (event.detail !== 0) return;
            tab.onSelect();
          }}
          onDoubleClick={(event) => {
            if (event.button !== 0 || !tab.onDoubleClick) return;
            event.preventDefault();
            tab.onDoubleClick();
          }}
        >
          <span
            aria-hidden="true"
            className="icon-xs relative flex shrink-0 items-center justify-center overflow-visible"
          >
            {tab.icon}
          </span>
          <span
            className="relative min-w-0 flex-1 overflow-hidden"
            style={titleOverflows ? { maskImage: TAB_TITLE_FADE_MASK } : undefined}
          >
            <NodexTooltip
              tooltipContent={tab.title}
              delayOpen
              side="bottom"
              align="start"
              style={{
                maxWidth:
                  "min(32rem, var(--nodex-floating-surface-available-width), calc(100vw - 16px))",
              }}
            >
              <span
                ref={titleRef}
                className="block w-full min-w-0 overflow-hidden whitespace-nowrap text-start"
              >
                {tab.title}
              </span>
            </NodexTooltip>
          </span>
        </button>
        {tab.actions ? (
          <div
            data-app-shell-tab-no-drag="true"
            className="no-drag relative z-10 flex shrink-0 items-center"
          >
            {tab.actions}
          </div>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        data-app-shell-tab-separator={tab.id}
        className={cn(
          "absolute end-0 h-3 w-px shrink-0 bg-token-border transition-opacity duration-150",
          separatorVisible ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
  return (
    <AppShellTabContextMenu items={tab.contextMenuItems ?? []} onOpen={onContextMenuOpen}>
      {chrome}
    </AppShellTabContextMenu>
  );
}

function buildAppShellTabContextMenuItems({
  customItems,
  canCloseOtherTabs,
  canCloseTabsToRight,
  canCloseAllTabs,
  canPinTab,
  canMoveTab,
  canSplitTab,
  moveTarget,
  onClose,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onCloseAllTabs,
  onPin,
  paneMoves,
  onMove,
  onSplit,
}: {
  customItems: AppShellTabContextMenuItem[] | undefined;
  canCloseOtherTabs: boolean;
  canCloseTabsToRight: boolean;
  canCloseAllTabs: boolean;
  canPinTab: boolean;
  canMoveTab: boolean;
  canSplitTab: boolean;
  moveTarget: { label: string; iconKey: NativeContextMenuIconKey };
  onClose: () => void;
  onCloseOtherTabs: () => void;
  onCloseTabsToRight: () => void;
  onCloseAllTabs: () => void;
  onPin: () => void;
  paneMoves: readonly { side: WorkbenchPanelSide; onSelect: () => void }[];
  onMove: () => void;
  onSplit: (side: AppShellTabSplitSide) => void;
}): AppShellTabContextMenuItem[] {
  // Codex order: the tab's own actions, where the tab goes, then closing.
  const items: AppShellTabContextMenuItem[] = [...(customItems ?? [])];
  const placementItems: AppShellTabContextMenuItem[] = [];
  if (canPinTab) {
    placementItems.push({
      id: "pin-tab",
      label: "Pin tab",
      iconKey: "pin",
      onSelect: onPin,
    });
  }
  for (const move of paneMoves) {
    placementItems.push({
      id: `move-tab-${move.side}-pane`,
      label: `Move to ${move.side} pane`,
      iconKey: move.side === "left" ? "moveLeft" : "moveRight",
      onSelect: move.onSelect,
    });
  }
  if (canMoveTab) {
    placementItems.push({
      id: "move-tab",
      label: `Move to ${moveTarget.label}`,
      iconKey: moveTarget.iconKey,
      onSelect: onMove,
    });
  }
  if (placementItems.length > 0) {
    if (items.length > 0) items.push({ id: "placement-separator", type: "separator" });
    items.push(...placementItems);
  }
  if (items.length > 0) {
    items.push({ id: "close-tab-separator", type: "separator" });
  }
  items.push(
    {
      id: "close-tab",
      label: "Close",
      iconKey: "close",
      onSelect: onClose,
    },
    {
      id: "close-other-tabs",
      label: "Close other tabs",
      iconKey: "close",
      disabled: !canCloseOtherTabs,
      onSelect: onCloseOtherTabs,
    },
    {
      id: "close-tabs-to-the-right",
      label: "Close tabs to the right",
      iconKey: "close",
      disabled: !canCloseTabsToRight,
      onSelect: onCloseTabsToRight,
    },
    {
      id: "close-all-tabs",
      label: "Close all tabs",
      iconKey: "close",
      disabled: !canCloseAllTabs,
      onSelect: onCloseAllTabs,
    },
  );
  if (canSplitTab) {
    items.push({ id: "split-tab-separator", type: "separator" });
    for (const action of APP_SHELL_SPLIT_ACTIONS) {
      items.push({
        id: `split-tab-${action.side}`,
        label: `Split tab ${action.label}`,
        iconKey: action.iconKey,
        onSelect: () => onSplit(action.side),
      });
    }
  }
  return items;
}

function ContextMenuDivider() {
  return (
    <div className="w-full px-[var(--padding-row-x)] py-1">
      <div className="h-px w-full bg-token-menu-border" />
    </div>
  );
}

function useAppShellTabTitleOverflow(
  titleRef: RefObject<HTMLElement | null>,
  title: string,
): boolean {
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const titleElement = titleRef.current;
    if (!titleElement) {
      setOverflows(false);
      return undefined;
    }

    const measure = () => {
      const nextOverflows = titleElement.scrollWidth - titleElement.clientWidth > 1;
      setOverflows((current) => (current === nextOverflows ? current : nextOverflows));
    };

    measure();

    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    resizeObserver?.observe(titleElement);
    window.addEventListener("resize", measure);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [title, titleRef]);

  return overflows;
}

function makeTabId(controllerId: string, tabId: string): string {
  return `app-shell-tab-${controllerId}-${encodeTabId(tabId)}`;
}

function makeTabPanelId(controllerId: string, tabId: string): string {
  return `app-shell-tabpanel-${controllerId}-${encodeTabId(tabId)}`;
}

function encodeTabId(tabId: string): string {
  return tabId.replace(/[^a-zA-Z0-9_-]/g, "_");
}
