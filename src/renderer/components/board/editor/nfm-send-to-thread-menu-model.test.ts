import { describe, expect, test } from "vite-plus/test";
import type { ChatCatalogEntry, ChatSearchMatch } from "../../../../shared/chat-search";
import type { CodexThreadSummary, PageChatItem } from "@/lib/types";
import {
  buildNfmSendToThreadRows,
  createLinkedChatMatch,
  LINKED_CHAT_LABEL,
  moveNfmSendToThreadFocusedRowId,
  resolveNfmSendToThreadTitle,
  resolveNfmSendToThreadFocusedRowId,
  resolveNfmSendToThreadPreferredTarget,
} from "./nfm-send-to-thread-menu-model";

function makeMatch(
  chat: Partial<ChatCatalogEntry> = {},
  match: Partial<Omit<ChatSearchMatch, "chat">> = {},
): ChatSearchMatch {
  return {
    chat: {
      sessionId: "session-existing",
      threadId: "thread-existing",
      projectId: "project-1",
      projectName: "Launch project",
      title: "Existing implementation",
      cwd: "/repo",
      branch: null,
      pullRequests: [],
      pinned: false,
      pinnedOrder: null,
      activity: "idle",
      createdAt: 0,
      recencyAt: 0,
      ...chat,
    },
    titleRanges: [],
    hint: null,
    excerpt: null,
    ...match,
  };
}

function makePreferredThread(
  overrides: Partial<CodexThreadSummary> & { threadId: string },
): CodexThreadSummary {
  return {
    threadId: overrides.threadId,
    projectId: overrides.projectId ?? "project-1",
    source: overrides.source ?? null,
    threadName: overrides.threadName ?? null,
    threadPreview: overrides.threadPreview ?? "",
    modelProvider: "openai",
    cwd: overrides.cwd ?? null,
    statusType: overrides.statusType ?? "idle",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    archived: overrides.archived ?? false,
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    linkedAt: overrides.linkedAt ?? "2026-01-01T00:00:00.000Z",
    ...(overrides.ephemeral !== undefined ? { ephemeral: overrides.ephemeral } : {}),
  };
}

function makeLinkedChat(overrides: Partial<PageChatItem> = {}): PageChatItem {
  return {
    sessionId: "session-linked",
    projectId: "project-1",
    projectName: "Launch project",
    displayTitle: "Linked work",
    threadId: "linked",
    executionRef: null,
    threadPreview: "",
    threadStatus: null,
    threadArchived: false,
    unread: false,
    sessionArchived: false,
    conversationRecencyAt: 1,
    linkedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("markdown send-to-thread menu model", () => {
  test("uses the compact Codex title projection for preferred thread labels", () => {
    expect(
      resolveNfmSendToThreadTitle(
        makePreferredThread({
          threadId: "projected",
          threadName: "**Review** [changes](https://example.com)",
        }),
      ),
    ).toBe("Review changes");
  });

  test("keeps New chat last and preserves Main match ordering", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      matches: [
        makeMatch({ threadId: "older", title: "Older", recencyAt: 1 }),
        makeMatch({ threadId: "newer", title: "Newer", recencyAt: 3 }),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["thread:older", "thread:newer", "new-thread"]);
  });

  test("carries content-only matches and their highlighted excerpts without reranking", () => {
    const match = makeMatch(
      { threadId: "content-hit", title: "General investigation" },
      {
        excerpt: {
          text: "backend needle snippet",
          ranges: [{ start: 8, end: 14 }],
          role: "assistant",
        },
      },
    );
    const rows = buildNfmSendToThreadRows({ query: "needle", matches: [match] });

    expect(rows.map((row) => row.id)).toEqual(["thread:content-hit", "new-thread"]);
    expect(rows[0]).toMatchObject({
      match,
      target: { kind: "thread", threadId: "content-hit", sessionId: "session-existing" },
    });
  });

  test("skips chats that have not started a Thread", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      matches: [
        makeMatch({ threadId: null, sessionId: "session-unstarted" }),
        makeMatch({ threadId: "started", sessionId: "session-started" }),
      ],
    });

    expect(rows.map((row) => row.id)).toEqual(["thread:started", "new-thread"]);
    expect(rows[0]).toMatchObject({
      target: { kind: "thread", threadId: "started", sessionId: "session-started" },
    });
  });

  test("uses project labels and projectless chat metadata", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      matches: [
        makeMatch({ threadId: "project", projectName: "Launch project" }),
        makeMatch({
          threadId: "projectless",
          projectId: null,
          projectName: null,
          title: "Projectless chat",
        }),
      ],
    });

    expect(rows[0]?.kind).toBe("thread");
    expect(rows[1]?.kind).toBe("thread");
    if (rows[0]?.kind !== "thread" || rows[1]?.kind !== "thread") {
      throw new Error("expected thread rows");
    }
    expect(rows[0].meta).toBe("Launch project");
    expect(rows[1].meta).toBe("Chats");
  });

  test("prefers the current chat's live Thread, else a first Turn it may start", () => {
    const thread = makePreferredThread({ threadId: "live" });
    expect(
      resolveNfmSendToThreadPreferredTarget({
        sessionId: " session-1 ",
        sessionThread: thread,
        canStartThreadInSession: true,
      }),
    ).toEqual({ kind: "thread", thread, sessionId: "session-1", meta: "This chat" });
    expect(
      resolveNfmSendToThreadPreferredTarget({
        sessionId: "session-1",
        sessionThread: makePreferredThread({ threadId: "gone", archived: true }),
        canStartThreadInSession: true,
      }),
    ).toEqual({ kind: "new-thread", sessionId: "session-1", meta: "This chat" });
    // A chat without a Thread is named by its own title rather than as a new chat.
    expect(
      resolveNfmSendToThreadPreferredTarget({
        sessionId: "session-1",
        sessionThread: null,
        canStartThreadInSession: true,
        sessionTitle: " Fix login ",
      }),
    ).toEqual({
      kind: "new-thread",
      sessionId: "session-1",
      meta: "This chat",
      label: "Fix login",
    });
    for (const input of [
      { sessionId: "session-1", sessionThread: null, canStartThreadInSession: false },
      { sessionId: " ", sessionThread: thread, canStartThreadInSession: true },
      {
        sessionId: "session-1",
        sessionThread: makePreferredThread({ threadId: "temp", ephemeral: true }),
        canStartThreadInSession: false,
      },
    ]) {
      expect(resolveNfmSendToThreadPreferredTarget(input)).toBe(null);
    }
  });

  test("pins the matched preferred thread once with its catalog title and Session", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      preferredTarget: {
        kind: "thread",
        thread: makePreferredThread({
          threadId: "preferred",
          threadName: "Stale title",
          updatedAt: 1,
        }),
        sessionId: "session-preferred",
        meta: "This chat",
      },
      matches: [
        makeMatch({ threadId: "newer", title: "Newer", recencyAt: 3 }),
        makeMatch({
          threadId: "preferred",
          sessionId: "session-catalog",
          title: "Fresh title",
          recencyAt: 5,
        }),
        makeMatch({ threadId: "preferred", title: "Duplicate preferred match" }),
      ],
    });

    expect(rows.length).toBe(3);
    expect(rows[0]?.id).toBe("thread:preferred");
    if (rows[0]?.kind !== "thread") {
      throw new Error("expected preferred thread row");
    }
    expect(rows[0].label).toBe("Fresh title");
    expect(rows[0].meta).toBe("This chat");
    expect(rows[0].isPreferredTarget).toBe(true);
    expect(rows[0].target.sessionId).toBe("session-catalog");
    expect(rows[1]?.id).toBe("thread:newer");
    expect(rows[2]?.kind).toBe("new-thread");
  });

  test("lists older Linked chats after this chat even outside the catalog result window", () => {
    const linked = makeMatch({ threadId: "linked", sessionId: "session-linked", recencyAt: 1 });
    const current = makeMatch({ threadId: "preferred", recencyAt: 5 });
    const recent = makeMatch({ threadId: "recent", recencyAt: 9 });
    const preferredTarget = {
      kind: "thread" as const,
      thread: makePreferredThread({ threadId: "preferred" }),
      sessionId: "session-preferred",
      meta: "This chat",
    };
    const rows = buildNfmSendToThreadRows({
      query: "",
      matches: [recent, current],
      linkedChats: [current, linked, linked],
      preferredTarget,
    });
    expect(rows.map((row) => [row.id, row.meta])).toEqual([
      ["thread:preferred", "This chat"],
      ["thread:linked", LINKED_CHAT_LABEL],
      ["thread:recent", "Launch project"],
      ["new-thread", "This project"],
    ]);
    expect(rows[1]?.isPreferredTarget).toBe(false);

    expect(
      buildNfmSendToThreadRows({
        query: "recent",
        matches: [recent],
        linkedChats: [linked],
        preferredTarget,
      }).map((row) => row.id),
    ).toEqual(["thread:recent", "new-thread"]);
    // A Linked chat that search matches keeps its normal Project label.
    expect(
      buildNfmSendToThreadRows({
        query: "work",
        matches: [linked],
        linkedChats: [linked],
      }).map((row) => [row.id, row.meta]),
    ).toEqual([
      ["thread:linked", "Launch project"],
      ["new-thread", "This project"],
    ]);
    expect(
      buildNfmSendToThreadRows({
        query: "",
        matches: [recent, linked],
        linkedChats: [linked],
      }).map((row) => row.id),
    ).toEqual(["thread:linked", "thread:recent", "new-thread"]);
  });

  test("converts a started Linked chat with its title, Project, activity and recency", () => {
    expect(
      createLinkedChatMatch(
        makeLinkedChat({
          threadStatus: { statusType: "active", activeFlags: ["waitingOnApproval"] },
        }),
      ),
    ).toEqual(
      makeMatch({
        threadId: "linked",
        sessionId: "session-linked",
        title: "Linked work",
        cwd: null,
        activity: "waitingOnApproval",
        createdAt: 1,
        recencyAt: 1,
      }),
    );
    const linkedAt = "2026-02-01T00:00:00.000Z";
    expect(
      createLinkedChatMatch(makeLinkedChat({ conversationRecencyAt: null, linkedAt })),
    ).toMatchObject({ chat: { createdAt: Date.parse(linkedAt), recencyAt: Date.parse(linkedAt) } });
  });

  test.each([{ threadId: null }, { sessionArchived: true }, { threadArchived: true }])(
    "skips archived or threadless Linked chats (%j)",
    (overrides) => {
      expect(createLinkedChatMatch(makeLinkedChat(overrides))).toBeNull();
    },
  );

  test.each(["", "   "])(
    "synthesizes the missing preferred thread only for an empty query (%j)",
    (query) => {
      const rows = buildNfmSendToThreadRows({
        query,
        preferredTarget: {
          kind: "thread",
          thread: makePreferredThread({ threadId: "preferred", threadName: "Current work" }),
          sessionId: "session-current",
          meta: "This chat",
        },
        projectNameById: { "project-1": "Launch project" },
        matches: [makeMatch({ threadId: "other" })],
      });

      expect(rows.map((row) => row.id)).toEqual(["thread:preferred", "thread:other", "new-thread"]);
      expect(rows[0]).toMatchObject({
        label: "Current work",
        meta: "This chat",
        isPreferredTarget: true,
        match: { chat: { projectName: "Launch project" }, excerpt: null },
        target: { kind: "thread", threadId: "preferred", sessionId: "session-current" },
      });
    },
  );

  test("hides the preferred thread during search unless Main matched it", () => {
    const input = {
      query: "needle",
      preferredTarget: {
        kind: "thread" as const,
        thread: makePreferredThread({ threadId: "preferred", threadName: "needle" }),
        sessionId: "session-current",
        meta: "This chat",
      },
    };
    const otherMatch = makeMatch({ threadId: "other" });
    expect(
      buildNfmSendToThreadRows({ ...input, matches: [otherMatch] }).map((row) => row.id),
    ).toEqual(["thread:other", "new-thread"]);

    const preferredMatch = makeMatch({ threadId: "preferred", title: "Content-only hit" });
    const rows = buildNfmSendToThreadRows({ ...input, matches: [otherMatch, preferredMatch] });
    expect(rows.map((row) => row.id)).toEqual(["thread:preferred", "thread:other", "new-thread"]);
    expect(rows[0]).toMatchObject({
      label: "Content-only hit",
      meta: "This chat",
      match: preferredMatch,
    });
  });

  test("pins the current session new-chat target without duplicating the footer action", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      preferredTarget: {
        kind: "new-thread",
        sessionId: "session-current",
        meta: "This chat",
      },
      matches: [
        makeMatch({ threadId: "newer", title: "Newer", recencyAt: 3 }),
        makeMatch({ threadId: "older", title: "Older", recencyAt: 1 }),
      ],
    });

    expect(rows.length).toBe(3);
    expect(rows[0]?.id).toBe("new-thread:session-current");
    if (rows[0]?.kind !== "new-thread") {
      throw new Error("expected preferred new chat row");
    }
    expect(rows[0].label).toBe("New chat");
    expect(rows[0].meta).toBe("This chat");
    expect(rows[0].isPreferredTarget).toBe(true);
    expect(rows[0].isFooterAction).toBe(false);
    expect(rows[0].target.sessionId).toBe("session-current");
    expect(rows[1]?.id).toBe("thread:newer");
    expect(rows[2]?.id).toBe("thread:older");
  });

  test("keeps the project new-chat footer when the preferred new-chat target does not match search", () => {
    const rows = buildNfmSendToThreadRows({
      query: "unrelated",
      preferredTarget: {
        kind: "new-thread",
        sessionId: "session-current",
        meta: "This chat",
      },
      matches: [],
    });

    expect(rows.length).toBe(1);
    expect(rows[0]?.id).toBe("new-thread");
    if (rows[0]?.kind !== "new-thread") {
      throw new Error("expected project new chat row");
    }
    expect(rows[0].meta).toBe("This project");
    expect(rows[0].isFooterAction).toBe(true);
    expect(rows[0].target.sessionId ?? "").toBe("");
  });

  test("does not pin unavailable preferred threads", () => {
    const unavailablePreferredThreads = [
      makePreferredThread({ threadId: "archived", threadName: "Archived", archived: true }),
      makePreferredThread({ threadId: "ephemeral", threadName: "Ephemeral", ephemeral: true }),
      makePreferredThread({
        threadId: "side",
        threadName: "Side",
        source: { parentThreadId: "parent", sideConversation: true },
      }),
    ];

    for (const thread of unavailablePreferredThreads) {
      const rows = buildNfmSendToThreadRows({
        query: "",
        preferredTarget: {
          kind: "thread",
          thread,
          sessionId: "session-preferred",
          meta: "Current section",
        },
        matches: [makeMatch({ threadId: "other", title: "Other", recencyAt: 1 })],
      });

      expect(rows.map((row) => row.id).join(",")).toBe("thread:other,new-thread");
    }
  });

  test("focus starts on a matching existing thread for search and wraps during keyboard movement", () => {
    const rows = buildNfmSendToThreadRows({
      query: "build",
      matches: [makeMatch({ threadId: "build-thread", title: "Build flow", recencyAt: 1 })],
    });

    const initial = resolveNfmSendToThreadFocusedRowId(null, "build", rows);
    expect(initial).toBe("thread:build-thread");
    expect(moveNfmSendToThreadFocusedRowId(initial, 1, rows)).toBe("new-thread");
    expect(moveNfmSendToThreadFocusedRowId("new-thread", -1, rows)).toBe("thread:build-thread");
  });
});
