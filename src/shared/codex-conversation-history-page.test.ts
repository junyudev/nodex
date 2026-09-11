import { describe, expect, it } from "vite-plus/test";
import type { CodexCanonicalItem } from "./codex-conversation-state/codex-conversation-state";
import { prependCodexHistoryItemPage } from "./codex-conversation-state/codex-history-item-window";
import {
  applyCodexConversationHistoryMutation,
  createCodexConversationHistoryTurnItemsRef,
  restoreCodexConversationHistoryItemWindow,
  seedCodexConversationHistoryItemWindow,
  snapshotCodexConversationHistoryItemWindow,
  type CodexConversationHistoryMutation,
} from "./codex-conversation-history-page";
import type { CodexConversationItem, CodexConversationSnapshot } from "./types";

const turnId = "turn-history";
const canonicalItem = (id: string, text = id): CodexCanonicalItem => ({
  id,
  type: "agentMessage",
  text,
  phase: "commentary",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const rendererItem = (id: string, text = id): CodexConversationItem => ({
  threadId: "thread-history",
  turnId,
  itemId: id,
  entryId: id,
  type: "agentMessage",
  kind: "assistantMessage",
  markdownText: text,
  status: "completed",
  createdAt: 1,
  updatedAt: 1,
});
const pagination = {
  olderCursor: "older:1",
  isLoadingOlder: false,
  hasLoadedOldest: false,
  oldestUserInput: null,
  openingUserMessageId: null,
  itemsView: "summary" as const,
};

function fixture() {
  const items = [canonicalItem("resident")];
  const rows = [rendererItem("resident")];
  const seeded = seedCodexConversationHistoryItemWindow({
    turnId,
    canonicalItems: items,
    rendererItems: rows,
    pagination,
  })!;
  const windowSnapshot = {
    ...snapshotCodexConversationHistoryItemWindow(seeded),
  };
  const window = restoreCodexConversationHistoryItemWindow(windowSnapshot)!;
  // Only the history-owned fields are relevant to this transport-neutral merge contract.
  const conversation = {
    threadId: "thread-history",
    requests: [],
    conversationEntityGeneration: 1,
    historyTopologyGeneration: 1,
    historyMutationRevision: 0,
    historyRows: [{ kind: "content", key: turnId, entityKey: turnId, turnKey: turnId }],
    turnPagination: {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: turnId,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: 1,
      itemsView: "summary",
    },
    turnItemsPaginationById: { [turnId]: pagination },
    historyItemWindowsByTurnId: { [turnId]: windowSnapshot },
    turns: [
      {
        threadId: "thread-history",
        turnId,
        status: "inProgress",
        itemIds: ["resident"],
        items: rows,
      },
    ],
    canonicalState: {
      protocol: { id: "thread-history" },
      requests: [],
      sidecar: {},
      turns: [
        {
          protocol: { id: turnId, itemsView: "summary", status: "inProgress" },
          sidecar: {},
          items,
        },
      ],
    },
  } as unknown as CodexConversationSnapshot;
  const transition = prependCodexHistoryItemPage(window, {
    turnId,
    segmentId: "page:older:1",
    items: {
      itemIds: ["older"],
      canonicalItems: [canonicalItem("older")],
      rendererItems: [rendererItem("older")],
    },
    approximateBytes: 100,
    olderCursorAfter: "older:2",
    newerCursor: "newer:1",
  });
  if (!transition.ok) throw new Error(transition.error.message);
  const mutation: CodexConversationHistoryMutation = {
    threadId: conversation.threadId,
    conversationGeneration: 1,
    topologyGeneration: 1,
    baseHistoryMutationRevision: 0,
    historyMutationRevision: 1,
    origin: {
      kind: "page",
      request: {
        threadId: conversation.threadId,
        expectedConversationGeneration: 1,
        expectedHistoryMutationRevision: 0,
        target: {
          kind: "turnItems",
          items: createCodexConversationHistoryTurnItemsRef({
            turnId,
            expectedTopologyGeneration: 1,
            pagination,
            window: windowSnapshot,
          })!,
        },
      },
    },
    upsertTurns: [],
    upsertCanonicalTurns: [],
    removeTurnIds: [],
    rowSplices: [],
    turnPagination: conversation.turnPagination!,
    turnItemsPaginationUpserts: { [turnId]: { ...pagination, olderCursor: "older:2" } },
    removeTurnItemsPaginationIds: [],
    turnItems: [
      {
        turnId,
        itemsView: "summary",
        windowMutation: {
          wireSegment: transition.wireSegment,
        },
      },
    ],
  };
  return { conversation, mutation };
}

function appendLive(conversation: CodexConversationSnapshot): CodexConversationSnapshot {
  const canonical = conversation.canonicalState!;
  return {
    ...conversation,
    turns: [
      {
        ...conversation.turns[0]!,
        items: [rendererItem("resident", "updated"), rendererItem("live")],
        itemIds: ["resident", "live"],
      },
    ],
    canonicalState: {
      ...canonical,
      turns: [
        {
          ...canonical.turns[0]!,
          items: [canonicalItem("resident", "updated"), canonicalItem("live")],
        },
      ],
    },
  };
}

describe("owner item history merge", () => {
  it("preserves live content and additions in the exact physical window for the next page", () => {
    const { conversation, mutation } = fixture();
    const latest = appendLive(conversation);
    const result = applyCodexConversationHistoryMutation(latest, mutation);
    if (!result.ok) throw new Error(result.reason);
    const merged = result.conversation;
    expect(merged.turns[0]!.items.map((item) => item.markdownText)).toEqual([
      "older",
      "updated",
      "live",
    ]);
    expect(merged.canonicalState!.turns[0]!.items).toEqual([
      canonicalItem("older"),
      canonicalItem("resident", "updated"),
      canonicalItem("live"),
    ]);
    const window = merged.historyItemWindowsByTurnId![turnId]!;
    expect(window.segments.map((segment) => segment.segmentId)).toEqual([
      "page:older:1",
      conversation.historyItemWindowsByTurnId![turnId]!.segments[0]!.segmentId,
    ]);
    expect(window.segments.flatMap((segment) => segment.items.itemIds)).toEqual([
      "older",
      "resident",
      "live",
    ]);
    expect(window.segments[1]!.items.canonicalItems[0]).toBe(
      latest.canonicalState!.turns[0]!.items[0],
    );
    expect(window.olderBoundary).toEqual({ status: "available", cursor: "older:2" });
    expect(restoreCodexConversationHistoryItemWindow(window)!.residency.itemCount).toBe(3);
  });
});
