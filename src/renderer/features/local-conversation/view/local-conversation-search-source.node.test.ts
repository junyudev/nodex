import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationTurn } from "../../../../shared/types";
import type { VisibleConversationTurnEntry } from "../selectors";
import { createLocalConversationSearchSource } from "./local-conversation-search-source";

function entry(turnKey: string, texts: string[]): VisibleConversationTurnEntry {
  const turn: CodexConversationTurn = {
    threadId: "thread",
    turnId: turnKey,
    status: "completed",
    itemIds: texts.map((_, index) => `${turnKey}-${index}`),
    items: texts.map((markdownText, index) => ({
      threadId: "thread",
      turnId: turnKey,
      itemId: `${turnKey}-${index}`,
      type: index === texts.length - 1 ? "assistant_message" : "user_message",
      kind: index === texts.length - 1 ? "assistantMessage" : "userMessage",
      semanticKind: index === texts.length - 1 ? "assistantMessage" : "userMessage",
      role: index === texts.length - 1 ? "assistant" : "user",
      markdownText,
      createdAt: index,
      updatedAt: index,
    })),
  };
  return {
    turn,
    turnId: turnKey,
    turnKey,
    turnSearchKey: turnKey,
    requests: [],
    isMostRecentTurn: true,
  };
}

function source(read: () => VisibleConversationTurnEntry[]) {
  return createLocalConversationSearchSource({
    routeContextId: "thread",
    getTurns: read,
    scrollAdapter: { scrollToTurn: async () => {}, getTurnContainer: () => null },
  });
}

describe("resident transcript search cache", () => {
  test("reuses units for a materialized Turn even when its lightweight entry is recreated", () => {
    const current = entry("one", ["A distinct answer"]);
    const read = source(() => [{ ...current }]);
    const first = read.getUnitsForTurn(current);
    expect(read.getUnitsForTurn({ ...current })).toBe(first);
    expect(read.findMatches("distinct")).toHaveLength(1);
  });

  test("prunes removed Turns and refreshes search units after an item prefix is evicted", () => {
    const old = entry("one", ["Earlier sensitive text", "Current response"]);
    let entries = [old, entry("two", ["Other response"])];
    const read = source(() => entries);
    expect(read.findMatches("Earlier sensitive text")).toHaveLength(1);
    expect(read.findMatches("Other response")).toHaveLength(1);
    entries = [entry("one", ["Current response"])];
    read.pruneCachedData();
    expect(read.findMatches("Earlier sensitive text")).toEqual([]);
    expect(read.findMatches("Other response")).toEqual([]);
    expect(read.findMatches("Current response")).toHaveLength(1);
    read.clearCachedData();
    expect(read.findMatches("Current response")).toHaveLength(1);
  });
});
