import { describe, expect, test, vi } from "vite-plus/test";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import { waitForLocalConversationPromptRailResidentTarget } from "./local-conversation-prompt-rail";
import type { CodexRealtimeTranscriptEntry } from "../projection/normalized-timeline-entries";
import { resolveRealtimeTranscriptRestoreState } from "./local-conversation-realtime-transcript-restore";
import {
  buildVirtualizedTurnLayout,
  resolveInitialVirtualizedTurnViewportState,
  type VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";

describe("local conversation prompt rail", () => {
  const residentItem = {
    id: "turn-older:item-real-user-message",
    turnId: "turn-older",
    turnKey: "turn-older",
    ordinal: 1,
    label: "Older prompt",
    responsePreview: "",
    outputs: [],
    isHeartbeat: false,
  } satisfies ThreadUserMessageNavigationItem;

  describe("prompt rail installed target resolution", () => {
    test("waits by Turn identity and reveals the real resident marker", async () => {
      const target = {} as HTMLElement;
      let residentItems: readonly ThreadUserMessageNavigationItem[] = [];
      const waitForNextRender = vi.fn(async () => {
        residentItems = [residentItem];
      });
      const revealResidentItem = vi.fn(() => target);

      const result = await waitForLocalConversationPromptRailResidentTarget({
        turnId: "turn-older",
        mode: "smooth",
        signal: new AbortController().signal,
        readResidentItems: () => residentItems,
        revealResidentItem,
        waitForNextRender,
      });

      expect(result).toBe(target);
      expect(waitForNextRender).toHaveBeenCalledOnce();
      expect(revealResidentItem).toHaveBeenCalledWith(residentItem, "smooth");
      expect(residentItem.id).not.toBe("turn-older:user:0");
    });

    test("stops at cancellation without invoking renderer navigation", async () => {
      const controller = new AbortController();
      controller.abort();
      const waitForNextRender = vi.fn(async () => {});
      const revealResidentItem = vi.fn(() => null);

      const result = await waitForLocalConversationPromptRailResidentTarget({
        turnId: "turn-older",
        mode: "instant",
        signal: controller.signal,
        readResidentItems: () => [residentItem],
        revealResidentItem,
        waitForNextRender,
      });

      expect(result).toBeNull();
      expect(waitForNextRender).not.toHaveBeenCalled();
      expect(revealResidentItem).not.toHaveBeenCalled();
    });
  });
});

describe("local conversation realtime transcript restore", () => {
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
});
