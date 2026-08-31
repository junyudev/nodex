import { describe, expect, test } from "vite-plus/test";
import type { CommandPaletteThread } from "@/lib/command-palette";
import {
  type CommandPaletteThreadSearchBatch,
  selectCommandPaletteChatResults,
} from "@/lib/command-palette-chat-search";
import { createCommandPaletteThreadSearchIndex } from "@/lib/command-palette-thread-search";
import type { CodexThreadSummary } from "@/lib/types";
import {
  buildNfmSendToThreadRows,
  moveNfmSendToThreadFocusedRowId,
  resolveNfmSendToThreadFocusedRowId,
} from "./nfm-send-to-thread-menu-model";

function makeThread(overrides: Partial<CommandPaletteThread> = {}): CommandPaletteThread {
  const threadId = overrides.threadId ?? "thread-existing";
  return {
    kind: "thread",
    id: overrides.id ?? `thread:${threadId}`,
    threadId,
    sessionId: overrides.sessionId === undefined ? "session-existing" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "project-1" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Launch project" : overrides.projectName,
    title: overrides.title ?? "Existing implementation",
    preview: overrides.preview ?? "Continue from selected notes",
    cwd: overrides.cwd ?? "/repo",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "idle",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 0,
    updatedAt: overrides.updatedAt ?? 0,
    inActiveProject: overrides.inActiveProject ?? true,
    searchPreview: overrides.searchPreview,
    searchDecorations: overrides.searchDecorations,
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

function makeThreadContentBatch(
  query: string,
  results: CommandPaletteThreadSearchBatch["results"],
): CommandPaletteThreadSearchBatch {
  return {
    query,
    results,
    loading: false,
    error: null,
  };
}

function searchThreads(query: string, threads: CommandPaletteThread[]): CommandPaletteThread[] {
  return selectCommandPaletteChatResults({
    query,
    threads,
    threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
    threadSearchBatch: makeThreadContentBatch(query, []),
    threadLimit: 24,
  });
}

describe("nfm send-to-thread menu model", () => {
  test("keeps New chat last and preserves command-palette thread ordering", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      threads: [
        makeThread({ threadId: "newer", title: "Newer", updatedAt: 3 }),
        makeThread({ threadId: "older", title: "Older", updatedAt: 1 }),
      ],
    });

    expect(rows.map((row) => row.id).join(",")).toBe("thread:newer,thread:older,new-thread");
  });

  test("uses command-palette fuzzy and prefix search results", () => {
    const threads = [
      makeThread({
        threadId: "target",
        title: "Command palette thread search",
        preview: "Search previous assistant messages.",
      }),
      makeThread({
        threadId: "miss",
        title: "Terminal layout polish",
        preview: "No matching words.",
      }),
    ];
    const rows = buildNfmSendToThreadRows({
      query: "commnd pal",
      threads: searchThreads("commnd pal", threads),
    });

    expect(rows.length).toBe(2);
    expect(rows[0]?.id).toBe("thread:target");
    expect(rows[1]?.kind).toBe("new-thread");
  });

  test("keeps content-only command-palette hits with snippets", () => {
    const threads = [
      makeThread({
        threadId: "content-hit",
        title: "General investigation",
        preview: "",
      }),
    ];
    const visibleThreads = selectCommandPaletteChatResults({
      query: "needle",
      threads,
      threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
      threadSearchBatch: makeThreadContentBatch("needle", [
        {
          thread: {
            backendBinding: { kind: "codex" },
            threadId: "content-hit",
            sessionId: "session-existing",
            projectId: "project-1",
            projectName: "Launch project",
            title: "General investigation",
            preview: "",
            cwd: "/repo",
            gitBranch: null,
            projectless: false,
            pinned: false,
            pinnedOrder: null,
            statusType: "idle",
            statusActiveFlags: [],
            createdAt: 0,
            updatedAt: 0,
          },
          snippet: "backend needle snippet",
        },
      ]),
      threadLimit: 24,
    });
    const rows = buildNfmSendToThreadRows({
      query: "needle",
      threads: visibleThreads,
    });

    expect(rows[0]?.id).toBe("thread:content-hit");
    if (rows[0]?.kind !== "thread") {
      throw new Error("expected thread row");
    }
    expect(rows[0].searchPreview?.source).toBe("content");
    expect(rows[0].searchPreview?.segments.some((segment) => segment.highlight)).toBe(true);
  });

  test("offers an app-server-only task as a send target", () => {
    const visibleThreads = selectCommandPaletteChatResults({
      query: "handoff",
      threads: [],
      threadSearchBatch: makeThreadContentBatch("handoff", [
        {
          thread: {
            backendBinding: { kind: "codex" },
            threadId: "server-only-target",
            sessionId: null,
            projectId: "project-1",
            projectName: "Launch project",
            title: "Historical handoff",
            preview: "Not loaded in the sidebar",
            cwd: "/repo/archive",
            gitBranch: "archive/handoff",
            projectless: false,
            pinned: false,
            pinnedOrder: null,
            statusType: "notLoaded",
            statusActiveFlags: [],
            createdAt: 1,
            updatedAt: 2,
          },
          snippet: "The handoff target exists only in app-server history.",
        },
      ]),
      activeProjectId: "project-1",
    });

    const rows = buildNfmSendToThreadRows({ query: "handoff", threads: visibleThreads });

    expect(rows[0]).toMatchObject({
      id: "thread:server-only-target",
      kind: "thread",
      threadId: "server-only-target",
    });
  });

  test("uses project labels and projectless chat metadata", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      threads: [
        makeThread({ threadId: "project", projectName: "Launch project" }),
        makeThread({
          threadId: "projectless",
          sessionId: null,
          projectId: null,
          projectName: null,
          projectless: true,
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

  test("pins and labels the preferred thread with caller meta", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      preferredTarget: {
        kind: "thread",
        thread: makePreferredThread({
          threadId: "preferred",
          threadName: "Stale title",
          updatedAt: 1,
        }),
        meta: "This session",
      },
      threads: [
        makeThread({ threadId: "newer", title: "Newer", updatedAt: 3 }),
        makeThread({ threadId: "preferred", title: "Fresh title", updatedAt: 5 }),
      ],
    });

    expect(rows.length).toBe(3);
    expect(rows[0]?.id).toBe("thread:preferred");
    if (rows[0]?.kind !== "thread") {
      throw new Error("expected preferred thread row");
    }
    expect(rows[0].label).toBe("Fresh title");
    expect(rows[0].meta).toBe("This session");
    expect(rows[0].isPreferredTarget).toBe(true);
    expect(rows[1]?.id).toBe("thread:newer");
    expect(rows[2]?.kind).toBe("new-thread");
  });

  test("pins the current session new-chat target without duplicating the footer action", () => {
    const rows = buildNfmSendToThreadRows({
      query: "",
      preferredTarget: {
        kind: "new-thread",
        sessionId: "session-current",
        meta: "This session",
      },
      threads: [
        makeThread({ threadId: "newer", title: "Newer", updatedAt: 3 }),
        makeThread({ threadId: "older", title: "Older", updatedAt: 1 }),
      ],
    });

    expect(rows.length).toBe(3);
    expect(rows[0]?.id).toBe("new-thread:session-current");
    if (rows[0]?.kind !== "new-thread") {
      throw new Error("expected preferred new chat row");
    }
    expect(rows[0].label).toBe("New chat");
    expect(rows[0].meta).toBe("This session");
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
        meta: "This session",
      },
      threads: [],
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
          meta: "Current section",
        },
        threads: [makeThread({ threadId: "other", title: "Other", updatedAt: 1 })],
      });

      expect(rows.map((row) => row.id).join(",")).toBe("thread:other,new-thread");
    }
  });

  test("focus starts on a matching existing thread for search and wraps during keyboard movement", () => {
    const rows = buildNfmSendToThreadRows({
      query: "build",
      threads: [makeThread({ threadId: "build-thread", title: "Build flow", updatedAt: 1 })],
    });

    const initial = resolveNfmSendToThreadFocusedRowId(null, "build", rows);
    expect(initial).toBe("thread:build-thread");
    expect(moveNfmSendToThreadFocusedRowId(initial, 1, rows)).toBe("new-thread");
    expect(moveNfmSendToThreadFocusedRowId("new-thread", -1, rows)).toBe("thread:build-thread");
  });
});
