import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { animate, motion, useMotionValue, type MotionValue } from "motion/react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type { CodexConversationChildMembership } from "../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import { cn } from "../../../lib/utils";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import type { CodexConversationHistoryTurnItemsRef } from "../../../../shared/codex-conversation-history-page";
import type { VisibleConversationTurnEntry } from "../selectors";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import {
  buildVirtualizedTurnLayout,
  buildVirtualizedTurnListRestoreState,
  resolveAnchorPreservedDistanceFromBottom,
  resolveInitialVirtualizedTurnViewportState,
  resolveMeasuredVisibleAnchorKey,
  resolveResponseSpacerBottomViewportOverflowPx,
  resolveResponseSpacerHeightPx,
  resolveRenderedRangeFromAnchor,
  resolveRenderedRangeForPendingScrollTarget,
  resolveRestoredDistanceWithoutResponseSpacer,
  resolveTargetCenterDistanceFromBottom,
  resolveThreadLatestTurnFollowState,
  resolveThreadLatestTurnPhase,
  resolveTurnCenterDistanceFromBottom,
  resolveVirtualizedTurnViewportState,
  shouldAllowResponseSpacerGrowth,
  THREAD_NEAR_BOTTOM_THRESHOLD_PX,
  type ThreadLatestTurnFollowState,
  type VirtualizedLatestTurnRestoreState,
  type VirtualizedTurnListRestoreState,
  type VirtualizedTurnViewportState,
  type VisibleTurnRange,
} from "./local-conversation-turn-virtualization";
import {
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { useLocalConversationTurnCollapseOverride } from "./local-conversation-thread-view-state";
import {
  createLocalConversationHistoryGapRequestCoordinator,
  CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
  LocalConversationHistoryGap,
  type LocalConversationHistoryGapLayout,
  type LocalConversationHistoryGapRow,
} from "./local-conversation-history-gap";
import { resolveVisibleHistoryTurnIds } from "./local-conversation-history-residency-pins";

const TURN_GAP_PX = 12;
const OVERSCAN_TURNS = 2;
const COLLAPSED_VISIBLE_TURNS = 3;
const DEFAULT_VIEWPORT_HEIGHT_PX = 800;
const RESPONSE_SPACER_TRANSITION = { type: "spring", bounce: 0, duration: 0.5 } as const;
const RESPONSE_SPACER_INTERSECTION_THRESHOLDS = Array.from(
  { length: 101 },
  (_, index) => index / 100,
);
const LATEST_TURN_PLACEMENT_BOTTOM_DISTANCE_PX = 1;

function readScrollPaddingBottomPx(element: HTMLElement | null): number {
  if (element === null || typeof window === "undefined") return 0;
  const value = window.getComputedStyle(element).scrollPaddingBottom;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readCodexWindowZoom(element: HTMLElement | null): number {
  if (element === null || typeof window === "undefined") return 1;
  const value = window.getComputedStyle(element).getPropertyValue("--codex-window-zoom");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function readMeasuredBlockSizePx(entry: ResizeObserverEntry): number {
  const borderBoxSize = entry.borderBoxSize;
  const size = Array.isArray(borderBoxSize) ? borderBoxSize[0] : borderBoxSize;
  const blockSize = size?.blockSize;
  if (typeof blockSize === "number" && Number.isFinite(blockSize) && blockSize > 0) {
    return blockSize;
  }
  const rectHeight = entry.contentRect.height;
  if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight;
  return readElementBlockSizePx(entry.target as HTMLElement);
}

function readElementBlockSizePx(element: HTMLElement): number {
  const rectHeight = element.getBoundingClientRect().height;
  if (Number.isFinite(rectHeight) && rectHeight > 0) return rectHeight;
  return element.offsetHeight;
}

function normalizeMeasuredHeightPx(heightPx: number): number {
  return Math.max(1, Math.round(heightPx));
}

function getBottomViewportOverflowPx(input: {
  scrollElement: HTMLElement | null;
  turnElement: HTMLElement | null;
  fallbackBottomViewportOverflowPx: number;
  windowZoom: number;
}): number {
  const { scrollElement, turnElement, fallbackBottomViewportOverflowPx, windowZoom } = input;
  if (scrollElement === null || turnElement === null) return fallbackBottomViewportOverflowPx;
  return Math.max(
    0,
    (turnElement.getBoundingClientRect().bottom - scrollElement.getBoundingClientRect().bottom) /
      windowZoom,
  );
}

function resolveBaseDistanceWithLatestTurnDelta(input: {
  allowResponseSpacerGrowth: boolean;
  baseScrollController: LocalConversationThreadScrollControllerValue;
  distanceDeltaPx: number;
  responseSpacerHeightPx: number;
  setResponseSpacerHeightPx: (heightPx: number) => void;
}): void {
  const {
    allowResponseSpacerGrowth,
    baseScrollController,
    distanceDeltaPx,
    responseSpacerHeightPx,
    setResponseSpacerHeightPx,
  } = input;
  const nextDistanceFromBottomPx =
    baseScrollController.getScrollDistanceFromBottomPx() + distanceDeltaPx;
  if (allowResponseSpacerGrowth && nextDistanceFromBottomPx < 0) {
    setResponseSpacerHeightPx(responseSpacerHeightPx - nextDistanceFromBottomPx);
  }
  baseScrollController.scrollToDistanceFromBottomPx(Math.max(0, nextDistanceFromBottomPx), "auto");
}

export type LocalConversationVirtualizedTurnTargetResolver = (
  turnElement: HTMLElement,
) => HTMLElement | null;

export type LocalConversationVirtualizedTurnListEntry = VisibleConversationTurnEntry;

type LocalConversationVirtualizedHistoryRow =
  | {
      readonly kind: "content";
      readonly layoutKey: string;
      readonly entry: LocalConversationVirtualizedTurnListEntry;
    }
  | {
      readonly kind: "gap";
      readonly layoutKey: string;
      readonly row: LocalConversationHistoryGapRow;
    };

function buildLocalConversationVirtualizedHistoryRows(input: {
  readonly entries: readonly LocalConversationVirtualizedTurnListEntry[];
  readonly historyRows: readonly CodexHistoryRow[] | undefined;
}): readonly LocalConversationVirtualizedHistoryRow[] {
  const entriesByTurnKey = new Map(input.entries.map((entry) => [entry.turnKey, entry]));
  if (!input.historyRows) {
    return input.entries.map((entry) => ({
      kind: "content",
      layoutKey: entry.turnKey,
      entry,
    }));
  }

  const representedTurnKeys = new Set<string>();
  const rows: LocalConversationVirtualizedHistoryRow[] = [];
  for (const row of input.historyRows) {
    if (row.kind === "gap") {
      rows.push({ kind: "gap", layoutKey: `\u0000${row.key}`, row });
      continue;
    }
    const entry = entriesByTurnKey.get(row.turnKey);
    if (!entry || representedTurnKeys.has(entry.turnKey)) continue;
    representedTurnKeys.add(entry.turnKey);
    rows.push({ kind: "content", layoutKey: entry.turnKey, entry });
  }
  for (const entry of input.entries) {
    if (representedTurnKeys.has(entry.turnKey)) continue;
    rows.push({ kind: "content", layoutKey: entry.turnKey, entry });
  }
  return rows;
}

export interface LocalConversationVirtualizedTurnListApi {
  scrollToKey: (
    turnKey: string,
    getTargetElement?: LocalConversationVirtualizedTurnTargetResolver,
  ) => Promise<void>;
  setScrollMode: ReturnType<typeof useLocalConversationThreadScrollController>["setScrollMode"];
  getScrollMode: ReturnType<typeof useLocalConversationThreadScrollController>["getScrollMode"];
}

interface LocalConversationVirtualizedTurnListProps {
  entries: LocalConversationVirtualizedTurnListEntry[];
  conversationId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  threadCwd: string | null;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  editableTurnId: string | null;
  canForkFromTurn: boolean;
  initialCollapsedAgentBodyByTurnSearchKey?: Readonly<Record<string, boolean>>;
  onEditLastTurnMessage?: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => void | Promise<void>;
  onForkTurnMessage?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
  onApiChange?: (api: LocalConversationVirtualizedTurnListApi | null) => void;
  initialScrollOffset?: number | null;
  initialRestoreState?: VirtualizedTurnListRestoreState | null;
  initialLatestTurnRestoreState?: VirtualizedLatestTurnRestoreState | null;
  onRestoreStateChange?: (state: VirtualizedTurnListRestoreState | null) => void;
  onLatestTurnRestoreStateChange?: (
    state: VirtualizedLatestTurnRestoreState | null,
    distanceFromBottomPx: number,
  ) => void;
  onVisibleContentReady?: () => void;
  historyRows?: readonly CodexHistoryRow[];
  onLoadHistoryBoundary?: (boundary: CodexHistoryBoundaryRef) => Promise<unknown>;
  historyTurnItemsRefs?: Readonly<
    Record<
      string,
      {
        readonly older: CodexConversationHistoryTurnItemsRef | null;
        readonly newer: CodexConversationHistoryTurnItemsRef | null;
      }
    >
  >;
  onLoadHistoryTurnItems?: (items: CodexConversationHistoryTurnItemsRef) => Promise<unknown>;
  onVisibleHistoryTurnIdsChange?: (turnIds: readonly string[]) => void;
  latestTurnSynchronousMeasurementKey?: string | number;
  scrollElement: HTMLDivElement | null;
  className?: string;
}

interface LatestTurnHeightChange {
  bottomViewportOverflowPx: number;
  followContentHeightPx: number | null;
  heightDeltaPx: number | null;
  heightPx: number | null;
  turnElement: HTMLElement | null;
}

interface VirtualizedTurnViewportChange {
  distanceFromBottomPx: number;
  gaps: readonly LocalConversationHistoryGapLayout[];
  turns: readonly { readonly turnId: string; readonly startPx: number; readonly endPx: number }[];
  target: { originPx: number; targetPx: number } | null;
  totalHeightPx: number;
  viewportEndPx: number;
  viewportHeightPx: number;
  viewportRevision: number;
  viewportStartPx: number;
  visibleTurnIds: readonly string[];
}

interface PendingVirtualizedTurnScrollTarget {
  complete: () => void;
  getTargetElement?: LocalConversationVirtualizedTurnTargetResolver;
  requestId: number;
  turnKey: string;
}

interface TurnMeasurement {
  element: HTMLElement;
  firstHeightPx: number;
  heightPx: number;
}

interface PendingLayoutEffect {
  latestTurnHeightChange: LatestTurnHeightChange | null;
  restoreScrollDistanceFromBottom: boolean;
  scrollDistanceFromBottomPx: number | null;
  turnHeightsByKey: Record<string, number>;
}

interface ObservedElementMetadata {
  kind: "turn" | "latest-turn-follow-content";
  turnKey?: string;
}

interface CoreProps extends Omit<
  LocalConversationVirtualizedTurnListProps,
  | "initialLatestTurnRestoreState"
  | "historyRows"
  | "onLatestTurnRestoreStateChange"
  | "onLoadHistoryBoundary"
  | "historyTurnItemsRefs"
  | "onLoadHistoryTurnItems"
  | "onVisibleHistoryTurnIdsChange"
  | "scrollElement"
> {
  historyRows?: readonly CodexHistoryRow[];
  initialScrollOffset: number;
  latestTurnYMotion: MotionValue<number>;
  onLatestTurnHeightChange: (change: LatestTurnHeightChange) => void;
  onViewportChange?: (change: VirtualizedTurnViewportChange) => void;
  preserveMeasuredTurnViewport?: boolean;
  scrollController: LocalConversationThreadScrollControllerValue;
  getPendingRestoreScrollDistanceFromBottomPx: () => number | null;
  restoreScrollDistanceFromBottomPx: () => void;
}

interface MeasuredTurnProps {
  entry: LocalConversationVirtualizedTurnListEntry;
  conversationId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  threadCwd: string | null;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  initialCollapsedOverride?: boolean;
  canEditTurnUserPrefix: boolean;
  canForkTurn: boolean;
  onEditLastTurnMessage?: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => void | Promise<void>;
  onForkTurnMessage?: (input: {
    threadId: string;
    turnId: string;
    message: string;
    isLatestTurn: boolean;
  }) => void | Promise<void>;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: ThreadStageActions["onOpenTurnDiffFileInSidePanel"];
  onOpenSideChat?: ThreadStageActions["onOpenSideChat"];
  onOpenThread?: ThreadStageActions["onOpenThread"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
  isLatestTurn: boolean;
  latestTurnFollowContentRef?: (element: HTMLDivElement | null) => void;
  latestTurnY: MotionValue<number> | null;
  observeTurnElement: (turnKey: string, element: HTMLElement) => () => void;
}

function MeasuredTurnComponent({
  entry,
  conversationId,
  childMemberships,
  backgroundAgentRows,
  threadCwd,
  projectWorkspacePath,
  projectlessOutputDirectory,
  initialCollapsedOverride,
  canEditTurnUserPrefix,
  canForkTurn,
  onEditLastTurnMessage,
  onForkTurnMessage,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  turnDiffHoverPreviewDisabled = false,
  isLatestTurn,
  latestTurnFollowContentRef,
  latestTurnY,
  observeTurnElement,
}: MeasuredTurnProps) {
  const [collapsedOverride, setCollapsedOverride] = useLocalConversationTurnCollapseOverride({
    conversationId,
    turnSearchKey: entry.turnSearchKey,
    initialOverride: initialCollapsedOverride,
  });
  const cleanupRef = useRef<(() => void) | null>(null);
  const handleElementRef = useCallback(
    (element: HTMLDivElement | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (element === null) return;
      cleanupRef.current = observeTurnElement(entry.turnKey, element);
    },
    [entry.turnKey, observeTurnElement],
  );

  useLayoutEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    [],
  );

  const turnContent = (
    <div
      ref={handleElementRef}
      className="[&_[data-virtualized-turn-content]]:[content-visibility:visible]"
      data-thread-turn-id={entry.turnKey}
      data-turn-key={entry.turnKey}
    >
      <LocalConversationTurnEntry
        conversationId={conversationId}
        childMemberships={childMemberships}
        backgroundAgentRows={backgroundAgentRows}
        entry={entry}
        cwd={threadCwd}
        persistedCollapsed={collapsedOverride ?? undefined}
        onSetCollapsed={setCollapsedOverride}
        canEditTurnUserPrefix={canEditTurnUserPrefix}
        canForkTurn={canForkTurn}
        projectWorkspacePath={projectWorkspacePath}
        projectlessOutputDirectory={projectlessOutputDirectory}
        threadCwd={threadCwd}
        onEditLastTurnMessage={onEditLastTurnMessage}
        onForkTurnMessage={onForkTurnMessage}
        onOpenTurnDiffReview={onOpenTurnDiffReview}
        onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
        onOpenSideChat={onOpenSideChat}
        onOpenThread={onOpenThread}
        onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
        onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
        onOpenPlanInSidePanel={onOpenPlanInSidePanel}
        onClosePlanSidePanel={onClosePlanSidePanel}
        planSidePanelState={planSidePanelState}
        turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
        latestTurnFollowContentRef={isLatestTurn ? latestTurnFollowContentRef : undefined}
      />
    </div>
  );

  const animatedTurnContent = latestTurnY ? (
    <motion.div style={{ y: latestTurnY }}>{turnContent}</motion.div>
  ) : (
    turnContent
  );

  return animatedTurnContent;
}

const MeasuredTurn = memo(
  MeasuredTurnComponent,
  (left, right) =>
    left.entry === right.entry &&
    left.conversationId === right.conversationId &&
    left.backgroundAgentRows === right.backgroundAgentRows &&
    left.threadCwd === right.threadCwd &&
    left.projectWorkspacePath === right.projectWorkspacePath &&
    left.projectlessOutputDirectory === right.projectlessOutputDirectory &&
    left.initialCollapsedOverride === right.initialCollapsedOverride &&
    left.canEditTurnUserPrefix === right.canEditTurnUserPrefix &&
    left.canForkTurn === right.canForkTurn &&
    left.onEditLastTurnMessage === right.onEditLastTurnMessage &&
    left.onForkTurnMessage === right.onForkTurnMessage &&
    left.onOpenTurnDiffReview === right.onOpenTurnDiffReview &&
    left.onOpenTurnDiffFileInSidePanel === right.onOpenTurnDiffFileInSidePanel &&
    left.onOpenSideChat === right.onOpenSideChat &&
    left.onOpenThread === right.onOpenThread &&
    left.onOpenSummaryScheduledAutomation === right.onOpenSummaryScheduledAutomation &&
    left.onOpenMcpAppSidePanel === right.onOpenMcpAppSidePanel &&
    left.onOpenPlanInSidePanel === right.onOpenPlanInSidePanel &&
    left.onClosePlanSidePanel === right.onClosePlanSidePanel &&
    left.planSidePanelState === right.planSidePanelState &&
    left.turnDiffHoverPreviewDisabled === right.turnDiffHoverPreviewDisabled &&
    left.isLatestTurn === right.isLatestTurn &&
    left.latestTurnFollowContentRef === right.latestTurnFollowContentRef &&
    left.latestTurnY === right.latestTurnY &&
    left.observeTurnElement === right.observeTurnElement,
);

function LocalConversationVirtualizedTurnListCore({
  entries,
  historyRows,
  conversationId,
  childMemberships,
  backgroundAgentRows,
  threadCwd,
  projectWorkspacePath,
  projectlessOutputDirectory,
  editableTurnId,
  canForkFromTurn,
  initialCollapsedAgentBodyByTurnSearchKey,
  onEditLastTurnMessage,
  onForkTurnMessage,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  turnDiffHoverPreviewDisabled = false,
  onApiChange,
  initialScrollOffset,
  initialRestoreState = null,
  onRestoreStateChange,
  onVisibleContentReady,
  latestTurnSynchronousMeasurementKey,
  className,
  latestTurnYMotion,
  onLatestTurnHeightChange,
  onViewportChange,
  preserveMeasuredTurnViewport = false,
  scrollController,
  getPendingRestoreScrollDistanceFromBottomPx,
  restoreScrollDistanceFromBottomPx,
}: CoreProps) {
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>(
    () => initialRestoreState?.turnHeightsByKey ?? {},
  );
  const [listRoot, setListRoot] = useState<HTMLDivElement | null>(null);
  const rows = useMemo(
    () => buildLocalConversationVirtualizedHistoryRows({ entries, historyRows }),
    [entries, historyRows],
  );
  const layout = useMemo(
    () =>
      buildVirtualizedTurnLayout({
        entries: rows.map((row) => ({
          turnKey: row.layoutKey,
          estimatedHeightPx: row.kind === "gap" ? row.row.estimatedHeightPx : null,
        })),
        gapPx: TURN_GAP_PX,
        measuredHeightsByKey: measuredHeights,
      }),
    [measuredHeights, rows],
  );
  const [virtualViewportState, setVirtualViewportState] = useState<VirtualizedTurnViewportState>(
    () =>
      resolveInitialVirtualizedTurnViewportState({
        distanceFromBottomPx: initialScrollOffset,
        initialRestoreState,
        layout,
        overscanCount: OVERSCAN_TURNS,
        viewportHeightPx: DEFAULT_VIEWPORT_HEIGHT_PX,
      }),
  );
  const [pendingScrollTarget, setPendingScrollTarget] =
    useState<PendingVirtualizedTurnScrollTarget | null>(null);
  const requestIdRef = useRef(0);
  const activePendingTargetRef = useRef<PendingVirtualizedTurnScrollTarget | null>(null);
  const layoutRef = useRef(layout);
  const previousLayoutRef = useRef(layout);
  const measuredHeightsRef = useRef(measuredHeights);
  const virtualViewportStateRef = useRef(virtualViewportState);
  const entriesRef = useRef(entries);
  const rowsRef = useRef(rows);
  const listRootRef = useRef<HTMLDivElement | null>(null);
  const visibleContentReadyRef = useRef(false);
  const turnElementsByKeyRef = useRef(new Map<string, HTMLElement>());
  const observedElementMetadataRef = useRef(new Map<Element, ObservedElementMetadata>());
  const pendingTurnMeasurementsRef = useRef(new Map<string, TurnMeasurement>());
  const followContentHeightsRef = useRef(new Map<HTMLElement, number>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const flushMeasurementsRef = useRef<() => void>(() => {});
  const pendingFollowContentMeasurementRef = useRef(false);
  const pendingLayoutEffectRef = useRef<PendingLayoutEffect | null>(null);
  const viewportRevisionRef = useRef(0);

  layoutRef.current = layout;
  measuredHeightsRef.current = measuredHeights;
  virtualViewportStateRef.current = virtualViewportState;
  entriesRef.current = entries;
  rowsRef.current = rows;
  listRootRef.current = listRoot;

  const getScrollElement = useCallback(
    () => scrollController.getScrollElement(),
    [scrollController],
  );

  const emitViewportChange = useCallback(
    (
      distanceFromBottomPx: number,
      viewportHeightPx: number,
      previousDistanceFromBottomPx?: number,
    ) => {
      if (!onViewportChange) return;
      const currentLayout = layoutRef.current;
      const viewportEndPx = Math.max(
        0,
        Math.min(currentLayout.totalHeightPx, currentLayout.totalHeightPx - distanceFromBottomPx),
      );
      const viewportStartPx = Math.max(0, viewportEndPx - viewportHeightPx);
      const previousViewportEndPx =
        previousDistanceFromBottomPx == null
          ? viewportEndPx
          : Math.max(
              0,
              Math.min(
                currentLayout.totalHeightPx,
                currentLayout.totalHeightPx - previousDistanceFromBottomPx,
              ),
            );
      const previousViewportStartPx = Math.max(0, previousViewportEndPx - viewportHeightPx);
      const gaps: LocalConversationHistoryGapLayout[] = [];
      const turns: Array<{ turnId: string; startPx: number; endPx: number }> = [];
      for (const [index, row] of rowsRef.current.entries()) {
        const startPx = currentLayout.topOffsetsPx[index];
        const heightPx = currentLayout.heightsPx[index];
        if (startPx == null || heightPx == null) continue;
        if (row.kind === "gap") {
          gaps.push({ row: row.row, startPx, endPx: startPx + heightPx });
          continue;
        }
        if (row.entry.turnId) {
          turns.push({ turnId: row.entry.turnId, startPx, endPx: startPx + heightPx });
        }
      }
      const target =
        previousDistanceFromBottomPx == null
          ? null
          : viewportStartPx < previousViewportStartPx
            ? { originPx: previousViewportStartPx, targetPx: viewportStartPx }
            : viewportEndPx > previousViewportEndPx
              ? { originPx: previousViewportEndPx, targetPx: viewportEndPx }
              : null;
      const visibleTurnIds = resolveVisibleHistoryTurnIds({
        rows: rowsRef.current.map((row, index) => {
          const startPx = currentLayout.topOffsetsPx[index] ?? 0;
          return {
            turnId: row.kind === "content" ? row.entry.turnId : null,
            startPx,
            endPx: startPx + (currentLayout.heightsPx[index] ?? 0),
          };
        }),
        viewportStartPx,
        viewportEndPx,
      });
      onViewportChange({
        distanceFromBottomPx,
        gaps,
        turns,
        target,
        totalHeightPx: currentLayout.totalHeightPx,
        viewportEndPx,
        viewportHeightPx,
        viewportRevision: viewportRevisionRef.current,
        viewportStartPx,
        visibleTurnIds,
      });
    },
    [onViewportChange],
  );

  const updateViewportState = useCallback(
    (
      distanceFromBottomPx: number,
      viewportHeightPx: number,
      previousDistanceFromBottomPx?: number,
      advanceViewportRevision = false,
    ) => {
      if (advanceViewportRevision) viewportRevisionRef.current += 1;
      setVirtualViewportState((current) =>
        resolveVirtualizedTurnViewportState({
          current,
          distanceFromBottomPx,
          layout: layoutRef.current,
          overscanCount: OVERSCAN_TURNS,
          viewportHeightPx,
        }),
      );
      emitViewportChange(distanceFromBottomPx, viewportHeightPx, previousDistanceFromBottomPx);
    },
    [emitViewportChange],
  );

  const reportLatestTurnFollowContentHeight = useCallback(() => {
    let heightPx = 0;
    let lastElement: HTMLElement | null = null;
    for (const [element, elementHeightPx] of followContentHeightsRef.current) {
      heightPx += elementHeightPx;
      if (
        lastElement === null ||
        lastElement.compareDocumentPosition(element) === Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        lastElement = element;
      }
    }
    if (lastElement === null) return;
    const scrollElement = getScrollElement();
    onLatestTurnHeightChange({
      bottomViewportOverflowPx: getBottomViewportOverflowPx({
        scrollElement,
        turnElement: lastElement,
        fallbackBottomViewportOverflowPx: 0,
        windowZoom: readCodexWindowZoom(scrollElement),
      }),
      followContentHeightPx: heightPx,
      heightDeltaPx: null,
      heightPx: null,
      turnElement: lastElement,
    });
  }, [getScrollElement, onLatestTurnHeightChange]);

  const applyTurnMeasurements = useCallback(
    (measurements: Map<string, TurnMeasurement>, sync: boolean): boolean => {
      if (measurements.size === 0) return false;
      const currentHeights = measuredHeightsRef.current;
      const currentLayout = layoutRef.current;
      const currentViewport = virtualViewportStateRef.current;
      let nextHeights = currentHeights;
      let hasChanged = false;
      let measuredDistanceDeltaPx = 0;
      let latestTurnHeightDeltaPx = 0;
      let latestTurnElement: HTMLElement | null = null;
      const latestTurnKey = entriesRef.current.at(-1)?.turnKey ?? null;
      const pendingRestoreDistanceFromBottomPx = preserveMeasuredTurnViewport
        ? null
        : getPendingRestoreScrollDistanceFromBottomPx();

      for (const [turnKey, measurement] of measurements) {
        if (!Number.isFinite(measurement.heightPx) || measurement.heightPx <= 0) continue;
        const nextHeightPx = normalizeMeasuredHeightPx(measurement.heightPx);
        const firstHeightPx =
          Number.isFinite(measurement.firstHeightPx) && measurement.firstHeightPx > 0
            ? normalizeMeasuredHeightPx(measurement.firstHeightPx)
            : nextHeightPx;
        const previousMeasuredHeightPx = currentHeights[turnKey] ?? firstHeightPx;
        if (currentHeights[turnKey] === nextHeightPx) continue;
        if (nextHeights === currentHeights) {
          nextHeights = { ...currentHeights };
        }
        nextHeights[turnKey] = nextHeightPx;
        hasChanged = true;

        const turnIndex = currentLayout.turnIndexByKey.get(turnKey);
        if (turnIndex == null) continue;
        if (turnKey === latestTurnKey) {
          latestTurnHeightDeltaPx += nextHeightPx - previousMeasuredHeightPx;
          latestTurnElement = measurement.element;
        }

        const layoutHeightPx = currentLayout.heightsPx[turnIndex] ?? nextHeightPx;
        const layoutDeltaPx = nextHeightPx - layoutHeightPx;
        const bottomOffsetPx = currentLayout.bottomOffsetsPx[turnIndex] ?? 0;
        const isLatestTurn = turnKey === latestTurnKey;
        if (
          layoutDeltaPx !== 0 &&
          scrollController.getScrollMode() !== "programmaticFind" &&
          bottomOffsetPx <= currentViewport.distanceFromBottomPx &&
          (preserveMeasuredTurnViewport ||
            (pendingRestoreDistanceFromBottomPx !== null && !isLatestTurn))
        ) {
          measuredDistanceDeltaPx += layoutDeltaPx;
        }
      }

      if (!hasChanged) return false;

      const nextLayout = buildVirtualizedTurnLayout({
        entries: rowsRef.current.map((row) => ({
          turnKey: row.layoutKey,
          estimatedHeightPx: row.kind === "gap" ? row.row.estimatedHeightPx : null,
        })),
        gapPx: TURN_GAP_PX,
        measuredHeightsByKey: nextHeights,
      });
      let nextDistanceFromBottomPx = currentViewport.distanceFromBottomPx;
      let scrollDistanceFromBottomPx: number | null = null;
      let restoreScrollDistanceFromBottom = false;
      if (pendingRestoreDistanceFromBottomPx !== null) {
        nextDistanceFromBottomPx = pendingRestoreDistanceFromBottomPx;
        restoreScrollDistanceFromBottom = true;
      } else if (scrollController.getScrollMode() === "stickToBottom") {
        nextDistanceFromBottomPx = 0;
        scrollDistanceFromBottomPx = 0;
      } else if (measuredDistanceDeltaPx !== 0) {
        nextDistanceFromBottomPx = Math.max(0, nextDistanceFromBottomPx + measuredDistanceDeltaPx);
        scrollDistanceFromBottomPx = Math.max(
          0,
          scrollController.getLastScrollDistanceFromBottomPx() + measuredDistanceDeltaPx,
        );
      }

      const nextViewport = resolveVirtualizedTurnViewportState({
        current: currentViewport,
        distanceFromBottomPx: nextDistanceFromBottomPx,
        layout: nextLayout,
        overscanCount: OVERSCAN_TURNS,
        viewportHeightPx: currentViewport.viewportHeightPx,
      });
      const scrollElement = getScrollElement();
      const latestTurnIndex = latestTurnKey
        ? nextLayout.turnIndexByKey.get(latestTurnKey)
        : undefined;
      pendingLayoutEffectRef.current = {
        latestTurnHeightChange:
          latestTurnHeightDeltaPx !== 0 || latestTurnElement !== null
            ? {
                bottomViewportOverflowPx: getBottomViewportOverflowPx({
                  scrollElement,
                  turnElement: latestTurnElement,
                  fallbackBottomViewportOverflowPx: 0,
                  windowZoom: readCodexWindowZoom(scrollElement),
                }),
                followContentHeightPx: null,
                heightDeltaPx: latestTurnHeightDeltaPx,
                heightPx:
                  latestTurnIndex === undefined
                    ? null
                    : (nextLayout.heightsPx[latestTurnIndex] ?? null),
                turnElement: latestTurnElement,
              }
            : null,
        restoreScrollDistanceFromBottom,
        scrollDistanceFromBottomPx,
        turnHeightsByKey: nextHeights,
      };

      const commit = () => {
        setMeasuredHeights(nextHeights);
        setVirtualViewportState(nextViewport);
      };
      if (sync) {
        flushSync(commit);
      } else {
        commit();
      }
      return true;
    },
    [
      getPendingRestoreScrollDistanceFromBottomPx,
      getScrollElement,
      preserveMeasuredTurnViewport,
      scrollController,
    ],
  );

  const flushPendingTurnMeasurements = useCallback(
    (sync: boolean): boolean => {
      const measurements = pendingTurnMeasurementsRef.current;
      if (measurements.size === 0) return false;
      pendingTurnMeasurementsRef.current = new Map();
      return applyTurnMeasurements(measurements, sync);
    },
    [applyTurnMeasurements],
  );

  const flushMeasurements = useCallback(() => {
    measurementFrameRef.current = null;
    const followContentChanged = pendingFollowContentMeasurementRef.current;
    pendingFollowContentMeasurementRef.current = false;
    flushPendingTurnMeasurements(true);
    if (followContentChanged) {
      reportLatestTurnFollowContentHeight();
    }
  }, [flushPendingTurnMeasurements, reportLatestTurnFollowContentHeight]);
  flushMeasurementsRef.current = flushMeasurements;

  const scheduleMeasurementFlush = useCallback((followContentChanged = false): void => {
    if (followContentChanged) {
      pendingFollowContentMeasurementRef.current = true;
    }
    if (measurementFrameRef.current !== null) return;
    measurementFrameRef.current = window.requestAnimationFrame(() => {
      flushMeasurementsRef.current();
    });
  }, []);

  const getResizeObserver = useCallback(() => {
    if (typeof ResizeObserver === "undefined") return null;
    if (resizeObserverRef.current) return resizeObserverRef.current;
    resizeObserverRef.current = new ResizeObserver((entries) => {
      let followContentChanged = false;
      for (const entry of entries) {
        const metadata = observedElementMetadataRef.current.get(entry.target);
        if (!metadata) continue;
        const measuredBlockSizePx = readMeasuredBlockSizePx(entry);
        if (measuredBlockSizePx <= 0) continue;
        const heightPx = normalizeMeasuredHeightPx(measuredBlockSizePx);
        if (metadata.kind === "turn") {
          const turnKey = metadata.turnKey;
          if (!turnKey) continue;
          const element = entry.target as HTMLElement;
          const previous = pendingTurnMeasurementsRef.current.get(turnKey);
          pendingTurnMeasurementsRef.current.set(turnKey, {
            element,
            firstHeightPx: previous?.firstHeightPx ?? heightPx,
            heightPx,
          });
          continue;
        }
        const element = entry.target as HTMLElement;
        const previousHeightPx = followContentHeightsRef.current.get(element);
        if (previousHeightPx !== heightPx) {
          followContentHeightsRef.current.set(element, heightPx);
          followContentChanged = true;
        }
      }
      scheduleMeasurementFlush(followContentChanged);
    });
    return resizeObserverRef.current;
  }, [scheduleMeasurementFlush]);

  const observeTurnElement = useCallback(
    (turnKey: string, element: HTMLElement) => {
      turnElementsByKeyRef.current.set(turnKey, element);
      observedElementMetadataRef.current.set(element, { kind: "turn", turnKey });
      const measuredHeightPx = readElementBlockSizePx(element);
      if (measuredHeightPx > 0) {
        const heightPx = normalizeMeasuredHeightPx(measuredHeightPx);
        pendingTurnMeasurementsRef.current.set(turnKey, {
          element,
          firstHeightPx: heightPx,
          heightPx,
        });
        scheduleMeasurementFlush(false);
      }
      const observer = getResizeObserver();
      observer?.observe(element);
      return () => {
        observer?.unobserve(element);
        observedElementMetadataRef.current.delete(element);
        if (turnElementsByKeyRef.current.get(turnKey) === element) {
          turnElementsByKeyRef.current.delete(turnKey);
        }
      };
    },
    [getResizeObserver, scheduleMeasurementFlush],
  );

  const latestTurnFollowContentCleanupRef = useRef<(() => void) | null>(null);
  const observeLatestTurnFollowContent = useCallback(
    (element: HTMLDivElement | null) => {
      latestTurnFollowContentCleanupRef.current?.();
      latestTurnFollowContentCleanupRef.current = null;
      if (element === null) return;
      observedElementMetadataRef.current.set(element, { kind: "latest-turn-follow-content" });
      const measuredHeightPx = readElementBlockSizePx(element);
      if (measuredHeightPx > 0) {
        followContentHeightsRef.current.set(element, normalizeMeasuredHeightPx(measuredHeightPx));
        reportLatestTurnFollowContentHeight();
      }
      const observer = getResizeObserver();
      observer?.observe(element);
      latestTurnFollowContentCleanupRef.current = () => {
        observer?.unobserve(element);
        observedElementMetadataRef.current.delete(element);
        followContentHeightsRef.current.delete(element);
      };
    },
    [getResizeObserver, reportLatestTurnFollowContentHeight],
  );

  const finishPendingScroll = useCallback((target: PendingVirtualizedTurnScrollTarget) => {
    queueMicrotask(() => {
      if (activePendingTargetRef.current === target) {
        target.complete();
        activePendingTargetRef.current = null;
      }
      setPendingScrollTarget((current) => (current === target ? null : current));
    });
  }, []);

  const scrollToKey = useCallback(
    (turnKey: string, getTargetElement?: LocalConversationVirtualizedTurnTargetResolver) => {
      activePendingTargetRef.current?.complete();
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      return new Promise<void>((resolve) => {
        const target: PendingVirtualizedTurnScrollTarget = {
          complete: resolve,
          getTargetElement,
          requestId,
          turnKey,
        };
        activePendingTargetRef.current = target;
        scrollController.setScrollMode("programmaticFind");
        setPendingScrollTarget(target);
      });
    },
    [scrollController],
  );

  useEffect(() => {
    if (!onApiChange) return;
    onApiChange({
      scrollToKey,
      setScrollMode: scrollController.setScrollMode,
      getScrollMode: scrollController.getScrollMode,
    });
    return () => {
      onApiChange(null);
    };
  }, [onApiChange, scrollController, scrollToKey]);

  useLayoutEffect(() => {
    const pendingEffect = pendingLayoutEffectRef.current;
    if (pendingEffect === null || pendingEffect.turnHeightsByKey !== measuredHeights) return;
    pendingLayoutEffectRef.current = null;
    if (pendingEffect.latestTurnHeightChange) {
      onLatestTurnHeightChange(pendingEffect.latestTurnHeightChange);
    }
    if (pendingEffect.restoreScrollDistanceFromBottom) {
      restoreScrollDistanceFromBottomPx();
      return;
    }
    if (pendingEffect.scrollDistanceFromBottomPx !== null) {
      scrollController.scrollToDistanceFromBottomPx(
        pendingEffect.scrollDistanceFromBottomPx,
        "auto",
      );
    }
  }, [
    measuredHeights,
    onLatestTurnHeightChange,
    restoreScrollDistanceFromBottomPx,
    scrollController,
  ]);

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (scrollElement === null) return;
    const getViewportHeightPx = () =>
      scrollElement.clientHeight ||
      virtualViewportStateRef.current.viewportHeightPx ||
      DEFAULT_VIEWPORT_HEIGHT_PX;
    const syncViewportState = (
      distanceFromBottomPx = scrollController.getLastScrollDistanceFromBottomPx(),
      previousDistanceFromBottomPx?: number,
      advanceViewportRevision = false,
    ) => {
      updateViewportState(
        distanceFromBottomPx,
        getViewportHeightPx(),
        previousDistanceFromBottomPx,
        advanceViewportRevision,
      );
    };
    syncViewportState();
    const removeScrollListener = scrollController.addScrollListener((distanceFromBottomPx) => {
      syncViewportState(distanceFromBottomPx);
    });
    const removeUserScrollListener = scrollController.addUserScrollListener(
      (distanceFromBottomPx, previousDistanceFromBottomPx) => {
        syncViewportState(distanceFromBottomPx, previousDistanceFromBottomPx, true);
      },
    );
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            syncViewportState(
              virtualViewportStateRef.current.distanceFromBottomPx,
              undefined,
              true,
            );
            restoreScrollDistanceFromBottomPx();
          });
    observer?.observe(scrollElement);
    return () => {
      removeScrollListener();
      removeUserScrollListener();
      observer?.disconnect();
    };
  }, [getScrollElement, restoreScrollDistanceFromBottomPx, scrollController, updateViewportState]);

  useLayoutEffect(() => {
    const previousLayout = previousLayoutRef.current;
    previousLayoutRef.current = layout;
    if (previousLayout === layout || pendingLayoutEffectRef.current !== null) return;

    setVirtualViewportState((current) => {
      const anchorKey = current.turnKeys[current.renderedRange.startIndex];
      const anchorRange =
        anchorKey && current.turnKeys.join("\u0000") !== layout.turnKeys.join("\u0000")
          ? resolveRenderedRangeFromAnchor({
              anchorKey,
              layout,
              previousRange: current.renderedRange,
            })
          : null;
      return resolveVirtualizedTurnViewportState({
        current: anchorRange ? { ...current, renderedRange: anchorRange } : current,
        distanceFromBottomPx: current.distanceFromBottomPx,
        layout,
        overscanCount: OVERSCAN_TURNS,
        viewportHeightPx: current.viewportHeightPx,
      });
    });

    if (!preserveMeasuredTurnViewport || pendingScrollTarget !== null) return;
    const pendingRestoreDistance = getPendingRestoreScrollDistanceFromBottomPx();
    if (pendingRestoreDistance !== null) return;
    if (scrollController.getLastScrollDistanceFromBottomPx() <= THREAD_NEAR_BOTTOM_THRESHOLD_PX)
      return;
    const anchorKey = resolveMeasuredVisibleAnchorKey({
      distanceFromBottomPx: virtualViewportStateRef.current.distanceFromBottomPx,
      layout: previousLayout,
      measuredHeightsByKey: measuredHeightsRef.current,
      nextLayout: layout,
      viewportHeightPx: virtualViewportStateRef.current.viewportHeightPx,
    });
    if (anchorKey === null) return;
    const preservedDistanceFromBottomPx = resolveAnchorPreservedDistanceFromBottom({
      anchorKey,
      distanceFromBottomPx: virtualViewportStateRef.current.distanceFromBottomPx,
      previousLayout,
      nextLayout: layout,
    });
    if (
      preservedDistanceFromBottomPx === null ||
      preservedDistanceFromBottomPx === virtualViewportStateRef.current.distanceFromBottomPx
    ) {
      return;
    }
    updateViewportState(
      preservedDistanceFromBottomPx,
      virtualViewportStateRef.current.viewportHeightPx,
    );
    scrollController.scrollToDistanceFromBottomPx(preservedDistanceFromBottomPx, "auto");
  }, [
    getPendingRestoreScrollDistanceFromBottomPx,
    layout,
    pendingScrollTarget,
    preserveMeasuredTurnViewport,
    scrollController,
    updateViewportState,
  ]);

  const visibleRange = useMemo((): VisibleTurnRange => {
    if (getScrollElement() === null) {
      return {
        startIndex: Math.max(0, rows.length - COLLAPSED_VISIBLE_TURNS),
        endIndex: rows.length,
      };
    }
    if (!pendingScrollTarget) return virtualViewportState.renderedRange;
    return resolveRenderedRangeForPendingScrollTarget({
      currentRange: virtualViewportState.renderedRange,
      layout,
      overscanCount: OVERSCAN_TURNS,
      pendingTurnKey: pendingScrollTarget.turnKey,
      viewportHeightPx: virtualViewportState.viewportHeightPx,
    });
  }, [
    getScrollElement,
    layout,
    pendingScrollTarget,
    rows.length,
    virtualViewportState.renderedRange,
    virtualViewportState.viewportHeightPx,
  ]);

  useLayoutEffect(() => {
    if (pendingTurnMeasurementsRef.current.size === 0) return;
    if (pendingFollowContentMeasurementRef.current) return;
    if (measurementFrameRef.current !== null) {
      window.cancelAnimationFrame(measurementFrameRef.current);
      measurementFrameRef.current = null;
    }
    flushPendingTurnMeasurements(false);
  }, [flushPendingTurnMeasurements, rows, visibleRange.endIndex, visibleRange.startIndex]);

  useLayoutEffect(() => {
    if (pendingScrollTarget === null) return;
    const scrollElement = getScrollElement();
    if (scrollElement === null) return;

    const mountedMeasurements = new Map<string, TurnMeasurement>();
    for (const [turnKey, element] of turnElementsByKeyRef.current) {
      const measuredHeightPx = readElementBlockSizePx(element);
      if (measuredHeightPx <= 0) continue;
      const heightPx = normalizeMeasuredHeightPx(measuredHeightPx);
      mountedMeasurements.set(turnKey, {
        element,
        firstHeightPx: measuredHeightsRef.current[turnKey] ?? heightPx,
        heightPx,
      });
    }
    if (
      applyTurnMeasurements(mountedMeasurements, false) ||
      pendingLayoutEffectRef.current !== null
    ) {
      return;
    }

    const index = layout.turnIndexByKey.get(pendingScrollTarget.turnKey);
    if (index == null) {
      finishPendingScroll(pendingScrollTarget);
      return;
    }

    const turnElement = turnElementsByKeyRef.current.get(pendingScrollTarget.turnKey) ?? null;
    if (
      turnElement === null &&
      (index < visibleRange.startIndex || index >= visibleRange.endIndex)
    ) {
      setVirtualViewportState((current) => ({
        ...current,
        renderedRange: resolveRenderedRangeForPendingScrollTarget({
          currentRange: current.renderedRange,
          layout,
          overscanCount: OVERSCAN_TURNS,
          pendingTurnKey: pendingScrollTarget.turnKey,
          viewportHeightPx: current.viewportHeightPx,
        }),
      }));
      return;
    }

    const targetElement = turnElement
      ? (pendingScrollTarget.getTargetElement?.(turnElement) ?? turnElement)
      : null;
    const targetDistanceFromBottomPx =
      turnElement && targetElement
        ? pendingScrollTarget.getTargetElement
          ? (() => {
              const turnRect = turnElement.getBoundingClientRect();
              const targetRect = targetElement.getBoundingClientRect();
              return resolveTargetCenterDistanceFromBottom({
                layout,
                targetHeightPx: targetRect.height,
                targetTopWithinTurnPx: targetRect.top - turnRect.top,
                turnIndex: index,
                viewportHeightPx: scrollElement.clientHeight,
                windowZoom: readCodexWindowZoom(scrollElement),
              });
            })()
          : resolveTurnCenterDistanceFromBottom({
              layout,
              turnIndex: index,
              viewportHeightPx: scrollElement.clientHeight,
            })
        : resolveTurnCenterDistanceFromBottom({
            layout,
            turnIndex: index,
            viewportHeightPx: scrollElement.clientHeight,
          });
    if (targetDistanceFromBottomPx === null) {
      finishPendingScroll(pendingScrollTarget);
      return;
    }

    scrollController.scrollToDistanceFromBottomPx(targetDistanceFromBottomPx, "auto");
    updateViewportState(targetDistanceFromBottomPx, scrollElement.clientHeight);
    finishPendingScroll(pendingScrollTarget);
  }, [
    applyTurnMeasurements,
    finishPendingScroll,
    getScrollElement,
    layout,
    pendingScrollTarget,
    scrollController,
    updateViewportState,
    visibleRange.endIndex,
    visibleRange.startIndex,
  ]);

  useLayoutEffect(() => {
    if (latestTurnSynchronousMeasurementKey == null) return;
    const latestTurnKey = entries.at(-1)?.turnKey;
    if (!latestTurnKey) return;
    const latestTurnElement = turnElementsByKeyRef.current.get(latestTurnKey);
    if (!latestTurnElement) return;
    const measuredHeightPx = readElementBlockSizePx(latestTurnElement);
    if (measuredHeightPx <= 0) return;
    const heightPx = normalizeMeasuredHeightPx(measuredHeightPx);
    applyTurnMeasurements(
      new Map([
        [
          latestTurnKey,
          {
            element: latestTurnElement,
            firstHeightPx: measuredHeightsRef.current[latestTurnKey] ?? heightPx,
            heightPx,
          },
        ],
      ]),
      false,
    );
  }, [applyTurnMeasurements, entries, latestTurnSynchronousMeasurementKey]);

  useLayoutEffect(() => {
    if (!onVisibleContentReady || visibleContentReadyRef.current || listRoot === null) return;
    if (entries.length > 0 && turnElementsByKeyRef.current.size === 0) return;
    let cancelled = false;
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (cancelled) return;
        visibleContentReadyRef.current = true;
        restoreScrollDistanceFromBottomPx();
        onVisibleContentReady();
      });
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) {
        window.cancelAnimationFrame(secondFrame);
      }
    };
  }, [
    entries.length,
    listRoot,
    measuredHeights,
    onVisibleContentReady,
    restoreScrollDistanceFromBottomPx,
  ]);

  useLayoutEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      latestTurnFollowContentCleanupRef.current?.();
      latestTurnFollowContentCleanupRef.current = null;
      if (measurementFrameRef.current !== null) {
        window.cancelAnimationFrame(measurementFrameRef.current);
      }
      activePendingTargetRef.current?.complete();
      activePendingTargetRef.current = null;
      onRestoreStateChange?.(
        buildVirtualizedTurnListRestoreState({
          measuredHeightsByKey: measuredHeightsRef.current,
          renderedRange: virtualViewportStateRef.current.renderedRange,
          turnKeys: layoutRef.current.turnKeys,
        }),
      );
    },
    [onRestoreStateChange],
  );

  const visibleRows = rows.slice(visibleRange.startIndex, visibleRange.endIndex);
  const topSpacerHeightPx = layout.topOffsetsPx[visibleRange.startIndex] ?? 0;

  return (
    <div
      ref={setListRoot}
      className={cn("relative shrink-0", className)}
      style={{ height: `${layout.totalHeightPx}px` }}
    >
      <div
        className="flex flex-col"
        style={{ gap: `${TURN_GAP_PX}px`, marginTop: `${topSpacerHeightPx}px` }}
      >
        {visibleRows.map((row) => {
          if (row.kind === "gap") {
            return <LocalConversationHistoryGap key={row.layoutKey} row={row.row} />;
          }
          const entry = row.entry;
          const isLatestTurn = entry.turnKey === entries.at(-1)?.turnKey;
          return (
            <MeasuredTurn
              key={row.layoutKey}
              entry={entry}
              conversationId={conversationId}
              childMemberships={childMemberships}
              backgroundAgentRows={backgroundAgentRows}
              threadCwd={threadCwd}
              projectWorkspacePath={projectWorkspacePath}
              projectlessOutputDirectory={projectlessOutputDirectory}
              initialCollapsedOverride={
                initialCollapsedAgentBodyByTurnSearchKey?.[entry.turnSearchKey]
              }
              canEditTurnUserPrefix={entry.turnId !== null && editableTurnId === entry.turnId}
              canForkTurn={canForkFromTurn && entry.turn.status !== "inProgress"}
              onEditLastTurnMessage={onEditLastTurnMessage}
              onForkTurnMessage={onForkTurnMessage}
              onOpenTurnDiffReview={onOpenTurnDiffReview}
              onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
              onOpenSideChat={onOpenSideChat}
              onOpenThread={onOpenThread}
              onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
              onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
              onOpenPlanInSidePanel={onOpenPlanInSidePanel}
              onClosePlanSidePanel={onClosePlanSidePanel}
              planSidePanelState={planSidePanelState}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
              isLatestTurn={isLatestTurn}
              latestTurnFollowContentRef={observeLatestTurnFollowContent}
              latestTurnY={isLatestTurn ? latestTurnYMotion : null}
              observeTurnElement={observeTurnElement}
            />
          );
        })}
      </div>
    </div>
  );
}

export function LocalConversationVirtualizedTurnList({
  entries,
  historyRows,
  initialScrollOffset = null,
  initialLatestTurnRestoreState = null,
  onLatestTurnRestoreStateChange,
  onLoadHistoryBoundary,
  historyTurnItemsRefs,
  onLoadHistoryTurnItems,
  onVisibleHistoryTurnIdsChange,
  scrollElement,
  ...coreProps
}: LocalConversationVirtualizedTurnListProps) {
  const prefersReducedMotion = useResolvedReducedMotion();
  const baseScrollController = useLocalConversationThreadScrollController();
  const responseSpacerHeightMotion = useMotionValue(0);
  const latestTurnYMotion = useMotionValue(0);
  const activeTurnItemProgressKeysRef = useRef(new Set<string>());
  const lastTurnItemViewportRevisionRef = useRef<number | null>(null);
  const latestTurnEntry = entries.at(-1) ?? null;
  const latestTurnKey = latestTurnEntry?.turnKey ?? null;
  const latestTurnPhase = resolveThreadLatestTurnPhase(latestTurnEntry?.turn ?? null);
  const isLatestTurnInProgress = latestTurnEntry?.turn.status === "inProgress";
  const initialLatestTurnKey = entries.at(-1)?.turnKey ?? null;
  const [responseSpacerHeightPx, setResponseSpacerHeightPxState] = useState(0);
  const [latestTurnFollowState, setLatestTurnFollowState] = useState<ThreadLatestTurnFollowState>(
    () =>
      initialLatestTurnRestoreState?.turnKey === initialLatestTurnKey
        ? { followMode: initialLatestTurnRestoreState.followMode }
        : { followMode: "static" },
  );
  const [latestTurnFollowContentHeightPx, setLatestTurnFollowContentHeightPx] = useState<
    number | null
  >(() =>
    initialLatestTurnRestoreState?.turnKey === initialLatestTurnKey
      ? initialLatestTurnRestoreState.latestTurnFollowContentHeightPx
      : null,
  );
  const responseSpacerRef = useRef<HTMLDivElement | null>(null);
  const responseSpacerHeightPxRef = useRef(0);
  const latestTurnFollowStateRef = useRef(latestTurnFollowState);
  const latestTurnFollowContentHeightPxRef = useRef(latestTurnFollowContentHeightPx);
  const latestTurnHeightPxRef = useRef<number | null>(
    initialLatestTurnRestoreState?.turnKey === initialLatestTurnKey
      ? initialLatestTurnRestoreState.latestTurnHeightPx
      : null,
  );
  const pendingExpectedLatestTurnHeightPxRef = useRef<number | null>(
    initialLatestTurnRestoreState?.turnKey === initialLatestTurnKey &&
      shouldAllowResponseSpacerGrowth(initialLatestTurnRestoreState.followMode)
      ? initialLatestTurnRestoreState.latestTurnHeightPx
      : null,
  );
  const initialScrollOffsetRef = useRef(initialScrollOffset ?? 0);
  const hasRestoredInitialScrollRef = useRef(false);
  const latestTurnKeyRef = useRef(latestTurnKey);
  const latestTurnPhaseRef = useRef(latestTurnPhase);
  const isLatestTurnInProgressRef = useRef(isLatestTurnInProgress);
  const spacerBottomReachedRef = useRef(false);
  const historyGapRequestCoordinatorRef = useRef(
    createLocalConversationHistoryGapRequestCoordinator(),
  );

  responseSpacerHeightPxRef.current = responseSpacerHeightPx;
  latestTurnFollowStateRef.current = latestTurnFollowState;
  latestTurnFollowContentHeightPxRef.current = latestTurnFollowContentHeightPx;
  latestTurnPhaseRef.current = latestTurnPhase;
  isLatestTurnInProgressRef.current = isLatestTurnInProgress;

  const setResponseSpacerHeightPx = useCallback((heightPx: number) => {
    setResponseSpacerHeightPxState(Math.max(0, heightPx));
  }, []);

  useEffect(() => {
    if (prefersReducedMotion) {
      responseSpacerHeightMotion.set(responseSpacerHeightPx);
      return;
    }
    const controls = animate(
      responseSpacerHeightMotion,
      responseSpacerHeightPx,
      RESPONSE_SPACER_TRANSITION,
    );
    return () => {
      controls.stop();
    };
  }, [prefersReducedMotion, responseSpacerHeightMotion, responseSpacerHeightPx]);

  const updateFollowState = useCallback(
    (
      event: Parameters<typeof resolveThreadLatestTurnFollowState>[1],
      forceFooterPreserveSync = false,
    ) => {
      const previousState = latestTurnFollowStateRef.current;
      const previousFollowMode = previousState.followMode;
      const nextState = resolveThreadLatestTurnFollowState(previousState, event);
      latestTurnFollowStateRef.current = nextState;
      if (nextState !== previousState) {
        setLatestTurnFollowState(nextState);
      }
      if (forceFooterPreserveSync || nextState.followMode !== previousFollowMode) {
        baseScrollController.setFooterResizeViewportPreserveDisabled(
          Boolean(
            isLatestTurnInProgressRef.current &&
            shouldAllowResponseSpacerGrowth(nextState.followMode),
          ),
        );
      }
      return nextState;
    },
    [baseScrollController],
  );

  const clearResponseSpacer = useCallback(() => {
    responseSpacerHeightMotion.stop?.();
    responseSpacerHeightMotion.set(0);
    setResponseSpacerHeightPx(0);
    spacerBottomReachedRef.current = false;
  }, [responseSpacerHeightMotion, setResponseSpacerHeightPx]);

  const scrollResponseSpacerToBottom = useCallback(() => {
    hasRestoredInitialScrollRef.current = true;
    latestTurnYMotion.stop?.();
    latestTurnYMotion.set(0);
    clearResponseSpacer();
    updateFollowState(
      {
        type: "scroll_to_bottom",
        latestTurnPhase: latestTurnPhaseRef.current,
      },
      true,
    );
    baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
  }, [baseScrollController, clearResponseSpacer, latestTurnYMotion, updateFollowState]);
  const scrollResponseSpacerToBottomRef = useRef(scrollResponseSpacerToBottom);
  scrollResponseSpacerToBottomRef.current = scrollResponseSpacerToBottom;
  const registerResponseSpacerState = baseScrollController.registerResponseSpacerState;

  useLayoutEffect(() => {
    if (latestTurnKey === null) {
      registerResponseSpacerState(null);
      return () => {
        registerResponseSpacerState(null);
      };
    }
    registerResponseSpacerState({
      getHeightPx: () => responseSpacerHeightMotion.get(),
      scrollToBottom: () => {
        scrollResponseSpacerToBottomRef.current();
      },
    });
    return () => {
      registerResponseSpacerState(null);
    };
  }, [latestTurnKey, registerResponseSpacerState, responseSpacerHeightMotion]);

  const wrappedScrollController = useMemo<LocalConversationThreadScrollControllerValue>(() => {
    const subtractSpacer = (distanceFromBottomPx: number) =>
      Math.max(0, distanceFromBottomPx - responseSpacerHeightMotion.get());
    return {
      ...baseScrollController,
      addScrollListener: (listener) =>
        baseScrollController.addScrollListener((distanceFromBottomPx) => {
          listener(subtractSpacer(distanceFromBottomPx));
        }),
      addUserScrollListener: (listener) =>
        baseScrollController.addUserScrollListener(
          (distanceFromBottomPx, previousDistanceFromBottomPx) => {
            listener(
              subtractSpacer(distanceFromBottomPx),
              previousDistanceFromBottomPx == null
                ? undefined
                : subtractSpacer(previousDistanceFromBottomPx),
            );
          },
        ),
      getLastScrollDistanceFromBottomPx: () =>
        subtractSpacer(baseScrollController.getLastScrollDistanceFromBottomPx()),
      getScrollDistanceFromBottomPx: () =>
        subtractSpacer(baseScrollController.getScrollDistanceFromBottomPx()),
      scrollToDistanceFromBottomPx: (distanceFromBottomPx, behavior = "auto") => {
        baseScrollController.scrollToDistanceFromBottomPx(
          distanceFromBottomPx + responseSpacerHeightMotion.get(),
          behavior,
        );
      },
    };
  }, [baseScrollController, responseSpacerHeightMotion]);

  const getPendingRestoreScrollDistanceFromBottomPx = useCallback(() => {
    if (hasRestoredInitialScrollRef.current) return null;
    const initialScrollOffset = initialScrollOffsetRef.current;
    if (
      initialScrollOffset == null ||
      latestTurnFollowStateRef.current.followMode === "prework_follow"
    ) {
      return null;
    }
    return Math.max(0, initialScrollOffset - responseSpacerHeightMotion.get());
  }, [responseSpacerHeightMotion]);

  const restoreScrollDistanceFromBottomPx = useCallback(() => {
    if (hasRestoredInitialScrollRef.current) return;
    const initialScrollOffset = initialScrollOffsetRef.current;
    if (
      initialScrollOffset == null ||
      latestTurnFollowStateRef.current.followMode === "prework_follow"
    ) {
      hasRestoredInitialScrollRef.current = true;
      return;
    }
    const scrollElement = baseScrollController.getScrollElement();
    if (scrollElement === null) return;
    if (
      Math.abs(baseScrollController.getScrollDistanceFromBottomPx() - initialScrollOffset) <=
      THREAD_NEAR_BOTTOM_THRESHOLD_PX
    ) {
      hasRestoredInitialScrollRef.current = true;
      return;
    }
    baseScrollController.scrollToDistanceFromBottomPx(initialScrollOffset, "auto");
    if (
      Math.abs(baseScrollController.getScrollDistanceFromBottomPx() - initialScrollOffset) <=
      THREAD_NEAR_BOTTOM_THRESHOLD_PX
    ) {
      hasRestoredInitialScrollRef.current = true;
    }
  }, [baseScrollController]);

  const shrinkResponseSpacer = useCallback(
    (targetHeightPx: number) => {
      const currentHeightPx = responseSpacerHeightMotion.get();
      const nextHeightPx =
        targetHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX
          ? 0
          : Math.min(currentHeightPx, targetHeightPx);
      if (currentHeightPx - nextHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) return;
      const scrollElement = baseScrollController.getScrollElement();
      const currentDistanceFromBottomPx =
        scrollElement === null ? 0 : baseScrollController.getScrollDistanceFromBottomPx();
      const heightDeltaPx = nextHeightPx - currentHeightPx;
      latestTurnYMotion.stop?.();
      latestTurnYMotion.set(0);
      responseSpacerHeightMotion.stop?.();
      responseSpacerHeightMotion.set(nextHeightPx);
      setResponseSpacerHeightPx(nextHeightPx);
      if (nextHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
        baseScrollController.registerResponseSpacerState(null);
      }
      if (scrollElement !== null) {
        baseScrollController.scrollToDistanceFromBottomPx(
          Math.max(0, currentDistanceFromBottomPx + heightDeltaPx),
          "auto",
        );
      }
    },
    [
      baseScrollController,
      latestTurnYMotion,
      responseSpacerHeightMotion,
      setResponseSpacerHeightPx,
    ],
  );

  useLayoutEffect(
    () =>
      baseScrollController.addUserScrollListener(
        (distanceFromBottomPx, previousDistanceFromBottomPx) => {
          hasRestoredInitialScrollRef.current = true;
          const spacerHeightPx = responseSpacerHeightMotion.get();
          if (distanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
            if (
              (spacerHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX ||
                spacerBottomReachedRef.current) &&
              previousDistanceFromBottomPx != null &&
              previousDistanceFromBottomPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX &&
              isLatestTurnInProgressRef.current
            ) {
              updateFollowState(
                {
                  type: "scroll_to_bottom",
                  latestTurnPhase: latestTurnPhaseRef.current,
                },
                true,
              );
              baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
            }
            return;
          }
          if (
            !isLatestTurnInProgressRef.current &&
            latestTurnPhaseRef.current === "idle" &&
            spacerHeightPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX
          ) {
            shrinkResponseSpacer(spacerHeightPx - distanceFromBottomPx);
            return;
          }
          if (
            isLatestTurnInProgressRef.current &&
            latestTurnPhaseRef.current === "prework" &&
            previousDistanceFromBottomPx != null &&
            distanceFromBottomPx > previousDistanceFromBottomPx &&
            spacerHeightPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX &&
            distanceFromBottomPx > spacerHeightPx
          ) {
            const nextDistanceFromBottomPx = distanceFromBottomPx - spacerHeightPx;
            latestTurnYMotion.stop?.();
            latestTurnYMotion.set(0);
            clearResponseSpacer();
            baseScrollController.scrollToDistanceFromBottomPx(nextDistanceFromBottomPx, "auto");
          }
        },
      ),
    [
      baseScrollController,
      clearResponseSpacer,
      latestTurnYMotion,
      responseSpacerHeightMotion,
      shrinkResponseSpacer,
      updateFollowState,
    ],
  );

  useLayoutEffect(() => {
    const element = baseScrollController.getScrollElement();
    const spacerElement = responseSpacerRef.current;
    if (element === null || spacerElement === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry) return;
        const intersectionHeightPx = entry.intersectionRect.height;
        if (isLatestTurnInProgressRef.current) {
          spacerBottomReachedRef.current =
            Math.max(0, intersectionHeightPx - readScrollPaddingBottomPx(element)) <=
            THREAD_NEAR_BOTTOM_THRESHOLD_PX;
          return;
        }
        shrinkResponseSpacer(
          Math.min(
            intersectionHeightPx,
            responseSpacerHeightMotion.get() - baseScrollController.getScrollDistanceFromBottomPx(),
          ),
        );
      },
      {
        root: element,
        threshold: RESPONSE_SPACER_INTERSECTION_THRESHOLDS,
      },
    );
    observer.observe(spacerElement);
    return () => {
      observer.disconnect();
    };
  }, [baseScrollController, responseSpacerHeightMotion, shrinkResponseSpacer]);

  const clampResponseSpacerForViewport = useCallback(() => {
    const element = scrollElement ?? baseScrollController.getScrollElement();
    if (element === null) return;
    const desiredHeightPx = resolveResponseSpacerHeightPx({
      scrollPaddingBottomPx: readScrollPaddingBottomPx(element),
      viewportHeightPx: element.clientHeight,
    });
    const currentHeightPx = responseSpacerHeightMotion.get();
    if (currentHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) return;
    const nextHeightPx = Math.min(currentHeightPx, desiredHeightPx);
    if (Math.abs(nextHeightPx - currentHeightPx) <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) return;
    const heightDeltaPx = nextHeightPx - currentHeightPx;
    responseSpacerHeightMotion.stop?.();
    responseSpacerHeightMotion.set(nextHeightPx);
    setResponseSpacerHeightPx(nextHeightPx);
    if (nextHeightPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) {
      baseScrollController.registerResponseSpacerState(null);
    }
    baseScrollController.scrollToDistanceFromBottomPx(
      Math.max(0, baseScrollController.getScrollDistanceFromBottomPx() + heightDeltaPx),
      "auto",
    );
  }, [baseScrollController, responseSpacerHeightMotion, scrollElement, setResponseSpacerHeightPx]);

  useLayoutEffect(() => {
    const element = scrollElement ?? baseScrollController.getScrollElement();
    if (element === null) return;
    clampResponseSpacerForViewport();
    let frameId: number | null = null;
    const scheduleClamp = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        clampResponseSpacerForViewport();
      });
    };
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleClamp);
    observer?.observe(element);
    window.addEventListener("resize", scheduleClamp, { passive: true });
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", scheduleClamp);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [baseScrollController, clampResponseSpacerForViewport, scrollElement]);

  const handleLatestTurnHeightChange = useCallback(
    ({
      heightDeltaPx,
      heightPx,
      bottomViewportOverflowPx,
      turnElement,
      followContentHeightPx,
    }: LatestTurnHeightChange) => {
      if (heightPx !== null) {
        latestTurnHeightPxRef.current = heightPx;
      }
      if (followContentHeightPx !== null) {
        setLatestTurnFollowContentHeightPx((current) =>
          current !== null && Math.abs(current - followContentHeightPx) < 1
            ? current
            : followContentHeightPx,
        );
      }
      const expectedLatestTurnHeightPx = pendingExpectedLatestTurnHeightPxRef.current;
      if (
        expectedLatestTurnHeightPx !== null &&
        heightPx !== null &&
        Math.abs(heightPx - expectedLatestTurnHeightPx) > THREAD_NEAR_BOTTOM_THRESHOLD_PX
      ) {
        const heightDifferencePx = heightPx - expectedLatestTurnHeightPx;
        pendingExpectedLatestTurnHeightPxRef.current = null;
        initialScrollOffsetRef.current = Math.max(
          0,
          initialScrollOffsetRef.current + heightDifferencePx,
        );
        resolveBaseDistanceWithLatestTurnDelta({
          allowResponseSpacerGrowth: isLatestTurnInProgressRef.current,
          baseScrollController,
          distanceDeltaPx: heightDifferencePx,
          responseSpacerHeightPx: responseSpacerHeightMotion.get(),
          setResponseSpacerHeightPx,
        });
      }
      if (latestTurnFollowStateRef.current.followMode === "user_follow") {
        baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
        return;
      }
      if (
        latestTurnFollowStateRef.current.followMode === "prework_follow" &&
        latestTurnPhaseRef.current === "prework"
      ) {
        baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
        return;
      }
      if (
        heightDeltaPx !== null &&
        heightDeltaPx !== 0 &&
        shouldAllowResponseSpacerGrowth(latestTurnFollowStateRef.current.followMode)
      ) {
        resolveBaseDistanceWithLatestTurnDelta({
          allowResponseSpacerGrowth: isLatestTurnInProgressRef.current,
          baseScrollController,
          distanceDeltaPx: heightDeltaPx,
          responseSpacerHeightPx: responseSpacerHeightMotion.get(),
          setResponseSpacerHeightPx,
        });
      }
      if (
        latestTurnFollowStateRef.current.followMode !== "prework_watch" ||
        latestTurnPhaseRef.current !== "prework" ||
        responseSpacerHeightMotion.get() <= THREAD_NEAR_BOTTOM_THRESHOLD_PX
      ) {
        return;
      }
      const scrollElement = baseScrollController.getScrollElement();
      if (scrollElement === null || turnElement === null) return;
      const followContentOverflowPx =
        getBottomViewportOverflowPx({
          scrollElement,
          turnElement,
          fallbackBottomViewportOverflowPx: bottomViewportOverflowPx,
          windowZoom: readCodexWindowZoom(scrollElement),
        }) + readScrollPaddingBottomPx(scrollElement);
      const previousState = latestTurnFollowStateRef.current;
      const nextState = updateFollowState({
        type: "latest_turn_follow_content_changed",
        followContentOverflowPx,
        latestTurnPhase: latestTurnPhaseRef.current,
      });
      if (
        previousState.followMode !== "prework_follow" &&
        nextState.followMode === "prework_follow"
      ) {
        latestTurnYMotion.stop?.();
        latestTurnYMotion.set(0);
        clearResponseSpacer();
        baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
      }
    },
    [
      baseScrollController,
      clearResponseSpacer,
      latestTurnYMotion,
      responseSpacerHeightMotion,
      setResponseSpacerHeightPx,
      updateFollowState,
    ],
  );

  useLayoutEffect(
    () =>
      baseScrollController.addScrollListener((distanceFromBottomPx) => {
        if (distanceFromBottomPx <= THREAD_NEAR_BOTTOM_THRESHOLD_PX) return;
        const spacerHeightPx = responseSpacerHeightMotion.get();
        if (
          isLatestTurnInProgressRef.current &&
          spacerHeightPx > THREAD_NEAR_BOTTOM_THRESHOLD_PX &&
          resolveResponseSpacerBottomViewportOverflowPx({
            distanceFromBottomPx,
            responseSpacerHeightPx: spacerHeightPx,
            scrollPaddingBottomPx: readScrollPaddingBottomPx(
              baseScrollController.getScrollElement(),
            ),
          }) <= THREAD_NEAR_BOTTOM_THRESHOLD_PX
        ) {
          spacerBottomReachedRef.current = true;
        }
        updateFollowState({
          type: "scroll_distance_changed",
          distanceFromBottomPx,
          latestTurnPhase: latestTurnPhaseRef.current,
        });
      }),
    [baseScrollController, responseSpacerHeightMotion, updateFollowState],
  );

  useLayoutEffect(() => {
    const previousLatestTurnKey = latestTurnKeyRef.current;
    const previousLatestTurnPhase = latestTurnPhaseRef.current;
    const previousLatestTurnInProgress = isLatestTurnInProgressRef.current;
    latestTurnKeyRef.current = latestTurnKey;
    latestTurnPhaseRef.current = latestTurnPhase;
    isLatestTurnInProgressRef.current = isLatestTurnInProgress;
    if (latestTurnKey === null) {
      updateFollowState({ type: "latest_turn_removed" }, true);
      latestTurnYMotion.stop?.();
      latestTurnYMotion.set(0);
      clearResponseSpacer();
      return;
    }

    const scrollElement = baseScrollController.getScrollElement();
    if (scrollElement === null) return;

    if (previousLatestTurnKey !== latestTurnKey) {
      const placement = baseScrollController.consumePendingLatestTurnSubmitPlacement();
      updateFollowState({ type: "latest_turn_placed" }, true);
      if (placement !== null && !placement.shouldPlaceLatestTurn) {
        latestTurnYMotion.stop?.();
        latestTurnYMotion.set(0);
        clearResponseSpacer();
        const scrollHeightDeltaPx =
          placement.scrollHeightPx === null
            ? 0
            : scrollElement.scrollHeight - placement.scrollHeightPx;
        baseScrollController.setScrollMode("user");
        baseScrollController.scrollToDistanceFromBottomPx(
          placement.distanceFromBottomPx + scrollHeightDeltaPx,
          "auto",
        );
        return;
      }
      const responseSpacerHeightPx = resolveResponseSpacerHeightPx({
        scrollPaddingBottomPx: readScrollPaddingBottomPx(scrollElement),
        viewportHeightPx: scrollElement.clientHeight,
      });
      const existingSpacerHeightPx = responseSpacerHeightMotion.get();
      responseSpacerHeightMotion.stop?.();
      latestTurnYMotion.stop?.();
      latestTurnYMotion.set(existingSpacerHeightPx);
      baseScrollController.scrollToDistanceFromBottomPx(
        LATEST_TURN_PLACEMENT_BOTTOM_DISTANCE_PX,
        "auto",
      );
      if (prefersReducedMotion) {
        latestTurnYMotion.set(0);
        responseSpacerHeightMotion.set(responseSpacerHeightPx);
      } else {
        animate(latestTurnYMotion, 0, RESPONSE_SPACER_TRANSITION);
      }
      setResponseSpacerHeightPx(responseSpacerHeightPx);
    }

    const previousState = latestTurnFollowStateRef.current;
    updateFollowState(
      {
        type: "latest_turn_phase_changed",
        latestTurnPhase,
        previousLatestTurnPhase,
      },
      true,
    );
    if (
      previousLatestTurnPhase === "prework" &&
      latestTurnPhase === "final_answer" &&
      previousState.followMode === "prework_follow"
    ) {
      latestTurnYMotion.stop?.();
      latestTurnYMotion.set(0);
      clearResponseSpacer();
      baseScrollController.scrollToDistanceFromBottomPx(0, "auto");
    }
    if (previousLatestTurnInProgress && !isLatestTurnInProgress) {
      latestTurnYMotion.stop?.();
      latestTurnYMotion.set(0);
      responseSpacerHeightMotion.stop?.();
    }
  }, [
    baseScrollController,
    clearResponseSpacer,
    isLatestTurnInProgress,
    latestTurnKey,
    latestTurnPhase,
    latestTurnYMotion,
    prefersReducedMotion,
    responseSpacerHeightMotion,
    setResponseSpacerHeightPx,
    updateFollowState,
  ]);

  const handleViewportChange = useCallback(
    (change: VirtualizedTurnViewportChange) => {
      onVisibleHistoryTurnIdsChange?.(change.visibleTurnIds);
      if (onLoadHistoryBoundary && change.gaps.length > 0) {
        const hasEligibleGap = change.gaps.some(
          (gap) =>
            gap.endPx >= change.viewportStartPx - CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX &&
            gap.startPx <= change.viewportEndPx + CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
        );
        if (hasEligibleGap) {
          historyGapRequestCoordinatorRef.current.observeViewport(
            {
              viewportRevision: change.viewportRevision,
              viewportStartPx: change.viewportStartPx,
              viewportEndPx: change.viewportEndPx,
              gaps: change.gaps,
            },
            onLoadHistoryBoundary,
          );
          return;
        }
      }
      const isMovingTowardNewer =
        change.target !== null && change.target.targetPx > change.target.originPx;
      const partial = change.turns
        .flatMap((turn) => {
          const refs = historyTurnItemsRefs?.[turn.turnId];
          const ref = isMovingTowardNewer
            ? (refs?.newer ?? refs?.older)
            : (refs?.older ?? refs?.newer);
          if (!ref) return [];
          const edgePx = ref.edge === "older" ? turn.startPx : turn.endPx;
          if (
            edgePx < change.viewportStartPx - CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX ||
            edgePx > change.viewportEndPx + CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX
          ) {
            return [];
          }
          const viewportEdgePx =
            ref.edge === "older" ? change.viewportStartPx : change.viewportEndPx;
          return [{ ref, distance: Math.abs(edgePx - viewportEdgePx) }];
        })
        .toSorted((left, right) => left.distance - right.distance)[0];
      if (partial) {
        const progressKey = `${partial.ref.turnId}:${partial.ref.progressKey}`;
        if (
          activeTurnItemProgressKeysRef.current.has(progressKey) ||
          (lastTurnItemViewportRevisionRef.current !== null &&
            change.viewportRevision <= lastTurnItemViewportRevisionRef.current)
        ) {
          return;
        }
        if (!onLoadHistoryTurnItems) return;
        lastTurnItemViewportRevisionRef.current = change.viewportRevision;
        activeTurnItemProgressKeysRef.current.add(progressKey);
        const release = () => activeTurnItemProgressKeysRef.current.delete(progressKey);
        try {
          void onLoadHistoryTurnItems(partial.ref).then(release, release);
        } catch {
          release();
        }
        return;
      }
      if (!onLoadHistoryBoundary || change.gaps.length === 0) return;
    },
    [
      historyTurnItemsRefs,
      onLoadHistoryBoundary,
      onLoadHistoryTurnItems,
      onVisibleHistoryTurnIdsChange,
    ],
  );

  useLayoutEffect(
    () => () => {
      const scrollElement = baseScrollController.getScrollElement();
      const currentDistanceFromBottomPx =
        scrollElement === null
          ? baseScrollController.getLastScrollDistanceFromBottomPx()
          : baseScrollController.getScrollDistanceFromBottomPx();
      const restoreState =
        latestTurnKeyRef.current === null
          ? null
          : resolveRestoredDistanceWithoutResponseSpacer({
              distanceFromBottomPx: currentDistanceFromBottomPx,
              latestTurnPhase: latestTurnPhaseRef.current,
              responseSpacerHeightPx: responseSpacerHeightMotion.get(),
              scrollPaddingBottomPx:
                scrollElement === null ? 0 : readScrollPaddingBottomPx(scrollElement),
              scrollState: latestTurnFollowStateRef.current,
            });
      if (restoreState !== null) {
        initialScrollOffsetRef.current = restoreState.distanceFromBottomPx;
      }
      onLatestTurnRestoreStateChange?.(
        latestTurnKeyRef.current === null
          ? null
          : {
              followMode: (restoreState?.scrollState ?? latestTurnFollowStateRef.current)
                .followMode,
              isLatestTurnInProgress: isLatestTurnInProgressRef.current,
              latestTurnFollowContentHeightPx: latestTurnFollowContentHeightPxRef.current,
              latestTurnHeightPx: shouldAllowResponseSpacerGrowth(
                (restoreState?.scrollState ?? latestTurnFollowStateRef.current).followMode,
              )
                ? latestTurnHeightPxRef.current
                : null,
              latestTurnPhase: latestTurnPhaseRef.current,
              turnKey: latestTurnKeyRef.current,
            },
        restoreState?.distanceFromBottomPx ?? currentDistanceFromBottomPx,
      );
      baseScrollController.setFooterResizeViewportPreserveDisabled(false);
    },
    [baseScrollController, onLatestTurnRestoreStateChange, responseSpacerHeightMotion],
  );

  return (
    <>
      <LocalConversationVirtualizedTurnListCore
        {...coreProps}
        entries={entries}
        historyRows={historyRows}
        initialScrollOffset={Math.max(0, initialScrollOffset ?? 0)}
        latestTurnYMotion={latestTurnYMotion}
        onLatestTurnHeightChange={handleLatestTurnHeightChange}
        onViewportChange={handleViewportChange}
        preserveMeasuredTurnViewport={historyRows !== undefined}
        scrollController={wrappedScrollController}
        getPendingRestoreScrollDistanceFromBottomPx={getPendingRestoreScrollDistanceFromBottomPx}
        restoreScrollDistanceFromBottomPx={restoreScrollDistanceFromBottomPx}
      />
      <motion.div
        ref={responseSpacerRef}
        aria-hidden="true"
        className="shrink-0"
        style={{ height: responseSpacerHeightMotion }}
      />
    </>
  );
}
