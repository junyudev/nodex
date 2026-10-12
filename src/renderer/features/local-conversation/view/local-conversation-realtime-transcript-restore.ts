import {
  isCodexRealtimeTimelineEntry,
  type CodexTimelineViewEntry,
} from "../projection/normalized-timeline-entries";
import type { VirtualizedTurnListRestoreState } from "./local-conversation-turn-virtualization";

export interface RealtimeTranscriptViewportAnchor {
  readonly itemId: string;
  readonly topWithinViewportPx: number;
}

/** A changed first segment may rename a row; only a resident native identity can restore it. */
export function resolveRealtimeTranscriptRestoreState(
  state: VirtualizedTurnListRestoreState | null,
  entries: readonly CodexTimelineViewEntry[],
): VirtualizedTurnListRestoreState | null {
  if (!state || entries.some((entry) => entry.turnKey === state.renderedWindow.anchorKey))
    return state;
  const witnesses = new Set(state.renderedWindow.realtimeSegmentIds);
  if (witnesses.size === 0) return state;
  const entry = entries.find(
    (entry) =>
      isCodexRealtimeTimelineEntry(entry) &&
      entry.itemType === "transcriptSegment" &&
      entry.segmentIds.some((itemId) => witnesses.has(itemId)),
  );
  if (!entry || !isCodexRealtimeTimelineEntry(entry) || entry.itemType !== "transcriptSegment")
    return state;
  return {
    ...state,
    renderedWindow: {
      ...state.renderedWindow,
      anchorKey: entry.turnKey,
      realtimeSegmentIds: entry.segmentIds,
    },
  };
}

/** Capture the first visible native leaf without reading or subscribing to transcript text. */
export function readRealtimeTranscriptViewportAnchor(input: {
  readonly rows: Iterable<HTMLElement>;
  readonly scrollElement: HTMLElement;
  readonly residentItemIds: ReadonlySet<string>;
  readonly windowZoom: number;
}): RealtimeTranscriptViewportAnchor | null {
  const viewport = input.scrollElement.getBoundingClientRect();
  for (const row of input.rows) {
    for (const element of row.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]")) {
      const itemId = element.dataset.nativeRealtimeItemId;
      if (!itemId || !input.residentItemIds.has(itemId)) continue;
      const rect = element.getBoundingClientRect();
      if (rect.height <= 0 || rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      return { itemId, topWithinViewportPx: (rect.top - viewport.top) / input.windowZoom };
    }
  }
  return null;
}

export function resolveRealtimeTranscriptAnchorDistance(input: {
  readonly distanceFromBottomPx: number;
  readonly currentTopWithinViewportPx: number;
  readonly anchorTopWithinViewportPx: number;
}): number {
  return Math.max(
    0,
    input.distanceFromBottomPx + input.anchorTopWithinViewportPx - input.currentTopWithinViewportPx,
  );
}
