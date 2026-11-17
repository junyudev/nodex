import { useDebouncedValue } from "@/lib/use-debounced-value";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useMembers } from "@/lib/members-runtime";
import { runWithCleanup } from "@/lib/run-with-cleanup";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { hashKey, useQuery, useQueryClient } from "@tanstack/react-query";

import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import type { WorkbenchDbViewSurfaceConfig } from "../../../shared/workbench-scene";
import { createUuidV7 } from "../../../shared/uuid-v7";
import type {
  DatabaseViewGroupScopeInput,
  DatabaseViewGroupsSnapshot,
  DatabaseViewWindowSnapshot,
} from "../../../shared/database-views";
import {
  CoreApiError,
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
import { DatabaseViewTabContent, DatabaseViewTabSurface } from "./workbench-db-view-panel";
import { databaseViewLayoutIcon } from "./database-settings/database-settings-rail";
import type { Project } from "@/lib/types";
import type { OpenPageInNewChatInput, SendPageToChatInput } from "@/lib/page-chat-actions";
import { useDatabaseViewMutationHistory } from "./database-view-mutation-history";
import type { DatabaseViewPageActionPort } from "./database-view-page-actions";
import type { DatabaseViewPageOpenHandler } from "./database-view-page-open";
import { useWorkbenchDatabaseViewPresentation } from "@/lib/use-workbench-database-view-presentation";
import type { WorkbenchDatabaseViewPresentationRegistration } from "@/lib/workbench-database-view-presentation";
import { useApplicationPending } from "@/bootstrap/application-surface";

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

interface ContinuationState {
  readonly windows: readonly DatabaseViewWindowSnapshot<string | null>[];
  readonly loading: boolean;
  readonly loadFailed: boolean;
}

const readDatabaseWindowForContext = async (
  routingContext: ContentRoutingContext,
  target: DatabaseReadTarget,
  input: {
    readonly searchQuery?: string;
    readonly after?: string;
    readonly groupScope?: DatabaseViewGroupScopeInput;
    readonly minimumCommitSeq?: number;
  } = {},
): Promise<DatabaseViewWindowSnapshot<string | null>> => {
  if (routingContext.kind === "project") {
    return await readDatabaseViewWindow(routingContext.projectId, {
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
  routingContext: ContentRoutingContext,
  target: DatabaseReadTarget,
  minimumCommitSeq = 0,
  searchQuery = "",
): Promise<DatabaseViewGroupsSnapshot<string | null>> => {
  if (routingContext.kind === "project") {
    return await readDatabaseViewGroups(routingContext.projectId, {
      ...target,
      ...(searchQuery ? { searchQuery } : {}),
      ...(minimumCommitSeq > 0 ? { minimumCommitSeq } : {}),
    });
  }
  return await readLibraryDatabaseViewGroups({
    ...target,
    ...(searchQuery ? { searchQuery } : {}),
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
  isActivePanelTab = true,
  workbenchPresentation,
  routingContext,
  target,
  onOpenPage,
  onPresentationChange,
  keyboardSurface,
  presentedPageIds,
  onOpenPageInNewChat,
  onOpenRelatedChat,
  onSendPageToChat,
}: {
  readonly isActivePanelTab?: boolean;
  readonly workbenchPresentation?: WorkbenchDatabaseViewPresentationRegistration;
  readonly routingContext: ContentRoutingContext;
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
  const intl = useIntl();
  const queryClient = useQueryClient();
  const members = useMembers();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const inFlightScopesRef = useRef({
    key: null as readonly unknown[] | null,
    updatedAt: 0,
    scopes: new Set<string>(),
  });
  const requiredMinimumCommitSeqRef = useRef(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedPageIds, setSelectedPageIds] = useState<ReadonlySet<string>>(() => new Set());
  const [continuations, setContinuations] = useState<ReadonlyMap<string, ContinuationState>>(
    new Map(),
  );
  const projectId = routingContext.kind === "project" ? routingContext.projectId : undefined;
  const targetIdentity =
    target.kind === "database-default"
      ? `database:${target.databaseId}`
      : `view:${target.databaseViewId}`;
  const viewQueryKey = useMemo(
    () => queryKeys.libraryDatabases.view(projectId, targetIdentity),
    [projectId, targetIdentity],
  );
  const readFirstWindows = async (search: string) => {
    const readTarget = readTargetFromIdentity(targetIdentity);
    let floor = requiredMinimumCommitSeqRef.current;
    const readContext: ContentRoutingContext = projectId
      ? { kind: "project", projectId }
      : { kind: "library" };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const groups = await readDatabaseGroupsForContext(readContext, readTarget, floor, search);
      const scopedWindows = await mapWithConcurrency(
        scopesFromGroups(groups),
        GROUP_WINDOW_READ_CONCURRENCY,
        async (scope): Promise<ScopedWindow> => ({
          ...scope,
          snapshot: await readDatabaseWindowForContext(readContext, readTarget, {
            ...(scope.scope ? { groupScope: scope.scope } : {}),
            ...(search ? { searchQuery: search } : {}),
            ...(floor > 0 ? { minimumCommitSeq: floor } : {}),
          }),
        }),
      );
      if (
        !search ||
        scopedWindows.every(
          ({ snapshot }) =>
            snapshot.storeEpoch === groups.storeEpoch &&
            snapshot.search?.result_key === groups.search?.result_key,
        )
      )
        return { groups, scopedWindows };
      floor = Math.max(
        floor,
        groups.commitSeq,
        ...scopedWindows.map(({ snapshot }) => snapshot.commitSeq),
      );
    }
    throw new Error("The search results changed while reading the View");
  };
  // The floor is a monotonic read barrier rather than part of the query key.
  const browse = useQuery({ queryKey: viewQueryKey, queryFn: () => readFirstWindows("") });
  const debouncedSearchQuery = useDebouncedValue(searchQuery.trim(), 120);
  const layout = browse.data?.scopedWindows[0]?.snapshot.query.view.layout;
  const boardSearchQuery = layout === "board" ? debouncedSearchQuery : "";
  const searchKey = useMemo(
    () => [...viewQueryKey, boardSearchQuery] as const,
    [viewQueryKey, boardSearchQuery],
  );
  const search = useQuery({
    enabled: boardSearchQuery.length > 0,
    queryKey: searchKey,
    queryFn: () => readFirstWindows(boardSearchQuery),
    placeholderData: (previous, previousQuery) =>
      hashKey(previousQuery?.queryKey.slice(0, -1) ?? []) === hashKey(viewQueryKey)
        ? previous
        : undefined,
  });
  const query = boardSearchQuery ? search : browse;
  const queryKey = boardSearchQuery ? searchKey : viewQueryKey;

  const [accepted, setAccepted] = useState({ data: query.data, generation: 0 });
  const displayedQuery = query.data ?? accepted.data;
  if (accepted.data !== displayedQuery) {
    setAccepted({ data: displayedQuery, generation: accepted.generation + 1 });
    setContinuations(new Map());
  }
  const resourceIdentity = hashKey(viewQueryKey);
  const [previousTargetIdentity, setPreviousTargetIdentity] = useState(resourceIdentity);
  if (previousTargetIdentity !== resourceIdentity) {
    setPreviousTargetIdentity(resourceIdentity);
    setAccepted({ data: query.data, generation: accepted.generation + 1 });
    setContinuations(new Map());
    setSearchQuery("");
    setSearchOpen(false);
  }

  const windowsByScope = useMemo(
    () =>
      new Map(
        (displayedQuery?.scopedWindows ?? []).map((base) => [
          base.scopeKey,
          [base.snapshot, ...(continuations.get(base.scopeKey)?.windows ?? [])],
        ]),
      ),
    [continuations, displayedQuery?.scopedWindows],
  );
  const mergedWindow = useMemo(
    () => mergeWindows([...windowsByScope.values()].flat()),
    [windowsByScope],
  );
  const model = useMemo(
    () =>
      mergedWindow
        ? buildDatabaseViewWindowRenderModel(mergedWindow, {
            members: members.data,
            windowKey: JSON.stringify(
              [...windowsByScope].map(([key, windows]) => [key, windows.length]),
            ),
          })
        : undefined,
    [mergedWindow, windowsByScope, members.data],
  );
  useWorkbenchDatabaseViewPresentation(workbenchPresentation, model?.databaseViewId ?? null);
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
        (displayedQuery?.groups.groups ?? []).map((group) => [
          groupScopeKeyForPath(group.groupKey, group.subgroupKey),
          group.totalRows,
        ]),
      ),
    [displayedQuery?.groups.groups],
  );
  const groupPagination = useMemo<ReadonlyMap<string, ColumnPaginationState>>(
    () =>
      new Map(
        (displayedQuery?.scopedWindows ?? []).map((base) => {
          const windows = windowsByScope.get(base.scopeKey) ?? [base.snapshot];
          const current = continuations.get(base.scopeKey);
          const loadedRows = uniqueBy(
            windows.flatMap((window) => window.query.rows),
            (row) => row.page.pageId,
          ).length;
          const totalRows = displayedQuery?.groups.grouped
            ? (groupTotals.get(base.scopeKey) ?? loadedRows)
            : (displayedQuery?.groups.totalRows ?? loadedRows);
          return [
            base.scopeKey,
            {
              scopeKey: base.scopeKey,
              loadedRows,
              totalRows,
              hasMore: windows.at(-1)?.nextCursor !== null,
              loadingMore: current?.loading ?? false,
              error: current?.loadFailed
                ? intl.formatMessage({
                    id: "workbench.workbenchDatabaseViewSurface.loadMoreFailed",
                    defaultMessage: "Couldn’t load more pages",
                  })
                : null,
            },
          ];
        }),
      ),
    [continuations, groupTotals, intl, displayedQuery, windowsByScope],
  );

  const authority = mergedWindow;
  useProjectionRegistration(
    authority
      ? {
          scope: projectId
            ? {
                kind: "project",
                libraryId: authority.libraryId,
                projectId: projectId,
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
          invalidate: async (cause: ProjectionInvalidationCause) => {
            requiredMinimumCommitSeqRef.current = Math.max(
              requiredMinimumCommitSeqRef.current,
              cause.stream.commitSeq,
            );
            await invalidateExactQuery(queryClient, viewQueryKey);
            if (boardSearchQuery) await invalidateExactQuery(queryClient, queryKey);
          },
        }
      : null,
  );

  useEffect(() => {
    inFlightScopesRef.current = {
      key: queryKey,
      updatedAt: query.dataUpdatedAt,
      scopes: new Set(),
    };
  }, [query.dataUpdatedAt, queryKey]);

  const loadMoreGroup = async (scopeKey: string): Promise<void> => {
    if (
      query.isPending ||
      query.isPlaceholderData ||
      query.error ||
      boardSearchQuery !== (query.data?.groups.search?.query ?? "")
    )
      return;
    if (
      inFlightScopesRef.current.key !== queryKey ||
      inFlightScopesRef.current.updatedAt !== query.dataUpdatedAt
    ) {
      inFlightScopesRef.current = {
        key: queryKey,
        updatedAt: query.dataUpdatedAt,
        scopes: new Set(),
      };
    }
    const inFlightScopes = inFlightScopesRef.current.scopes;
    if (inFlightScopes.has(scopeKey)) return;
    const base = query.data?.scopedWindows.find((candidate) => candidate.scopeKey === scopeKey);
    if (!base) return;
    const current = continuations.get(scopeKey);
    const windows = [base.snapshot, ...(current?.windows ?? [])];
    const cursor = windows.at(-1)?.nextCursor;
    if (!cursor) return;
    const readTarget = readTargetFromIdentity(targetIdentity);

    inFlightScopes.add(scopeKey);
    setContinuations((states) =>
      new Map(states).set(scopeKey, {
        windows: current?.windows ?? [],
        loading: true,
        loadFailed: false,
      }),
    );
    await runWithCleanup(
      async () => {
        const next = await readDatabaseWindowForContext(routingContext, readTarget, {
          after: cursor,
          ...(boardSearchQuery ? { searchQuery: boardSearchQuery } : {}),
          ...(base.scope ? { groupScope: base.scope } : {}),
        });
        if (inFlightScopes !== inFlightScopesRef.current.scopes) return;
        if (
          next.storeEpoch !== base.snapshot.storeEpoch ||
          next.search?.result_key !== base.snapshot.search?.result_key
        ) {
          await query.refetch({ throwOnError: true });
          return;
        }
        setContinuations((states) =>
          inFlightScopes !== inFlightScopesRef.current.scopes
            ? states
            : new Map(states).set(scopeKey, {
                windows: [...(states.get(scopeKey)?.windows ?? []), next],
                loading: false,
                loadFailed: false,
              }),
        );
      },
      {
        onError: (error) => {
          if (inFlightScopes !== inFlightScopesRef.current.scopes) return;
          if (
            error instanceof CoreApiError &&
            error.isCursorRejection({ requestHadCursor: true })
          ) {
            void query.refetch();
            return;
          }
          console.error("[database-view:continuation]", error);
          setContinuations((states) =>
            inFlightScopes !== inFlightScopesRef.current.scopes
              ? states
              : new Map(states).set(scopeKey, {
                  windows: states.get(scopeKey)?.windows ?? [],
                  loading: false,
                  loadFailed: true,
                }),
          );
        },
        cleanup: () => {
          inFlightScopes.delete(scopeKey);
        },
      },
    );
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

  const pageActionPort: DatabaseViewPageActionPort = {
    ...(onOpenPageInNewChat ? { openInNewChat: onOpenPageInNewChat } : {}),
    ...(onOpenRelatedChat ? { openRelatedChat: onOpenRelatedChat } : {}),
    ...(onSendPageToChat ? { sendToChat: onSendPageToChat } : {}),
    deletePage: async ({ pageId }) => {
      const committed = await commitPageLifecycleIntent({
        kind: "delete",
        projectId: projectId ?? null,
        pageId,
        operationId: createUuidV7(),
      });
      if (committed.receipt.lifecycle !== "deleted") {
        throw new Error(`Page ${pageId} delete did not commit`);
      }
      await query.refetch();
    },
  };

  useApplicationPending(isActivePanelTab && query.isPending);

  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <div className="flex min-h-0 flex-1 flex-col">
        {query.error && model ? (
          <div
            role="alert"
            className="mx-3 mt-2 flex min-h-8 items-center gap-2 rounded-md bg-token-error-background/20 px-2.5 text-xs text-token-error-foreground"
          >
            <span className="min-w-0 flex-1 truncate">
              <FormattedMessage
                id="workbench.workbenchDatabaseViewSurface.refreshFailed"
                defaultMessage="Couldn’t refresh this database"
              />
            </span>
            <button
              type="button"
              className="shrink-0 rounded-md px-2 py-1 text-token-text-primary hover:bg-token-foreground/5"
              onClick={() => void query.refetch()}
            >
              <FormattedMessage
                id="workbench.workbenchDatabaseViewSurface.retry"
                defaultMessage="Retry"
              />
            </button>
          </div>
        ) : null}
        {query.data?.groups.truncated ? (
          <DatabaseViewGroupLimitNotice
            totalGroups={query.data.groups.totalGroups}
            groupLimit={query.data.groups.groupLimit}
          />
        ) : null}
        {query.isPending && !model ? (
          <div
            className="py-20 text-center text-sm text-token-description-foreground"
            role="status"
          >
            <FormattedMessage
              id="workbench.workbenchDatabaseViewSurface.opening"
              defaultMessage="Opening Database…"
            />
          </div>
        ) : query.error && !model ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-token-description-foreground">
            <span role="alert">
              <FormattedMessage
                id="workbench.workbenchDatabaseViewSurface.openFailed"
                defaultMessage="Couldn’t open this database"
              />
            </span>
            <button
              type="button"
              className="h-8 rounded-md px-2.5 text-token-text-primary hover:bg-token-list-hover-background"
              onClick={() => void query.refetch()}
            >
              <FormattedMessage
                id="workbench.workbenchDatabaseViewSurface.retry"
                defaultMessage="Retry"
              />
            </button>
          </div>
        ) : model ? (
          <DatabaseViewTabSurface
            toolbar={{
              items: [
                {
                  id: model.databaseViewId,
                  label: model.viewName,
                  icon: databaseViewLayoutIcon(model.query.view.layout),
                  active: true,
                  onSelect: () => undefined,
                },
              ],
              activeSearchQuery: searchQuery,
              taskSearchOpen: searchOpen,
              searchShortcutLabel,
              taskSearchInputRef: searchInputRef,
              onSearchQueryChange: setSearchQuery,
              onOpenTaskSearch: openSearch,
              onCloseTaskSearch: () => setSearchOpen(false),
            }}
          >
            {boardSearchQuery && query.error ? (
              <div role="alert" className="px-4 py-1 text-xs text-token-error-foreground">
                <FormattedMessage
                  id="database.viewSearch.failed"
                  defaultMessage="Couldn’t search this View."
                />
              </div>
            ) : null}
            <DatabaseViewTabContent
              workbenchContent={
                workbenchPresentation
                  ? {
                      presentation: workbenchPresentation,
                      preferencesRevision: null,
                      preferencesPending: false,
                      loading: query.isFetching,
                    }
                  : undefined
              }
              model={model}
              canonicalReadGeneration={accepted.generation}
              groupPagination={groupPagination}
              onLoadMoreGroup={loadMoreGroup}
              activeSearchQuery={searchQuery}
              onOpenPage={onOpenPage}
              pageActionPort={pageActionPort}
              keyboardSurface={keyboardSurface}
              presentedPageIds={presentedPageIds}
              initialSelectedPageIds={selectedPageIds}
              onSelectedPageIdsChange={setSelectedPageIds}
              mutationHistory={mutationHistory}
              onCommitted={async (cursor) => {
                if (cursor && cursor.storeEpoch === model.storeEpoch)
                  requiredMinimumCommitSeqRef.current = Math.max(
                    requiredMinimumCommitSeqRef.current,
                    cursor.commitSeq,
                  );
                await browse.refetch({ throwOnError: true });
                if (boardSearchQuery) await search.refetch({ throwOnError: true });
              }}
            />
          </DatabaseViewTabSurface>
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
  const intl = useIntl();
  return (
    <div
      role="alert"
      className="mx-3 mt-2 min-h-8 rounded-md bg-token-warning-background/20 px-2.5 py-2 text-xs text-token-text-secondary"
    >
      {intl.formatMessage(
        {
          id: "workbench.workbenchDatabaseViewSurface.groupLimit",
          defaultMessage:
            "This View has {totalGroups} group combinations. Refine grouping or filters to stay within the {groupLimit}-group limit.",
        },
        {
          totalGroups: intl.formatNumber(totalGroups, { useGrouping: false }),
          groupLimit: intl.formatNumber(groupLimit, { useGrouping: false }),
        },
      )}
    </div>
  );
}
