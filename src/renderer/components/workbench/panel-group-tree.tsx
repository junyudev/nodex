import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/adapter/element-adapter";
import type {
  DragLocationHistory,
  DropTargetRecord,
} from "@atlaskit/pragmatic-drag-and-drop/types";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { AppShellTabs, type AppShellTabItem } from "./app-shell-tabs";
import { markContextualKeyboardActionPresentationActive } from "@/lib/contextual-keyboard-actions";
import {
  findWorkbenchPanelLeaf,
  getWorkbenchPanelTopLeftLeafId,
  getWorkbenchPanelTopRightLeafId,
} from "../../../shared/workbench-panel-layout";
import type {
  PanelId,
  WorkbenchPanelLayout,
  WorkbenchPanelNode,
  WorkbenchPanelSplitSide,
  WorkbenchPanelSplitBranch,
  WorkbenchPanelSplitLeaf,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  buildPanelGroupBodyDropData,
  buildPanelTabRowDropData,
  isPanelGroupBodyDropData,
  isPanelTabDragData,
  isPanelTabRowDropData,
  resolvePanelGroupBodyDropZone,
  resolvePanelTabDropCommit,
  resolvePanelTabRowInsertion,
  resolveSameLeafInsertionIndex,
  type PanelGroupBodyDropZone,
  type PanelTabDragData,
  type PanelTabDropIntent,
  type PanelTabRect,
} from "./panel-tab-dnd";
import { PanelTabInsertionIndicator } from "./panel-tab-insertion-indicator";
import { WorkbenchPaneTitlebar } from "./workbench-titlebar-context";

const PANEL_GROUP_RATIO_ACK_EPSILON = 0.000_001;

interface PanelGroupTreeProps {
  sessionId: string;
  panelId: PanelId;
  layout: WorkbenchPanelLayout;
  tabItemsByLeafId: Record<string, AppShellTabItem[]>;
  activeTabIdsByLeafId: Record<string, string | null>;
  renderEmptyLeaf: (leafId: string) => ReactNode;
  renderAfterTabs?: (leafId: string) => ReactNode;
  renderAfterList?: (leafId: string) => ReactNode;
  headerStartInsetPx?: number;
  headerEndInsetPx?: number;
  onSelectTab: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  onDirectCloseTab?: (leafId: string, tabId: string) => void;
  onPinTab?: (leafId: string, tabId: string) => void;
  onReorderTab: (leafId: string, tabId: string, targetIndex: number) => void;
  onMoveTab: (
    tabId: string,
    targetPanelId: PanelId,
    targetLeafId: string,
    targetIndex?: number,
    splitTarget?: { leafId: string; side: WorkbenchPanelSplitSide },
  ) => void;
  onSplitGroup: (leafId: string, side: WorkbenchPanelSplitSide, tabId?: string) => void;
  onFocusGroup?: (leafId: string) => void;
  onActivateGroup: (leafId: string, tabId?: string | null) => void;
  onResizeGroup: (branchId: string, ratio: number) => Promise<void> | void;
}

export function PanelGroupTree({
  sessionId,
  panelId,
  layout,
  tabItemsByLeafId,
  activeTabIdsByLeafId,
  renderEmptyLeaf,
  renderAfterTabs,
  renderAfterList,
  headerStartInsetPx,
  headerEndInsetPx,
  onSelectTab,
  onCloseTab,
  onDirectCloseTab,
  onPinTab,
  onReorderTab,
  onMoveTab,
  onSplitGroup,
  onFocusGroup,
  onActivateGroup,
  onResizeGroup,
}: PanelGroupTreeProps) {
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [previewIntent, setPreviewIntent] = useState<PanelTabDropIntent | null>(null);

  const clearDragState = () => {
    setActiveDragId(null);
    setPreviewIntent(null);
  };

  useEffect(() => {
    return monitorForElements({
      canMonitor: ({ source }) =>
        isPanelTabDragData(source.data) && source.data.sessionId === sessionId,
      onDragStart: ({ source }) => {
        if (!isPanelTabDragData(source.data)) return;
        setActiveDragId(source.data.tabId);
        setPreviewIntent(null);
      },
      onDrag: ({ source, location }) => {
        if (!isPanelTabDragData(source.data)) return;
        updatePreviewIntent(source.data, location, panelId, setPreviewIntent);
      },
      onDropTargetChange: ({ source, location }) => {
        if (!isPanelTabDragData(source.data)) return;
        updatePreviewIntent(source.data, location, panelId, setPreviewIntent);
      },
      onDrop: ({ source, location }) => {
        if (!isPanelTabDragData(source.data)) {
          clearDragState();
          return;
        }
        const intent = resolvePanelTabDropIntent(source.data, location);
        clearDragState();
        if (!intent || intent.panelId !== panelId) return;
        const commit = resolvePanelTabDropCommit(source.data, intent);
        if (!commit) return;
        if (commit.kind === "reorder") {
          onReorderTab(commit.leafId, commit.tabId, commit.targetIndex);
          return;
        }
        if (commit.kind === "move") {
          onMoveTab(commit.tabId, commit.targetPanelId, commit.targetLeafId, commit.targetIndex);
          return;
        }
        onMoveTab(commit.tabId, commit.targetPanelId, commit.targetLeafId, undefined, {
          leafId: commit.targetLeafId,
          side: commit.side,
        });
      },
    });
  }, [onMoveTab, onReorderTab, panelId, sessionId]);

  const maximizedLeafId = layout.maximizedLeafId ?? null;
  const maximizedLeaf = maximizedLeafId ? findWorkbenchPanelLeaf(layout, maximizedLeafId) : null;
  const activeLeafId = layout.activeLeafId;
  const rootNode = maximizedLeaf ?? layout.root;
  const headerStartInsetLeafId =
    headerStartInsetPx && headerStartInsetPx > 0 ? getWorkbenchPanelTopLeftLeafId(rootNode) : null;
  const headerEndInsetLeafId =
    headerEndInsetPx && headerEndInsetPx > 0 ? getWorkbenchPanelTopRightLeafId(rootNode) : null;
  const afterListLeafId = renderAfterList ? getWorkbenchPanelTopRightLeafId(rootNode) : null;
  return (
    <div
      data-panel-group-tree={panelId}
      className="h-full min-h-0 w-full overflow-hidden bg-token-main-surface-primary"
    >
      <PanelGroupNode
        sessionId={sessionId}
        panelId={panelId}
        node={rootNode}
        titlebar={panelId === "right"}
        activeLeafId={activeLeafId}
        activeDragId={activeDragId}
        previewIntent={previewIntent}
        tabItemsByLeafId={tabItemsByLeafId}
        activeTabIdsByLeafId={activeTabIdsByLeafId}
        renderEmptyLeaf={renderEmptyLeaf}
        renderAfterTabs={renderAfterTabs}
        renderAfterList={renderAfterList}
        headerStartInsetPx={headerStartInsetPx}
        headerStartInsetLeafId={headerStartInsetLeafId}
        headerEndInsetPx={headerEndInsetPx}
        headerEndInsetLeafId={headerEndInsetLeafId}
        afterListLeafId={afterListLeafId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onDirectCloseTab={onDirectCloseTab}
        onPinTab={onPinTab}
        onReorderTab={onReorderTab}
        onMoveTab={onMoveTab}
        onSplitGroup={onSplitGroup}
        onFocusGroup={onFocusGroup}
        onActivateGroup={onActivateGroup}
        onResizeGroup={onResizeGroup}
      />
    </div>
  );
}

function updatePreviewIntent(
  source: PanelTabDragData,
  location: DragLocationHistory,
  panelId: PanelId,
  setPreviewIntent: Dispatch<SetStateAction<PanelTabDropIntent | null>>,
) {
  const nextIntent = resolvePanelTabDropIntent(source, location);
  const scopedIntent = nextIntent?.panelId === panelId ? nextIntent : null;
  setPreviewIntent((currentIntent) =>
    arePanelTabDropIntentsEqual(currentIntent, scopedIntent) ? currentIntent : scopedIntent,
  );
}

function resolvePanelTabDropIntent(
  source: PanelTabDragData,
  location: DragLocationHistory,
): PanelTabDropIntent | null {
  const rowRecord = findDropTargetRecord(location.current.dropTargets, isPanelTabRowDropData);
  if (rowRecord && isPanelTabRowDropData(rowRecord.data)) {
    const rowElement = rowRecord.element;
    if (!(rowElement instanceof HTMLElement)) return null;
    const rowRect = rowElement.getBoundingClientRect();
    const tabRects = readPanelTabRects(rowElement);
    const insertion = resolvePanelTabRowInsertion({
      pointerClientX: location.current.input.clientX,
      rowLeft: rowRect.left,
      rowScrollLeft: rowElement.scrollLeft,
      tabRects,
    });
    if (source.panelId === rowRecord.data.panelId && source.leafId === rowRecord.data.leafId) {
      const tabIds = tabRects.map((tabRect) => tabRect.id);
      const normalizedIndex = resolveSameLeafInsertionIndex({
        tabIds,
        sourceTabId: source.tabId,
        targetIndex: insertion.targetIndex,
      });
      if (normalizedIndex === null) return null;
    }
    return {
      kind: "tab-row",
      panelId: rowRecord.data.panelId,
      leafId: rowRecord.data.leafId,
      targetIndex: insertion.targetIndex,
      markerLeft: insertion.markerLeft,
    };
  }

  const bodyRecord = findDropTargetRecord(location.current.dropTargets, isPanelGroupBodyDropData);
  if (!bodyRecord || !isPanelGroupBodyDropData(bodyRecord.data)) return null;
  const bodyRect = bodyRecord.element.getBoundingClientRect();
  if (bodyRect.width <= 0 || bodyRect.height <= 0) return null;

  return {
    kind: "body",
    panelId: bodyRecord.data.panelId,
    leafId: bodyRecord.data.leafId,
    zone: resolvePanelGroupBodyDropZone({
      pointerClientX: location.current.input.clientX,
      pointerClientY: location.current.input.clientY,
      rect: {
        left: bodyRect.left,
        top: bodyRect.top,
        width: bodyRect.width,
        height: bodyRect.height,
      },
    }),
  };
}

function findDropTargetRecord(
  dropTargets: readonly DropTargetRecord[],
  predicate: (value: Record<string | symbol, unknown>) => boolean,
): DropTargetRecord | null {
  return dropTargets.find((record) => predicate(record.data)) ?? null;
}

function readPanelTabRects(rowElement: HTMLElement): PanelTabRect[] {
  return Array.from(rowElement.querySelectorAll<HTMLElement>("[data-panel-tab-id]"))
    .map((tabElement) => {
      const rect = tabElement.getBoundingClientRect();
      return {
        id: tabElement.dataset.panelTabId ?? "",
        left: rect.left,
        right: rect.right,
      };
    })
    .filter((rect) => rect.id.length > 0);
}

function arePanelTabDropIntentsEqual(
  currentIntent: PanelTabDropIntent | null,
  nextIntent: PanelTabDropIntent | null,
): boolean {
  if (currentIntent === nextIntent) return true;
  if (!currentIntent || !nextIntent) return false;
  if (currentIntent.kind !== nextIntent.kind) return false;
  if (currentIntent.panelId !== nextIntent.panelId || currentIntent.leafId !== nextIntent.leafId)
    return false;
  if (currentIntent.kind === "tab-row" && nextIntent.kind === "tab-row") {
    return (
      currentIntent.targetIndex === nextIntent.targetIndex &&
      currentIntent.markerLeft === nextIntent.markerLeft
    );
  }
  if (currentIntent.kind === "body" && nextIntent.kind === "body") {
    return currentIntent.zone === nextIntent.zone;
  }
  return false;
}

function PanelGroupNode(props: {
  sessionId: string;
  panelId: PanelId;
  node: WorkbenchPanelNode;
  titlebar: boolean;
  activeLeafId: string;
  activeDragId: string | null;
  previewIntent: PanelTabDropIntent | null;
  tabItemsByLeafId: Record<string, AppShellTabItem[]>;
  activeTabIdsByLeafId: Record<string, string | null>;
  renderEmptyLeaf: (leafId: string) => ReactNode;
  renderAfterTabs?: (leafId: string) => ReactNode;
  renderAfterList?: (leafId: string) => ReactNode;
  headerStartInsetPx?: number;
  headerStartInsetLeafId: string | null;
  headerEndInsetPx?: number;
  headerEndInsetLeafId: string | null;
  afterListLeafId: string | null;
  onSelectTab: (leafId: string, tabId: string) => void;
  onCloseTab: (leafId: string, tabId: string) => void;
  onDirectCloseTab?: (leafId: string, tabId: string) => void;
  onPinTab?: (leafId: string, tabId: string) => void;
  onReorderTab: (leafId: string, tabId: string, targetIndex: number) => void;
  onMoveTab: (
    tabId: string,
    targetPanelId: PanelId,
    targetLeafId: string,
    targetIndex?: number,
    splitTarget?: { leafId: string; side: WorkbenchPanelSplitSide },
  ) => void;
  onSplitGroup: (leafId: string, side: WorkbenchPanelSplitSide, tabId?: string) => void;
  onFocusGroup?: (leafId: string) => void;
  onActivateGroup: (leafId: string, tabId?: string | null) => void;
  onResizeGroup: (branchId: string, ratio: number) => Promise<void> | void;
}) {
  if (props.node.type === "leaf") {
    return <PanelGroupLeaf {...props} leaf={props.node} />;
  }
  return <PanelGroupSplit {...props} branch={props.node} />;
}

function PanelGroupSplit({
  branch,
  onResizeGroup,
  ...props
}: Omit<Parameters<typeof PanelGroupNode>[0], "node"> & { branch: WorkbenchPanelSplitBranch }) {
  const [optimisticRatio, setOptimisticRatio] = useState<number | null>(null);
  const resizeCommitIdRef = useRef(0);
  const ratio = optimisticRatio ?? branch.ratio;
  const isHorizontal = branch.direction === "horizontal";

  useEffect(() => {
    setOptimisticRatio((currentRatio) => {
      if (currentRatio === null) return null;
      if (Math.abs(currentRatio - branch.ratio) > PANEL_GROUP_RATIO_ACK_EPSILON)
        return currentRatio;
      return null;
    });
  }, [branch.ratio]);

  const commitRatio = (nextRatio: number) => {
    const commitId = resizeCommitIdRef.current + 1;
    resizeCommitIdRef.current = commitId;
    setOptimisticRatio(nextRatio);
    void (async () => {
      try {
        await onResizeGroup(branch.id, nextRatio);
      } catch {
        if (resizeCommitIdRef.current !== commitId) return;
        setOptimisticRatio(null);
      }
    })();
  };
  const updateDragRatio = (nextRatio: number | null) => {
    if (nextRatio !== null) resizeCommitIdRef.current += 1;
    setOptimisticRatio(nextRatio);
  };

  return (
    <div
      data-panel-group-branch-id={branch.id}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0",
        isHorizontal ? "flex-row" : "flex-col",
      )}
    >
      <div
        className="min-h-0 min-w-0 overflow-hidden"
        style={
          isHorizontal
            ? { flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }
            : { flexBasis: `${ratio * 100}%`, flexGrow: 0, flexShrink: 0 }
        }
      >
        <PanelGroupNode {...props} node={branch.first} onResizeGroup={onResizeGroup} />
      </div>
      <PanelGroupSash
        branch={branch}
        ratio={ratio}
        onDragRatio={updateDragRatio}
        onCommitRatio={commitRatio}
      />
      <div
        className={cn(
          "min-h-0 min-w-0 flex-1 overflow-hidden border-token-border",
          isHorizontal ? "border-l" : "border-t",
        )}
      >
        <PanelGroupNode
          {...props}
          node={branch.second}
          titlebar={props.titlebar && isHorizontal}
          onResizeGroup={onResizeGroup}
        />
      </div>
    </div>
  );
}

function PanelGroupLeaf({
  sessionId,
  panelId,
  leaf,
  titlebar,
  activeLeafId,
  activeDragId,
  previewIntent,
  tabItemsByLeafId,
  activeTabIdsByLeafId,
  renderEmptyLeaf,
  renderAfterTabs,
  renderAfterList,
  headerStartInsetPx,
  headerStartInsetLeafId,
  headerEndInsetPx,
  headerEndInsetLeafId,
  afterListLeafId,
  onSelectTab,
  onCloseTab,
  onDirectCloseTab,
  onPinTab,
  onMoveTab,
  onSplitGroup,
  onFocusGroup,
  onActivateGroup,
}: Omit<Parameters<typeof PanelGroupNode>[0], "node"> & { leaf: WorkbenchPanelSplitLeaf }) {
  const tabs = tabItemsByLeafId[leaf.id] ?? [];
  const activeTabId = activeTabIdsByLeafId[leaf.id] ?? tabs[0]?.id ?? null;
  const isActive = leaf.id === activeLeafId;
  const afterTabs = renderAfterTabs?.(leaf.id) ?? null;
  const afterList = leaf.id === afterListLeafId ? (renderAfterList?.(leaf.id) ?? null) : null;
  const leafHeaderStartInsetPx = leaf.id === headerStartInsetLeafId ? headerStartInsetPx : 0;
  const leafHeaderEndInsetPx = leaf.id === headerEndInsetLeafId ? headerEndInsetPx : 0;
  const resolvedBeforeList =
    leafHeaderStartInsetPx && leafHeaderStartInsetPx > 0 ? (
      <div
        aria-hidden="true"
        className="pointer-events-none h-full shrink-0"
        style={{ width: leafHeaderStartInsetPx }}
      />
    ) : null;
  const splittableTabCount = tabs.filter((tab) => tab.splittable === true).length;
  const activateLeaf = () => {
    if (isActive) return;
    onActivateGroup(leaf.id, activeTabId);
  };
  const focusLeaf = () => {
    if (activeTabId) {
      markContextualKeyboardActionPresentationActive(activeTabId);
    }
    onFocusGroup?.(leaf.id);
  };
  const focusAndActivateLeaf = () => {
    focusLeaf();
    activateLeaf();
  };

  return (
    <div
      data-panel-group-leaf-id={leaf.id}
      data-panel-group-leaf-active={isActive ? "true" : "false"}
      className={cn(
        "relative h-full min-h-0 min-w-0 overflow-hidden bg-token-main-surface-primary",
        isActive && "ring-1 ring-inset ring-token-foreground/10",
      )}
      onFocusCapture={focusLeaf}
      onPointerDownCapture={focusAndActivateLeaf}
    >
      {tabs.length > 0 && activeTabId ? (
        <AppShellTabs
          titlebar={titlebar}
          tabs={tabs}
          activeTabId={activeTabId}
          panelId={`${panelId}:${leaf.id}`}
          controllerId={`session-${sessionId}-${panelId}-${leaf.id}`}
          onSelect={(tabId) => {
            markContextualKeyboardActionPresentationActive(tabId);
            onSelectTab(leaf.id, tabId);
          }}
          onCloseTab={(tabId) => onCloseTab(leaf.id, tabId)}
          onDirectCloseTab={
            onDirectCloseTab ? (tabId) => onDirectCloseTab(leaf.id, tabId) : undefined
          }
          onPinTab={onPinTab ? (tabId) => onPinTab(leaf.id, tabId) : undefined}
          onMoveTab={(tabId, targetPanelId) =>
            onMoveTab(tabId, targetPanelId === "bottom" ? "bottom" : "right", leaf.id)
          }
          onSplitTab={
            splittableTabCount > 1 ? (tabId, side) => onSplitGroup(leaf.id, side, tabId) : undefined
          }
          panelTabDnd={{
            sessionId,
            panelId,
            leafId: leaf.id,
            activeDragId,
            previewIntent,
          }}
          beforeList={resolvedBeforeList}
          afterTabsInline={afterTabs}
          afterList={afterList}
          bodyOverlay={<PanelGroupBodyDropOverlay leafId={leaf.id} previewIntent={previewIntent} />}
          headerEndInsetPx={leafHeaderEndInsetPx}
          headerHeight="toolbar"
        />
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <PanelGroupEmptyHeader
            titlebar={titlebar}
            sessionId={sessionId}
            panelId={panelId}
            leafId={leaf.id}
            activeDragId={activeDragId}
            previewIntent={previewIntent}
            beforeList={resolvedBeforeList}
            afterTabs={afterTabs}
            afterList={afterList}
          >
            {leafHeaderEndInsetPx && leafHeaderEndInsetPx > 0 ? (
              <div
                aria-hidden="true"
                className="pointer-events-none h-full shrink-0"
                style={{ width: leafHeaderEndInsetPx }}
              />
            ) : null}
          </PanelGroupEmptyHeader>
          <PanelGroupEmptyBody
            sessionId={sessionId}
            panelId={panelId}
            leafId={leaf.id}
            previewIntent={previewIntent}
          >
            {renderEmptyLeaf(leaf.id)}
          </PanelGroupEmptyBody>
        </div>
      )}
    </div>
  );
}

function PanelGroupSash({
  branch,
  ratio,
  onDragRatio,
  onCommitRatio,
}: {
  branch: WorkbenchPanelSplitBranch;
  ratio: number;
  onDragRatio: (ratio: number | null) => void;
  onCommitRatio: (ratio: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isHorizontal = branch.direction === "horizontal";

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const parent = containerRef.current?.parentElement;
    if (!parent) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const resizeHandle = event.currentTarget;
    const pointerId = event.pointerId;
    const rect = parent.getBoundingClientRect();

    const readRatio = (clientX: number, clientY: number) => {
      const raw = isHorizontal
        ? (clientX - rect.left) / Math.max(1, rect.width)
        : (clientY - rect.top) / Math.max(1, rect.height);
      return Math.min(0.85, Math.max(0.15, raw));
    };

    const handleMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault();
      onDragRatio(readRatio(moveEvent.clientX, moveEvent.clientY));
    };
    const handleUp = (upEvent: PointerEvent) => {
      upEvent.preventDefault();
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture(pointerId);
      }
      onCommitRatio(readRatio(upEvent.clientX, upEvent.clientY));
    };
    const handleCancel = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      if (resizeHandle.hasPointerCapture?.(pointerId)) {
        resizeHandle.releasePointerCapture(pointerId);
      }
      onDragRatio(null);
    };

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
    window.addEventListener("pointercancel", handleCancel, { once: true });
  };

  return (
    <div
      ref={containerRef}
      role="separator"
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(ratio * 100)}
      className={cn(
        "group/sash relative z-20 flex shrink-0 touch-none select-none",
        isHorizontal ? "w-0 cursor-col-resize" : "h-0 cursor-row-resize",
      )}
      onPointerDown={startResize}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onCommitRatio(0.5);
      }}
    >
      <div
        className={cn(
          "absolute flex",
          isHorizontal ? "top-0 bottom-0 -left-2 w-4" : "left-0 right-0 -top-2 h-4",
        )}
      >
        <div
          className={cn(
            "pointer-events-none m-auto opacity-0 group-hover/sash:opacity-100 group-active/sash:opacity-100",
            isHorizontal
              ? "h-full w-px bg-linear-to-b from-transparent via-token-foreground/25 to-transparent"
              : "h-px w-full bg-linear-to-r from-transparent via-token-foreground/25 to-transparent",
          )}
        />
      </div>
    </div>
  );
}

function PanelGroupEmptyHeader({
  sessionId,
  panelId,
  leafId,
  activeDragId,
  previewIntent,
  beforeList,
  afterTabs,
  afterList,
  children,
  titlebar,
}: {
  sessionId: string;
  panelId: PanelId;
  leafId: string;
  activeDragId: string | null;
  previewIntent: PanelTabDropIntent | null;
  beforeList?: ReactNode;
  afterTabs: ReactNode;
  afterList?: ReactNode;
  children: ReactNode;
  titlebar: boolean;
}) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const tabRowPreview =
    previewIntent?.kind === "tab-row" &&
    previewIntent.panelId === panelId &&
    previewIntent.leafId === leafId
      ? previewIntent
      : null;

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return undefined;

    return dropTargetForElements({
      element,
      canDrop: ({ source }) =>
        isPanelTabDragData(source.data) && source.data.sessionId === sessionId,
      getIsSticky: () => true,
      getData: () => buildPanelTabRowDropData({ sessionId, panelId, leafId }),
    });
  }, [leafId, panelId, sessionId]);

  return (
    <WorkbenchPaneTitlebar enabled={titlebar}>
      <div
        className={cn(
          "isolate flex h-toolbar min-w-0 shrink-0 select-none items-center px-2 [contain:layout_paint]",
          titlebar ? "bg-transparent" : "bg-token-main-surface-primary",
        )}
      >
        {beforeList ? (
          <div role="presentation" className="my-auto flex shrink-0 items-center">
            {beforeList}
          </div>
        ) : null}
        <div
          ref={rowRef}
          data-panel-tab-row={`${panelId}:${leafId}`}
          className="relative isolate flex h-full min-w-0 flex-1 items-center [contain:layout_paint]"
        >
          {afterTabs ? (
            <div role="presentation" className="flex h-full shrink-0 items-center">
              {afterTabs}
            </div>
          ) : null}
          {tabRowPreview && activeDragId ? (
            <PanelTabInsertionIndicator intent={tabRowPreview} />
          ) : null}
        </div>
        {afterList ? (
          <div role="presentation" className="my-auto flex shrink-0 items-center">
            {afterList}
          </div>
        ) : null}
        {children}
      </div>
    </WorkbenchPaneTitlebar>
  );
}

function PanelGroupEmptyBody({
  sessionId,
  panelId,
  leafId,
  previewIntent,
  children,
}: {
  sessionId: string;
  panelId: PanelId;
  leafId: string;
  previewIntent: PanelTabDropIntent | null;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return undefined;

    return dropTargetForElements({
      element,
      canDrop: ({ source }) =>
        isPanelTabDragData(source.data) && source.data.sessionId === sessionId,
      getIsSticky: () => true,
      getData: () => buildPanelGroupBodyDropData({ sessionId, panelId, leafId }),
    });
  }, [leafId, panelId, sessionId]);

  return (
    <div ref={bodyRef} className="relative min-h-0 flex-1">
      <PanelGroupBodyDropOverlay leafId={leafId} previewIntent={previewIntent} />
      {children}
    </div>
  );
}

function PanelGroupBodyDropOverlay({
  leafId,
  previewIntent,
}: {
  leafId: string;
  previewIntent: PanelTabDropIntent | null;
}) {
  if (previewIntent?.kind !== "body" || previewIntent.leafId !== leafId) return null;
  return (
    <div
      aria-hidden="true"
      data-panel-group-drop-zone={previewIntent.zone}
      className={cn(
        "pointer-events-none absolute z-10 rounded-sm bg-token-foreground/10 ring-1 ring-inset ring-token-foreground/20",
        getBodyDropOverlayClassName(previewIntent.zone),
      )}
    />
  );
}

function getBodyDropOverlayClassName(zone: PanelGroupBodyDropZone): string {
  if (zone === "left") return "inset-y-0 left-0 w-1/2";
  if (zone === "right") return "inset-y-0 right-0 w-1/2";
  if (zone === "up") return "inset-x-0 top-0 h-1/2";
  if (zone === "down") return "inset-x-0 bottom-0 h-1/2";
  return "inset-0";
}
