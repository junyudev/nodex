import { describe, expect, test } from "vite-plus/test";
import type { PageChatActivitySummary } from "./types";
import { presentPageChatActivity } from "./page-chat-activity-presentation";

const summary = (overrides: Partial<PageChatActivitySummary> = {}): PageChatActivitySummary => ({
  pageId: "page:one",
  relatedCount: 1,
  workingCount: 0,
  waitingOnApprovalCount: 0,
  waitingOnUserInputCount: 0,
  errorCount: 0,
  unreadCount: 0,
  soleSessionId: "session:one",
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
});
