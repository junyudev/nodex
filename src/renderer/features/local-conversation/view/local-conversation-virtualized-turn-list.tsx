import {
  memo,
  useCallback,
  useEffect,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import { scheduleAfterPaint } from "@/lib/schedule-after-paint";
import type { CodexConversationChildMembership } from "../../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import { cn } from "../../../lib/utils";
import { ActivitySpinnerIcon } from "@/components/shared/icons";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  codexConversationHistoryTurnItemsRefKey,
  type CodexConversationHistoryTurnItemsRef,
} from "../../../../shared/codex-conversation-history-page";
import {
  isNormalizedConversationTurnEntry,
  readConversationTurnListEntryStatus,
} from "../selectors";
import {
  projectCodexHistoryViewportBoundary,
  type CodexHistoryViewportBoundary,
} from "../../../../shared/codex-history-policy";
import type {
  ThreadComposerShellBackgroundAgentRowModel,
  ThreadPlanSidePanelState,
  ThreadStageActions,
} from "../thread-stage-types";
import {
  buildVirtualizedTurnLayout,
  buildVirtualizedTurnListRestoreState,
  isRewindSurvivorLatestTurn,
  resolveAnchorPreservedDistanceFromBottom,
  resolveInitialVirtualizedTurnViewportState,
  resolveMeasuredVisibleAnchorKey,
  resolveRetainedContentRange,
  resolveRenderedRangeForPendingScrollTarget,
  resolveRestoredDistanceWithoutResponseSpacer,
  resolveTargetCenterDistanceFromBottom,
  resolveThreadLatestTurnFollowState,
  resolveTurnCenterDistanceFromBottom,
  resolveVirtualizedTurnViewportState,
  resolveVisibleTurnRangeFromBottomDistance,
  shouldAllowResponseSpacerGrowth,
  shouldFollowMeasuredTurnGrowth,
  THREAD_NEAR_BOTTOM_THRESHOLD_PX,
  type ThreadLatestTurnFollowState,
  type VirtualizedLatestTurnRestoreState,
  type VirtualizedTurnListRestoreState,
  type VirtualizedTurnViewportState,
  type VisibleTurnRange,
} from "./local-conversation-turn-virtualization";
import {
  getThreadScrollDistanceFromBottomPx,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import {
  createThreadResponseSpaceController,
  readThreadScrollPaddingBottomPx,
} from "./local-conversation-response-space";
import { LocalConversationResponseSpaceElement } from "./local-conversation-response-space-element";
import { useCodexTranscriptLatestTurnMetadata } from "../normalized-transcript-hooks";
import { LocalConversationTurnEntry } from "./local-conversation-turn-entry";
import { LocalConversationRealtimeTranscript } from "./local-conversation-realtime-transcript";
import {
  readRealtimeTranscriptViewportAnchor,
  readRealtimeTranscriptViewportAnchors,
  resolveRetiringRealtimeTranscriptViewportAnchor,
  resolveRealtimeTranscriptAnchorDistance,
  resolveRealtimeTranscriptRestoreState,
  type RealtimeTranscriptViewportAnchor,
} from "./local-conversation-realtime-transcript-restore";
import {
  isCodexNativeTimelineTurnEntry,
  isCodexRealtimeTimelineEntry,
  readLatestCodexTimelineTurnEntry,
  type CodexTimelineViewEntry,
} from "../projection/normalized-timeline-entries";
import { useLocalConversationTurnCollapseOverride } from "./local-conversation-thread-view-state";
import {
  createLocalConversationHistoryGapRequestCoordinator,
  createLocalConversationHistoryRequestGate,
  CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
  LocalConversationHistoryGap,
  type LocalConversationHistoryGapLayout,
  type LocalConversationHistoryGapRow,
  type LocalConversationHistoryGapRequestState,
  type LocalConversationHistoryRequestGateState,
} from "./local-conversation-history-gap";

const TURN_GAP_PX = 12;
const OVERSCAN_TURNS = 2;
const COLLAPSED_VISIBLE_TURNS = 3;
const DEFAULT_VIEWPORT_HEIGHT_PX = 800;
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
  if (typeof blockSize === "number" && Number.isFinite(blockSize) && blockSize >= 0) {
    return blockSize;
  }
  const rectHeight = entry.contentRect.height;
  if (Number.isFinite(rectHeight) && rectHeight >= 0) return rectHeight;
  return readElementBlockSizePx(entry.target as HTMLElement);
}

function readElementBlockSizePx(element: HTMLElement): number {
  const rectHeight = element.getBoundingClientRect().height;
  if (Number.isFinite(rectHeight) && rectHeight >= 0)
    return rectHeight / readCodexWindowZoom(element);
  return element.offsetHeight;
}

function normalizeMeasuredHeightPx(heightPx: number): number {
  return Math.max(1, heightPx);
}

function readPhysicalPixelScale(element: HTMLElement | null): number {
  const ratio = window.devicePixelRatio;
  return readCodexWindowZoom(element) * (Number.isFinite(ratio) && ratio > 0 ? ratio : 1);
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

export type LocalConversationVirtualizedTurnTargetResolver = (
  turnElement: HTMLElement,
) => HTMLElement | null;

export type LocalConversationVirtualizedTurnListEntry = CodexTimelineViewEntry;

function readTimelineEntryStatus(entry: LocalConversationVirtualizedTurnListEntry) {
  return isCodexRealtimeTimelineEntry(entry)
    ? "completed"
    : readConversationTurnListEntryStatus(entry);
}

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
    // A canonical occurrence belongs at its sparse position; only independent overlays append.
    if (
      !isCodexRealtimeTimelineEntry(entry) &&
      isNormalizedConversationTurnEntry(entry) &&
      entry.historyPositionKey !== undefined
    )
      continue;
    rows.push({ kind: "content", layoutKey: entry.turnKey, entry });
  }
  return rows;
}

export interface LocalConversationVirtualizedTurnListApi {
  scrollToKey: (
    turnKey: string,
    getTargetElement?: LocalConversationVirtualizedTurnTargetResolver,
    options?: { readonly signal?: AbortSignal },
  ) => Promise<void>;
  setScrollMode: ReturnType<typeof useLocalConversationThreadScrollController>["setScrollMode"];
  getScrollMode: ReturnType<typeof useLocalConversationThreadScrollController>["getScrollMode"];
}

interface LocalConversationVirtualizedTurnListProps {
  entries: LocalConversationVirtualizedTurnListEntry[];
  conversationId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  threadCwd: string | null;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  /** Turns whose user message can be rewritten; every later Turn leaves with the edit. */
  editableTurnIds: ReadonlySet<string>;
  canForkFromTurn: boolean;
  initialCollapsedAgentBodyByTurnSearchKey?: Readonly<Record<string, boolean>>;
  onEditUserTurn?: (input: {
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
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
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
  historyRequestSource?: object;
  onLoadHistoryBoundary?: (boundary: CodexHistoryBoundaryRef) => Promise<unknown>;
  onHistoryRetentionBoundaryChange?: (
    boundary: CodexHistoryViewportBoundary | null | undefined,
  ) => void;
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

type LatestTurnHeightChangeHandler = (
  change: LatestTurnHeightChange,
) => "followed_bottom" | "preserve_viewport";

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
}

interface PendingVirtualizedTurnScrollTarget {
  complete: () => void;
  getTargetElement?: LocalConversationVirtualizedTurnTargetResolver;
  requestId: number;
  turnKey: string;
}

interface TurnMeasurement {
  element: HTMLElement;
  heightPx: number;
}

interface MeasuredContentAnchor {
  readonly turnKey: string;
  readonly row: HTMLElement;
  readonly leaf: HTMLElement;
  readonly topWithinViewportPx: number;
}

/** Hit-test the viewport, never walk all messages in a potentially very long Turn. */
function readMeasuredContentAnchor(
  scrollElement: HTMLElement,
  rows: ReadonlyMap<string, HTMLElement>,
): MeasuredContentAnchor | null {
  const document = scrollElement.ownerDocument;
  if (typeof document.elementFromPoint !== "function") return null;
  const viewport = scrollElement.getBoundingClientRect();
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  const windowZoom = readCodexWindowZoom(scrollElement);
  for (const y of [viewport.top + 1, viewport.top + 24, (viewport.top + viewport.bottom) / 2]) {
    for (const fraction of [0.5, 0.25, 0.75]) {
      const hit = document.elementFromPoint(viewport.left + viewport.width * fraction, y);
      const leaf = hit?.closest<HTMLElement>("[data-content-search-unit-key]");
      const row = leaf?.closest<HTMLElement>("[data-turn-key]");
      const turnKey = row?.dataset.turnKey;
      if (!leaf || !row || !turnKey || rows.get(turnKey) !== row) continue;
      return {
        turnKey,
        row,
        leaf,
        topWithinViewportPx: (leaf.getBoundingClientRect().top - viewport.top) / windowZoom,
      };
    }
  }
  return null;
}

interface PendingLayoutEffect {
  contentAnchor: MeasuredContentAnchor | null;
  latestTurnHeightChange: LatestTurnHeightChange | null;
  restoreScrollDistanceFromBottom: boolean;
  nativeScrollDistanceFromBottomPx: number | null;
  turnHeightsByKey: Record<string, number>;
}

/** Latest-Turn following owns placement; otherwise compensate with application-time response space. */
export function applyLocalConversationTurnMeasurementEffect({
  effect,
  getResponseSpacerHeightPx,
  onLatestTurnHeightChange,
  restoreScrollDistanceFromBottomPx,
  compensateScrollToDistanceFromBottomPx,
}: {
  readonly effect: Pick<
    PendingLayoutEffect,
    | "latestTurnHeightChange"
    | "restoreScrollDistanceFromBottom"
    | "nativeScrollDistanceFromBottomPx"
  >;
  readonly getResponseSpacerHeightPx: () => number;
  readonly onLatestTurnHeightChange: LatestTurnHeightChangeHandler;
  readonly restoreScrollDistanceFromBottomPx: () => void;
  readonly compensateScrollToDistanceFromBottomPx: (distance: number) => void;
}) {
  const responseSpaceHeightBeforeCallbackPx = getResponseSpacerHeightPx();
  if (
    effect.latestTurnHeightChange &&
    onLatestTurnHeightChange(effect.latestTurnHeightChange) === "followed_bottom"
  )
    return;
  if (effect.restoreScrollDistanceFromBottom) {
    restoreScrollDistanceFromBottomPx();
    return;
  }
  if (effect.nativeScrollDistanceFromBottomPx === null) return;
  // The wrapped owner adds the post-callback space, yielding native target + new space - old space.
  compensateScrollToDistanceFromBottomPx(
    effect.nativeScrollDistanceFromBottomPx - responseSpaceHeightBeforeCallbackPx,
  );
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
  | "scrollElement"
> {
  historyGapState: LocalConversationHistoryGapRequestState;
  historyItemState: LocalConversationHistoryRequestGateState;
  historyItemRefs: LocalConversationVirtualizedTurnListProps["historyTurnItemsRefs"];
  retryHistoryItems: (ref: CodexConversationHistoryTurnItemsRef) => void;
  retryHistoryBoundary: (boundary: CodexHistoryBoundaryRef) => void;
  historyRows?: readonly CodexHistoryRow[];
  initialScrollOffset: number;
  onLatestTurnHeightChange: LatestTurnHeightChangeHandler;
  onViewportChange?: (change: VirtualizedTurnViewportChange) => void;
  preserveMeasuredTurnViewport?: boolean;
  scrollController: LocalConversationThreadScrollControllerValue;
  getPendingRestoreScrollDistanceFromBottomPx: () => number | null;
  getResponseSpacerHeightPx: () => number;
  restoreScrollDistanceFromBottomPx: () => void;
}

interface MeasuredTurnProps {
  retainedTopPx?: number;
  entry: LocalConversationVirtualizedTurnListEntry;
  conversationId: string;
  childMemberships?: readonly CodexConversationChildMembership[];
  parentModel?: string | null;
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  threadCwd: string | null;
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  initialCollapsedOverride?: boolean;
  canEditTurnUserPrefix: boolean;
  canForkTurn: boolean;
  onEditUserTurn?: (input: {
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
  onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
  onOpenSummaryScheduledAutomation?: ThreadStageActions["onOpenSummaryScheduledAutomation"];
  onOpenMcpAppSidePanel?: ThreadStageActions["onOpenMcpAppSidePanel"];
  onOpenPlanInSidePanel?: ThreadStageActions["onOpenPlanInSidePanel"];
  onClosePlanSidePanel?: ThreadStageActions["onClosePlanSidePanel"];
  planSidePanelState?: ThreadPlanSidePanelState | null;
  turnDiffHoverPreviewDisabled?: boolean;
  isLatestTurn: boolean;
  latestTurnFollowContentRef?: (element: HTMLDivElement | null) => void;
  observeTurnElement: (turnKey: string, element: HTMLElement) => () => void;
  historyItemRef?: CodexConversationHistoryTurnItemsRef;
  historyItemLoading?: boolean;
  retryHistoryItems?: (ref: CodexConversationHistoryTurnItemsRef) => void;
}

function MeasuredTurnComponent({
  retainedTopPx,
  entry,
  conversationId,
  childMemberships,
  parentModel,
  backgroundAgentRows,
  threadCwd,
  projectWorkspacePath,
  projectlessOutputDirectory,
  initialCollapsedOverride,
  canEditTurnUserPrefix,
  canForkTurn,
  onEditUserTurn,
  onForkTurnMessage,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSubagentsPanel,
  onOpenSummaryScheduledAutomation,
  onOpenMcpAppSidePanel,
  onOpenPlanInSidePanel,
  onClosePlanSidePanel,
  planSidePanelState,
  turnDiffHoverPreviewDisabled = false,
  isLatestTurn,
  latestTurnFollowContentRef,
  observeTurnElement,
  historyItemRef,
  historyItemLoading,
  retryHistoryItems,
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
      className={cn(
        "[&_[data-virtualized-turn-content]]:[content-visibility:visible]",
        retainedTopPx !== undefined && "absolute inset-x-0",
      )}
      style={retainedTopPx === undefined ? undefined : { top: retainedTopPx }}
      data-thread-turn-id={entry.turnKey}
      data-turn-key={entry.turnKey}
    >
      {isCodexRealtimeTimelineEntry(entry) ? (
        <LocalConversationRealtimeTranscript
          entry={entry}
          conversationId={conversationId}
          cwd={threadCwd}
        />
      ) : (
        <LocalConversationTurnEntry
          conversationId={conversationId}
          childMemberships={childMemberships}
          parentModel={parentModel}
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
          onEditUserTurn={onEditUserTurn}
          onForkTurnMessage={onForkTurnMessage}
          onOpenTurnDiffReview={onOpenTurnDiffReview}
          onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
          onOpenSideChat={onOpenSideChat}
          onOpenThread={onOpenThread}
          onOpenSubagentsPanel={onOpenSubagentsPanel}
          onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
          onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
          onOpenPlanInSidePanel={onOpenPlanInSidePanel}
          onClosePlanSidePanel={onClosePlanSidePanel}
          planSidePanelState={planSidePanelState}
          turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
          latestTurnFollowContentRef={isLatestTurn ? latestTurnFollowContentRef : undefined}
        />
      )}
      {historyItemRef ? (
        <div className="flex min-h-9 items-center justify-center">
          {historyItemLoading ? (
            <span role="status">
              <ActivitySpinnerIcon className="icon-xs" />
              <span className="sr-only">Loading history</span>
            </span>
          ) : (
            <button
              type="button"
              className="text-xs text-token-text-secondary hover:text-token-foreground"
              onClick={() => retryHistoryItems?.(historyItemRef)}
            >
              Try again
            </button>
          )}
        </div>
      ) : null}
    </div>
  );

  return turnContent;
}

const MeasuredTurn = memo(
  MeasuredTurnComponent,
  (left, right) =>
    left.retainedTopPx === right.retainedTopPx &&
    left.entry === right.entry &&
    left.conversationId === right.conversationId &&
    left.parentModel === right.parentModel &&
    left.backgroundAgentRows === right.backgroundAgentRows &&
    left.threadCwd === right.threadCwd &&
    left.projectWorkspacePath === right.projectWorkspacePath &&
    left.projectlessOutputDirectory === right.projectlessOutputDirectory &&
    left.initialCollapsedOverride === right.initialCollapsedOverride &&
    left.canEditTurnUserPrefix === right.canEditTurnUserPrefix &&
    left.canForkTurn === right.canForkTurn &&
    left.onEditUserTurn === right.onEditUserTurn &&
    left.onForkTurnMessage === right.onForkTurnMessage &&
    left.onOpenTurnDiffReview === right.onOpenTurnDiffReview &&
    left.onOpenTurnDiffFileInSidePanel === right.onOpenTurnDiffFileInSidePanel &&
    left.onOpenSideChat === right.onOpenSideChat &&
    left.onOpenThread === right.onOpenThread &&
    left.onOpenSubagentsPanel === right.onOpenSubagentsPanel &&
    left.onOpenSummaryScheduledAutomation === right.onOpenSummaryScheduledAutomation &&
    left.onOpenMcpAppSidePanel === right.onOpenMcpAppSidePanel &&
    left.onOpenPlanInSidePanel === right.onOpenPlanInSidePanel &&
    left.onClosePlanSidePanel === right.onClosePlanSidePanel &&
    left.planSidePanelState === right.planSidePanelState &&
    left.turnDiffHoverPreviewDisabled === right.turnDiffHoverPreviewDisabled &&
    left.isLatestTurn === right.isLatestTurn &&
    left.latestTurnFollowContentRef === right.latestTurnFollowContentRef &&
    left.historyItemRef === right.historyItemRef &&
    left.historyItemLoading === right.historyItemLoading &&
    left.retryHistoryItems === right.retryHistoryItems &&
    left.observeTurnElement === right.observeTurnElement,
);

function LocalConversationVirtualizedTurnListCore({
  entries,
  historyRows,
  conversationId,
  childMemberships,
  parentModel,
  backgroundAgentRows,
  threadCwd,
  projectWorkspacePath,
  projectlessOutputDirectory,
  editableTurnIds,
  canForkFromTurn,
  initialCollapsedAgentBodyByTurnSearchKey,
  onEditUserTurn,
  onForkTurnMessage,
  onOpenTurnDiffReview,
  onOpenTurnDiffFileInSidePanel,
  onOpenSideChat,
  onOpenThread,
  onOpenSubagentsPanel,
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
  onLatestTurnHeightChange,
  onViewportChange,
  onHistoryRetentionBoundaryChange,
  historyGapState,
  historyItemState,
  historyItemRefs,
  retryHistoryItems,
  retryHistoryBoundary,
  preserveMeasuredTurnViewport = false,
  scrollController,
  getPendingRestoreScrollDistanceFromBottomPx,
  getResponseSpacerHeightPx,
  restoreScrollDistanceFromBottomPx,
}: CoreProps) {
  const resolvedInitialRestoreState = resolveRealtimeTranscriptRestoreState(
    initialRestoreState,
    entries,
  );
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>(
    () => resolvedInitialRestoreState?.turnHeightsByKey ?? {},
  );
  const [listRoot, setListRoot] = useState<HTMLDivElement | null>(null);
  const [pixelScale, setPixelScale] = useState(() =>
    readPhysicalPixelScale(scrollController.getScrollElement()),
  );
  const pixelScaleRef = useRef(pixelScale);
  const latestNativeTurnKey = useMemo(
    () => readLatestCodexTimelineTurnEntry(entries)?.turnKey ?? null,
    [entries],
  );
  const rows = useMemo(
    () => buildLocalConversationVirtualizedHistoryRows({ entries, historyRows }),
    [entries, historyRows],
  );
  const layout = useMemo(
    () =>
      buildVirtualizedTurnLayout({
        entries: rows.map((row) => ({
          turnKey: row.layoutKey,
          estimatedHeightPx:
            row.kind === "gap"
              ? row.row.estimatedHeightPx
              : isCodexRealtimeTimelineEntry(row.entry) &&
                  row.entry.itemType === "transcriptSegment"
                ? row.entry.estimatedHeightPx
                : null,
          type: row.kind,
        })),
        gapPx: TURN_GAP_PX,
        measuredHeightsByKey: measuredHeights,
        pixelScale,
      }),
    [measuredHeights, pixelScale, rows],
  );
  const [virtualViewportState, setVirtualViewportState] = useState<VirtualizedTurnViewportState>(
    () =>
      resolveInitialVirtualizedTurnViewportState({
        distanceFromBottomPx: initialScrollOffset,
        initialRestoreState: resolvedInitialRestoreState,
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
  const preMeasurementLayoutRef = useRef<typeof layout | null>(null);
  const measuredHeightsRef = useRef(measuredHeights);
  const virtualViewportStateRef = useRef(virtualViewportState);
  const latestNativeTurnKeyRef = useRef(latestNativeTurnKey);
  const rowsRef = useRef(rows);
  const listRootRef = useRef<HTMLDivElement | null>(null);
  const visibleContentReadyRef = useRef(false);
  const turnElementsByKeyRef = useRef(new Map<string, HTMLElement>());
  const measuredContentAnchorRef = useRef<MeasuredContentAnchor | null>(null);
  const observedElementMetadataRef = useRef(new Map<Element, ObservedElementMetadata>());
  const pendingTurnMeasurementsRef = useRef(new Map<string, TurnMeasurement>());
  const followContentHeightsRef = useRef(new Map<HTMLElement, number>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const flushMeasurementsRef = useRef<() => void>(() => {});
  const pendingFollowContentMeasurementRef = useRef(false);
  const pendingLayoutEffectRef = useRef<PendingLayoutEffect | null>(null);
  const pendingRealtimeAnchorRef = useRef<RealtimeTranscriptViewportAnchor | null>(
    resolvedInitialRestoreState?.realtimeAnchor ?? null,
  );
  const retiringRealtimeAnchorsRef = useRef(
    new Map<string, readonly RealtimeTranscriptViewportAnchor[]>(),
  );
  const viewportRevisionRef = useRef(0);
  const lastScrollElementRef = useRef<HTMLDivElement | null>(null);

  useInsertionEffect(() => {
    pixelScaleRef.current = pixelScale;
    layoutRef.current = layout;
    measuredHeightsRef.current = measuredHeights;
    latestNativeTurnKeyRef.current = latestNativeTurnKey;
    rowsRef.current = rows;
    listRootRef.current = listRoot;
    if (scrollController.scrollElement)
      lastScrollElementRef.current = scrollController.scrollElement;
  }, [
    latestNativeTurnKey,
    layout,
    listRoot,
    measuredHeights,
    pixelScale,
    rows,
    scrollController.scrollElement,
  ]);

  const publishViewportState = useCallback((next: VirtualizedTurnViewportState) => {
    // Native placement and measurement callbacks share this state before React commits.
    virtualViewportStateRef.current = next;
    setVirtualViewportState(next);
  }, []);

  const getScrollElement = useCallback(() => {
    const element = scrollController.getScrollElement();
    if (element) lastScrollElementRef.current = element;
    return element;
  }, [scrollController]);

  const shouldFollowMeasuredGrowth = useCallback(() => {
    const element = getScrollElement();
    if (element === null) return false;
    return shouldFollowMeasuredTurnGrowth({
      shouldFollowContentGrowth: scrollController.shouldFollowContentGrowth(),
      responseSpacerHeightPx: getResponseSpacerHeightPx(),
      physicalDistanceFromBottomPx: getThreadScrollDistanceFromBottomPx(element),
    });
  }, [getResponseSpacerHeightPx, getScrollElement, scrollController]);

  const canPreserveContentAnchor = useCallback(
    () =>
      preserveMeasuredTurnViewport &&
      scrollController.getScrollMode() === "user" &&
      !scrollController.hasPendingLatestTurnSubmitPlacement() &&
      scrollController.getLastScrollDistanceFromBottomPx() >= 0 &&
      activePendingTargetRef.current === null &&
      pendingRealtimeAnchorRef.current === null &&
      getPendingRestoreScrollDistanceFromBottomPx() === null &&
      !shouldFollowMeasuredGrowth(),
    [
      getPendingRestoreScrollDistanceFromBottomPx,
      preserveMeasuredTurnViewport,
      scrollController,
      shouldFollowMeasuredGrowth,
    ],
  );
  const captureContentAnchor = useCallback(() => {
    const element = getScrollElement();
    measuredContentAnchorRef.current =
      element && canPreserveContentAnchor()
        ? readMeasuredContentAnchor(element, turnElementsByKeyRef.current)
        : null;
  }, [canPreserveContentAnchor, getScrollElement]);

  const emitViewportChange = useCallback(
    (
      distanceFromBottomPx: number,
      viewportHeightPx: number,
      previousDistanceFromBottomPx?: number,
    ) => {
      if (!onViewportChange && !onHistoryRetentionBoundaryChange) return;
      const currentLayout = layoutRef.current;
      const viewportEndPx = Math.max(
        0,
        Math.min(currentLayout.totalHeightPx, currentLayout.totalHeightPx - distanceFromBottomPx),
      );
      const viewportStartPx = Math.max(0, viewportEndPx - viewportHeightPx);
      const range = resolveVisibleTurnRangeFromBottomDistance({
        distanceFromBottomPx,
        layout: currentLayout,
        overscanCount: 0,
        viewportHeightPx,
      });
      onHistoryRetentionBoundaryChange?.(
        projectCodexHistoryViewportBoundary({
          distanceFromBottom: distanceFromBottomPx,
          hasPendingScrollTarget:
            activePendingTargetRef.current !== null ||
            getPendingRestoreScrollDistanceFromBottomPx() !== null,
          viewportRows: rowsRef.current.slice(range.startIndex, range.endIndex).map((row) =>
            row.kind === "gap"
              ? { kind: "gap" }
              : {
                  kind: "content",
                  turnId: row.entry.turnId,
                  status: readTimelineEntryStatus(row.entry),
                  turnItemIds: isCodexRealtimeTimelineEntry(row.entry)
                    ? []
                    : isNormalizedConversationTurnEntry(row.entry)
                      ? row.entry.turnItemIds
                      : row.entry.turn.itemIds,
                },
          ),
        }),
      );
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
      onViewportChange?.({
        distanceFromBottomPx,
        gaps,
        turns,
        target,
        totalHeightPx: currentLayout.totalHeightPx,
        viewportEndPx,
        viewportHeightPx,
        viewportRevision: viewportRevisionRef.current,
        viewportStartPx,
      });
    },
    [
      getPendingRestoreScrollDistanceFromBottomPx,
      onHistoryRetentionBoundaryChange,
      onViewportChange,
    ],
  );

  const updateViewportState = useCallback(
    (
      distanceFromBottomPx: number,
      viewportHeightPx: number,
      previousDistanceFromBottomPx?: number,
      advanceViewportRevision = false,
    ) => {
      if (advanceViewportRevision) viewportRevisionRef.current += 1;
      const next = resolveVirtualizedTurnViewportState({
        current: virtualViewportStateRef.current,
        distanceFromBottomPx,
        layout: layoutRef.current,
        overscanCount: OVERSCAN_TURNS,
        viewportHeightPx,
      });
      publishViewportState(next);
      emitViewportChange(distanceFromBottomPx, viewportHeightPx, previousDistanceFromBottomPx);
    },
    [emitViewportChange, publishViewportState],
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

  const applyMeasurementEffects = useCallback(
    (effect: PendingLayoutEffect) => {
      const anchor = effect.contentAnchor;
      const scrollElement = getScrollElement();
      const preserveAnchor =
        anchor &&
        anchor === measuredContentAnchorRef.current &&
        canPreserveContentAnchor() &&
        scrollElement &&
        turnElementsByKeyRef.current.get(anchor.turnKey) === anchor.row &&
        anchor.row.contains(anchor.leaf);
      // Resolve after layout: removing a gap can clamp native scroll before the
      // enlarged Turn is measured. The retained leaf also distinguishes growth
      // before the reading position from growth after it.
      const nativeScrollDistanceFromBottomPx = anchor
        ? preserveAnchor
          ? getThreadScrollDistanceFromBottomPx(scrollElement) +
            anchor.topWithinViewportPx -
            (anchor.leaf.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top) /
              readCodexWindowZoom(scrollElement)
          : null // A user scroll or navigation superseded this measurement's sample.
        : effect.nativeScrollDistanceFromBottomPx;
      applyLocalConversationTurnMeasurementEffect({
        effect: { ...effect, nativeScrollDistanceFromBottomPx },
        getResponseSpacerHeightPx,
        onLatestTurnHeightChange,
        restoreScrollDistanceFromBottomPx,
        compensateScrollToDistanceFromBottomPx:
          scrollController.compensateScrollToDistanceFromBottomPx,
      });
      captureContentAnchor();
    },
    [
      canPreserveContentAnchor,
      captureContentAnchor,
      getResponseSpacerHeightPx,
      getScrollElement,
      onLatestTurnHeightChange,
      restoreScrollDistanceFromBottomPx,
      scrollController,
    ],
  );

  const applyTurnMeasurements = useCallback(
    (measurements: Map<string, TurnMeasurement>, sync: boolean): boolean => {
      if (measurements.size === 0) return false;
      const currentHeights = measuredHeightsRef.current;
      const currentLayout = layoutRef.current;
      const currentViewport = virtualViewportStateRef.current;
      const capturedAnchor = measuredContentAnchorRef.current;
      const contentAnchor =
        canPreserveContentAnchor() &&
        capturedAnchor &&
        turnElementsByKeyRef.current.get(capturedAnchor.turnKey) === capturedAnchor.row &&
        capturedAnchor.row.contains(capturedAnchor.leaf)
          ? capturedAnchor
          : null;
      const responseSpaceHeightAtMeasurementPx = getResponseSpacerHeightPx();
      let nextHeights = currentHeights;
      let hasChanged = false;
      let measuredDistanceDeltaPx = 0;
      let latestTurnHeightDeltaPx = 0;
      let latestTurnElement: HTMLElement | null = null;
      const latestTurnKey = latestNativeTurnKeyRef.current;
      const pendingRestoreDistanceFromBottomPx = preserveMeasuredTurnViewport
        ? null
        : getPendingRestoreScrollDistanceFromBottomPx();

      for (const [turnKey, measurement] of measurements) {
        if (!Number.isFinite(measurement.heightPx) || measurement.heightPx < 0) continue;
        const nextHeightPx = normalizeMeasuredHeightPx(measurement.heightPx);
        if (currentHeights[turnKey] === nextHeightPx) continue;
        if (nextHeights === currentHeights) {
          nextHeights = { ...currentHeights };
        }
        nextHeights[turnKey] = nextHeightPx;
        hasChanged = true;

        const turnIndex = currentLayout.turnIndexByKey.get(turnKey);
        if (turnIndex == null) continue;
        const roundedHeightPx =
          Math.round(nextHeightPx * pixelScaleRef.current) / pixelScaleRef.current;
        const layoutHeightPx = currentLayout.heightsPx[turnIndex] ?? roundedHeightPx;
        const layoutDeltaPx = roundedHeightPx - layoutHeightPx;
        if (turnKey === latestTurnKey) {
          latestTurnHeightDeltaPx += currentHeights[turnKey] === undefined ? 0 : layoutDeltaPx;
          latestTurnElement = measurement.element;
        }
        const bottomOffsetPx = currentLayout.bottomOffsetsPx[turnIndex] ?? 0;
        const isLatestTurn = turnKey === latestTurnKey;
        if (
          layoutDeltaPx !== 0 &&
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
          estimatedHeightPx:
            row.kind === "gap"
              ? row.row.estimatedHeightPx
              : isCodexRealtimeTimelineEntry(row.entry) &&
                  row.entry.itemType === "transcriptSegment"
                ? row.entry.estimatedHeightPx
                : null,
          type: row.kind,
        })),
        gapPx: TURN_GAP_PX,
        measuredHeightsByKey: nextHeights,
        pixelScale: pixelScaleRef.current,
      });
      let nextDistanceFromBottomPx = currentViewport.distanceFromBottomPx;
      let scrollDistanceFromBottomPx: number | null = null;
      let restoreScrollDistanceFromBottom = false;
      if (pendingRestoreDistanceFromBottomPx !== null) {
        nextDistanceFromBottomPx = pendingRestoreDistanceFromBottomPx;
        restoreScrollDistanceFromBottom = true;
      } else if (preserveMeasuredTurnViewport && shouldFollowMeasuredGrowth()) {
        nextDistanceFromBottomPx = 0;
        scrollDistanceFromBottomPx = 0;
      } else if (measuredDistanceDeltaPx !== 0) {
        scrollDistanceFromBottomPx =
          scrollController.getUnroundedScrollDistanceFromBottomPx(
            scrollController.getLastScrollDistanceFromBottomPx(),
          ) + measuredDistanceDeltaPx;
        nextDistanceFromBottomPx = Math.max(0, scrollDistanceFromBottomPx);
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
      const measurementEffect: PendingLayoutEffect = {
        contentAnchor,
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
        nativeScrollDistanceFromBottomPx:
          scrollDistanceFromBottomPx === null
            ? null
            : scrollDistanceFromBottomPx + responseSpaceHeightAtMeasurementPx,
        turnHeightsByKey: nextHeights,
      };
      // A same-row submit places after child layout. Publish its already measured
      // content before that placement, rather than consuming the new space later.
      const publishLatestMeasurementImmediately =
        !sync &&
        contentAnchor === null &&
        measurements.size === 1 &&
        latestTurnElement !== null &&
        latestTurnKey === currentLayout.turnKeys.at(-1) &&
        currentHeights[latestTurnKey] !== undefined &&
        pendingLayoutEffectRef.current === null &&
        nextViewport.renderedRange === currentViewport.renderedRange &&
        nextLayout.gapsBeforePx.at(-1) === currentLayout.gapsBeforePx.at(-1);
      pendingLayoutEffectRef.current = publishLatestMeasurementImmediately
        ? null
        : measurementEffect;

      const commit = () => {
        if (preMeasurementLayoutRef.current === null)
          preMeasurementLayoutRef.current = currentLayout;
        setMeasuredHeights(nextHeights);
        publishViewportState(nextViewport);
      };
      if (sync) {
        flushSync(commit);
      } else {
        commit();
      }
      if (publishLatestMeasurementImmediately) applyMeasurementEffects(measurementEffect);
      return true;
    },
    [
      applyMeasurementEffects,
      canPreserveContentAnchor,
      getPendingRestoreScrollDistanceFromBottomPx,
      getResponseSpacerHeightPx,
      getScrollElement,
      preserveMeasuredTurnViewport,
      publishViewportState,
      scrollController,
      shouldFollowMeasuredGrowth,
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
  useInsertionEffect(() => {
    flushMeasurementsRef.current = flushMeasurements;
  }, [flushMeasurements]);

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
        if (measuredBlockSizePx < 0) continue;
        const heightPx =
          metadata.kind === "turn"
            ? normalizeMeasuredHeightPx(measuredBlockSizePx)
            : measuredBlockSizePx;
        if (metadata.kind === "turn") {
          const turnKey = metadata.turnKey;
          if (!turnKey) continue;
          const element = entry.target as HTMLElement;
          pendingTurnMeasurementsRef.current.set(turnKey, {
            element,
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
          heightPx,
        });
        scheduleMeasurementFlush(false);
      }
      const observer = getResizeObserver();
      observer?.observe(element);
      return () => {
        const scrollElement = getScrollElement();
        if (
          preserveMeasuredTurnViewport &&
          scrollElement &&
          scrollController.getScrollMode() === "user" &&
          element.querySelector("[data-native-realtime-item-id]") !== null
        ) {
          const residentItemIds = new Set(
            rowsRef.current.flatMap((row) =>
              row.kind === "content" &&
              isCodexRealtimeTimelineEntry(row.entry) &&
              row.entry.itemType === "transcriptSegment"
                ? row.entry.segmentIds
                : [],
            ),
          );
          if (!retiringRealtimeAnchorsRef.current.has(turnKey)) {
            const anchors = readRealtimeTranscriptViewportAnchors({
              rows: [element],
              scrollElement,
              residentItemIds,
              windowZoom: readCodexWindowZoom(scrollElement),
            });
            if (anchors.length > 0) retiringRealtimeAnchorsRef.current.set(turnKey, anchors);
          }
        }
        observer?.unobserve(element);
        observedElementMetadataRef.current.delete(element);
        if (turnElementsByKeyRef.current.get(turnKey) === element) {
          turnElementsByKeyRef.current.delete(turnKey);
        }
      };
    },
    [
      getResizeObserver,
      getScrollElement,
      preserveMeasuredTurnViewport,
      scheduleMeasurementFlush,
      scrollController,
    ],
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
        followContentHeightsRef.current.set(element, measuredHeightPx);
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
    (
      turnKey: string,
      getTargetElement?: LocalConversationVirtualizedTurnTargetResolver,
      options?: { readonly signal?: AbortSignal },
    ) => {
      if (options?.signal?.aborted) return Promise.resolve();
      onHistoryRetentionBoundaryChange?.(null);
      activePendingTargetRef.current?.complete();
      requestIdRef.current += 1;
      const requestId = requestIdRef.current;
      return new Promise<void>((resolve) => {
        const target: PendingVirtualizedTurnScrollTarget = {
          complete: () => {
            options?.signal?.removeEventListener("abort", abort);
            resolve();
          },
          getTargetElement,
          requestId,
          turnKey,
        };
        const abort = () => {
          if (activePendingTargetRef.current === target) activePendingTargetRef.current = null;
          setPendingScrollTarget((current) => (current === target ? null : current));
          target.complete();
        };
        options?.signal?.addEventListener("abort", abort, { once: true });
        activePendingTargetRef.current = target;
        scrollController.setScrollMode("programmaticFind");
        setPendingScrollTarget(target);
      });
    },
    [onHistoryRetentionBoundaryChange, scrollController],
  );

  useLayoutEffect(() => {
    emitViewportChange(
      virtualViewportState.distanceFromBottomPx,
      virtualViewportState.viewportHeightPx,
    );
  }, [
    emitViewportChange,
    layout,
    pendingScrollTarget,
    virtualViewportState.distanceFromBottomPx,
    virtualViewportState.viewportHeightPx,
  ]);

  useEffect(
    () => () => onHistoryRetentionBoundaryChange?.(undefined),
    [onHistoryRetentionBoundaryChange],
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
    applyMeasurementEffects(pendingEffect);
  }, [applyMeasurementEffects, measuredHeights]);

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (scrollElement === null) return;
    const getViewportHeightPx = () =>
      scrollElement.clientHeight ||
      virtualViewportStateRef.current.viewportHeightPx ||
      DEFAULT_VIEWPORT_HEIGHT_PX;
    const syncViewportState = (
      distanceFromBottomPx?: number,
      previousDistanceFromBottomPx?: number,
      advanceViewportRevision = false,
    ) => {
      setPixelScale(readPhysicalPixelScale(scrollElement));
      updateViewportState(
        distanceFromBottomPx ?? scrollController.getLastScrollDistanceFromBottomPx(),
        getViewportHeightPx(),
        previousDistanceFromBottomPx,
        advanceViewportRevision,
      );
    };
    syncViewportState();
    const handleWindowResize = () => syncViewportState();
    window.addEventListener("resize", handleWindowResize);
    const removeScrollListener = scrollController.addScrollListener((distanceFromBottomPx) => {
      if (!canPreserveContentAnchor()) measuredContentAnchorRef.current = null;
      syncViewportState(distanceFromBottomPx);
    });
    const removeUserScrollListener = scrollController.addUserScrollListener(
      (distanceFromBottomPx, previousDistanceFromBottomPx) => {
        captureContentAnchor();
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
      window.removeEventListener("resize", handleWindowResize);
      removeScrollListener();
      removeUserScrollListener();
      observer?.disconnect();
    };
  }, [
    canPreserveContentAnchor,
    captureContentAnchor,
    getScrollElement,
    restoreScrollDistanceFromBottomPx,
    scrollController,
    updateViewportState,
  ]);

  useLayoutEffect(() => {
    // Child ref cleanup precedes this owner's insertion effect. Decide row removal
    // against committed rows here, after capturing geometry from the old DOM.
    const retiring = retiringRealtimeAnchorsRef.current;
    if (pendingRealtimeAnchorRef.current === null && retiring.size > 0) {
      const rows = rowsRef.current;
      const rowKeys = new Set(rows.map((row) => row.layoutKey));
      const residentItemIds = new Set(
        rows.flatMap((row) =>
          row.kind === "content" &&
          isCodexRealtimeTimelineEntry(row.entry) &&
          row.entry.itemType === "transcriptSegment"
            ? row.entry.segmentIds
            : [],
        ),
      );
      pendingRealtimeAnchorRef.current = resolveRetiringRealtimeTranscriptViewportAnchor({
        retiringRows: retiring,
        committedRowKeys: rowKeys,
        residentItemIds,
      });
    }
    retiring.clear();
    const anchor = pendingRealtimeAnchorRef.current;
    if (!anchor || getPendingRestoreScrollDistanceFromBottomPx() !== null) return;
    const scrollElement = getScrollElement();
    if (!scrollElement) return;
    const row = rowsRef.current.find(
      (row) =>
        row.kind === "content" &&
        isCodexRealtimeTimelineEntry(row.entry) &&
        row.entry.itemType === "transcriptSegment" &&
        row.entry.segmentIds.includes(anchor.itemId),
    );
    if (!row) {
      pendingRealtimeAnchorRef.current = null;
      return;
    }
    if (measuredHeightsRef.current[row.layoutKey] === undefined) return;
    const element = turnElementsByKeyRef.current.get(row.layoutKey);
    const leaf =
      element &&
      Array.from(element.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]")).find(
        (leaf) => leaf.dataset.nativeRealtimeItemId === anchor.itemId,
      );
    if (!leaf) return;
    pendingRealtimeAnchorRef.current = null;
    if (scrollController.getScrollMode() === "programmaticFind") return;
    const currentTopWithinViewportPx =
      (leaf.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top) /
      readCodexWindowZoom(scrollElement);
    const distanceFromBottomPx = resolveRealtimeTranscriptAnchorDistance({
      distanceFromBottomPx: scrollController.getUnroundedScrollDistanceFromBottomPx(
        scrollController.getLastScrollDistanceFromBottomPx(),
      ),
      currentTopWithinViewportPx,
      anchorTopWithinViewportPx: anchor.topWithinViewportPx,
    });
    updateViewportState(distanceFromBottomPx, scrollElement.clientHeight);
    scrollController.compensateScrollToDistanceFromBottomPx(distanceFromBottomPx);
  });

  useLayoutEffect(() => {
    if (pendingLayoutEffectRef.current !== null) return;
    const previousLayout = previousLayoutRef.current;
    const unmeasuredLayout = preMeasurementLayoutRef.current ?? layout;
    preMeasurementLayoutRef.current = null;
    previousLayoutRef.current = layout;
    if (previousLayout === unmeasuredLayout) return;

    const current = virtualViewportStateRef.current;
    const anchorRange = resolveRetainedContentRange({
      previousTurnKeys: current.turnKeys,
      previousRange: current.renderedRange,
      layout,
    });
    const publishCurrentLayout = () =>
      publishViewportState(
        resolveVirtualizedTurnViewportState({
          current: anchorRange ? { ...current, renderedRange: anchorRange } : current,
          distanceFromBottomPx: current.distanceFromBottomPx,
          layout,
          overscanCount: OVERSCAN_TURNS,
          viewportHeightPx: current.viewportHeightPx,
        }),
      );

    if (
      !preserveMeasuredTurnViewport ||
      pendingScrollTarget !== null ||
      pendingRealtimeAnchorRef.current !== null
    ) {
      publishCurrentLayout();
      return;
    }
    const pendingRestoreDistance = getPendingRestoreScrollDistanceFromBottomPx();
    if (pendingRestoreDistance !== null || shouldFollowMeasuredGrowth()) {
      publishCurrentLayout();
      return;
    }
    const previousContentDistanceFromBottomPx =
      scrollController.getLastScrollDistanceFromBottomPx();
    const previousDistanceFromBottomPx = Math.max(0, previousContentDistanceFromBottomPx);
    const responseSpaceHeightPx = getResponseSpacerHeightPx();
    const scrollElement = getScrollElement();
    const scrollContent = scrollElement?.firstElementChild;
    const listRoot = listRootRef.current;
    const anchorDistanceFromBottomPx =
      scrollElement && scrollContent && listRoot
        ? previousContentDistanceFromBottomPx +
          responseSpaceHeightPx -
          (scrollContent.getBoundingClientRect().bottom - listRoot.getBoundingClientRect().bottom) /
            readCodexWindowZoom(scrollElement)
        : previousContentDistanceFromBottomPx;
    const anchorKey = resolveMeasuredVisibleAnchorKey({
      distanceFromBottomPx: anchorDistanceFromBottomPx,
      preferLatestVisibleRow: previousContentDistanceFromBottomPx < 0,
      layout: previousLayout,
      measuredHeightsByKey: measuredHeightsRef.current,
      nextLayout: unmeasuredLayout,
      viewportHeightPx: current.viewportHeightPx,
    });
    if (anchorKey === null) {
      publishCurrentLayout();
      return;
    }
    const preservedDistanceFromBottomPx = resolveAnchorPreservedDistanceFromBottom({
      anchorKey,
      distanceFromBottomPx: previousDistanceFromBottomPx,
      previousLayout,
      nextLayout: unmeasuredLayout,
    });
    if (
      preservedDistanceFromBottomPx === null ||
      preservedDistanceFromBottomPx === previousDistanceFromBottomPx
    ) {
      publishCurrentLayout();
      return;
    }
    updateViewportState(preservedDistanceFromBottomPx, current.viewportHeightPx);
    scrollController.compensateScrollToDistanceFromBottomPx(
      scrollController.getUnroundedScrollDistanceFromBottomPx(previousContentDistanceFromBottomPx) +
        preservedDistanceFromBottomPx -
        previousDistanceFromBottomPx,
    );
  }, [
    getResponseSpacerHeightPx,
    getScrollElement,
    getPendingRestoreScrollDistanceFromBottomPx,
    layout,
    pendingScrollTarget,
    preserveMeasuredTurnViewport,
    publishViewportState,
    scrollController,
    shouldFollowMeasuredGrowth,
    updateViewportState,
  ]);

  const visibleRange = useMemo((): VisibleTurnRange => {
    if (scrollController.scrollElement === null) {
      return {
        startIndex: Math.max(0, rows.length - COLLAPSED_VISIBLE_TURNS),
        endIndex: rows.length,
      };
    }
    if (!pendingScrollTarget)
      return (
        resolveRetainedContentRange({
          previousTurnKeys: virtualViewportState.turnKeys,
          previousRange: virtualViewportState.renderedRange,
          layout,
        }) ?? virtualViewportState.renderedRange
      );
    return resolveRenderedRangeForPendingScrollTarget({
      currentRange: virtualViewportState.renderedRange,
      layout,
      overscanCount: OVERSCAN_TURNS,
      pendingTurnKey: pendingScrollTarget.turnKey,
      viewportHeightPx: virtualViewportState.viewportHeightPx,
    });
  }, [
    layout,
    pendingScrollTarget,
    rows.length,
    scrollController.scrollElement,
    virtualViewportState.renderedRange,
    virtualViewportState.turnKeys,
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
      const current = virtualViewportStateRef.current;
      publishViewportState({
        ...current,
        renderedRange: resolveRenderedRangeForPendingScrollTarget({
          currentRange: current.renderedRange,
          layout,
          overscanCount: OVERSCAN_TURNS,
          pendingTurnKey: pendingScrollTarget.turnKey,
          viewportHeightPx: current.viewportHeightPx,
        }),
      });
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
    publishViewportState,
    scrollController,
    updateViewportState,
    visibleRange.endIndex,
    visibleRange.startIndex,
  ]);

  useLayoutEffect(() => {
    if (latestTurnSynchronousMeasurementKey == null) return;
    const latestTurnKey = latestNativeTurnKey;
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
            heightPx,
          },
        ],
      ]),
      false,
    );
  }, [applyTurnMeasurements, entries, latestNativeTurnKey, latestTurnSynchronousMeasurementKey]);

  useLayoutEffect(() => {
    const anchor = measuredContentAnchorRef.current;
    if (anchor?.leaf.isConnected && anchor.row.contains(anchor.leaf)) return;
    if (pendingTurnMeasurementsRef.current.size > 0 || pendingLayoutEffectRef.current) return;
    // Retain the previous sample across commits until measurement consumes it.
    captureContentAnchor();
  });

  useLayoutEffect(() => {
    if (!onVisibleContentReady || visibleContentReadyRef.current || listRoot === null) return;
    if (entries.length > 0 && turnElementsByKeyRef.current.size === 0) return;
    return scheduleAfterPaint(
      () => {
        visibleContentReadyRef.current = true;
        restoreScrollDistanceFromBottomPx();
        onVisibleContentReady();
      },
      { requireVisibleAtPaint: true },
    );
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
      const state = buildVirtualizedTurnListRestoreState({
        measuredHeightsByKey: measuredHeightsRef.current,
        renderedRange: virtualViewportStateRef.current.renderedRange,
        turnKeys: layoutRef.current.turnKeys,
      });
      if (!state) {
        onRestoreStateChange?.(null);
        return;
      }
      const anchorRow = rowsRef.current.find(
        (row) => row.layoutKey === state.renderedWindow.anchorKey,
      );
      const realtimeSegmentIds =
        anchorRow?.kind === "content" &&
        isCodexRealtimeTimelineEntry(anchorRow.entry) &&
        anchorRow.entry.itemType === "transcriptSegment"
          ? anchorRow.entry.segmentIds
          : undefined;
      const scrollElement = getScrollElement() ?? lastScrollElementRef.current;
      const residentItemIds = new Set(
        rowsRef.current.flatMap((row) =>
          row.kind === "content" &&
          isCodexRealtimeTimelineEntry(row.entry) &&
          row.entry.itemType === "transcriptSegment"
            ? row.entry.segmentIds
            : [],
        ),
      );
      const realtimeAnchor =
        scrollElement &&
        readRealtimeTranscriptViewportAnchor({
          rows: turnElementsByKeyRef.current.values(),
          scrollElement,
          residentItemIds,
          windowZoom: readCodexWindowZoom(scrollElement),
        });
      onRestoreStateChange?.({
        ...state,
        renderedWindow: {
          ...state.renderedWindow,
          ...(realtimeSegmentIds ? { realtimeSegmentIds } : {}),
        },
        ...(realtimeAnchor ? { realtimeAnchor } : {}),
      });
    },
    [getScrollElement, onRestoreStateChange],
  );

  const visibleRows = rows.slice(visibleRange.startIndex, visibleRange.endIndex);
  const retainedTurnIndex = scrollController.nativeFindTurnKey
    ? layout.turnIndexByKey.get(scrollController.nativeFindTurnKey)
    : undefined;
  const retainedRow = retainedTurnIndex === undefined ? undefined : rows[retainedTurnIndex];
  if (
    retainedRow?.kind === "content" &&
    retainedTurnIndex !== undefined &&
    (retainedTurnIndex < visibleRange.startIndex || retainedTurnIndex >= visibleRange.endIndex)
  ) {
    // Keep the destination connected while native smooth scrolling crosses the bounded window.
    if (retainedTurnIndex < visibleRange.startIndex) visibleRows.unshift(retainedRow);
    else visibleRows.push(retainedRow);
  }
  const topSpacerHeightPx = layout.topOffsetsPx[visibleRange.startIndex] ?? 0;
  const shownHistoryItemKeys = new Set<string>();

  return (
    <div
      ref={setListRoot}
      className={cn("relative shrink-0", className)}
      style={{ height: `${layout.totalHeightPx}px` }}
    >
      <div
        className="flex flex-col"
        style={{
          gap: `${Math.round(TURN_GAP_PX * pixelScale) / pixelScale}px`,
          marginTop: `${topSpacerHeightPx}px`,
        }}
      >
        {visibleRows.map((row) => {
          if (row.kind === "gap") {
            return (
              <LocalConversationHistoryGap
                key={row.layoutKey}
                row={row.row}
                state={historyGapState}
                onRetry={retryHistoryBoundary}
              />
            );
          }
          const entry = row.entry;
          const isLatestTurn = entry.turnKey === latestNativeTurnKey;
          const itemRefs = entry.turnId === null ? undefined : historyItemRefs?.[entry.turnId];
          const historyItemRef = [itemRefs?.older, itemRefs?.newer].find(
            (ref) =>
              ref &&
              !shownHistoryItemKeys.has(codexConversationHistoryTurnItemsRefKey(ref)) &&
              (historyItemState.failed.has(codexConversationHistoryTurnItemsRefKey(ref)) ||
                historyItemState.loading.has(codexConversationHistoryTurnItemsRefKey(ref))),
          );
          if (historyItemRef)
            shownHistoryItemKeys.add(codexConversationHistoryTurnItemsRefKey(historyItemRef));
          return (
            <MeasuredTurn
              key={row.layoutKey}
              retainedTopPx={
                row === retainedRow &&
                retainedTurnIndex !== undefined &&
                (retainedTurnIndex < visibleRange.startIndex ||
                  retainedTurnIndex >= visibleRange.endIndex)
                  ? layout.topOffsetsPx[retainedTurnIndex]
                  : undefined
              }
              entry={entry}
              conversationId={conversationId}
              childMemberships={childMemberships}
              parentModel={parentModel}
              backgroundAgentRows={backgroundAgentRows}
              threadCwd={threadCwd}
              projectWorkspacePath={projectWorkspacePath}
              projectlessOutputDirectory={projectlessOutputDirectory}
              initialCollapsedOverride={
                initialCollapsedAgentBodyByTurnSearchKey?.[entry.turnSearchKey]
              }
              canEditTurnUserPrefix={entry.turnId !== null && editableTurnIds.has(entry.turnId)}
              canForkTurn={
                canForkFromTurn &&
                !isCodexRealtimeTimelineEntry(entry) &&
                readTimelineEntryStatus(entry) !== "inProgress"
              }
              onEditUserTurn={onEditUserTurn}
              onForkTurnMessage={onForkTurnMessage}
              onOpenTurnDiffReview={onOpenTurnDiffReview}
              onOpenTurnDiffFileInSidePanel={onOpenTurnDiffFileInSidePanel}
              onOpenSideChat={onOpenSideChat}
              onOpenThread={onOpenThread}
              onOpenSubagentsPanel={onOpenSubagentsPanel}
              onOpenSummaryScheduledAutomation={onOpenSummaryScheduledAutomation}
              onOpenMcpAppSidePanel={onOpenMcpAppSidePanel}
              onOpenPlanInSidePanel={onOpenPlanInSidePanel}
              onClosePlanSidePanel={onClosePlanSidePanel}
              planSidePanelState={planSidePanelState}
              turnDiffHoverPreviewDisabled={turnDiffHoverPreviewDisabled}
              isLatestTurn={isLatestTurn}
              latestTurnFollowContentRef={observeLatestTurnFollowContent}
              observeTurnElement={observeTurnElement}
              historyItemRef={historyItemRef ?? undefined}
              historyItemLoading={
                historyItemRef
                  ? historyItemState.loading.has(
                      codexConversationHistoryTurnItemsRefKey(historyItemRef),
                    )
                  : false
              }
              retryHistoryItems={retryHistoryItems}
            />
          );
        })}
      </div>
    </div>
  );
}

function createHistoryRequestScope(conversationId: string, source: object | undefined) {
  return {
    conversationId,
    source,
    items: createLocalConversationHistoryRequestGate(),
    gaps: createLocalConversationHistoryGapRequestCoordinator(),
  };
}

export function LocalConversationVirtualizedTurnList({
  entries,
  historyRows,
  historyRequestSource,
  initialScrollOffset = null,
  initialLatestTurnRestoreState = null,
  onLatestTurnRestoreStateChange,
  onLoadHistoryBoundary,
  historyTurnItemsRefs,
  onLoadHistoryTurnItems,
  scrollElement: _scrollElement,
  ...coreProps
}: LocalConversationVirtualizedTurnListProps) {
  const baseScrollController = useLocalConversationThreadScrollController();
  const [responseSpace] = useState(() => createThreadResponseSpaceController(baseScrollController));
  const [historyRequests, setHistoryRequests] = useState(() =>
    createHistoryRequestScope(coreProps.conversationId, historyRequestSource),
  );
  if (
    historyRequests.conversationId !== coreProps.conversationId ||
    historyRequests.source !== historyRequestSource
  )
    setHistoryRequests(createHistoryRequestScope(coreProps.conversationId, historyRequestSource));
  const { items: turnItemRequestGate, gaps: historyGapRequestCoordinator } = historyRequests;
  const historyItemState = useSyncExternalStore(
    turnItemRequestGate.subscribe,
    turnItemRequestGate.readState,
  );
  const retryHistoryItems = useCallback(
    (ref: CodexConversationHistoryTurnItemsRef) => {
      if (!onLoadHistoryTurnItems) return;
      const current = historyTurnItemsRefs?.[ref.turnId]?.[ref.edge];
      if (
        !current ||
        codexConversationHistoryTurnItemsRefKey(current) !==
          codexConversationHistoryTurnItemsRefKey(ref)
      )
        return;
      turnItemRequestGate.retry(codexConversationHistoryTurnItemsRefKey(current), () =>
        onLoadHistoryTurnItems(current),
      );
    },
    [historyTurnItemsRefs, onLoadHistoryTurnItems, turnItemRequestGate],
  );
  useLayoutEffect(() => {
    turnItemRequestGate.retain(
      new Set(
        Object.values(historyTurnItemsRefs ?? {}).flatMap((refs) =>
          [refs.older, refs.newer].flatMap((ref) =>
            ref ? [codexConversationHistoryTurnItemsRefKey(ref)] : [],
          ),
        ),
      ),
    );
  }, [historyTurnItemsRefs, turnItemRequestGate]);
  useLayoutEffect(() => {
    return () => turnItemRequestGate.retain(new Set());
  }, [turnItemRequestGate]);
  const latestTurnEntry = useMemo(() => readLatestCodexTimelineTurnEntry(entries), [entries]);
  const latest = useCodexTranscriptLatestTurnMetadata(latestTurnEntry);
  const latestTurnKey = latestTurnEntry?.turnKey ?? null;
  const nativeTurnKeys = useMemo(
    () =>
      new Set(
        entries.flatMap((entry) => (isCodexNativeTimelineTurnEntry(entry) ? [entry.turnKey] : [])),
      ),
    [entries],
  );
  // Read by the placement effect before this commit's values replace them.
  const committedTurnKeysRef = useRef<ReadonlySet<string>>(nativeTurnKeys);
  const committedLatestTurnKeyRef = useRef(latestTurnKey);
  const placementKey =
    latestTurnKey === null
      ? null
      : latest?.latestSteeringUserMessageKey == null
        ? latestTurnKey
        : latestTurnKey + ":" + latest.latestSteeringUserMessageKey;
  const latestTurnPhase = latest?.phase ?? "idle";
  const isLatestTurnInProgress = latest?.isInProgress ?? false;
  const initialRestore =
    initialLatestTurnRestoreState?.turnKey === latestTurnKey ? initialLatestTurnRestoreState : null;
  const restoredFollowMode =
    initialLatestTurnRestoreState?.followMode === "user_hold"
      ? "user_hold"
      : initialRestore?.followMode;
  const initialFollowMode =
    restoredFollowMode ??
    (isLatestTurnInProgress && (initialScrollOffset ?? 0) <= THREAD_NEAR_BOTTOM_THRESHOLD_PX
      ? latestTurnPhase === "prework"
        ? "prework_follow"
        : "user_follow"
      : "static");
  const latestTurnFollowStateRef = useRef<ThreadLatestTurnFollowState>({
    followMode: initialFollowMode,
  });
  const latestTurnFollowContentHeightPxRef = useRef(
    initialRestore?.latestTurnFollowContentHeightPx ?? null,
  );
  const latestTurnHeightPxRef = useRef(initialRestore?.latestTurnHeightPx ?? null);
  const pendingExpectedLatestTurnHeightPxRef = useRef(
    initialRestore && shouldAllowResponseSpacerGrowth(initialRestore.followMode)
      ? initialRestore.latestTurnHeightPx
      : null,
  );
  const initialScrollOffsetRef = useRef(initialScrollOffset);
  const hasRestoredInitialScrollRef = useRef(false);
  const isInitialActivePlacement =
    isLatestTurnInProgress && initialScrollOffset === null && initialRestore === null;
  const needsInitialActivePlacementRef = useRef(isInitialActivePlacement);
  const placementKeyRef = useRef(isInitialActivePlacement ? null : placementKey);
  const latestTurnKeyRef = useRef(latestTurnKey);
  const latestTurnPhaseRef = useRef(initialRestore?.latestTurnPhase ?? latestTurnPhase);
  const isLatestTurnInProgressRef = useRef(isLatestTurnInProgress);
  useInsertionEffect(() => {
    latestTurnKeyRef.current = latestTurnKey;
    isLatestTurnInProgressRef.current = isLatestTurnInProgress;
  }, [isLatestTurnInProgress, latestTurnKey]);
  const historyGapState = useSyncExternalStore(
    historyGapRequestCoordinator.subscribe,
    historyGapRequestCoordinator.readState,
  );
  const retryHistoryBoundary = useCallback(
    (boundary: CodexHistoryBoundaryRef) => {
      void historyGapRequestCoordinator.retryBoundary(boundary);
    },
    [historyGapRequestCoordinator],
  );
  useEffect(() => {
    return () => {
      void historyGapRequestCoordinator.observeViewport(null);
    };
  }, [historyGapRequestCoordinator]);

  const updateFollowState = useCallback(
    (event: Parameters<typeof resolveThreadLatestTurnFollowState>[1], force = false) => {
      const previous = latestTurnFollowStateRef.current;
      const next = resolveThreadLatestTurnFollowState(previous, event);
      latestTurnFollowStateRef.current = next;
      if (force || next.followMode !== previous.followMode) {
        baseScrollController.setFooterResizeViewportPreserveDisabled(
          isLatestTurnInProgressRef.current && shouldAllowResponseSpacerGrowth(next.followMode),
        );
      }
      return next;
    },
    [baseScrollController],
  );
  const holdLatestTurnViewport = useCallback(() => {
    hasRestoredInitialScrollRef.current = true;
    responseSpace.stop();
    updateFollowState({ type: "hold_viewport" }, true);
  }, [responseSpace, updateFollowState]);
  const scrollResponseSpacerToBottom = useCallback(() => {
    hasRestoredInitialScrollRef.current = true;
    updateFollowState(
      { type: "scroll_to_bottom", latestTurnPhase: latestTurnPhaseRef.current },
      true,
    );
    if (
      isLatestTurnInProgressRef.current ||
      (latestTurnPhaseRef.current === "idle" &&
        responseSpace.getHeightPx() > THREAD_NEAR_BOTTOM_THRESHOLD_PX)
    ) {
      responseSpace.clear();
      baseScrollController.scrollToDistanceFromBottomPx(0, "instant");
      return;
    }
    baseScrollController.scrollToBottom();
  }, [baseScrollController, responseSpace, updateFollowState]);
  const responseSpaceActionsRef = useRef({ holdLatestTurnViewport, scrollResponseSpacerToBottom });
  useInsertionEffect(() => {
    responseSpaceActionsRef.current = { holdLatestTurnViewport, scrollResponseSpacerToBottom };
  }, [holdLatestTurnViewport, scrollResponseSpacerToBottom]);
  const registerResponseSpacerState = baseScrollController.registerResponseSpacerState;
  useLayoutEffect(() => {
    registerResponseSpacerState(
      placementKey === null
        ? null
        : {
            getHeightPx: responseSpace.getHeightPx,
            holdViewport: () => responseSpaceActionsRef.current.holdLatestTurnViewport(),
            scrollToBottom: () => responseSpaceActionsRef.current.scrollResponseSpacerToBottom(),
          },
    );
    return () => registerResponseSpacerState(null);
  }, [placementKey, registerResponseSpacerState, responseSpace]);
  useLayoutEffect(
    () =>
      baseScrollController.addUserScrollListener((distance, previous) => {
        hasRestoredInitialScrollRef.current = true;
        if (previous == null) return;
        updateFollowState({
          type: "user_scrolled",
          distanceFromBottomPx: distance,
          previousDistanceFromBottomPx: previous,
          responseSpacerHeightPx: responseSpace.getHeightPx(),
        });
      }),
    [baseScrollController, responseSpace, updateFollowState],
  );

  const wrappedScrollController = useMemo<LocalConversationThreadScrollControllerValue>(() => {
    const virtualDistance = (distance: number) =>
      Math.max(0, distance - responseSpace.getHeightPx());
    return {
      ...baseScrollController,
      addScrollListener: (listener) =>
        baseScrollController.addScrollListener((distance) => listener(virtualDistance(distance))),
      addUserScrollListener: (listener) =>
        baseScrollController.addUserScrollListener((distance, previous) =>
          listener(
            virtualDistance(distance),
            previous == null ? undefined : virtualDistance(previous),
          ),
        ),
      // Keep the negative response-space offset for compensation; virtual range helpers clamp it.
      getLastScrollDistanceFromBottomPx: () =>
        baseScrollController.getLastScrollDistanceFromBottomPx() - responseSpace.getHeightPx(),
      getScrollDistanceFromBottomPx: () =>
        baseScrollController.getScrollDistanceFromBottomPx() - responseSpace.getHeightPx(),
      getUnroundedScrollDistanceFromBottomPx: (distance) =>
        baseScrollController.getUnroundedScrollDistanceFromBottomPx(
          distance + responseSpace.getHeightPx(),
        ) - responseSpace.getHeightPx(),
      compensateScrollToDistanceFromBottomPx: (distance) =>
        baseScrollController.compensateScrollToDistanceFromBottomPx(
          distance + responseSpace.getHeightPx(),
        ),
      scrollToDistanceFromBottomPx: (distance, behavior = "auto") =>
        baseScrollController.scrollToDistanceFromBottomPx(
          distance + responseSpace.getHeightPx(),
          behavior,
        ),
    };
  }, [baseScrollController, responseSpace]);
  const getPendingRestoreScrollDistanceFromBottomPx = useCallback(() => {
    const distance = initialScrollOffsetRef.current;
    if (
      hasRestoredInitialScrollRef.current ||
      distance === null ||
      latestTurnFollowStateRef.current.followMode === "prework_follow"
    )
      return null;
    return Math.max(0, distance - responseSpace.getHeightPx());
  }, [responseSpace]);
  const restoreScrollDistanceFromBottomPx = useCallback(() => {
    if (hasRestoredInitialScrollRef.current) return;
    const distance = initialScrollOffsetRef.current;
    if (distance === null || latestTurnFollowStateRef.current.followMode === "prework_follow") {
      hasRestoredInitialScrollRef.current = true;
      return;
    }
    if (!baseScrollController.getScrollElement()) return;
    const tolerancePx =
      latestTurnFollowStateRef.current.followMode === "user_hold"
        ? 1
        : THREAD_NEAR_BOTTOM_THRESHOLD_PX;
    if (Math.abs(baseScrollController.getScrollDistanceFromBottomPx() - distance) <= tolerancePx) {
      hasRestoredInitialScrollRef.current = true;
      return;
    }
    baseScrollController.scrollToDistanceFromBottomPx(distance, "instant");
    if (Math.abs(baseScrollController.getScrollDistanceFromBottomPx() - distance) <= tolerancePx)
      hasRestoredInitialScrollRef.current = true;
  }, [baseScrollController]);
  const handleLatestTurnHeightChange = useCallback(
    ({
      heightDeltaPx,
      heightPx,
      bottomViewportOverflowPx,
      turnElement,
      followContentHeightPx,
    }: LatestTurnHeightChange): ReturnType<LatestTurnHeightChangeHandler> => {
      const expected = pendingExpectedLatestTurnHeightPxRef.current;
      if (heightPx !== null) {
        latestTurnHeightPxRef.current = heightPx;
        pendingExpectedLatestTurnHeightPxRef.current = null;
      }
      if (followContentHeightPx !== null)
        latestTurnFollowContentHeightPxRef.current = followContentHeightPx;
      if (
        expected !== null &&
        heightPx !== null &&
        Math.abs(heightPx - expected) > THREAD_NEAR_BOTTOM_THRESHOLD_PX &&
        baseScrollController.getScrollElement()
      ) {
        const delta = heightPx - expected;
        if (initialScrollOffsetRef.current !== null) {
          hasRestoredInitialScrollRef.current = false;
          initialScrollOffsetRef.current = Math.max(0, initialScrollOffsetRef.current + delta);
        }
        baseScrollController.compensateScrollToDistanceFromBottomPx(
          Math.max(
            0,
            baseScrollController.getUnroundedScrollDistanceFromBottomPx(
              baseScrollController.getLastScrollDistanceFromBottomPx(),
            ) + delta,
          ),
        );
      }
      const followMode = latestTurnFollowStateRef.current.followMode;
      if (
        followMode === "user_follow" ||
        (followMode === "prework_follow" && latestTurnPhaseRef.current === "prework")
      ) {
        baseScrollController.scrollToDistanceFromBottomPx(0, "instant");
        return "followed_bottom";
      }
      const hadResponseSpace = responseSpace.getHeightPx() > THREAD_NEAR_BOTTOM_THRESHOLD_PX;
      if (expected === null) responseSpace.consumeGrowth(heightDeltaPx ?? 0);
      const element = baseScrollController.getScrollElement();
      if (
        followMode !== "prework_watch" ||
        latestTurnPhaseRef.current !== "prework" ||
        !hadResponseSpace ||
        !element ||
        !turnElement
      )
        return "preserve_viewport";
      const overflow =
        getBottomViewportOverflowPx({
          scrollElement: element,
          turnElement,
          fallbackBottomViewportOverflowPx: bottomViewportOverflowPx,
          windowZoom: readCodexWindowZoom(element),
        }) + readThreadScrollPaddingBottomPx(element);
      const state = updateFollowState({
        type: "latest_turn_follow_content_changed",
        followContentOverflowPx: overflow,
        latestTurnPhase: latestTurnPhaseRef.current,
      });
      if (state.followMode === "prework_follow") {
        responseSpace.clear();
        baseScrollController.scrollToDistanceFromBottomPx(0, "instant");
        return "followed_bottom";
      }
      return "preserve_viewport";
    },
    [baseScrollController, responseSpace, updateFollowState],
  );
  useLayoutEffect(() => {
    const previousKey = placementKeyRef.current;
    const previousPhase = latestTurnPhaseRef.current;
    placementKeyRef.current = placementKey;
    latestTurnPhaseRef.current = latestTurnPhase;
    if (placementKey === null) {
      if (previousKey !== null) updateFollowState({ type: "latest_turn_removed" }, true);
      responseSpace.clear();
      return;
    }
    const element = baseScrollController.getScrollElement();
    if (!element) return;
    if (previousKey !== placementKey) {
      const initialPlacement = needsInitialActivePlacementRef.current;
      needsInitialActivePlacementRef.current = false;
      if (
        isRewindSurvivorLatestTurn({
          latestTurnKey,
          previousLatestTurnKey: committedLatestTurnKeyRef.current,
          previousTurnKeys: committedTurnKeysRef.current,
        })
      )
        return;
      const placement = baseScrollController.consumePendingLatestTurnSubmitPlacement();
      // Peers and history hydration may append rows; only this window's submit owns placement.
      if (placement === null && !initialPlacement) return;
      if (placement && !placement.shouldPlaceLatestTurn) {
        updateFollowState({ type: "latest_turn_placed" }, true);
        responseSpace.clear();
        const delta =
          placement.scrollHeightPx === null ? 0 : element.scrollHeight - placement.scrollHeightPx;
        baseScrollController.scrollToDistanceFromBottomPx(
          placement.distanceFromBottomPx + delta,
          "instant",
        );
        return;
      }
      responseSpace.place();
      // Placement temporarily holds the viewport; the new Turn can then follow its work.
      updateFollowState({ type: "latest_turn_placed" }, true);
    }
    const previous = latestTurnFollowStateRef.current;
    updateFollowState({
      type: "latest_turn_phase_changed",
      latestTurnPhase,
      previousLatestTurnPhase: previousPhase,
    });
    if (
      previousPhase === "prework" &&
      latestTurnPhase === "final_answer" &&
      previous.followMode === "prework_follow"
    ) {
      responseSpace.clear();
      baseScrollController.scrollToDistanceFromBottomPx(0, "instant");
    }
  }, [
    baseScrollController,
    isLatestTurnInProgress,
    latestTurnKey,
    latestTurnPhase,
    placementKey,
    responseSpace,
    updateFollowState,
  ]);
  useLayoutEffect(() => {
    committedTurnKeysRef.current = nativeTurnKeys;
    committedLatestTurnKeyRef.current = latestTurnKey;
  }, [latestTurnKey, nativeTurnKeys]);
  const handleViewportChange = useCallback(
    (change: VirtualizedTurnViewportChange) => {
      if (onLoadHistoryBoundary) {
        void historyGapRequestCoordinator.observeViewport(
          {
            viewportStartPx: change.viewportStartPx,
            viewportEndPx: change.viewportEndPx,
            gaps: change.gaps,
          },
          onLoadHistoryBoundary,
        );
        const hasEligibleGap = change.gaps.some(
          (gap) =>
            gap.endPx >= change.viewportStartPx - CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX &&
            gap.startPx <= change.viewportEndPx + CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
        );
        if (hasEligibleGap) return;
      }
      turnItemRequestGate.retain(
        new Set(
          Object.values(historyTurnItemsRefs ?? {}).flatMap((refs) =>
            [refs.older, refs.newer].flatMap((ref) =>
              ref ? [codexConversationHistoryTurnItemsRefKey(ref)] : [],
            ),
          ),
        ),
      );
      const isMovingTowardNewer =
        change.target !== null && change.target.targetPx > change.target.originPx;
      const unavailableItemKeys = turnItemRequestGate.unavailableKeys();
      const partial = change.turns
        .flatMap((turn) => {
          const refs = historyTurnItemsRefs?.[turn.turnId];
          const ref = isMovingTowardNewer
            ? (refs?.newer ?? refs?.older)
            : (refs?.older ?? refs?.newer);
          if (!ref) return [];
          if (unavailableItemKeys.has(codexConversationHistoryTurnItemsRefKey(ref))) return [];
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
        const progressKey = codexConversationHistoryTurnItemsRefKey(partial.ref);
        if (!onLoadHistoryTurnItems) return;
        turnItemRequestGate.request(
          progressKey,
          () => onLoadHistoryTurnItems(partial.ref),
          change.viewportRevision,
        );
        return;
      }
    },
    [
      historyGapRequestCoordinator,
      historyTurnItemsRefs,
      onLoadHistoryBoundary,
      onLoadHistoryTurnItems,
      turnItemRequestGate,
    ],
  );

  useLayoutEffect(() => {
    baseScrollController.setFooterResizeViewportPreserveDisabled(
      isLatestTurnInProgressRef.current &&
        shouldAllowResponseSpacerGrowth(latestTurnFollowStateRef.current.followMode),
    );
    return () => {
      const element = baseScrollController.getScrollElement();
      const distance =
        element === null
          ? baseScrollController.getLastScrollDistanceFromBottomPx()
          : baseScrollController.getScrollDistanceFromBottomPx();
      const restored = resolveRestoredDistanceWithoutResponseSpacer({
        distanceFromBottomPx: distance,
        latestTurnPhase: latestTurnPhaseRef.current,
        responseSpacerHeightPx: responseSpace.getHeightPx(),
        scrollPaddingBottomPx: element === null ? 0 : readThreadScrollPaddingBottomPx(element),
        scrollState: latestTurnFollowStateRef.current,
      });
      onLatestTurnRestoreStateChange?.(
        latestTurnKeyRef.current === null
          ? null
          : {
              followMode: restored.scrollState.followMode,
              isLatestTurnInProgress: isLatestTurnInProgressRef.current,
              latestTurnFollowContentHeightPx: latestTurnFollowContentHeightPxRef.current,
              latestTurnHeightPx: shouldAllowResponseSpacerGrowth(restored.scrollState.followMode)
                ? latestTurnHeightPxRef.current
                : null,
              latestTurnPhase: latestTurnPhaseRef.current,
              turnKey: latestTurnKeyRef.current,
            },
        restored.distanceFromBottomPx,
      );
      baseScrollController.setFooterResizeViewportPreserveDisabled(false);
    };
  }, [baseScrollController, onLatestTurnRestoreStateChange, responseSpace]);
  const handleResponseSpaceReleased = useCallback(() => {
    if (!isLatestTurnInProgressRef.current) baseScrollController.registerResponseSpacerState(null);
  }, [baseScrollController]);
  return (
    <>
      <LocalConversationVirtualizedTurnListCore
        {...coreProps}
        entries={entries}
        historyRows={historyRows}
        initialScrollOffset={Math.max(0, initialScrollOffset ?? 0)}
        onLatestTurnHeightChange={handleLatestTurnHeightChange}
        onViewportChange={handleViewportChange}
        historyGapState={historyGapState}
        historyItemState={historyItemState}
        historyItemRefs={historyTurnItemsRefs}
        retryHistoryItems={retryHistoryItems}
        retryHistoryBoundary={retryHistoryBoundary}
        preserveMeasuredTurnViewport
        scrollController={wrappedScrollController}
        getPendingRestoreScrollDistanceFromBottomPx={getPendingRestoreScrollDistanceFromBottomPx}
        getResponseSpacerHeightPx={responseSpace.getHeightPx}
        restoreScrollDistanceFromBottomPx={restoreScrollDistanceFromBottomPx}
      />
      <LocalConversationResponseSpaceElement
        controller={responseSpace}
        onReleased={handleResponseSpaceReleased}
      />
    </>
  );
}
