import { describe, expect, test } from "vite-plus/test";
import type { CommandPaletteThread } from "./command-palette";
import {
  getCommandPaletteThreadSearchPlan,
  type CommandPaletteThreadSearchBatch,
  selectCommandPaletteChatResults,
} from "./command-palette-chat-search";
import { createCommandPaletteThreadSearchIndex } from "./command-palette-thread-search";
import type { CommandPaletteThreadSearchResult, CommandPaletteThreadSummary } from "./types";

function makeThread(overrides: Partial<CommandPaletteThread> = {}): CommandPaletteThread {
  return {
    kind: "thread",
    id: overrides.id ?? "thread:thr-1",
    threadId: overrides.threadId ?? "thr-1",
    sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "project-1" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Project" : overrides.projectName,
    title: overrides.title ?? "Command palette chat search",
    preview: overrides.preview ?? "Add shared chat search to pickers.",
    cwd: overrides.cwd ?? "/tmp/project",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "notLoaded",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 1_781_990_400,
    updatedAt: overrides.updatedAt ?? 1_781_990_400,
    inActiveProject: overrides.inActiveProject ?? true,
  };
}

function makeSearchSummary(
  overrides: Partial<CommandPaletteThreadSummary> = {},
): CommandPaletteThreadSummary {
  return {
    backendBinding: overrides.backendBinding ?? { kind: "codex" },
    threadId: overrides.threadId ?? "thr-1",
    sessionId: overrides.sessionId === undefined ? "session-1" : overrides.sessionId,
    projectId: overrides.projectId === undefined ? "project-1" : overrides.projectId,
    projectName: overrides.projectName === undefined ? "Project" : overrides.projectName,
    title: overrides.title ?? "General chat",
    preview: overrides.preview ?? "No matching metadata here.",
    cwd: overrides.cwd ?? "/tmp/project",
    gitBranch: overrides.gitBranch ?? null,
    projectless: overrides.projectless ?? false,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    statusType: overrides.statusType ?? "notLoaded",
    statusActiveFlags: overrides.statusActiveFlags ?? [],
    createdAt: overrides.createdAt ?? 1_781_990_400,
    updatedAt: overrides.updatedAt ?? 1_781_990_400,
  };
}

function makeSearchResult(
  thread: Partial<CommandPaletteThreadSummary>,
  snippet: string,
): CommandPaletteThreadSearchResult {
  return { thread: makeSearchSummary(thread), snippet };
}

function makeSearchBatch(
  query: string,
  results: readonly CommandPaletteThreadSearchResult[],
): CommandPaletteThreadSearchBatch {
  return { query, results, loading: false, error: null };
}

describe("command palette chat result selection", () => {
  test("switches from commands to metadata and then content at the root thresholds", () => {
    expect(getCommandPaletteThreadSearchPlan("root", "a")).toBeNull();
    expect(getCommandPaletteThreadSearchPlan("root", "ab")).toEqual({
      includeContentResults: false,
      maxResults: 9,
    });
    expect(getCommandPaletteThreadSearchPlan("root", "abc")).toEqual({
      includeContentResults: true,
      maxResults: 9,
    });
    expect(getCommandPaletteThreadSearchPlan("chats", "a")).toEqual({
      includeContentResults: true,
      maxResults: 9,
    });
  });

  test("searches projectless and sessionless chats through metadata labels", () => {
    const thread = makeThread({
      threadId: "thr-projectless",
      id: "thread:thr-projectless",
      sessionId: null,
      projectId: null,
      projectName: null,
      projectless: true,
      title: "Inbox research",
    });
    const threads = [thread];

    const results = selectCommandPaletteChatResults({
      query: "chats",
      threads,
      threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
    });

    expect(results[0]?.threadId).toBe("thr-projectless");
    expect(
      results[0]?.searchDecorations?.projectNameSegments?.some((segment) => segment.highlight),
    ).toBe(true);
  });

  test("includes content matches that have not been materialized in Nodex", () => {
    const results = selectCommandPaletteChatResults({
      query: "approval heuristic",
      threads: [],
      threadSearchBatch: makeSearchBatch("approval heuristic", [
        makeSearchResult(
          {
            threadId: "thr-server-only",
            sessionId: null,
            title: "Server-only chat",
            projectId: "project-1",
          },
          "Tune the approval heuristic before merging.",
        ),
      ]),
      activeProjectId: "project-1",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      threadId: "thr-server-only",
      inActiveProject: true,
      searchPreview: { source: "content" },
    });
  });

  test("highlights an exact title match on a server-only chat", () => {
    const results = selectCommandPaletteChatResults({
      query: "server",
      threads: [],
      threadSearchBatch: makeSearchBatch("server", [
        makeSearchResult(
          {
            threadId: "thr-server-title",
            title: "Server-only chat",
          },
          "Server-only chat",
        ),
      ]),
    });

    expect(
      results[0]?.searchDecorations?.titleSegments
        ?.filter((segment) => segment.highlight)
        .map((segment) => segment.text)
        .join(""),
    ).toBe("Server");
  });

  test("prioritizes active-project content hits before applying the result limit", () => {
    const otherProjectThread = makeThread({
      threadId: "thr-other-metadata",
      id: "thread:thr-other-metadata",
      projectId: "project-2",
      projectName: "Other",
      title: "Approval heuristic",
      inActiveProject: false,
      updatedAt: 200,
    });
    const threads = [otherProjectThread];
    const batch = makeSearchBatch("approval heuristic", [
      makeSearchResult(
        {
          threadId: "thr-active-content",
          projectId: "project-1",
          title: "General chat",
          updatedAt: 100,
        },
        "Approval heuristic appears only in the active transcript.",
      ),
    ]);

    const results = selectCommandPaletteChatResults({
      query: "approval heuristic",
      threads,
      threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
      threadSearchBatch: batch,
      threadLimit: 1,
      preferActiveProject: true,
      activeProjectId: "project-1",
    });

    expect(results[0]?.threadId).toBe("thr-active-content");
  });

  test("keeps a stronger metadata preview when content search returns the same chat", () => {
    const thread = makeThread({
      threadId: "thr-preview",
      id: "thread:thr-preview",
      title: "Incident review",
      preview: "Discuss retry budget and queue recovery.",
    });
    const threads = [thread];

    const results = selectCommandPaletteChatResults({
      query: "retry budget",
      threads,
      threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
      threadSearchBatch: makeSearchBatch("retry budget", [
        makeSearchResult({ threadId: "thr-preview" }, "Server retry budget transcript snippet."),
      ]),
    });

    expect(results[0]?.searchPreview?.source).toBe("metadata");
    expect(results[0]?.searchPreview?.excerpt).toContain("Discuss retry budget");
  });

  test("does not merge a stale app-server batch from another query", () => {
    const results = selectCommandPaletteChatResults({
      query: "approval heuristic",
      threads: [],
      threadSearchBatch: makeSearchBatch("queue recovery", [
        makeSearchResult({ threadId: "thr-content" }, "Tune the approval heuristic."),
      ]),
    });

    expect(results).toEqual([]);
  });

  test("uses recency as the deterministic tie-breaker for equal metadata matches", () => {
    const older = makeThread({
      id: "thread:older",
      threadId: "older",
      title: "Release review",
      updatedAt: 10,
    });
    const newer = makeThread({
      id: "thread:newer",
      threadId: "newer",
      title: "Release review",
      updatedAt: 20,
    });
    const threads = [older, newer];

    const results = selectCommandPaletteChatResults({
      query: "release",
      threads,
      threadSearchIndex: createCommandPaletteThreadSearchIndex(threads),
    });

    expect(results.map((thread) => thread.threadId)).toEqual(["newer", "older"]);
  });
});
