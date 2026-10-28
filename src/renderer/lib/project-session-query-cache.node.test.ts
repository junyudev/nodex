import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "vite-plus/test";
import type { ProjectSession, ProjectSessionSummaryWindow } from "./types";
import { queryKeys } from "./query-keys";
import {
  getCachedProjectSessionDetail,
  invalidateProjectSessionScope,
  preferNewestProjectSessionSummaryWindow,
  projectSessionToSummary,
  readProjectSessionSummaryWindowThrough,
  seedProjectSessionDetail,
  setProjectSessionSummaries,
} from "./project-session-query-cache";

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 5 * 60_000,
      },
    },
  });
}

function createSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id: overrides.id ?? "session-1",
    projectId: overrides.projectId === undefined ? "project-1" : overrides.projectId,
    noThreadFallbackTitle: overrides.noThreadFallbackTitle ?? "Session",
    displayTitle: overrides.displayTitle ?? "Session",
    order: overrides.order ?? 0,
    pinned: overrides.pinned ?? false,
    pinnedOrder: overrides.pinnedOrder ?? null,
    archived: overrides.archived ?? false,
    archivedAt: overrides.archivedAt ?? null,
    unread: overrides.unread ?? false,
    thread: overrides.thread ?? null,
    executionRef: overrides.executionRef ?? null,
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-01T00:00:00.000Z",
  };
}

describe("project session query cache", () => {
  test("uses stable summary and detail keys", () => {
    expect(JSON.stringify(queryKeys.projectSessions.summaries("project-1"))).toBe(
      JSON.stringify(["projectSessions", "summaries", "project-1"]),
    );
    expect(JSON.stringify(queryKeys.projectSessions.summaries(null))).toBe(
      JSON.stringify(["projectSessions", "summaries", ""]),
    );
    expect(JSON.stringify(queryKeys.projectSessions.detail("session-1"))).toBe(
      JSON.stringify(["projectSessions", "detail", "session-1"]),
    );
  });

  test("keeps a Runtime binding through detail-to-summary publication without a native Thread", () => {
    const queryClient = createQueryClient();
    const binding = { runtimeId: "runtime:test", threadId: "engine-thread" };
    const session = createSession({ executionRef: binding });
    const summary = projectSessionToSummary(session);
    expect(summary.thread).toBeNull();
    expect(summary.executionRef).toEqual(binding);
    setProjectSessionSummaries(queryClient, session.projectId, [summary]);
    seedProjectSessionDetail(queryClient, session);
    const window = queryClient.getQueryData<ProjectSessionSummaryWindow>(
      queryKeys.projectSessions.summaries(session.projectId),
    );
    expect(window?.items[0]?.executionRef).toEqual(binding);
    expect(getCachedProjectSessionDetail(queryClient, session.id)?.executionRef).toEqual(binding);
    queryClient.clear();
  });

  test("seeds and reads session detail", () => {
    const queryClient = createQueryClient();
    const session = createSession();

    seedProjectSessionDetail(queryClient, session);

    expect(getCachedProjectSessionDetail(queryClient, "session-1")).toBe(session);
    queryClient.clear();
  });

  test("seeding detail updates cached summary-visible fields", () => {
    const queryClient = createQueryClient();
    const initial = createSession({ displayTitle: "Old title", unread: true });
    const updated = createSession({
      displayTitle: "New title",
      unread: false,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    setProjectSessionSummaries(queryClient, "project-1", [projectSessionToSummary(initial)]);

    seedProjectSessionDetail(queryClient, updated);

    const window = queryClient.getQueryData<ProjectSessionSummaryWindow>(
      queryKeys.projectSessions.summaries("project-1"),
    );
    const summary = window?.items[0] ?? null;
    expect(summary?.displayTitle).toBe("New title");
    expect(summary?.unread).toBe(false);
    expect(summary?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    queryClient.clear();
  });

  test("preserves canonical TaskWindow order while seeding detail changes", () => {
    const queryClient = createQueryClient();
    const first = createSession({ id: "session-first", order: 10 });
    const second = createSession({ id: "session-second", order: 0 });
    setProjectSessionSummaries(queryClient, "project-1", [
      projectSessionToSummary(first),
      projectSessionToSummary(second),
    ]);

    seedProjectSessionDetail(queryClient, {
      ...first,
      displayTitle: "Updated first",
      order: 20,
    });

    const window = queryClient.getQueryData<ProjectSessionSummaryWindow>(
      queryKeys.projectSessions.summaries("project-1"),
    );
    expect(window?.items.map((item) => item.id)).toEqual(["session-first", "session-second"]);
    queryClient.clear();
  });

  test("keeps the canonical revision and pagination extent during a local summary patch", () => {
    const queryClient = createQueryClient();
    const summary = projectSessionToSummary(createSession());
    queryClient.setQueryData<ProjectSessionSummaryWindow>(
      queryKeys.projectSessions.summaries("project-1"),
      {
        items: [summary],
        nextCursor: "cursor:one",
        hasMore: true,
        projectionRevision: 12,
      },
    );

    setProjectSessionSummaries(queryClient, "project-1", [
      {
        ...summary,
        unread: true,
      },
    ]);

    expect(
      queryClient.getQueryData<ProjectSessionSummaryWindow>(
        queryKeys.projectSessions.summaries("project-1"),
      ),
    ).toEqual({
      items: [{ ...summary, unread: true }],
      nextCursor: "cursor:one",
      hasMore: true,
      projectionRevision: 12,
    });
    queryClient.clear();
  });

  test("reads through the committed projection revision and preserves the loaded window", async () => {
    const canonical = Array.from({ length: 51 }, (_, index) =>
      projectSessionToSummary(createSession({ id: `session-${index}` })),
    );
    const reads: Array<{ after: string | null; first: number }> = [];
    let firstPageReads = 0;

    const window = await readProjectSessionSummaryWindowThrough({
      previousItemCount: 51,
      projectionRevision: 10,
      read: async (after, first) => {
        reads.push({ after, first });
        if (after === null) {
          firstPageReads += 1;
          if (firstPageReads === 1) {
            return {
              items: canonical.slice(0, 50),
              nextCursor: "cursor:50",
              hasMore: true,
              projectionRevision: 9,
            };
          }
          return {
            items: canonical.slice(0, 50),
            nextCursor: "cursor:50",
            hasMore: true,
            projectionRevision: 10,
          };
        }
        return {
          items: canonical.slice(50),
          nextCursor: null,
          hasMore: false,
          projectionRevision: 10,
        };
      },
    });

    expect(reads).toEqual([
      { after: null, first: 50 },
      { after: null, first: 50 },
      { after: "cursor:50", first: 1 },
    ]);
    expect(window.items.map((item) => item.id)).toEqual(canonical.map((item) => item.id));
    expect(window.projectionRevision).toBe(10);
  });

  test("rejects a late older projection instead of rolling canonical order back", () => {
    const newer = {
      items: [projectSessionToSummary(createSession({ id: "newer" }))],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 11,
    } satisfies ProjectSessionSummaryWindow;
    const older = {
      items: [projectSessionToSummary(createSession({ id: "older" }))],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 10,
    } satisfies ProjectSessionSummaryWindow;

    expect(preferNewestProjectSessionSummaryWindow(newer, older)).toBe(newer);
  });

  test("keeps the larger loaded extent when a same-revision first page finishes late", () => {
    const first = projectSessionToSummary(createSession({ id: "first" }));
    const second = projectSessionToSummary(createSession({ id: "second" }));
    const loaded = {
      items: [first, second],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 11,
    } satisfies ProjectSessionSummaryWindow;
    const lateFirstPage = {
      items: [first],
      nextCursor: "cursor:1",
      hasMore: true,
      projectionRevision: 11,
    } satisfies ProjectSessionSummaryWindow;

    expect(preferNewestProjectSessionSummaryWindow(loaded, lateFirstPage)).toBe(loaded);

    const terminalRefresh = {
      items: [first],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 11,
    } satisfies ProjectSessionSummaryWindow;
    expect(preferNewestProjectSessionSummaryWindow(loaded, terminalRefresh)).toBe(terminalRefresh);
  });

  test("summary refresh replaces the identical domain detail shape", () => {
    const queryClient = createQueryClient();
    const detail = createSession({ displayTitle: "Stale title", order: 7 });
    seedProjectSessionDetail(queryClient, detail);
    const summary = projectSessionToSummary(
      createSession({
        displayTitle: "Current title",
        order: 2,
        updatedAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    setProjectSessionSummaries(queryClient, "project-1", [summary]);

    const cached = getCachedProjectSessionDetail(queryClient, detail.id);
    expect(cached?.displayTitle).toBe("Current title");
    expect(cached?.order).toBe(2);
    expect(cached).toEqual(summary);
    queryClient.clear();
  });

  test("archive and delete events evict cached detail", async () => {
    const queryClient = createQueryClient();
    const session = createSession();
    seedProjectSessionDetail(queryClient, session);

    await invalidateProjectSessionScope(queryClient, {
      summaryScopes: [{ kind: "project", projectId: "project-1" }],
      detailInvalidation: { kind: "sessions", sessionIds: ["session-1"] },
      changeType: "archive",
    });

    expect(getCachedProjectSessionDetail(queryClient, "session-1")).toBe(null);

    seedProjectSessionDetail(queryClient, session);
    await invalidateProjectSessionScope(queryClient, {
      summaryScopes: [{ kind: "project", projectId: "project-1" }],
      detailInvalidation: { kind: "sessions", sessionIds: ["session-1"] },
      changeType: "delete",
    });

    expect(getCachedProjectSessionDetail(queryClient, "session-1")).toBe(null);
    queryClient.clear();
  });

  test("full resync invalidates every cached session detail", async () => {
    const queryClient = createQueryClient();
    seedProjectSessionDetail(queryClient, createSession({ id: "session-1" }));
    seedProjectSessionDetail(queryClient, createSession({ id: "session-2" }));

    await invalidateProjectSessionScope(queryClient, {
      summaryScopes: [{ kind: "all" }],
      detailInvalidation: { kind: "all" },
      changeType: "update",
    });

    expect(
      queryClient.getQueryState(queryKeys.projectSessions.detail("session-1"))?.isInvalidated,
    ).toBe(true);
    expect(
      queryClient.getQueryState(queryKeys.projectSessions.detail("session-2"))?.isInvalidated,
    ).toBe(true);
    queryClient.clear();
  });

  test("session changes invalidate complete Project activity aggregates", async () => {
    const queryClient = createQueryClient();
    const activityKey = queryKeys.projectActivity.summaries(["project-2", "project-1"]);
    queryClient.setQueryData(activityKey, []);

    await invalidateProjectSessionScope(queryClient, {
      summaryScopes: [{ kind: "project", projectId: "project-1" }],
      detailInvalidation: { kind: "sessions", sessionIds: ["session-1"] },
      changeType: "update",
    });

    expect(queryClient.getQueryState(activityKey)?.isInvalidated).toBe(true);
    queryClient.clear();
  });

  test("session changes invalidate Page Chat projections without touching Database rows", async () => {
    const queryClient = createQueryClient();
    const pageChatKey = queryKeys.pageChats.activity(["page-1"]);
    const databaseKey = queryKeys.boards.byProject("project-1");
    queryClient.setQueryData(pageChatKey, { summaries: [], projectionRevision: 1 });
    queryClient.setQueryData(databaseKey, { rows: [] });

    await invalidateProjectSessionScope(queryClient, {
      summaryScopes: [{ kind: "project", projectId: "project-1" }],
      detailInvalidation: { kind: "sessions", sessionIds: ["session-1"] },
      changeType: "update",
    });

    expect(queryClient.getQueryState(pageChatKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(databaseKey)?.isInvalidated).toBe(false);
    queryClient.clear();
  });
});
