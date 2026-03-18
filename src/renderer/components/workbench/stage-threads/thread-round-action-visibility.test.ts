import { describe, expect, test } from "bun:test";
import type { CodexItemView, CodexTurnSummary } from "../../../lib/types";
import { resolveThreadRoundActionVisibility } from "./thread-round-action-visibility";

function makeTurn(overrides: Partial<CodexTurnSummary>): CodexTurnSummary {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    itemIds: [],
    ...overrides,
  };
}

function makeItem(overrides: Partial<CodexItemView>): CodexItemView {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    type: "agentMessage",
    normalizedKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("thread round action visibility", () => {
  test("shows assistant actions on the final assistant message for each completed turn", () => {
    const visibility = resolveThreadRoundActionVisibility(
      [
        makeItem({
          itemId: "user-1",
          type: "userMessage",
          normalizedKind: "userMessage",
          role: "user",
          markdownText: "First prompt",
        }),
        makeItem({
          itemId: "assistant-1a",
          markdownText: "Draft reply",
        }),
        makeItem({
          itemId: "assistant-1b",
          markdownText: "Final reply",
          createdAt: 2,
          updatedAt: 2,
        }),
        makeItem({
          itemId: "user-2",
          turnId: "turn-2",
          type: "userMessage",
          normalizedKind: "userMessage",
          role: "user",
          markdownText: "Second prompt",
          createdAt: 3,
          updatedAt: 3,
        }),
        makeItem({
          itemId: "assistant-2",
          turnId: "turn-2",
          markdownText: "Second final reply",
          createdAt: 4,
          updatedAt: 4,
        }),
      ],
      [
        makeTurn({ itemIds: ["user-1", "assistant-1a", "assistant-1b"] }),
        makeTurn({ turnId: "turn-2", itemIds: ["user-2", "assistant-2"] }),
      ],
    );

    expect(visibility.assistantMessageActionItemIds.has("assistant-1a")).toBeFalse();
    expect(visibility.assistantMessageActionItemIds.has("assistant-1b")).toBeTrue();
    expect(visibility.assistantMessageActionItemIds.has("assistant-2")).toBeTrue();
  });

  test("hides actions for rounds that are still in progress", () => {
    const visibility = resolveThreadRoundActionVisibility(
      [
        makeItem({
          itemId: "user-1",
          type: "userMessage",
          normalizedKind: "userMessage",
          role: "user",
          markdownText: "Prompt",
        }),
        makeItem({
          itemId: "assistant-1",
          markdownText: "Streaming reply",
          status: "inProgress",
        }),
      ],
      [
        makeTurn({
          status: "inProgress",
          itemIds: ["user-1", "assistant-1"],
        }),
      ],
    );

    expect(visibility.assistantMessageActionItemIds.size).toBe(0);
  });

  test("does not fall back to the user message when a settled turn has no assistant transcript", () => {
    const visibility = resolveThreadRoundActionVisibility(
      [
        makeItem({
          itemId: "user-1",
          type: "userMessage",
          normalizedKind: "userMessage",
          role: "user",
          markdownText: "Prompt without assistant text",
        }),
        makeItem({
          itemId: "tool-1",
          type: "commandExecution",
          normalizedKind: "commandExecution",
          status: "completed",
          toolCall: {
            subtype: "command",
            toolName: "bash",
            args: { command: "echo ok" },
          },
          createdAt: 2,
          updatedAt: 2,
        }),
      ],
      [
        makeTurn({
          itemIds: ["user-1", "tool-1"],
        }),
      ],
    );

    expect(visibility.assistantMessageActionItemIds.size).toBe(0);
  });
});
