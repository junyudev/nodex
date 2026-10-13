import { describe, expect, test } from "vite-plus/test";
import type { CodexRealtimeTranscriptEntry } from "../projection/normalized-timeline-entries";
import {
  resolveRealtimeTranscriptRestoreState,
  resolveRealtimeTranscriptAnchorDistance,
  resolveRetiringRealtimeTranscriptViewportAnchor,
} from "./local-conversation-realtime-transcript-restore";
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
  test("selects a surviving visible native segment after a row rename releases its first leaf", () => {
    const released = { itemId: "released", topWithinViewportPx: -20 };
    const retained = { itemId: "retained", topWithinViewportPx: 90 };
    expect(
      resolveRetiringRealtimeTranscriptViewportAnchor({
        retiringRows: new Map([["old-row", [released, retained]]]),
        committedRowKeys: new Set(["renamed-row"]),
        residentItemIds: new Set(["retained"]),
      }),
    ).toBe(retained);
  });

  test("ignores ref replacement on a retained row and continues to a genuinely removed row", () => {
    const unchanged = { itemId: "unchanged", topWithinViewportPx: 20 };
    const retained = { itemId: "retained", topWithinViewportPx: 90 };
    expect(
      resolveRetiringRealtimeTranscriptViewportAnchor({
        retiringRows: new Map([
          ["same-row", [unchanged]],
          ["old-row", [retained]],
        ]),
        committedRowKeys: new Set(["same-row", "renamed-row"]),
        residentItemIds: new Set(["unchanged", "retained"]),
      }),
    ).toBe(retained);
  });

  test("does not compensate when every captured visible native identity is gone", () => {
    expect(
      resolveRetiringRealtimeTranscriptViewportAnchor({
        retiringRows: new Map([["old-row", [{ itemId: "released", topWithinViewportPx: 20 }]]]),
        committedRowKeys: new Set(["new-row"]),
        residentItemIds: new Set(["different"]),
      }),
    ).toBeNull();
  });

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

  test("corrects the native leaf position independently of added content below it", () => {
    expect(
      resolveRealtimeTranscriptAnchorDistance({
        distanceFromBottomPx: 200,
        anchorTopWithinViewportPx: 90,
        currentTopWithinViewportPx: 30,
      }),
    ).toBe(260);
    expect(
      resolveRealtimeTranscriptAnchorDistance({
        distanceFromBottomPx: 200,
        anchorTopWithinViewportPx: 90,
        currentTopWithinViewportPx: 140,
      }),
    ).toBe(150);
  });
});
