import {
  hashKey,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueries,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import {
  type LibraryApplyOperation,
  type LibraryModuleReadRequest,
  type LibraryNavigationParent,
  type LibraryPageRelocationDestinationScope,
  type LibraryPageRelocationUndoToken,
  type LibraryReadValue,
  type LibraryResourceTarget,
  type LibraryRouteTarget,
} from "../../shared/library-module";
import { libraryContentAccess } from "../../shared/content-access-context";
import { applyLibraryModule, readLibraryModule, subscribeLibraryChanges } from "./api";
import { createUuidV7 } from "../../shared/uuid-v7";
import { queryKeys } from "./query-keys";
import { invalidateQueryFamilyExactly, queryFamilyProjectionCursor } from "./query-invalidation";
import { useProjectionRegistration } from "./projection-invalidation-context";
import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import {
  admitResourceAuthorityQuery,
  resourceAuthorityQueryMeta,
} from "./resource-authority-query-cache";

export const libraryModuleQueryKey = queryKeys.library.all();

const resolveLibraryReadAuthority = (_queryKey: readonly unknown[], data: unknown) => {
  const authorization = (data as { readonly authorization?: AuthorizedReadStamp | null } | null)
    ?.authorization;
  return authorization ? { authorizations: [authorization] } : null;
};

const libraryReadAuthorityMeta = resourceAuthorityQueryMeta(resolveLibraryReadAuthority);

export const libraryMetadataQueryOptions = () =>
  queryOptions({
    queryKey: queryKeys.library.metadata(),
    queryFn: async () => {
      const result = await readLibraryModule(libraryContentAccess, {
        read: { mode: "metadata" },
      });
      if (!result.ok) throw new Error(result.error.message);
      return await admitResourceAuthorityQuery(result.value, resolveLibraryReadAuthority);
    },
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

const requireReadValue = async <Kind extends LibraryReadValue["kind"]>(
  request: LibraryModuleReadRequest,
  kind: Kind,
): Promise<
  Extract<LibraryReadValue, { kind: Kind }> & {
    readonly libraryId: string;
    readonly storeEpoch: string;
    readonly commitSeq: number;
    readonly authorization: AuthorizedReadStamp | null;
  }
> => {
  const result = await readLibraryModule(libraryContentAccess, request);
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== kind) {
    throw new Error(`Library read returned ${result.value.value.kind}, expected ${kind}`);
  }
  return await admitResourceAuthorityQuery(
    {
      ...result.value.value,
      libraryId: result.value.libraryId,
      storeEpoch: result.value.storeEpoch,
      commitSeq: result.value.commitSeq,
      authorization: result.value.authorization,
    } as Extract<LibraryReadValue, { kind: Kind }> & {
      readonly libraryId: string;
      readonly storeEpoch: string;
      readonly commitSeq: number;
      readonly authorization: AuthorizedReadStamp | null;
    },
    resolveLibraryReadAuthority,
  );
};

const parentKey = (parent: LibraryNavigationParent): string => {
  if (parent.kind === "library") return "library";
  if (parent.kind === "page") return `page:${parent.pageId}`;
  return `database:${parent.databaseId}`;
};

export const libraryChildrenQueryOptions = (
  parent: LibraryNavigationParent,
  input: Readonly<{
    cursor?: string;
    limit?: number;
    forceIncludeTarget?: Extract<
      LibraryModuleReadRequest["read"],
      { mode: "children" }
    >["forceIncludeTarget"];
  }> = {},
) =>
  queryOptions({
    queryKey: queryKeys.library.children(parentKey(parent), input),
    queryFn: () =>
      requireReadValue(
        {
          read: {
            mode: "children",
            parent,
            ...input,
          },
        },
        "children",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryStandaloneRootsQueryOptions = (
  input: Omit<Extract<LibraryModuleReadRequest["read"], { mode: "standalone_roots" }>, "mode"> = {},
) =>
  queryOptions({
    queryKey: queryKeys.library.standaloneRoots(input),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "standalone_roots", ...input },
        },
        "standalone_roots",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryCatalogQueryOptions = (
  input: Omit<Extract<LibraryModuleReadRequest["read"], { mode: "catalog" }>, "mode"> = {},
) =>
  queryOptions({
    queryKey: queryKeys.library.catalog(input),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "catalog", ...input },
        },
        "catalog",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryMoveDestinationsQueryOptions = (
  target: LibraryResourceTarget,
  input: Omit<
    Extract<LibraryModuleReadRequest["read"], { mode: "move_destinations" }>,
    "mode" | "target"
  >,
) =>
  queryOptions({
    queryKey: queryKeys.library.moveDestinations(target, input),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "move_destinations", target, ...input },
        },
        "move_destinations",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryPageRelocationDestinationsQueryOptions = (
  pageId: string,
  input: Readonly<{
    scope: LibraryPageRelocationDestinationScope;
    cursor?: string;
    limit?: number;
  }>,
) =>
  queryOptions({
    queryKey: queryKeys.library.pageRelocationDestinations(pageId, input),
    queryFn: () =>
      requireReadValue(
        {
          read: {
            mode: "page_relocation_destinations",
            pageId,
            ...input,
          },
        },
        "page_relocation_destinations",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryPathQueryOptions = (target: LibraryRouteTarget) =>
  queryOptions({
    queryKey: queryKeys.library.path(target),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "path", target },
        },
        "path",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryCanvasTargetQueryOptions = (canvasId: string) =>
  queryOptions({
    queryKey: queryKeys.library.canvasTarget(canvasId),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "canvas_target", canvasId },
        },
        "canvas_target",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const libraryResourceProjectAccessQueryOptions = (target: LibraryResourceTarget) =>
  queryOptions({
    queryKey: queryKeys.library.resourceProjectAccess(target),
    queryFn: () =>
      requireReadValue(
        {
          read: { mode: "resource_project_access", target },
        },
        "resource_project_access",
      ),
    meta: libraryReadAuthorityMeta,
    staleTime: 30_000,
  });

export const useLibraryResourceProjectAccess = (target: LibraryResourceTarget, enabled = true) =>
  useQuery({
    ...libraryResourceProjectAccessQueryOptions(target),
    enabled,
  });

export const useLibraryNavigationInvalidation = (): string | null => {
  const queryClient = useQueryClient();
  const metadata = useQuery(libraryMetadataQueryOptions());
  const retainedLibraryId = useRef<string | null>(null);
  // A reset clears query data before Main receives its acknowledgement. Keep
  // the immutable audience identity alive across that bounded repair window.
  if (metadata.data) retainedLibraryId.current = metadata.data.libraryId;
  const libraryId = metadata.data?.libraryId ?? retainedLibraryId.current;
  useEffect(
    () =>
      subscribeLibraryChanges(() => {
        void invalidateQueryFamilyExactly(queryClient, libraryModuleQueryKey);
      }),
    [queryClient],
  );
  useProjectionRegistration(
    libraryId
      ? {
          scope: { kind: "library", libraryId },
          consumerKey: hashKey(libraryModuleQueryKey),
          getDependencies: () => ({ aggregate: true }),
          getCursor: () => queryFamilyProjectionCursor(queryClient, libraryModuleQueryKey),
          invalidate: () => invalidateQueryFamilyExactly(queryClient, libraryModuleQueryKey),
        }
      : null,
  );
  return libraryId ?? null;
};

export const useLibraryMetadata = (enabled = true) =>
  useQuery({
    ...libraryMetadataQueryOptions(),
    enabled,
  });

export const useApplyLibraryOperation = () => {
  const queryClient = useQueryClient();
  const metadata = useLibraryMetadata();
  const mutation = useMutation({
    mutationFn: async (operation: LibraryApplyOperation) => {
      if (!metadata.data) throw new Error("Library identity is not ready");
      const result = await applyLibraryModule(libraryContentAccess, {
        operationId: createUuidV7(),
        storeEpoch: metadata.data.storeEpoch,
        operation,
      });
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: libraryModuleQueryKey });
    },
  });
  return { metadata, mutation };
};

/**
 * Relocation Undo outlives the picker that initiated the move. The capability
 * carries its Store epoch, so submitting it must not depend on a still-mounted
 * Library metadata observer.
 */
export const useUndoLibraryPageRelocation = () => {
  const queryClient = useQueryClient();
  return async (token: LibraryPageRelocationUndoToken) => {
    const result = await applyLibraryModule(libraryContentAccess, {
      operationId: createUuidV7(),
      storeEpoch: token.storeEpoch,
      operation: { kind: "undo_page_relocation", token },
    });
    if (!result.ok) throw new Error(result.error.message);
    await queryClient.invalidateQueries({ queryKey: libraryModuleQueryKey });
    return result.value;
  };
};

export const useLibraryChildren = (
  parent: LibraryNavigationParent,
  input: Parameters<typeof libraryChildrenQueryOptions>[1] = {},
  enabled = true,
) =>
  useQuery({
    ...libraryChildrenQueryOptions(parent, input),
    enabled,
  });

export const useInfiniteLibraryChildren = (
  parent: LibraryNavigationParent,
  input: Omit<NonNullable<Parameters<typeof libraryChildrenQueryOptions>[1]>, "cursor"> = {},
  enabled = true,
) =>
  useInfiniteQuery({
    queryKey: queryKeys.library.childrenPages(parentKey(parent), input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireReadValue(
        {
          read: {
            mode: "children",
            parent,
            ...input,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        "children",
      ),
    meta: libraryReadAuthorityMeta,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    enabled,
  });

export const useInfiniteLibraryStandaloneRoots = (
  input: Omit<Parameters<typeof libraryStandaloneRootsQueryOptions>[0], "cursor"> = {},
  enabled = true,
) =>
  useInfiniteQuery({
    queryKey: queryKeys.library.standaloneRootPages(input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireReadValue(
        {
          read: {
            mode: "standalone_roots",
            ...input,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        "standalone_roots",
      ),
    meta: libraryReadAuthorityMeta,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    enabled,
  });

export const useLibraryPath = (target: LibraryRouteTarget, enabled = true) =>
  useQuery({ ...libraryPathQueryOptions(target), enabled });

export const useLibraryCanvasTarget = (canvasId: string, enabled = true) =>
  useQuery({ ...libraryCanvasTargetQueryOptions(canvasId), enabled });

export const useLibraryCatalog = (
  input: Parameters<typeof libraryCatalogQueryOptions>[0] = {},
  enabled = true,
) => useQuery({ ...libraryCatalogQueryOptions(input), enabled });

export const useLibraryMoveDestinations = (
  target: LibraryResourceTarget,
  input: Parameters<typeof libraryMoveDestinationsQueryOptions>[1],
  enabled = true,
) =>
  useQuery({
    ...libraryMoveDestinationsQueryOptions(target, input),
    enabled,
  });

export const useInfiniteLibraryMoveDestinations = (
  target: LibraryResourceTarget,
  input: Omit<Parameters<typeof libraryMoveDestinationsQueryOptions>[1], "cursor">,
  enabled = true,
) =>
  useInfiniteQuery({
    queryKey: queryKeys.library.moveDestinationPages(target, input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireReadValue(
        {
          read: {
            mode: "move_destinations",
            target,
            ...input,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        "move_destinations",
      ),
    meta: libraryReadAuthorityMeta,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
    enabled,
  });

export const useLibraryMoveDestinationChildren = (
  target: LibraryResourceTarget,
  pageIds: readonly string[],
  enabled = true,
) =>
  useQueries({
    queries: pageIds.map((pageId) => ({
      ...libraryMoveDestinationsQueryOptions(target, {
        scope: { kind: "children", parent: { kind: "page", pageId } },
        limit: 100,
      }),
      enabled,
    })),
  });

export const useLibraryPageRelocationDestinations = (
  pageId: string,
  input: Parameters<typeof libraryPageRelocationDestinationsQueryOptions>[1],
  enabled = true,
) =>
  useQuery({
    ...libraryPageRelocationDestinationsQueryOptions(pageId, input),
    enabled,
  });

export const useLibraryPageRelocationChildren = (
  pageId: string,
  parentPageIds: readonly string[],
  enabled = true,
) =>
  useQueries({
    queries: parentPageIds.map((parentPageId) => ({
      ...libraryPageRelocationDestinationsQueryOptions(pageId, {
        scope: { kind: "page_children", parent: { kind: "page", pageId: parentPageId } },
        limit: 100,
      }),
      enabled,
    })),
  });

export const useInfiniteLibraryCatalog = (
  input: Omit<Parameters<typeof libraryCatalogQueryOptions>[0], "cursor"> = {},
) =>
  useInfiniteQuery({
    queryKey: queryKeys.library.catalogPages(input),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireReadValue(
        {
          read: {
            mode: "catalog",
            ...input,
            ...(pageParam ? { cursor: pageParam } : {}),
          },
        },
        "catalog",
      ),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    staleTime: 30_000,
  });
