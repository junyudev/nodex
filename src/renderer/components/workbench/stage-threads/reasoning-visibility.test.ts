import { describe, expect, test } from "bun:test";
import type { CodexItemView } from "../../../lib/types";
import { shouldRenderThreadItem } from "./reasoning-visibility";

function makeItem(partial: Partial<CodexItemView>): CodexItemView {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    type: "reasoning",
    normalizedKind: "reasoning",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("reasoning visibility", () => {
  test("always renders non-reasoning items", () => {
    const item = makeItem({ type: "agentMessage", normalizedKind: "assistantMessage" });
    expect(shouldRenderThreadItem(item, true, null)).toBeTrue();
  });

  test("renders reasoning when hide-thinking toggle is disabled", () => {
    const item = makeItem({ normalizedKind: "reasoning", status: "completed" });
    expect(shouldRenderThreadItem(item, false, null)).toBeTrue();
  });

  test("renders only in-progress reasoning when item status exists", () => {
    const inProgressItem = makeItem({ normalizedKind: "reasoning", status: "inProgress" });
    const completedItem = makeItem({ normalizedKind: "reasoning", status: "completed" });

    expect(shouldRenderThreadItem(inProgressItem, true, null)).toBeTrue();
    expect(shouldRenderThreadItem(completedItem, true, "turn-1")).toBeFalse();
  });

  test("falls back to active turn match when reasoning status is missing", () => {
    const activeTurnItem = makeItem({ normalizedKind: "reasoning", turnId: "turn-active" });
    const inactiveTurnItem = makeItem({ normalizedKind: "reasoning", turnId: "turn-old" });

    expect(shouldRenderThreadItem(activeTurnItem, true, "turn-active")).toBeTrue();
    expect(shouldRenderThreadItem(inactiveTurnItem, true, "turn-active")).toBeFalse();
    expect(shouldRenderThreadItem(activeTurnItem, true, null)).toBeFalse();
  });
});
