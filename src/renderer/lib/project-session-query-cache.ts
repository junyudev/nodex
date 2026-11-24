import type { QueryClient } from "@tanstack/react-query";
import type { ProjectSessionsChangeEvent } from "../../shared/ipc-api";
import type { ConversationIdentity } from "../../shared/conversation-identity";
import type {
  ProjectSession,
  ProjectSessionSummary,
  ProjectSessionSummaryWindow,
  SessionSideChatWindow,
  SessionSideChatWindowInput,
} from "./types";
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
    return right.activityAt - left.activityAt || left.id.localeCompare(right.id);
  });
}

export function projectSessionToSummary(session: ProjectSession): ProjectSessionSummary {
  return {
    id: session.id,
    projectId: session.projectId,
    noThreadFallbackTitle: session.noThreadFallbackTitle,
    displayTitle: session.displayTitle,
    activityAt: session.activityAt,
    pinned: session.pinned,
    managed: session.managed,
    pinnedOrder: session.pinnedOrder,
    archived: session.archived,
    archivedAt: session.archivedAt,
    unread: session.unread,
    snoozedUntil: session.snoozedUntil,
    snoozedAt: session.snoozedAt ?? null,
    wokeAt: session.wokeAt ?? null,
    pageTurn: session.pageTurn,
    settledAt: session.settledAt ?? null,
    ...(session.attentionAt === undefined ? {} : { attentionAt: session.attentionAt }),
    canManage: session.canManage,
    canStop: session.canStop,
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

/**
 * Shows a chat's settlement, or its removal, in every chat list at once, before Core confirms it.
 * A settled chat leaves the lists of open chats and heads the settled ones; a reopened chat leaves
 * the settled ones, and the lists of open chats read its place back from Core. Returns the undo.
 */
export function applyProjectSessionSettled(
  queryClient: QueryClient,
  sessionIds: readonly string[],
  settledAt: number | null,
): () => void {
  const ids = new Set(sessionIds);
  const settled = settledAt !== null;
  const patch = {
    settledAt,
    ...(settled
      ? {
          pinned: false,
          pinnedOrder: null,
          snoozedUntil: null,
          snoozedAt: null,
          wokeAt: null,
          unread: false,
        }
      : {}),
  };
  const shouldChange = (session: ProjectSessionSummary) =>
    ids.has(session.id) && !session.archived && (session.settledAt != null) !== settled;
  const projectRoot = [...queryKeys.projectSessions.all(), "summaries"];
  const groups = [
    { prefix: projectRoot, wholeLibraryKey: false },
    { prefix: queryKeys.projectSessions.librarySummariesAll(), wholeLibraryKey: true },
  ];
  const lists = groups.flatMap(({ prefix, wholeLibraryKey }) =>
    queryClient
      .getQueriesData<ProjectSessionSummaryWindow>({ queryKey: prefix })
      .map(([key, window]) => ({ key, window, scope: key[prefix.length], wholeLibraryKey })),
  );
  const changes = new Map<string, ProjectSessionSummary>();
  for (const { window } of lists) {
    for (const summary of window?.items ?? []) {
      if (shouldChange(summary)) changes.set(summary.id, { ...summary, ...patch });
    }
  }
  const rollback: Array<() => void> = [];
  for (const id of ids) {
    const key = queryKeys.projectSessions.detail(id);
    const detail = queryClient.getQueryData<ProjectSession>(key);
    if (!detail || !shouldChange(detail)) continue;
    changes.set(id, { ...projectSessionToSummary(detail), ...patch });
    const installed = queryClient.setQueryData(key, { ...detail, ...patch });
    rollback.push(() => {
      queryClient.setQueryData<ProjectSession>(key, (current) =>
        current === installed ? detail : current,
      );
    });
  }
  const changedSummaries = sessionIds.flatMap((id) => {
    const summary = changes.get(id);
    return summary ? [summary] : [];
  });
  for (const { key, window, scope, wholeLibraryKey } of lists) {
    if (!window) continue;
    const lifecycle = key.at(-1);
    const inScope = (item: ProjectSessionSummary) =>
      wholeLibraryKey
        ? scope === null || scope === item.projectId
        : scope === (item.projectId ?? "");
    const items = window.items.flatMap((item) => {
      if (!changes.has(item.id)) return [item];
      if ((lifecycle === "open" && settled) || (lifecycle === "settled" && !settled)) return [];
      return [{ ...item, ...patch }];
    });
    if (lifecycle === "settled" && settled) {
      const known = new Set(items.map((item) => item.id));
      items.unshift(...changedSummaries.filter((item) => inScope(item) && !known.has(item.id)));
    }
    if (
      items.length === window.items.length &&
      items.every((item, index) => item === window.items[index])
    )
      continue;
    const installed = queryClient.setQueryData(key, { ...window, items });
    rollback.push(() => {
      queryClient.setQueryData<ProjectSessionSummaryWindow>(key, (current) =>
        current === installed ? window : current,
      );
    });
  }
  return () => {
    for (const undo of rollback) undo();
  };
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

/** Read one bounded page; use nextCursor to continue the source's attached chats. */
export function listSessionSideChats(
  sourceSessionId: string,
  input?: SessionSideChatWindowInput,
): Promise<SessionSideChatWindow> {
  return invokeRendererQuery("project-sessions:side-chats", sourceSessionId, input);
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

  // A side chat's creation, rename, or deletion lists under its source, which no scope names.
  // The whole Library's lists hold every scope's chats.
  if (event.summaryScopes.length > 0)
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.projectSessions.all(), "sideChats"],
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectSessions.librarySummariesAll(),
      }),
    );
  for (const scope of event.summaryScopes) {
    if (scope.kind === "all") {
      invalidations.push(
        queryClient.invalidateQueries({
          queryKey: [...queryKeys.projectSessions.all(), "summaries"],
        }),
      );
      continue;
    }
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: [
          ...queryKeys.projectSessions.all(),
          "summaries",
          scope.kind === "project" ? scope.projectId : "",
        ],
      }),
    );
  }

  // A renamed, archived or deleted chat updates every reference that names it.
  const named =
    event.detailInvalidation.kind === "all" ? null : event.detailInvalidation.sessionIds;
  invalidations.push(
    queryClient.invalidateQueries({
      queryKey: queryKeys.conversationIdentity.all(),
      predicate: (query) => {
        const identity = query.state.data as ConversationIdentity | null | undefined;
        return !named || !identity?.sessionId || named.includes(identity.sessionId);
      },
    }),
  );

  // What a chat's reader may do follows Core's chat: a Run that Core has since attributed to its
  // Member, or a message another Member sent, changes which messages are theirs to edit and
  // which work they may stop, while the Runs the reader names stay the same.
  if (event.detailInvalidation.kind === "all") {
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.projectSessions.all(), "detail"],
      }),
      queryClient.invalidateQueries({
        queryKey: [...queryKeys.projectSessions.all(), "start"],
      }),
      queryClient.invalidateQueries({ queryKey: queryKeys.agentRuntime.memberActionsAll() }),
    );
    await Promise.all(invalidations);
    return;
  }

  const sessionIds = event.detailInvalidation.sessionIds;
  for (const sessionId of sessionIds)
    invalidations.push(
      queryClient.invalidateQueries({
        queryKey: queryKeys.agentRuntime.memberActionsOf(sessionId),
      }),
    );
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
      queryClient.invalidateQueries({
        queryKey: queryKeys.projectSessions.start(sessionId),
        exact: true,
      }),
    );
  }
  await Promise.all(invalidations);
}
