import { describe, expect, test, vi } from "vite-plus/test";
import {
  sendPageToChatWithHandoff,
  type PagePromptContext,
  type SendPageToChatInput,
} from "./page-chat-actions";
import type { PageChatActivitySummary, PageChatItem, PageChatActivitySummaryResult } from "./types";
import {
  presentPageChatActivity,
  presentPageChatItemActivity,
} from "./page-chat-activity-presentation";
import { describePageChatDelivery, resolvePageChatDelivery } from "./page-chat-delivery";
import { normalizePageChatPageIds, readPageChatActivitySummaryBatches } from "./page-chat-queries";

describe("page chat actions", () => {
  const pageInput = (target: SendPageToChatInput["target"]): SendPageToChatInput => ({
    projectId: "project-page",
    pageId: "page-1",
    pageKey: "LAB-1",
    titleSnapshot: "Release plan",
    target,
  });

  const context: PagePromptContext = {
    projectId: "project-page",
    pageId: "page-1",
    pageKey: "LAB-1",
    title: "Release plan",
    source: "nodex://pages/page-1",
    promptInput: { text: "Page: Release plan" },
  };

  type SendDependencies = Parameters<typeof sendPageToChatWithHandoff>[1];

  function dependencies(overrides: Partial<SendDependencies> = {}) {
    const calls: string[] = [];
    return {
      calls,
      value: {
        loadPageContext: vi.fn(async () => {
          calls.push("snapshot");
          return context;
        }),
        resolveSessionById: vi.fn(async () => {
          calls.push("resolve-session");
          return { id: "session-target", projectId: "project-target" };
        }),
        resolveSessionForThread: vi.fn(async () => {
          calls.push("resolve-thread");
          return { id: "session-target", projectId: "project-target" };
        }),
        ensureDefaultSession: vi.fn(async () => {
          calls.push("ensure-default");
          return { id: "session-default", projectId: "project-page" };
        }),
        handOffPage: vi.fn(async () => {
          calls.push("hand-off");
        }),
        startTurn: vi.fn(async () => {
          calls.push("start-turn");
        }),
        startThread: vi.fn(async () => {
          calls.push("start-thread");
          return { kind: "started" };
        }),
        refreshSessions: vi.fn(async () => {
          calls.push("refresh");
        }),
        ...overrides,
      },
    };
  }

  describe("sendPageToChatWithHandoff", () => {
    test("orders canonical snapshot, target resolution, durable hand-off, then existing Turn", async () => {
      const runtime = dependencies();
      await sendPageToChatWithHandoff(
        pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
        runtime.value,
      );
      expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "hand-off", "start-turn"]);
      expect(runtime.value.handOffPage).toHaveBeenCalledWith({
        pageId: "page-1",
        sessionId: "session-target",
      });
      expect(runtime.value.startTurn).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: "project-target", threadId: "thread-target" }),
      );
    });

    test("does not hand off or send when the Page snapshot fails", async () => {
      const runtime = dependencies({
        loadPageContext: vi.fn(async () => {
          runtime.calls.push("snapshot");
          throw new Error("Page unavailable");
        }),
      });
      await expect(
        sendPageToChatWithHandoff(
          pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
          runtime.value,
        ),
      ).rejects.toThrow("Page unavailable");
      expect(runtime.calls).toEqual(["snapshot"]);
    });

    test("does not hand off or send when target Session resolution fails", async () => {
      const runtime = dependencies({
        resolveSessionForThread: vi.fn(async () => {
          runtime.calls.push("resolve-thread");
          throw new Error("Chat unavailable");
        }),
      });
      await expect(
        sendPageToChatWithHandoff(
          pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
          runtime.value,
        ),
      ).rejects.toThrow("Chat unavailable");
      expect(runtime.calls).toEqual(["snapshot", "resolve-thread"]);
    });

    test("does not start a Turn when the durable hand-off fails", async () => {
      const runtime = dependencies({
        handOffPage: vi.fn(async () => {
          runtime.calls.push("hand-off");
          throw new Error("Store unavailable");
        }),
      });
      await expect(
        sendPageToChatWithHandoff(
          pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
          runtime.value,
        ),
      ).rejects.toThrow("Store unavailable");
      expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "hand-off"]);
    });

    test("keeps the durable hand-off when Agent start fails", async () => {
      const runtime = dependencies({
        startTurn: vi.fn(async () => {
          runtime.calls.push("start-turn");
          throw new Error("Agent unavailable");
        }),
      });
      await expect(
        sendPageToChatWithHandoff(
          pageInput({ kind: "thread", threadId: "thread-target", sessionId: "session-target" }),
          runtime.value,
        ),
      ).rejects.toThrow("Agent unavailable");
      expect(runtime.calls).toEqual(["snapshot", "resolve-thread", "hand-off", "start-turn"]);
      expect(runtime.value.handOffPage).toHaveBeenCalledTimes(1);
    });

    test("hands the Page to a resolved blank Chat before starting its first Thread", async () => {
      const runtime = dependencies();
      await sendPageToChatWithHandoff(
        pageInput({ kind: "new-thread", sessionId: "session-target" }),
        runtime.value,
      );
      expect(runtime.calls).toEqual([
        "snapshot",
        "resolve-session",
        "hand-off",
        "start-thread",
        "refresh",
      ]);
    });
  });
});

describe("page chat activity presentation", () => {
  const summary = (overrides: Partial<PageChatActivitySummary> = {}): PageChatActivitySummary => ({
    pageId: "page:one",
    relatedCount: 1,
    workingCount: 0,
    waitingOnApprovalCount: 0,
    waitingOnUserInputCount: 0,
    errorCount: 0,
    unreadCount: 0,
    soleSessionId: "session:one",
    work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
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
        report: null,
        sessionArchived: false,
        conversationRecencyAt: 1,
        linkedAt: "2026-10-15T00:00:00Z",
      };
      expect(presentPageChatItemActivity(item)).toMatchObject({ execution: "idle", unread: true });
      expect(presentPageChatItemActivity(item, "running").execution).toBe("working");
      expect(presentPageChatItemActivity(item, "waiting").execution).toBe("input");
      expect(presentPageChatItemActivity(item, "approval")).toMatchObject({
        execution: "approval",
        accessibleLabel: "1 linked chat, 1 awaiting approval, 1 unread chat",
      });
      expect(
        presentPageChatItemActivity({ ...item, sessionArchived: true }, "running").execution,
      ).toBe("idle");
    });
  });
});

describe("Page send delivery", () => {
  test("an idle or background chat receives a send at once", () => {
    for (const status of [null, "background"] as const) {
      expect(resolvePageChatDelivery({ status, queueFollowUps: true })).toBe("send");
      expect(
        describePageChatDelivery(resolvePageChatDelivery({ status, queueFollowUps: false })),
      ).toBeNull();
    }
  });

  test("a chat in a Turn follows the Composer's Queue or Steer default", () => {
    for (const status of ["running", "waiting"] as const) {
      expect(resolvePageChatDelivery({ status, queueFollowUps: true })).toBe("queue");
      expect(resolvePageChatDelivery({ status, queueFollowUps: false })).toBe("steer");
    }
    expect(describePageChatDelivery("queue")).toBe("Queues after its current turn");
    expect(describePageChatDelivery("steer")).toBe("Steers its current turn");
  });

  test("content that starts its own Turn queues even when the default is Steer", () => {
    expect(
      resolvePageChatDelivery({ status: "running", queueFollowUps: false, startsNewTurn: true }),
    ).toBe("queue");
  });
});

describe("Page Chat activity queries", () => {
  test("normalizes identities and reads 201 Pages as 200 plus one bounded batch", async () => {
    const requested = Array.from({ length: 201 }, (_, index) => `page:${index.toString(10)}`);
    requested.push("page:7");
    const calls: string[][] = [];

    const result = await readPageChatActivitySummaryBatches(
      { pageIds: requested.reverse() },
      async (input): Promise<PageChatActivitySummaryResult> => {
        calls.push(input.pageIds);
        return {
          summaries: input.pageIds.map((pageId) => ({
            pageId,
            relatedCount: 0,
            workingCount: 0,
            waitingOnApprovalCount: 0,
            waitingOnUserInputCount: 0,
            errorCount: 0,
            unreadCount: 0,
            soleSessionId: null,
            work: { activeChat: null, latestReport: null, managedSessionCount: 0 },
            runtimeSessionIds: [],
          })),
          projectionRevision: calls.length * 10,
        };
      },
    );

    expect(calls.map((batch) => batch.length)).toEqual([200, 1]);
    expect(calls.flat()).toEqual(normalizePageChatPageIds(requested));
    expect(result.summaries).toHaveLength(201);
    expect(result.projectionRevision).toBe(20);
  });

  test("returns an empty projection without issuing a Core read", async () => {
    let readCount = 0;
    const result = await readPageChatActivitySummaryBatches({ pageIds: [] }, async () => {
      readCount += 1;
      return { summaries: [], projectionRevision: 99 };
    });

    expect(result).toEqual({ summaries: [], projectionRevision: 0 });
    expect(readCount).toBe(0);
  });
});
