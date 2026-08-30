import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { installWindowApi } from "../test/browser-globals";
import {
  linkPageChat,
  readPageChatActivitySummaries,
  readPageChatWindow,
  unlinkPageChat,
} from "./page-chat-runtime";
import {
  completePageOccurrence,
  readBoardPage,
  readCalendarOccurrenceWindow,
  skipPageOccurrence,
  updatePageOccurrence,
} from "./page-occurrence-runtime";

const invoke = vi.fn(async (channel: string) => {
  if (channel === "database-row:get") return null;
  if (channel === "calendar:occurrences") return { occurrences: [], nextCursor: null };
  if (channel === "page-chats:activity-summaries") {
    return { summaries: [], projectionRevision: 3 };
  }
  if (channel === "page-chats:list") {
    return { items: [], nextCursor: null, hasMore: false, projectionRevision: 4 };
  }
  if (channel.startsWith("page:occurrence:")) {
    return { success: true, commitCursor: { storeEpoch: "epoch-page", commitSeq: 9 } };
  }
  return undefined;
});

beforeEach(() => {
  invoke.mockClear();
  installWindowApi({ invoke, on: () => () => undefined });
});

describe("Page coordination runtimes", () => {
  test("routes Board and calendar reads through typed query endpoints", async () => {
    const start = new Date("2026-08-31T00:00:00.000Z");
    const end = new Date("2026-09-01T00:00:00.000Z");

    await readBoardPage("project-1", "page-1", "plan", {
      storeEpoch: "epoch-page",
      commitSeq: 8,
    });
    await readCalendarOccurrenceWindow("project-1", start, end, "launch", null);
    await readPageChatActivitySummaries({
      pageAccessProjectId: "project-1",
      pageIds: ["page-1"],
    });
    await readPageChatWindow({
      pageAccessProjectId: "project-1",
      pageId: "page-1",
      first: 20,
    });

    expect(invoke.mock.calls).toEqual([
      [
        "database-row:get",
        "project-1",
        "page-1",
        "plan",
        { storeEpoch: "epoch-page", commitSeq: 8 },
      ],
      ["calendar:occurrences", "project-1", start, end, "launch", null],
      ["page-chats:activity-summaries", { pageAccessProjectId: "project-1", pageIds: ["page-1"] }],
      ["page-chats:list", { pageAccessProjectId: "project-1", pageId: "page-1", first: 20 }],
    ]);
  });

  test("preserves occurrence commit cursors without fabricating LocalCommit evidence", async () => {
    const occurrenceStart = new Date("2026-08-31T00:00:00.000Z");
    const base = {
      operationId: "operation-1",
      pageId: "page-1",
      occurrenceStart,
      source: "calendar" as const,
    };

    const completed = await completePageOccurrence("project-1", {
      ...base,
      createdPageId: "page-created",
    });
    await skipPageOccurrence("project-1", base);
    await updatePageOccurrence("project-1", {
      ...base,
      scope: "all",
      updates: { isAllDay: true },
    });

    expect(completed).toEqual({
      success: true,
      commitCursor: { storeEpoch: "epoch-page", commitSeq: 9 },
    });
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      "page:occurrence:complete",
      "page:occurrence:skip",
      "page:occurrence:update",
    ]);
  });

  test("keeps Page-chat relation changes behind their pending projection boundary", async () => {
    const relation = { pageAccessProjectId: "project-1", pageId: "page-1" };

    await linkPageChat("session-1", relation);
    await unlinkPageChat("session-1", relation);

    expect(invoke.mock.calls).toEqual([
      ["page-chats:link", "session-1", relation],
      ["page-chats:unlink", "session-1", relation],
    ]);
  });
});
