import { expect, test } from "vite-plus/test";
import {
  codexConversationHistoryTurnItemsProgressKey,
  createCodexConversationHistoryTurnItemsRef,
} from "./codex-conversation-history-page";

test("item history navigation addresses the incomplete native older cursor", () => {
  const pagination = {
    olderCursor: "native",
    hasLoadedOldest: false,
    isLoadingOlder: false,
    itemsView: "summary" as const,
  };
  const ref = createCodexConversationHistoryTurnItemsRef({
    turnId: "turn",
    expectedTopologyGeneration: 4,
    pagination,
  });
  expect(ref).toMatchObject({ turnId: "turn", expectedTopologyGeneration: 4, edge: "older" });
  expect(
    createCodexConversationHistoryTurnItemsRef({
      turnId: "turn",
      expectedTopologyGeneration: 4,
      pagination: { ...pagination, olderCursor: "next" },
    })?.progressKey,
  ).not.toBe(ref?.progressKey);
  expect(
    createCodexConversationHistoryTurnItemsRef({
      turnId: "turn",
      expectedTopologyGeneration: 4,
      pagination: { ...pagination, hasLoadedOldest: true },
    }),
  ).toBeNull();
});

test("released Turn history remains navigable through its item anchor", () => {
  const pagination = {
    olderCursor: { type: "item" as const, itemId: "retained-first" },
    hasLoadedOldest: false,
    isLoadingOlder: false,
    itemsView: "summary" as const,
  };
  const input = { turnId: "turn", expectedTopologyGeneration: 4, pagination };
  expect(createCodexConversationHistoryTurnItemsRef(input)).toMatchObject({
    turnId: "turn",
    edge: "older",
  });
  expect(
    createCodexConversationHistoryTurnItemsRef({
      ...input,
      pagination: { ...pagination, hasLoadedOldest: true },
    }),
  ).toBeNull();
  expect(createCodexConversationHistoryTurnItemsRef({ ...input, edge: "newer" })).toBeNull();
  const progress = codexConversationHistoryTurnItemsProgressKey(pagination);
  expect(
    codexConversationHistoryTurnItemsProgressKey({
      ...pagination,
      olderCursor: { type: "item", itemId: "another-first" },
    }),
  ).not.toBe(progress);
  expect(
    codexConversationHistoryTurnItemsProgressKey({ ...pagination, olderCursor: "page" }),
  ).not.toBe(progress);
});
