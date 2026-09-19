import { expect, test } from "vite-plus/test";
import { createCodexConversationHistoryTurnItemsRef } from "./codex-conversation-history-page";

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
