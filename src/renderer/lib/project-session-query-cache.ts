import type { QueryClient } from "@tanstack/react-query";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ProjectSession, ProjectSessionSummary, ProjectSessionSummaryWindow } from "./types";
import { projectSessionDetailQueryOptions } from "./query-options";
import { queryKeys } from "./query-keys";
import { invokeRendererQuery } from "./renderer-command";

export { preferNewestProjectSessionSummaryWindow } from "./project-session-summary-window";

export type ProjectSessionSummaryWindowReader = (
  after: string | null,
  first: number,
) => Promise<ProjectSessionSummaryWindow>;

export async function readProjectSessionSummaryWindowThrough({
  previousItemCount,
  projectionRevision,
  read,
}: {
  previousItemCount: number;
  projectionRevision: number;
  read: ProjectSessionSummaryWindowReader;
}): Promise<ProjectSessionSummaryWindow> {
  const requestedItemCount = Math.max(50, previousItemCount);
  let first = await read(null, 50);
  if (first.projectionRevision < projectionRevision) {
    first = await read(null, 50);
  }
  if (first.projectionRevision < projectionRevision) {
    throw new Error("Canonical chat order has not reached the committed revision");
  }

  const items = [...first.items];
  const knownIds = new Set(items.map((item) => item.id));
  let cursor = first.nextCursor;
  let latest = first;
  while (items.length < requestedItemCount && cursor !== null) {
    const next = await read(cursor, Math.min(50, requestedItemCount - items.length));
    for (const item of next.items) {
      if (knownIds.has(item.id)) continue;
      knownIds.add(item.id);
      items.push(item);
    }
    cursor = next.nextCursor;
    latest = next;
  }
  return {
    items,
    nextCursor: cursor,
    hasMore: cursor !== null || latest.hasMore,
    projectionRevision: latest.projectionRevision,
  };
}

export function sortProjectSessionSummariesForSidebar(
  summaries: readonly ProjectSessionSummary[],
): ProjectSessionSummary[] {
  return [...summaries].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    if (left.pinned && right.pinned) {
      const leftPinnedOrder = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
      const rightPinnedOrder = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
      if (leftPinnedOrder !== rightPinnedOrder) return leftPinnedOrder - rightPinnedOrder;
    }
    if (left.order !== right.order) return left.order - right.order;
    return left.createdAt.localeCompare(right.createdAt);
  });
}

export function projectSessionToSummary(session: ProjectSession): ProjectSessionSummary {
  return {
    id: session.id,
    projectId: session.projectId,
    noThreadFallbackTitle: session.noThreadFallbackTitle,
    displayTitle: session.displayTitle,
    order: session.order,
    pinned: session.pinned,
    pinnedOrder: session.pinnedOrder,
    archived: session.archived,
    archivedAt: session.archivedAt,
    unread: session.unread,
    thread: session.thread,
    executionRef: session.executionRef ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

export function getCachedProjectSessionDetail(
  queryClient: QueryClient,
  sessionId: string,
): ProjectSession | null {
  return (
    queryClient.getQueryData<ProjectSession | null>(queryKeys.projectSessions.detail(sessionId)) ??
    null
  );
}

export function setProjectSessionSummaries(
  queryClient: QueryClient,
  projectId: string | null,
  summaries: readonly ProjectSessionSummary[],
): ProjectSessionSummaryWindow {
  for (const summary of summaries) {
    queryClient.setQueryData<ProjectSession | null | undefined>(
      queryKeys.projectSessions.detail(summary.id),
      (current) =>
        current
          ? {
              ...summary,
              thread: summary.thread
                ? current.thread?.threadId === summary.thread.threadId
                  ? { ...current.thread, ...summary.thread }
                  : null
                : null,
            }
          : current,
    );
  }
  const installed = queryClient.setQueryData<ProjectSessionSummaryWindow>(
    queryKeys.projectSessions.summaries(projectId),
    (current) => ({
      items: [...summaries],
      nextCursor: current?.nextCursor ?? null,
      hasMore: current?.hasMore ?? false,
      projectionRevision: current?.projectionRevision ?? 0,
    }),
  );
  return (
    installed ?? {
      items: [...summaries],
      nextCursor: null,
      hasMore: false,
      projectionRevision: 0,
    }
  );
}

export function seedProjectSessionDetail(
  queryClient: QueryClient,
  session: ProjectSession | null | undefined,
): ProjectSession | null | undefined {
  if (!session) return session;

  const installed = queryClient.setQueryData<ProjectSession | null | undefined>(
    queryKeys.projectSessions.detail(session.id),
    session,
  );
  const summary = projectSessionToSummary(session);
  queryClient.setQueryData<ProjectSessionSummaryWindow | undefined>(
    queryKeys.projectSessions.summaries(session.projectId),
    (current) => {
      if (!current) return current;
      const next = current.items.some((candidate) => candidate.id === summary.id)
        ? current.items.map((candidate) => (candidate.id === summary.id ? summary : candidate))
        : [...current.items, summary];
      return {
        ...current,
        items: next,
      };
    },
  );
  return installed;
}

export function seedProjectSessionDetails(
  queryClient: QueryClient,
  sessions: readonly ProjectSession[],
): void {
  for (const session of sessions) {
    seedProjectSessionDetail(queryClient, session);
  }
}

export async function prefetchProjectSessionDetail(
  queryClient: QueryClient,
  sessionId: string,
): Promise<ProjectSession | null> {
  if (sessionId.trim().length === 0) return null;
  return await queryClient.fetchQuery(projectSessionDetailQueryOptions(sessionId));
}

/** Execution routing needs current binding metadata, independent of a cached draft read. */
export async function readCurrentProjectSessionDetail(
  sessionId: string,
): Promise<ProjectSession | null> {
  if (!sessionId.trim()) return null;
  const session = (await invokeRendererQuery(
    "project-sessions:get",
    sessionId,
  )) as ProjectSession | null;
  return session;
}

export async function invalidateProjectSessionScope(
  queryClient: QueryClient,
  event: ProjectSessionsChangeEvent,
): Promise<void> {
  const invalidations: Array<Promise<unknown>> = [];
  invalidations.push(
    queryClient.invalidateQueries({
      queryKey: queryKeys.projectActivity.all(),
    }),
  );
  invalidations.push(
    queryClient.invalidateQueries({
      queryKey: queryKeys.pageChats.all(),
    }),
  );

  for (const scope of event.summaryScopes) {
    if (scope.kind === "all") {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: ["projectSessions", "summaries"],
        }),
      );
      continue;
    }
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectSessions.summaries(
          scope.kind === "project" ? scope.projectId : null,
        ),
        exact: true,
      }),
    );
  }

  if (event.detailInvalidation.kind === "all") {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: ["projectSessions", "detail"],
      }),
    );
    await Promise.all(invalidations);
    return;
  }

  const sessionIds = event.detailInvalidation.sessionIds;
  if (event.changeType === "delete" || event.changeType === "archive") {
    for (const sessionId of sessionIds) {
      queryClient.removeQueries({
        queryKey: queryKeys.projectSessions.detail(sessionId),
        exact: true,
      });
    }
    await Promise.all(invalidations);
    return;
  }

  for (const sessionId of sessionIds) {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectSessions.detail(sessionId),
        exact: true,
      }),
    );
  }
  await Promise.all(invalidations);
}
