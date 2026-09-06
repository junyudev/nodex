import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentAccessContext } from "../../../shared/content-access-context";
import type { WorkbenchDbViewSurfaceConfig } from "../../../shared/workbench-scene";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type {
  DatabaseViewGroupScopeInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewWindowSnapshot,
} from "../../../shared/database-views";
import {
  commitPageLifecycleIntent,
  readDatabaseViewGroups,
  readDatabaseViewWindow,
  readLibraryDatabaseViewGroups,
  readLibraryDatabaseViewWindow,
} from "../../lib/api";
import {
  buildDatabaseViewWindowRenderModel,
  groupScopeKeyForPath,
  UNGROUPED_SCOPE_KEY,
} from "../../lib/database-view-render-model";
import type { ColumnPaginationState } from "../../lib/board-store";
import { invalidateExactQuery, projectionCursorForSnapshots } from "../../lib/query-invalidation";
import { mapWithConcurrency } from "../../lib/map-with-concurrency";
import { queryKeys } from "../../lib/query-keys";
import { useProjectionRegistration } from "../../lib/projection-invalidation-context";
import type { ProjectionInvalidationCause } from "../../lib/projection-invalidation-registry";
import {
  admitResourceAuthorityQuery,
  resourceAuthorityQueryMeta,
} from "../../lib/resource-authority-query-cache";
import { DatabaseViewTabSurface } from "./workbench-db-view-panel";
import type { Project } from "@/lib/types";
import type { OpenPageInNewChatInput, SendPageToChatInput } from "@/lib/page-chat-actions";
import { useDatabaseViewMutationHistory } from "./database-view-mutation-history";
import type { DatabaseViewPageActionPort } from "./database-view-page-actions";
import type { DatabaseViewPageOpenHandler } from "./database-view-page-open";

type DatabaseReadTarget = { readonly databaseViewId: string } | { readonly databaseId: string };

type DatabaseSurfaceTarget = Exclude<
  WorkbenchDbViewSurfaceConfig["target"],
  { readonly kind: "project-default" }
>;

interface ScopedWindow {
  readonly scopeKey: string;
  readonly scope?: DatabaseViewGroupScopeInput;
  readonly snapshot: DatabaseViewWindowSnapshot<string | null>;
}

const GROUP_WINDOW_READ_CONCURRENCY = 8;

const resolveDatabaseSurfaceAuthority = (_queryKey: readonly unknown[], data: unknown) => {
  const snapshot = data as
    | {
        readonly groups: DatabaseViewGroupsSnapshot<string | null>;
        readonly scopedWindows: readonly ScopedWindow[];
      }
    | undefined;
  return snapshot
    ? {
        authorizations: [
          snapshot.groups.authorization,
          ...snapshot.scopedWindows.map((window) => window.snapshot.authorization),
        ],
      }
    : null;
};

interface ContinuationState {
  readonly windows: readonly DatabaseViewWindowSnapshot<string | null>[];
  readonly loading: boolean;
  readonly error: string | null;
}

const readDatabaseWindowForContext = async (
  accessContext: ContentAccessContext,
  target: DatabaseReadTarget,
  input: {
    readonly after?: string;
    readonly groupScope?: DatabaseViewGroupScopeInput;
    readonly minimumCommitSeq?: number;
  } = {},
): Promise<DatabaseViewWindowSnapshot<string | null>> => {
  if (accessContext.kind === "project") {
    return await readDatabaseViewWindow(accessContext.projectId, {
      ...target,
      ...input,
      first: 50,
    });
  }
  return await readLibraryDatabaseViewWindow({
    ...target,
    ...input,
    first: 50,
  });
};

const readDatabaseGroupsForContext = async (
  accessContext: ContentAccessContext,
  target: DatabaseReadTarget,
  minimumCommitSeq = 0,
): Promise<DatabaseViewGroupsSnapshot<string | null>> => {
  if (accessContext.kind === "project") {
    return await readDatabaseViewGroups(accessContext.projectId, {
      ...target,
      ...(minimumCommitSeq > 0 ? { minimumCommitSeq } : {}),
    });
  }
  return await readLibraryDatabaseViewGroups({
    ...target,
    ...(minimumCommitSeq > 0 ? { minimumCommitSeq } : {}),
  });
};

const readTargetFromIdentity = (identity: string): DatabaseReadTarget => {
  if (identity.startsWith("database:")) {
    return { databaseId: identity.slice("database:".length) };
  }
  return { databaseViewId: identity.slice("view:".length) };
};

const scopesFromGroups = (
  groups: DatabaseViewGroupsSnapshot<string | null>,
): readonly Omit<ScopedWindow, "snapshot">[] => {
  if (groups.truncated) return [{ scopeKey: UNGROUPED_SCOPE_KEY }];
  if (!groups.grouped) return [{ scopeKey: UNGROUPED_SCOPE_KEY }];
  if (groups.groups.length === 0) return [{ scopeKey: UNGROUPED_SCOPE_KEY }];
  return groups.groups.map((group) => ({
    scopeKey: groupScopeKeyForPath(group.groupKey, group.subgroupKey),
    scope: {
      kind: "path",
      groupKey: group.groupKey,
      subgroupKey: group.subgroupKey,
    },
  }));
};

const uniqueBy = <Value, Key>(
  values: readonly Value[],
  keyOf: (value: Value) => Key,
): readonly Value[] => {
  const keys = new Set<Key>();
  return values.filter((value) => {
    const key = keyOf(value);
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
};

const mergeWindows = (
  windows: readonly DatabaseViewWindowSnapshot<string | null>[],
): DatabaseViewWindowSnapshot<string | null> | undefined => {
  const first = windows[0];
  if (!first) return undefined;
  return {
    ...first,
    commitSeq: Math.min(...windows.map((window) => window.commitSeq)),
    nextCursor: null,
    rows: uniqueBy(
      windows.flatMap((window) => window.rows),
      (row) => row.page.id,
    ),
    query: {
      ...first.query,
      rows: uniqueBy(
        windows.flatMap((window) => window.query.rows),
        (row) => row.page.pageId,
      ),
    },
  };
};

export function WorkbenchDatabaseViewSurface({
  accessContext,
  target,
  onOpenPage,
  onPresentationChange,
  keyboardSurface,
  presentedPageIds,
  onOpenPageInNewChat,
  onOpenRelatedChat,
  onSendPageToChat,
}: {
  readonly accessContext: ContentAccessContext;
  readonly target: DatabaseSurfaceTarget;
  readonly onOpenPage: DatabaseViewPageOpenHandler;
  readonly onPresentationChange?: (presentation: {
    readonly databaseName: string;
    readonly viewName: string;
  }) => void;
  readonly keyboardSurface?: {
    readonly surfaceId: string;
    readonly presentationId: string;
  };
  readonly presentedPageIds?: ReadonlySet<string>;
  readonly projects?: Project[];
  readonly pageStageCloseRef?: RefObject<(() => Promise<void>) | null>;
  readonly onOpenPageInNewChat?: (input: OpenPageInNewChatInput) => Promise<void> | void;
  readonly onOpenRelatedChat?: (sessionId: string) => Promise<void> | void;
  readonly onSendPageToChat?: (input: SendPageToChatInput) => Promise<void> | void;
}) {
  const queryClient = useQueryClient();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inFlightScopesRef = useRef(new Set<string>());
  const requiredMinimumCommitSeqRef = useRef(0);
  const revocationRepairRef = useRef<Promise<void> | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [continuations, setContinuations] = useState<ReadonlyMap<string, ContinuationState>>(
    new Map(),
  );
  const accessProjectId = accessContext.kind === "project" ? accessContext.projectId : undefined;
  const targetIdentity =
    target.kind === "database-default"
      ? `database:${target.databaseId}`
      : `view:${target.databaseViewId}`;
  const queryKey = useMemo(
    () => queryKeys.libraryDatabases.view(accessProjectId, targetIdentity),
    [accessProjectId, targetIdentity],
  );
  // The floor is a monotonic read barrier, not semantic query identity.
  // Keeping it out of the key prevents one cache entry per LocalCommit while
  // invalidation still updates the barrier before refetching this entry.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const readTarget = readTargetFromIdentity(targetIdentity);
      const minimumCommitSeq = requiredMinimumCommitSeqRef.current;
      const readContext: ContentAccessContext = accessProjectId
        ? { kind: "project", projectId: accessProjectId }
        : { kind: "library" };
      const groups = await readDatabaseGroupsForContext(readContext, readTarget, minimumCommitSeq);
      const scopedWindows = await mapWithConcurrency(
        scopesFromGroups(groups),
        GROUP_WINDOW_READ_CONCURRENCY,
        async (scope): Promise<ScopedWindow> => ({
          ...scope,
          snapshot: await readDatabaseWindowForContext(readContext, readTarget, {
            ...(scope.scope ? { groupScope: scope.scope } : {}),
            ...(minimumCommitSeq > 0 ? { minimumCommitSeq } : {}),
          }),
        }),
      );
      return await admitResourceAuthorityQuery(
        { groups, scopedWindows },
        resolveDatabaseSurfaceAuthority,
      );
    },
    meta: resourceAuthorityQueryMeta(resolveDatabaseSurfaceAuthority),
  });

  useEffect(() => {
    setContinuations(new Map());
    inFlightScopesRef.current.clear();
  }, [query.dataUpdatedAt]);

  useEffect(() => {
    setSearchQuery("");
    setSearchOpen(false);
  }, [targetIdentity]);

  const windowsByScope = useMemo(
    () =>
      new Map(
        (query.data?.scopedWindows ?? []).map((base) => [
          base.scopeKey,
          [base.snapshot, ...(continuations.get(base.scopeKey)?.windows ?? [])],
        ]),
      ),
    [continuations, query.data?.scopedWindows],
  );
  const mergedWindow = useMemo(
    () => mergeWindows([...windowsByScope.values()].flat()),
    [windowsByScope],
  );
  const model = useMemo(
    () => (mergedWindow ? buildDatabaseViewWindowRenderModel(mergedWindow) : undefined),
    [mergedWindow],
  );
  const mutationHistory = useDatabaseViewMutationHistory(model);
  useEffect(() => {
    if (!model) return;
    onPresentationChange?.({
      databaseName: model.databaseName,
      viewName: model.viewName,
    });
  }, [model, onPresentationChange]);
  const groupTotals = useMemo(
    () =>
      new Map(
        (query.data?.groups.groups ?? []).map((group) => [
          groupScopeKeyForPath(group.groupKey, group.subgroupKey),
          group.totalRows,
        ]),
      ),
    [query.data?.groups.groups],
  );
  const groupPagination = useMemo<ReadonlyMap<string, ColumnPaginationState>>(
    () =>
      new Map(
        (query.data?.scopedWindows ?? []).map((base) => {
          const windows = windowsByScope.get(base.scopeKey) ?? [base.snapshot];
          const current = continuations.get(base.scopeKey);
          const loadedRows = uniqueBy(
            windows.flatMap((window) => window.query.rows),
            (row) => row.page.pageId,
          ).length;
          const totalRows = query.data?.groups.grouped
            ? (groupTotals.get(base.scopeKey) ?? loadedRows)
            : (query.data?.groups.totalRows ?? loadedRows);
          return [
            base.scopeKey,
            {
              scopeKey: base.scopeKey,
              loadedRows,
              totalRows,
              hasMore: windows.at(-1)?.nextCursor !== null,
              loadingMore: current?.loading ?? false,
              error: current?.error ?? null,
            },
          ];
        }),
      ),
    [continuations, groupTotals, query.data, windowsByScope],
  );

  const authority = mergedWindow;
  useProjectionRegistration(
    authority
      ? {
          scope: accessProjectId
            ? {
                kind: "project",
                libraryId: authority.libraryId,
                projectId: accessProjectId,
              }
            : { kind: "library", libraryId: authority.libraryId },
          consumerKey: hashKey(["projection", queryKey]),
          getDependencies: () => ({
            databaseIds: [authority.query.database.databaseId],
            dataSourceIds: [authority.query.dataSource.dataSourceId],
            viewIds: [authority.query.view.viewId],
            pageIds: authority.query.rows.map((row) => row.page.pageId),
          }),
          getCursor: () => {
            const current = queryClient.getQueryData<{
              readonly groups: DatabaseViewGroupsSnapshot<string | null>;
              readonly scopedWindows: readonly ScopedWindow[];
            }>(queryKey);
            if (!current) return null;
            return projectionCursorForSnapshots([
              current.groups,
              ...current.scopedWindows.map((window) => window.snapshot),
            ]);
          },
          revoke: (cause) => {
            requiredMinimumCommitSeqRef.current = Math.max(
              requiredMinimumCommitSeqRef.current,
              cause.stream.commitSeq,
            );
            revocationRepairRef.current = queryClient.resetQueries({
              queryKey,
              exact: true,
            });
          },
          invalidate: async (cause: ProjectionInvalidationCause) => {
            requiredMinimumCommitSeqRef.current = Math.max(
              requiredMinimumCommitSeqRef.current,
              cause.stream.commitSeq,
            );
            if (cause.kind === "revocation") {
              await revocationRepairRef.current;
              revocationRepairRef.current = null;
              return;
            }
            await invalidateExactQuery(queryClient, queryKey);
          },
        }
      : null,
  );

  const loadMoreGroup = async (scopeKey: string): Promise<void> => {
    if (inFlightScopesRef.current.has(scopeKey)) return;
    const base = query.data?.scopedWindows.find((candidate) => candidate.scopeKey === scopeKey);
    if (!base) return;
    const current = continuations.get(scopeKey);
    const windows = [base.snapshot, ...(current?.windows ?? [])];
    const cursor = windows.at(-1)?.nextCursor;
    if (!cursor) return;
    const readTarget = readTargetFromIdentity(targetIdentity);

    inFlightScopesRef.current.add(scopeKey);
    setContinuations((states) =>
      new Map(states).set(scopeKey, {
        windows: current?.windows ?? [],
        loading: true,
        error: null,
      }),
    );
    try {
      const next = await readDatabaseWindowForContext(accessContext, readTarget, {
        after: cursor,
        ...(base.scope ? { groupScope: base.scope } : {}),
      });
      setContinuations((states) =>
        new Map(states).set(scopeKey, {
          windows: [...(states.get(scopeKey)?.windows ?? []), next],
          loading: false,
          error: null,
        }),
      );
    } catch (error) {
      console.error("[database-view:continuation]", error);
      setContinuations((states) =>
        new Map(states).set(scopeKey, {
          windows: states.get(scopeKey)?.windows ?? [],
          loading: false,
          error: "Couldn’t load more pages",
        }),
      );
    } finally {
      inFlightScopesRef.current.delete(scopeKey);
    }
  };

  const openSearch = (selectQuery = false) => {
    setSearchOpen(true);
    requestAnimationFrame(() => {
      const input = searchInputRef.current;
      input?.focus();
      if (selectQuery) input?.select();
    });
  };
  const searchShortcutLabel =
    typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC")
      ? "⌘F"
      : "Ctrl+F";

  useEffect(() => {
    if (!query.error) return;
    console.error("[database-view:read]", query.error);
  }, [query.error]);

  const pageActionPort: DatabaseViewPageActionPort | undefined = accessProjectId
    ? {
        ...(onOpenPageInNewChat ? { openInNewChat: onOpenPageInNewChat } : {}),
        ...(onOpenRelatedChat ? { openRelatedChat: onOpenRelatedChat } : {}),
        ...(onSendPageToChat ? { sendToChat: onSendPageToChat } : {}),
        deletePage: async ({ pageId }) => {
          const committed = await commitPageLifecycleIntent({
            kind: "delete",
            projectId: accessProjectId,
            pageId,
            operationId: createUuidV7(),
          });
          if (committed.receipt.lifecycle !== "deleted") {
            throw new Error(`Page ${pageId} delete did not commit`);
          }
          await query.refetch();
        },
      }
    : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <div className="flex min-h-0 flex-1 flex-col">
        {query.error && model ? (
          <div
            role="alert"
            className="mx-3 mt-2 flex min-h-8 items-center gap-2 rounded-md bg-token-error-background/20 px-2.5 text-xs text-token-error-foreground"
          >
            <span className="min-w-0 flex-1 truncate">Couldn’t refresh this database</span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-token-text-primary hover:bg-token-foreground/5"
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : null}
        {query.data?.groups.truncated ? (
          <DatabaseViewGroupLimitNotice
            totalGroups={query.data.groups.totalGroups}
            groupLimit={query.data.groups.groupLimit}
          />
        ) : null}
        {query.isPending ? (
          <div
            className="py-20 text-center text-sm text-token-description-foreground"
            role="status"
          >
            Opening Database…
          </div>
        ) : query.error && !model ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-token-description-foreground">
            <span role="alert">Couldn’t open this database</span>
            <button
              type="button"
              className="h-8 rounded-md px-2.5 text-token-text-primary hover:bg-token-list-hover-background"
              onClick={() => void query.refetch()}
            >
              Retry
            </button>
          </div>
        ) : model ? (
          <DatabaseViewTabSurface
            model={model}
            canonicalReadGeneration={queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0}
            groupPagination={groupPagination}
            onLoadMoreGroup={loadMoreGroup}
            activeSearchQuery={searchQuery}
            taskSearchOpen={searchOpen}
            searchShortcutLabel={searchShortcutLabel}
            taskSearchInputRef={searchInputRef}
            onSearchQueryChange={setSearchQuery}
            onOpenTaskSearch={openSearch}
            onCloseTaskSearch={() => setSearchOpen(false)}
            onOpenPage={onOpenPage}
            pageActionPort={pageActionPort}
            keyboardSurface={keyboardSurface}
            presentedPageIds={presentedPageIds}
            initialSelectedPageIds={selectedPageIds}
            onSelectedPageIdsChange={setSelectedPageIds}
            mutationHistory={mutationHistory}
            onCommitted={async () => {
              await query.refetch({ throwOnError: true });
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

export function DatabaseViewGroupLimitNotice({
  totalGroups,
  groupLimit,
}: {
  readonly totalGroups: number;
  readonly groupLimit: number;
}) {
  return (
    <div
      role="alert"
      className="mx-3 mt-2 min-h-8 rounded-md bg-token-warning-background/20 px-2.5 py-2 text-xs text-token-text-secondary"
    >
      This View has {totalGroups} group combinations. Refine grouping or filters to stay within the{" "}
      {groupLimit}-group limit.
    </div>
  );
}
