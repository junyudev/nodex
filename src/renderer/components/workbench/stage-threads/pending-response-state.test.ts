import { describe, expect, test } from "bun:test";
import type { CodexItemView } from "@/lib/types";
import { shouldShowPendingResponseRow } from "./pending-response-state";

function makeItem(overrides: Partial<CodexItemView>): CodexItemView {
  return {
    threadId: "thr_1",
    turnId: "turn_1",
    itemId: "item_1",
    type: "userMessage",
    normalizedKind: "userMessage",
    role: "user",
    markdownText: "Ship the fix",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe("pending response state", () => {
  test("shows the waiting row when the active turn only contains user messages", () => {
    const result = shouldShowPendingResponseRow([
      makeItem({}),
      makeItem({
        itemId: "item_2",
        turnId: "turn_previous",
        markdownText: "Previous assistant reply",
        normalizedKind: "assistantMessage",
        role: "assistant",
        type: "agentMessage",
      }),
    ], "turn_1", true);

    expect(result).toBeTrue();
  });

  test("hides the waiting row once the active turn has started streaming a response", () => {
    const result = shouldShowPendingResponseRow([
      makeItem({}),
      makeItem({
        itemId: "item_2",
        normalizedKind: "assistantMessage",
        role: "assistant",
        type: "agentMessage",
        markdownText: "Working on it",
      }),
    ], "turn_1", true);

    expect(result).toBeFalse();
  });

  test("hides the waiting row when the thread is idle", () => {
    const result = shouldShowPendingResponseRow([makeItem({})], "turn_1", false);

    expect(result).toBeFalse();
  });
});
