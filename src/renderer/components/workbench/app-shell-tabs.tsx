import {
  dropTargetForElements,
  draggable,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { preserveOffsetOnSource } from "@atlaskit/pragmatic-drag-and-drop/element/preserve-offset-on-source";
import { setCustomNativeDragPreview } from "@atlaskit/pragmatic-drag-and-drop/element/set-custom-native-drag-preview";
import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from "react";
import { NodexTooltip, NodexTooltipProvider } from "@/components/ui/tooltip";
import { CloseIcon } from "@/components/shared/icons";
import {
  NodexContextMenuContent,
  NodexContextMenuItem,
  NodexContextMenuPortal,
  NodexContextMenuRoot,
  NodexContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { PanelId } from "@/lib/types";
import { cn } from "@/lib/utils";
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
  buildAppShellTabFlexSizing,
  buildAppShellTabListWidth,
} from "./app-shell-tab-sizing";

export type AppShellTabSplitSide = "left" | "right" | "up" | "down";

const APP_SHELL_SPLIT_ACTIONS: { side: AppShellTabSplitSide; label: string }[] = [
  { side: "left", label: "left" },
  { side: "right", label: "right" },
  { side: "up", label: "up" },
  { side: "down", label: "down" },
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
  contextLabel?: string;
  icon?: ComponentType<{ className?: string }>;
  iconElement?: ReactNode;
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

export interface AppShellTabPanelRenderContext {
  active: boolean;
}

function makeAppShellTabAccessibleLabel(tab: AppShellTabItem, title: string): string {
  if (typeof tab.titleLabel === "function") return tab.titleLabel(title);
  if (tab.titleLabel) return tab.titleLabel;
  if (tab.contextLabel) return `${tab.contextLabel} · ${title}`;
  return title;
}

function makeAppShellTabTooltip(tab: AppShellTabItem, title: string): ReactNode {
  if (tab.renderTooltip) return tab.renderTooltip(title);
  if (tab.tooltip !== undefined) return tab.tooltip;
  if (tab.contextLabel) return `${tab.contextLabel} · ${title}`;
  return title;
}

const subscribeToStaticAppShellTabTitle = (): (() => void) => () => undefined;

function useAppShellTabTitle(tab: AppShellTabItem): string {
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
  activeTabId: string;
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
  tabScrollEndPaddingPx?: number;
  headerEndInsetPx?: number;
  headerHeight?: "pane" | "toolbar";
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

export function AppShellTabs({
  tabs,
  activeTabId,
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
  tabScrollEndPaddingPx = 0,
  headerEndInsetPx = 0,
  headerHeight = "pane",
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
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
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
  const tabListWidth = buildAppShellTabListWidth({
    tabCount: layoutTabCount,
    trailingWidthPx: afterTabsInlineWidthPx,
    lockedWidthPx: lockedTabWidthPx,
  });
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

    const trailingInsetPx = Math.max(0, Math.ceil(afterTabsInlineWidthPx + tabScrollEndPaddingPx));
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
        rootMargin: `0px -${trailingInsetPx}px 0px 0px`,
        threshold: 0.99,
      },
    );
    observer.observe(leftSentinel);
    observer.observe(rightSentinel);
    return () => {
      observer.disconnect();
    };
  }, [afterTabsInlineWidthPx, tabScrollEndPaddingPx, tabs.length]);

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
        <div
          className={cn(
            "isolate flex min-w-0 shrink-0 select-none items-center bg-token-main-surface-primary px-2 [contain:layout_paint]",
            headerHeight === "toolbar" ? "h-toolbar" : "h-toolbar-pane",
          )}
        >
          {beforeList ? (
            <div role="presentation" className="no-drag my-auto flex shrink-0 items-center">
              {beforeList}
            </div>
          ) : null}
          <div
            ref={tabRowRef}
            data-panel-tab-row={
              panelTabDnd ? `${panelTabDnd.panelId}:${panelTabDnd.leafId}` : undefined
            }
            data-app-shell-tab-close-mode={lockedTabWidthPx !== null ? "true" : undefined}
            className="hide-scrollbar relative isolate flex h-full min-w-0 flex-1 scroll-px-1 items-center overflow-x-auto overflow-y-hidden [contain:layout_paint]"
            style={{
              scrollPaddingInlineEnd: tabScrollEndPaddingPx,
            }}
            onPointerLeave={exitTabCloseMode}
          >
            <div
              aria-hidden="true"
              data-app-shell-tab-edge-fade="start"
              data-clipped={leftEdgeClipped ? "true" : "false"}
              className={cn(
                "pointer-events-none sticky start-0 z-20 h-full w-0 transition-opacity duration-100 after:absolute after:start-0 after:inset-y-0 after:w-10 after:bg-linear-to-l after:from-transparent after:to-token-main-surface-primary after:content-['']",
                leftEdgeClipped ? "opacity-100" : "opacity-0",
              )}
            />
            <span ref={leftEdgeSentinelRef} aria-hidden="true" className="h-px w-px shrink-0" />
            {tabList}
            <span ref={rightEdgeSentinelRef} aria-hidden="true" className="h-px w-px shrink-0" />
            {afterTabsInline ? (
              <div
                ref={afterTabsInlineRef}
                className="no-drag sticky right-0 z-10 flex h-full shrink-0 items-center bg-token-main-surface-primary"
              >
                {afterTabsInline}
              </div>
            ) : null}
            {tabRowPreview ? <PanelTabInsertionIndicator intent={tabRowPreview} /> : null}
            <div
              aria-hidden="true"
              data-app-shell-tab-edge-fade="end"
              data-clipped={rightEdgeClipped ? "true" : "false"}
              className={cn(
                "pointer-events-none sticky end-0 z-20 h-full w-0 transition-opacity duration-100 after:absolute after:end-0 after:inset-y-0 after:w-10 after:bg-linear-to-r after:from-transparent after:to-token-main-surface-primary after:content-['']",
                rightEdgeClipped ? "opacity-100" : "opacity-0",
              )}
              style={{ right: tabScrollEndPaddingPx }}
            />
          </div>
          {afterListSticky ? (
            <div role="presentation" className="no-drag my-auto flex shrink-0 items-center">
              {afterListSticky}
            </div>
          ) : null}
          {afterList ? (
            <div role="presentation" className="no-drag my-auto flex shrink-0 items-center">
              {afterList}
            </div>
          ) : null}
          {headerEndInsetPx > 0 ? (
            <div
              aria-hidden="true"
              className="no-drag pointer-events-none h-full shrink-0"
              style={{ width: headerEndInsetPx }}
            />
          ) : null}
        </div>

        {activeTab ? (
          <div ref={bodyRef} className="relative min-h-0 flex-1 overflow-hidden">
            {renderPanel(activeTab)}
          </div>
        ) : null}
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
  const Icon = tab.icon;
  const iconElement = tab.iconElement ?? (Icon ? <Icon className="icon-xs shrink-0" /> : null);
  const dataTabId = tab.domTabId ?? tab.id;
  const tabId = makeTabId(controllerId, tab.id);
  const accessibleLabel = makeAppShellTabAccessibleLabel(tab, resolvedTitle);
  const tooltipContent = makeAppShellTabTooltip(tab, resolvedTitle);
  const titleRef = useRef<HTMLSpanElement | null>(null);
  const titleOverflows = useAppShellTabTitleOverflow(titleRef, resolvedTitle);
  const title = (
    <span
      ref={titleRef}
      data-app-shell-tab-title={tab.id}
      className={cn(
        "block w-full min-w-0 overflow-hidden whitespace-nowrap text-start",
        tab.preview && "italic",
      )}
    >
      {resolvedTitle}
    </span>
  );
  const label = (
    <span className="relative min-w-0 flex-1 overflow-hidden">
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
        <span className="flex min-w-0 items-center gap-1">
          {tab.contextLabel ? (
            <>
              <span
                data-app-shell-tab-context-label={tab.id}
                className="max-w-20 shrink truncate text-xs text-token-description-foreground"
              >
                {tab.contextLabel}
              </span>
              <span aria-hidden="true" className="shrink-0 text-token-description-foreground">
                ·
              </span>
            </>
          ) : null}
          {title}
        </span>
      </NodexTooltip>
      {titleOverflows ? (
        <span
          aria-hidden="true"
          data-app-shell-tab-title-fade={tab.id}
          className={cn(
            "pointer-events-none absolute inset-y-0 end-0 z-20 w-7 bg-linear-to-r from-transparent to-[85%]",
            isActive
              ? "to-[var(--app-shell-tab-background)]"
              : "to-token-main-surface-primary group-hover/tab:to-[var(--app-shell-tab-background)]",
          )}
        />
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
  const targetPanelId = controllerId.includes("bottom") ? "right" : "bottom";
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
        className="group group/tab relative flex h-7 w-full max-w-39 shrink-0 items-center overflow-hidden rounded-lg bg-token-main-surface-primary px-2 py-1"
        style={
          {
            "--app-shell-tab-background":
              "color-mix(in srgb, var(--color-token-foreground) 5%, var(--color-token-main-surface-primary))",
          } as CSSProperties
        }
        onMouseDown={(event) => {
          if (event.button !== 1 || !onClose) return;
          event.preventDefault();
          event.stopPropagation();
          closeCurrentTabFromDirectInteraction();
        }}
      >
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-0 rounded-lg group-hover/tab:bg-[var(--app-shell-tab-background)]",
            (isActive || isDragging) && "bg-[var(--app-shell-tab-background)]",
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
            "no-drag relative z-10 flex min-w-0 flex-1 items-center gap-2 text-sm",
            onClose &&
              (isActive ? "pe-3.5" : "group-focus-within/tab:pe-3.5 group-hover/tab:pe-3.5"),
            isActive ? "text-token-text-primary" : "text-token-text-secondary",
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
        {onClose ? (
          <button
            type="button"
            data-app-shell-tab-close-button="true"
            data-app-shell-tab-no-drag="true"
            aria-label={`Close ${accessibleLabel} tab`}
            className={cn(
              "no-drag absolute end-1 top-1/2 z-30 flex size-5 -translate-y-1/2 cursor-interaction items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-foreground/8 hover:text-token-text-primary focus-visible:bg-token-foreground/8 focus-visible:text-token-text-primary",
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
            <CloseIcon className="icon-xs relative" />
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
    canPinTab: tab.preview === true && Boolean(onPin),
    canMoveTab: Boolean(onMove) && tab.preview !== true,
    canSplitTab: Boolean(onSplit) && tab.splittable === true,
    targetPanelId,
    onClose: closeCurrentTab,
    onCloseOtherTabs: closeOtherTabs,
    onCloseTabsToRight: closeTabsToRight,
    onPin: pinCurrentTab,
    onMove: moveCurrentTab,
    onSplit: splitCurrentTab,
  });

  return (
    <NodexContextMenuRoot
      onOpenChange={(open) => {
        if (!open) return;
        onCloseModeExit();
      }}
    >
      <NodexContextMenuTrigger>{chrome}</NodexContextMenuTrigger>
      <NodexContextMenuPortal>
        <NodexContextMenuContent className="min-w-36">
          {contextMenuItems.map((item) =>
            item.type === "separator" ? (
              <ContextMenuDivider key={item.id} />
            ) : (
              <NodexContextMenuItem
                key={item.id}
                disabled={item.disabled}
                className={cn(
                  "cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-sm outline-hidden hover:bg-token-list-hover-background focus:bg-token-list-hover-background",
                  item.tone === "destructive" && "text-token-error-foreground",
                  item.disabled && "cursor-default opacity-50",
                )}
                onSelect={item.disabled ? undefined : item.onSelect}
              >
                {item.label}
              </NodexContextMenuItem>
            ),
          )}
        </NodexContextMenuContent>
      </NodexContextMenuPortal>
    </NodexContextMenuRoot>
  );
}

function buildAppShellTabContextMenuItems({
  customItems,
  canCloseOtherTabs,
  canCloseTabsToRight,
  canPinTab,
  canMoveTab,
  canSplitTab,
  targetPanelId,
  onClose,
  onCloseOtherTabs,
  onCloseTabsToRight,
  onPin,
  onMove,
  onSplit,
}: {
  customItems: AppShellTabContextMenuItem[] | undefined;
  canCloseOtherTabs: boolean;
  canCloseTabsToRight: boolean;
  canPinTab: boolean;
  canMoveTab: boolean;
  canSplitTab: boolean;
  targetPanelId: string;
  onClose: () => void;
  onCloseOtherTabs: () => void;
  onCloseTabsToRight: () => void;
  onPin: () => void;
  onMove: () => void;
  onSplit: (side: AppShellTabSplitSide) => void;
}): AppShellTabContextMenuItem[] {
  const items: AppShellTabContextMenuItem[] = [...(customItems ?? [])];
  if (items.length > 0) {
    items.push({ id: "close-tab-separator", type: "separator" });
  }
  items.push(
    {
      id: "close-tab",
      label: "Close",
      onSelect: onClose,
    },
    {
      id: "close-other-tabs",
      label: "Close other tabs",
      disabled: !canCloseOtherTabs,
      onSelect: onCloseOtherTabs,
    },
    {
      id: "close-tabs-to-the-right",
      label: "Close tabs to the right",
      disabled: !canCloseTabsToRight,
      onSelect: onCloseTabsToRight,
    },
  );
  if (canPinTab) {
    items.push({
      id: "pin-tab",
      label: "Pin tab",
      onSelect: onPin,
    });
  }
  if (canMoveTab) {
    items.push({
      id: "move-tab",
      label: `Move to ${targetPanelId === "bottom" ? "bottom panel" : "right panel"}`,
      onSelect: onMove,
    });
  }
  if (canSplitTab) {
    items.push({ id: "split-tab-separator", type: "separator" });
    for (const action of APP_SHELL_SPLIT_ACTIONS) {
      items.push({
        id: `split-tab-${action.side}`,
        label: `Split tab ${action.label}`,
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
