import { describe, expect, test } from "vite-plus/test";
import type { PageChatActivitySummary } from "./types";
import {
  presentPageChatActivity,
  presentPageChatItemActivity,
} from "./page-chat-activity-presentation";
import type { PageChatItem } from "./types";

const summary = (overrides: Partial<PageChatActivitySummary> = {}): PageChatActivitySummary => ({
  pageId: "page:one",
  relatedCount: 1,
  workingCount: 0,
  waitingOnApprovalCount: 0,
  waitingOnUserInputCount: 0,
  errorCount: 0,
  unreadCount: 0,
  soleSessionId: "session:one",
  runtimeSessionIds: [],
  ...overrides,
});

describe("Page Chat activity presentation", () => {
  test("keeps running and unread orthogonal", () => {
    expect(presentPageChatActivity(summary({ workingCount: 1, unreadCount: 1 }))).toEqual({
      execution: "working",
      unread: true,
      accessibleLabel: "1 linked chat, 1 working chat, 1 unread chat",
    });
  });

  test("uses error, approval, input, and working display priority", () => {
    expect(
      presentPageChatActivity(
        summary({
          errorCount: 1,
          waitingOnApprovalCount: 1,
          waitingOnUserInputCount: 1,
          workingCount: 1,
        }),
      ).execution,
    ).toBe("error");
    expect(
      presentPageChatActivity(
        summary({ waitingOnApprovalCount: 1, waitingOnUserInputCount: 1, workingCount: 1 }),
      ).execution,
    ).toBe("approval");
    expect(
      presentPageChatActivity(summary({ waitingOnUserInputCount: 1, workingCount: 1 })).execution,
    ).toBe("input");
  });

  test("presents idle/read relations without execution or unread activity", () => {
    expect(presentPageChatActivity(summary())).toMatchObject({
      execution: "idle",
      unread: false,
    });
  });

  test("adds linked Runtime chats' live Session activity to native counts", () => {
    const runtime = summary({
      relatedCount: 4,
      workingCount: 1,
      runtimeSessionIds: ["runtime:running", "runtime:waiting", "runtime:background", "idle"],
    });
    const presented = presentPageChatActivity(
      runtime,
      new Map([
        ["runtime:running", "running"],
        ["runtime:waiting", "waiting"],
        ["runtime:background", "background"],
      ]),
    );
    expect(presented).toEqual({
      execution: "input",
      unread: false,
      accessibleLabel:
        "4 linked chats, 1 awaiting input, 2 working chats, 1 chat working in background",
    });
    expect(
      presentPageChatActivity(
        summary({ runtimeSessionIds: ["runtime:background"] }),
        new Map([["runtime:background", "background"]]),
      ).execution,
    ).toBe("background");
    expect(presentPageChatActivity(runtime).execution).toBe("working");
  });

  test("reads a Runtime row from its activity and never from a native status", () => {
    const item: PageChatItem = {
      sessionId: "session:runtime",
      projectId: "project:one",
      projectName: "One",
      displayTitle: "Runtime chat",
      threadId: "root:runtime",
      executionRef: { runtimeId: "runtime:primary", threadId: "root:runtime" },
      threadPreview: "",
      threadStatus: { statusType: "active", activeFlags: [] },
      threadArchived: false,
      unread: true,
      sessionArchived: false,
      conversationRecencyAt: 1,
      linkedAt: "2026-10-15T00:00:00Z",
    };
    expect(presentPageChatItemActivity(item)).toMatchObject({ execution: "idle", unread: true });
    expect(presentPageChatItemActivity(item, "running").execution).toBe("working");
    expect(presentPageChatItemActivity(item, "waiting").execution).toBe("input");
    expect(
      presentPageChatItemActivity({ ...item, sessionArchived: true }, "running").execution,
    ).toBe("idle");
  });
});
