import { useEffect } from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import {
  projectIdFromContentAccessContext,
  type ContentAccessContext,
} from "../../shared/content-access-context";
import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import {
  admitResourceAuthorityQuery,
  resourceAuthorityQueryMeta,
} from "./resource-authority-query-cache";

export interface ReferenceQueryResult<T> {
  readonly data: T | null;
  readonly loading: boolean;
  readonly error: Error | null;
}

const toError = (error: unknown): Error | null => {
  if (error === null || error === undefined) return null;
  return error instanceof Error ? error : new Error(String(error));
};

const resolveReferenceAuthority = (_queryKey: readonly unknown[], data: unknown) => {
  const authorization = (
    data as {
      readonly authorization?: AuthorizedReadStamp | null;
    } | null
  )?.authorization;
  return authorization ? { authorizations: [authorization] } : null;
};

const pageOwnershipPathChangeSubscriptions = createProjectEventSubscriptionHub({
  subscribeToProject: (projectId, listener) =>
    resolveRendererTransport().subscribePageOwnershipPathChanges(projectId, listener),
});

const pageTargetQueryOptions = (accessContext: ContentAccessContext, targetBlockId: string) => {
  return {
    queryKey: queryKeys.pageTargets.byId(accessContext, targetBlockId),
    queryFn: async () =>
      admitResourceAuthorityQuery(
        await resolvePageTarget({
          accessContext,
          targetPageId: targetBlockId,
        }),
        resolveReferenceAuthority,
      ),
    enabled: targetBlockId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    meta: resourceAuthorityQueryMeta(resolveReferenceAuthority),
  };
};

export const readCachedPageTargetReadModel = (
  queryClient: Pick<QueryClient, "getQueryData">,
  accessContext: ContentAccessContext,
  targetPageId: string,
): PageTargetReadModel | null =>
  queryClient.getQueryData<PageTargetReadModel>(
    queryKeys.pageTargets.byId(accessContext, targetPageId),
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
  accessContext: ContentAccessContext,
  targetBlockId: string,
): ReferenceQueryResult<PageTargetReadModel> => {
  const enabled = targetBlockId.length > 0;
  const library = useLibraryMetadata(enabled);
  const query = useQuery(pageTargetQueryOptions(accessContext, targetBlockId));
  const libraryId = library.data?.libraryId ?? query.data?.libraryId ?? null;
  const queryKey = queryKeys.pageTargets.byId(accessContext, targetBlockId);
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? accessContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: accessContext.projectId,
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
  accessContext: ContentAccessContext,
  targetPageId: string,
): ReferenceQueryResult<PageOwnershipPathReadModel> => {
  const queryClient = useQueryClient();
  const enabled = targetPageId.length > 0;
  const projectId = projectIdFromContentAccessContext(accessContext);
  const library = useLibraryMetadata(enabled);
  const queryKey = queryKeys.pageOwnershipPaths.byPage(accessContext, targetPageId);
  const query = useQuery({
    queryKey,
    queryFn: async () =>
      admitResourceAuthorityQuery(
        await resolvePageOwnershipPath({ accessContext, targetPageId }),
        resolveReferenceAuthority,
      ),
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    meta: resourceAuthorityQueryMeta(resolveReferenceAuthority),
  });
  const libraryId = library.data?.libraryId ?? query.data?.libraryId ?? null;
  const observedPageIds =
    query.data?.status === "available"
      ? [targetPageId, ...query.data.ancestors.map((ancestor) => ancestor.pageId)]
      : [targetPageId];
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? accessContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: accessContext.projectId,
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
  accessContext: ContentAccessContext,
  databaseViewId: string,
  hostBlockId?: string,
): ReferenceQueryResult<DatabaseViewReadModel> => {
  const enabled = databaseViewId.length > 0;
  const library = useLibraryMetadata(enabled);
  const queryKey = queryKeys.blockReferences.databaseView(
    accessContext,
    databaseViewId,
    hostBlockId,
  );
  const { data, error, status } = useQuery({
    queryKey,
    queryFn: async () =>
      admitResourceAuthorityQuery(
        await readDatabaseViewReference({
          accessContext,
          databaseViewId,
          ...(hostBlockId ? { hostBlockId } : {}),
        }),
        resolveReferenceAuthority,
      ),
    enabled,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    meta: resourceAuthorityQueryMeta(resolveReferenceAuthority),
  });
  const libraryId = library.data?.libraryId ?? data?.libraryId ?? null;
  useProjectionQueryRefresh({
    scope:
      enabled && libraryId
        ? accessContext.kind === "library"
          ? { kind: "library", libraryId }
          : {
              kind: "project",
              libraryId,
              projectId: accessContext.projectId,
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
