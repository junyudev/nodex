import { describe, expect, test } from "vite-plus/test";
import type { CodexPromptRailIndex } from "../../../../shared/codex-prompt-rail-history";
import type { ThreadUserMessageNavigationItem } from "../thread-stage-types";
import {
  buildLocalConversationPromptRailItems,
  projectLocalConversationPromptRailVirtualWindow,
  resolveCodexPromptRailRevealTarget,
} from "./local-conversation-prompt-rail-model";

const shellIndex = (count: number): CodexPromptRailIndex => ({
  threadId: "thread-a",
  hostId: "host-a",
  generation: 4,
  shells: Array.from({ length: count }, (_, index) => ({
    turnId: `turn-${index + 1}`,
    pageBackwardsCursor: `page-${Math.floor(index / 100)}`,
    descendingOffset: index % 100,
  })),
  complete: count < 1_000,
  truncatedBy: count >= 1_000 ? "page-budget" : null,
  approximateBytes: count * 64,
  loadedAtMs: 1_000,
});

const residentItem = (turnId: string, label: string): ThreadUserMessageNavigationItem => ({
  id: `${turnId}:user:0`,
  turnId,
  turnKey: turnId,
  ordinal: 1,
  label,
  responsePreview: "resident response",
  outputs: [],
  isHeartbeat: false,
});

describe("local conversation prompt rail model", () => {
  test("keeps one item-free marker per shell and replaces only resident or previewed Turns", () => {
    const index = shellIndex(1_000);
    const resident = residentItem("turn-999", "resident prompt");
    const items = buildLocalConversationPromptRailItems({
      index,
      residentItems: [resident],
      previewsByTurnId: new Map([
        [
          "turn-4",
          [
            {
              itemId: "prompt-4",
              promptPreview: "lazy prompt",
              responsePreview: "lazy response",
              isHeartbeat: false,
            },
          ],
        ],
      ]),
    });

    expect(items).toHaveLength(1_000);
    expect(items[3]).toMatchObject({
      id: "turn-4:user:0",
      label: "lazy prompt",
      responsePreview: "lazy response",
    });
    expect(items[998]).toEqual({ ...resident, ordinal: 999 });
    expect(items[0]).not.toHaveProperty("turn");
  });

  test("uses explicit identity seek when a known Turn is beyond the 1,000-shell window", () => {
    const index = shellIndex(1_000);
    expect(resolveCodexPromptRailRevealTarget(index, "turn-1000").kind).toBe("shell");
    expect(resolveCodexPromptRailRevealTarget(index, "turn-1001")).toEqual({
      kind: "knownTurn",
      turnId: "turn-1001",
    });
  });

  test("projects a bounded overscanned DOM window for a 1,000-marker rail", () => {
    const window = projectLocalConversationPromptRailVirtualWindow({
      itemCount: 1_000,
      scrollTop: 4_500,
      viewportHeight: 400,
    });

    expect(window).toEqual({
      startIndex: 438,
      endIndex: 502,
      paddingBeforePx: 4_380,
      paddingAfterPx: 4_980,
    });
    expect(window.endIndex - window.startIndex).toBeLessThan(100);
  });
});
