import { describe, expect, test } from "vite-plus/test";
import type { CodexRealtimeTranscriptEntry } from "../projection/normalized-timeline-entries";
import { resolveRealtimeTranscriptRestoreState } from "./local-conversation-realtime-transcript-restore";
import {
  buildVirtualizedTurnLayout,
  resolveInitialVirtualizedTurnViewportState,
  type VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";

function group(segmentIds: readonly string[]): CodexRealtimeTranscriptEntry {
  const itemId = segmentIds[0]!;
  const turnKey = `realtime-voice:transcript:${itemId}`;
  return {
    type: "realtime",
    itemId,
    itemType: "transcriptSegment",
    segmentIds,
    estimatedHeightPx: 144 * segmentIds.length,
    turnKey,
    turnSearchKey: turnKey,
    turnId: null,
  };
}

describe("native voice row restoration", () => {
  test.each([{ ids: ["older", "first", "second"] }, { ids: ["second"] }])(
    "restores a renamed row through a retained native segment %j",
    ({ ids }) => {
      const previous = group(["first", "second"]);
      const next = group(ids);
      const state: VirtualizedTurnListRestoreState = {
        renderedWindow: {
          anchorKey: previous.turnKey,
          count: 1,
          realtimeSegmentIds: previous.segmentIds,
        },
        turnHeightsByKey: { [previous.turnKey]: 432 },
        realtimeAnchor: { itemId: "second", topWithinViewportPx: 100 },
      };
      const restored = resolveRealtimeTranscriptRestoreState(state, [next]);
      const viewport = resolveInitialVirtualizedTurnViewportState({
        initialRestoreState: restored,
        distanceFromBottomPx: 120,
        layout: buildVirtualizedTurnLayout({
          entries: [{ turnKey: next.turnKey, estimatedHeightPx: next.estimatedHeightPx }],
          gapPx: 12,
        }),
        overscanCount: 0,
        viewportHeightPx: 80,
      });
      expect(restored?.renderedWindow.anchorKey).toBe(next.turnKey);
      expect(viewport.renderedRange).toEqual({ startIndex: 0, endIndex: 1 });
      expect(restored?.realtimeAnchor?.itemId).toBe("second");
    },
  );

  test("does not infer a replacement when every old native segment has been released", () => {
    const state: VirtualizedTurnListRestoreState = {
      renderedWindow: {
        anchorKey: "realtime-voice:transcript:released",
        count: 1,
        realtimeSegmentIds: ["released"],
      },
      turnHeightsByKey: {},
    };
    expect(resolveRealtimeTranscriptRestoreState(state, [group(["unrelated"])])).toBe(state);
  });
});
