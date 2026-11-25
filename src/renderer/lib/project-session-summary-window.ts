import { replaceEqualDeep, type QueryClient, type QueryKey } from "@tanstack/query-core";
import type { ProjectSessionSummary, ProjectSessionSummaryWindow } from "./types";

const PAGE_SIZE = 50;

export type ProjectSessionSummaryWindowReader = (
  after: string | null,
  first: number,
) => Promise<ProjectSessionSummaryWindow>;

export function normalizeProjectSessionSummaryQuery(query?: string | null): string | undefined {
  return query?.trim() || undefined;
}

/**
 * Canonical windows are monotonic by projection revision and, within one
 * revision, by loaded extent. A background first-page request must not trim
 * pages that the user has already loaded from the same snapshot.
 */
export function preferNewestProjectSessionSummaryWindow(
  current: ProjectSessionSummaryWindow | undefined,
  incoming: ProjectSessionSummaryWindow,
): ProjectSessionSummaryWindow {
  if (!current) return incoming;
  if (current.projectionRevision > incoming.projectionRevision) {
    return current;
  }
  if (
    current.projectionRevision === incoming.projectionRevision &&
    current.items.length > incoming.items.length &&
    current.nextCursor !== incoming.nextCursor &&
    (incoming.hasMore || incoming.nextCursor !== null)
  ) {
    return current;
  }
  return incoming;
}

/** Apply revision and extent ordering when the query actually writes to the cache. */
export function shareProjectSessionSummaryWindow(
  previous: unknown,
  data: unknown,
): ProjectSessionSummaryWindow {
  const current = previous as ProjectSessionSummaryWindow | undefined;
  const incoming = data as ProjectSessionSummaryWindow;
  return replaceEqualDeep(current, preferNewestProjectSessionSummaryWindow(current, incoming));
}

function addUniqueSummaries(
  items: ProjectSessionSummary[],
  ids: Set<string>,
  incoming: readonly ProjectSessionSummary[],
): void {
  for (const item of incoming) {
    if (ids.has(item.id)) continue;
    ids.add(item.id);
    items.push(item);
  }
}

export function appendProjectSessionSummaryWindow(
  current: ProjectSessionSummaryWindow | undefined,
  after: string,
  next: ProjectSessionSummaryWindow,
): ProjectSessionSummaryWindow | undefined {
  if (!current || current.nextCursor !== after) return current;
  const items = [...current.items];
  addUniqueSummaries(items, new Set(items.map((item) => item.id)), next.items);
  return {
    ...next,
    items,
    totalCount:
      next.projectionRevision >= current.projectionRevision ? next.totalCount : current.totalCount,
    projectionRevision: Math.max(current.projectionRevision, next.projectionRevision),
  };
}

export async function loadNextProjectSessionSummaryWindow(
  queryClient: QueryClient,
  queryKey: QueryKey,
  read: ProjectSessionSummaryWindowReader,
): Promise<void> {
  const after = queryClient.getQueryData<ProjectSessionSummaryWindow>(queryKey)?.nextCursor;
  if (!after) return;
  const next = await read(after, PAGE_SIZE);
  queryClient.setQueryData<ProjectSessionSummaryWindow>(queryKey, (current) => {
    const appended = appendProjectSessionSummaryWindow(current, after, next);
    return appended === current ? undefined : appended;
  });
}

/** Rebuild from the head through the visible depth, even when a page hits Core's byte budget. */
export async function readProjectSessionSummaryWindowThrough({
  previousItemCount,
  projectionRevision = 0,
  read,
  signal,
}: {
  previousItemCount: () => number;
  projectionRevision?: number;
  read: ProjectSessionSummaryWindowReader;
  signal?: AbortSignal;
}): Promise<ProjectSessionSummaryWindow> {
  let first = await read(null, PAGE_SIZE);
  signal?.throwIfAborted();
  if (first.projectionRevision < projectionRevision) {
    first = await read(null, PAGE_SIZE);
    signal?.throwIfAborted();
  }
  if (first.projectionRevision < projectionRevision) {
    throw new Error("Canonical chat order has not reached the committed revision");
  }

  const items = [...first.items];
  const knownIds = new Set(items.map((item) => item.id));
  let latest = first;
  while (items.length < previousItemCount() && latest.nextCursor !== null) {
    latest = await read(latest.nextCursor, PAGE_SIZE);
    signal?.throwIfAborted();
    addUniqueSummaries(items, knownIds, latest.items);
  }

  return {
    ...latest,
    items,
    // The head determines freshness. Later pages may have seen unrelated commits.
    projectionRevision: first.projectionRevision,
  };
}
