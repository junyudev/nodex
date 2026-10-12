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

test("released full Turn history remains navigable through its recovery boundary", () => {
  const pagination = {
    olderCursor: null,
    olderItemId: "retained-first",
    evicted: true,
    hasLoadedOldest: false,
    isLoadingOlder: false,
    itemsView: "full" as const,
  };
  const input = { turnId: "turn", expectedTopologyGeneration: 4, pagination };
  expect(createCodexConversationHistoryTurnItemsRef(input)).toMatchObject({
    turnId: "turn",
    edge: "older",
  });
  // A completely released Turn resumes at its native tail without an item anchor.
  expect(
    createCodexConversationHistoryTurnItemsRef({
      ...input,
      pagination: { ...pagination, olderItemId: undefined },
    }),
  ).not.toBeNull();
  expect(
    createCodexConversationHistoryTurnItemsRef({
      ...input,
      pagination: { ...pagination, evicted: false },
    }),
  ).toBeNull();
  expect(
    createCodexConversationHistoryTurnItemsRef({
      ...input,
      pagination: { ...pagination, hasLoadedOldest: true },
    }),
  ).toBeNull();
  expect(createCodexConversationHistoryTurnItemsRef({ ...input, edge: "newer" })).toBeNull();
  const progress = codexConversationHistoryTurnItemsProgressKey(pagination);
  expect(
    codexConversationHistoryTurnItemsProgressKey({ ...pagination, olderItemId: "another-first" }),
  ).not.toBe(progress);
  expect(
    codexConversationHistoryTurnItemsProgressKey({ ...pagination, olderItemId: undefined }),
  ).not.toBe(progress);
  expect(codexConversationHistoryTurnItemsProgressKey({ ...pagination, evicted: false })).not.toBe(
    progress,
  );
});
