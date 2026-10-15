import { useEffect } from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  projectIdFromContentRoutingContext,
  type ContentRoutingContext,
} from "../../shared/content-routing-context";
import type { PageTargetReadModel } from "../../shared/page-targets";
import type { PageOwnershipPathReadModel } from "../../shared/page-ownership-paths";
import type { DatabaseViewReadModel } from "../../shared/database-views";
import { readDatabaseViewReference, resolvePageOwnershipPath, resolvePageTarget } from "./api";
import { queryKeys } from "./query-keys";
import { resolveRendererTransport } from "./renderer-transport";
import { createProjectEventSubscriptionHub } from "./project-event-subscription-hub";
import { invalidateExactQuery } from "./query-invalidation";
import { useProjectionRegistration } from "./projection-invalidation-context";
import type { ProjectionDependencies } from "./projection-invalidation-registry";
import type { ProjectionCursor, ProjectionScope } from "../../shared/projection-stream";
import { useLibraryMetadata } from "./use-library-navigation";

export interface ReferenceQueryResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
}

const toError = (error: unknown): Error | null => {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error : new Error(String(error));
};

const pageOwnershipPathChangeSubscriptions = createProjectEventSubscriptionHub({
  subscribeToProject: (projectId, listener) =>
    resolveRendererTransport().subscribePageOwnershipPathChanges(projectId, listener),
});

const pageTargetQueryOptions = (routingContext: ContentRoutingContext, targetBlockId: string) => {
  return {
    queryKey: queryKeys.pageTargets.byId(routingContext, targetBlockId),
    queryFn: async () =>
      await resolvePageTarget({
        routingContext,
        targetPageId: targetBlockId,
      }),
    enabled: targetBlockId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  };
};

export const readCachedPageTargetReadModel = (
  queryClient: Pick<QueryClient, "getQueryData">,
  routingContext: ContentRoutingContext,
  targetPageId: string,
): PageTargetReadModel | null =>
  queryClient.getQueryData<PageTargetReadModel>(
    queryKeys.pageTargets.byId(routingContext, targetPageId),
  ) ?? null;

const useProjectionQueryRefresh = (input: {
  readonly scope: ProjectionScope | null;
  readonly dependencies: ProjectionDependencies;
  readonly cursor: ProjectionCursor | null;
  readonly queryKey: readonly unknown[];
}): void => {
  const queryClient = useQueryClient();
  const consumerKey = hashKey(input.queryKey);
  useProjectionRegistration(
    input.scope
      ? {
          scope: input.scope,
          consumerKey,
          getDependencies: () => input.dependencies,
          getCursor: () => {
            const current = queryClient.getQueryData<{
              readonly storeEpoch: string;
              readonly commitSeq: number;
            }>(input.queryKey);
            return current
              ? {
                  storeEpoch: current.storeEpoch,
                  commitSeq: current.commitSeq,
                }
              : input.cursor;
          },
          invalidate: () => invalidateExactQuery(queryClient, input.queryKey),
        }
      : null,
  );
};

export const usePageTargetReadModel = (
  routingContext: ContentRoutingContext,
  targetBlockId: string,
): ReferenceQueryResult<PageTargetReadModel> => {
  const enabled = targetBlockId.length > 0;
  const library = useLibraryMetadata(enabled);
  const query = useQuery(pageTargetQueryOptions(routingContext, targetBlockId));
  const libraryId = library.data?.libraryId ?? query.data?.libraryId ?? null;
  const queryKey = queryKeys.pageTargets.byId(routingContext, targetBlockId);
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? routingContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: routingContext.projectId,
            }
        : null,
    dependencies: { pageIds: [targetBlockId] },
    cursor: query.data
      ? { storeEpoch: query.data.storeEpoch, commitSeq: query.data.commitSeq }
      : null,
    queryKey,
  });
  return {
    data: query.data ?? null,
    loading: enabled && query.status === "pending",
    error: toError(query.error),
  };
};

export const usePageOwnershipPathReadModel = (
  routingContext: ContentRoutingContext,
  targetPageId: string,
): ReferenceQueryResult<PageOwnershipPathReadModel> => {
  const queryClient = useQueryClient();
  const enabled = targetPageId.length > 0;
  const projectId = projectIdFromContentRoutingContext(routingContext);
  const library = useLibraryMetadata(enabled);
  const queryKey = queryKeys.pageOwnershipPaths.byPage(routingContext, targetPageId);
  const query = useQuery({
    queryKey,
    queryFn: async () => await resolvePageOwnershipPath({ routingContext, targetPageId }),
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const libraryId = library.data?.libraryId ?? query.data?.libraryId ?? null;
  const observedPageIds =
    query.data?.status === "available"
      ? [targetPageId, ...query.data.ancestors.map((ancestor) => ancestor.pageId)]
      : [targetPageId];
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? routingContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: routingContext.projectId,
            }
        : null,
    dependencies: { pageIds: observedPageIds },
    cursor: query.data
      ? { storeEpoch: query.data.storeEpoch, commitSeq: query.data.commitSeq }
      : null,
    queryKey,
  });

  useEffect(() => {
    if (!enabled || !projectId) return;
    return pageOwnershipPathChangeSubscriptions.subscribe(projectId, "page-ownership-paths", () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.pageOwnershipPaths.byScope({
          kind: "project",
          projectId,
        }),
      });
    });
  }, [enabled, projectId, queryClient]);

  return {
    data: query.data ?? null,
    loading: enabled && query.status === "pending",
    error: toError(query.error),
  };
};

export const useDatabaseViewReadModel = (
  routingContext: ContentRoutingContext,
  databaseViewId: string,
  hostBlockId?: string,
): ReferenceQueryResult<DatabaseViewReadModel> => {
  const enabled = databaseViewId.length > 0;
  const library = useLibraryMetadata(enabled);
  const queryKey = queryKeys.blockReferences.databaseView(
    routingContext,
    databaseViewId,
    hostBlockId,
  );
  const { data, error, status } = useQuery({
    queryKey,
    queryFn: async () =>
      await readDatabaseViewReference({
        routingContext,
        databaseViewId,
        ...(hostBlockId ? { hostBlockId } : {}),
      }),
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });
  const libraryId = library.data?.libraryId ?? data?.libraryId ?? null;
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? routingContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: routingContext.projectId,
            }
        : null,
    dependencies: {
      databaseIds: data ? [data.view.databaseBlockId] : [],
      dataSourceIds: data ? [data.dataSourceId] : [],
      viewIds: [databaseViewId],
      pageIds: data?.rows.map((row) => row.page.id) ?? [],
    },
    cursor: data ? { storeEpoch: data.storeEpoch, commitSeq: data.commitSeq } : null,
    queryKey,
  });
  return {
    data: data ?? null,
    loading: enabled && status === "pending",
    error: toError(error),
  };
};
