import { describe, expect, test } from "bun:test";
import type { CodexCommandAction, CodexItemView } from "../../../lib/types";
import { coalesceExplorationItems } from "./exploration-item-coalescer";

function makeCommandItem(
  partial: Partial<CodexItemView> & { commandActions?: CodexCommandAction[] },
): CodexItemView {
  const { commandActions, ...rest } = partial;
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    type: "commandExecution",
    normalizedKind: "commandExecution",
    createdAt: 1,
    updatedAt: 1,
    toolCall: {
      subtype: "command",
      toolName: "bash",
      args: {
        commandActions: commandActions ?? [],
      },
    },
    ...rest,
  };
}

function makeMessageItem(partial: Partial<CodexItemView>): CodexItemView {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-message",
    type: "agentMessage",
    normalizedKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  };
}

describe("coalesceExplorationItems", () => {
  test("coalesces contiguous exploration command items in the same turn", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        commandActions: [{ type: "read", command: "cat src/api.ts", name: "api.ts", path: "src/api.ts" }],
        status: "completed",
        createdAt: 1,
        updatedAt: 3,
      }),
      makeCommandItem({
        itemId: "item-b",
        commandActions: [{ type: "read", command: "cat src/store.ts", name: "store.ts", path: "src/store.ts" }],
        status: "completed",
        createdAt: 2,
        updatedAt: 4,
      }),
      makeCommandItem({
        itemId: "item-c",
        commandActions: [{ type: "search", command: "rg sendPrompt src", query: "sendPrompt", path: "src" }],
        status: "completed",
        createdAt: 3,
        updatedAt: 5,
      }),
      makeMessageItem({
        itemId: "item-d",
        markdownText: "Done",
        createdAt: 4,
        updatedAt: 6,
      }),
    ];

    const coalesced = coalesceExplorationItems(items);
    expect(coalesced.length).toBe(2);

    const merged = coalesced[0];
    const mergedActions = ((merged?.toolCall?.args as { commandActions?: unknown[] } | undefined)?.commandActions ?? []);
    expect(merged?.itemId).toBe("item-a::explore::item-c");
    expect(mergedActions.length).toBe(3);
    expect(merged?.status).toBe("completed");
    expect(merged?.createdAt).toBe(1);
    expect(merged?.updatedAt).toBe(5);
    expect(coalesced[1]?.itemId).toBe("item-d");
  });

  test("does not coalesce across turn boundaries", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        turnId: "turn-1",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
      makeCommandItem({
        itemId: "item-b",
        turnId: "turn-2",
        commandActions: [{ type: "search", command: "rg x src", query: "x", path: "src" }],
      }),
    ];

    const coalesced = coalesceExplorationItems(items);
    expect(coalesced.length).toBe(2);
    expect(coalesced[0]?.itemId).toBe("item-a");
    expect(coalesced[1]?.itemId).toBe("item-b");
  });

  test("breaks coalescing when a non-exploration command appears", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
      makeCommandItem({
        itemId: "item-b",
        commandActions: [{ type: "unknown", command: "git status" }],
      }),
      makeCommandItem({
        itemId: "item-c",
        commandActions: [{ type: "search", command: "rg z src", query: "z", path: "src" }],
      }),
    ];

    const coalesced = coalesceExplorationItems(items);
    expect(coalesced.length).toBe(3);
    expect(coalesced[0]?.itemId).toBe("item-a");
    expect(coalesced[1]?.itemId).toBe("item-b");
    expect(coalesced[2]?.itemId).toBe("item-c");
  });

  test("marks trailing exploration section in active turn as in-progress", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
      makeCommandItem({
        itemId: "item-b",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "search", command: "rg z src", query: "z", path: "src" }],
      }),
    ];

    const coalesced = coalesceExplorationItems(items, { activeTurnId: "turn-2" });
    expect(coalesced.length).toBe(1);
    expect(coalesced[0]?.status).toBe("inProgress");
  });

  test("marks single trailing exploration item in active turn as in-progress", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
    ];

    const coalesced = coalesceExplorationItems(items, { activeTurnId: "turn-2" });
    expect(coalesced.length).toBe(1);
    expect(coalesced[0]?.status).toBe("inProgress");
  });

  test("absorbs reasoning items between exploration steps in the same turn", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
      makeMessageItem({
        itemId: "item-b",
        turnId: "turn-2",
        type: "reasoning",
        normalizedKind: "reasoning",
        status: "inProgress",
        markdownText: "Thinking through next search",
        updatedAt: 3,
      }),
      makeCommandItem({
        itemId: "item-c",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "search", command: "rg z src", query: "z", path: "src" }],
        updatedAt: 4,
      }),
    ];

    const coalesced = coalesceExplorationItems(items, { activeTurnId: "turn-2" });
    const mergedActions = (((coalesced[0]?.toolCall?.args as { commandActions?: unknown[] } | undefined)?.commandActions) ?? []);
    expect(coalesced.length).toBe(1);
    expect(coalesced[0]?.itemId).toBe("item-a::explore::item-c");
    expect(mergedActions.length).toBe(2);
    expect(coalesced[0]?.status).toBe("inProgress");
  });

  test("does not mark exploration as in-progress after non-exploration item in same active turn", () => {
    const items = [
      makeCommandItem({
        itemId: "item-a",
        turnId: "turn-2",
        status: "completed",
        commandActions: [{ type: "read", command: "cat src/a.ts", name: "a.ts", path: "src/a.ts" }],
      }),
      makeMessageItem({
        itemId: "item-b",
        turnId: "turn-2",
        markdownText: "Switching from exploration to implementation",
      }),
    ];

    const coalesced = coalesceExplorationItems(items, { activeTurnId: "turn-2" });
    expect(coalesced.length).toBe(2);
    expect(coalesced[0]?.status).toBe("completed");
  });
});
