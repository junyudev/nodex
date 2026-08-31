import { describe, expect, it } from "vitest";
import type { Turn } from "@nodex/codex-app-server-protocol/v2";
import type { CodexHistoryTurnItemsPagination } from "./codex-conversation-state/codex-history-topology";
import {
  buildCodexPromptRailPreviews,
  isValidCodexPromptRailDescendingOffset,
  truncateCodexPromptRailPreview,
} from "./codex-prompt-rail-history";

const pagination: CodexHistoryTurnItemsPagination = {
  olderCursor: "items:older",
  isLoadingOlder: false,
  hasLoadedOldest: false,
  oldestUserInput: [{ type: "text", text: "opening prompt", text_elements: [] }],
  openingUserMessageId: "opening-user",
  itemsView: "summary",
};

describe("Codex prompt rail history", () => {
  it("truncates by Unicode code points without splitting surrogate pairs", () => {
    expect(truncateCodexPromptRailPreview("a😀b😀c", 4)).toBe("a😀b…");
    expect(Array.from(truncateCodexPromptRailPreview("😀😀😀", 2))).toEqual(["😀", "…"]);
  });

  it("accepts only bounded safe-integer shell offsets", () => {
    expect(isValidCodexPromptRailDescendingOffset(0)).toBe(true);
    expect(isValidCodexPromptRailDescendingOffset(99)).toBe(true);
    for (const invalid of [-1, 100, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(isValidCodexPromptRailDescendingOffset(invalid)).toBe(false);
    }
  });

  it("injects the bounded opening prompt and associates the following response", () => {
    const turn = {
      id: "turn-1",
      status: "completed",
      itemsView: "summary",
      items: [{ type: "agentMessage", id: "answer", text: "response", phase: null }],
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    } as Turn;

    expect(buildCodexPromptRailPreviews({ turn, pagination })).toEqual([
      {
        itemId: "opening-user",
        promptPreview: "opening prompt",
        responsePreview: "response",
        isHeartbeat: false,
      },
    ]);
  });
});
