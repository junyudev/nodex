import { hashKey, useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import type { AuthorizedReadStamp } from "../../shared/authorized-read-stamp";
import type { ContentAccessContext } from "../../shared/content-access-context";
import type {
  LibraryFile,
  LibraryFilePage,
  LibraryFileUsage,
  LibraryFileUsageFilter,
  LibraryFileUsagePage,
  LibraryFileVersion,
  LibraryFileVersionPage,
  LibraryPageFileInventory,
  LibraryPageFileItem,
} from "../../shared/library-files";
import type { ProjectionScope } from "../../shared/projection-stream";
import { readLibraryModule } from "./api";
import { invalidateExactQuery } from "./query-invalidation";
import { queryKeys } from "./query-keys";
import { useProjectionRegistration } from "./projection-invalidation-context";
import {
  admitResourceAuthorityQuery,
  resourceAuthorityQueryMeta,
} from "./resource-authority-query-cache";
import { useLibraryMetadata } from "./use-library-navigation";

const PAGE_SIZE = 50;

interface AuthorizedSnapshot<Value> {
  readonly value: Value;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: AuthorizedReadStamp | null;
}

const resolveFileQueryAuthority = (_queryKey: readonly unknown[], data: unknown) => {
  const candidate = data as {
    readonly authorization?: AuthorizedReadStamp | null;
    readonly pages?: readonly AuthorizedSnapshot<unknown>[];
  } | null;
  const authorizations = [
    ...(candidate?.authorization ? [candidate.authorization] : []),
    ...(candidate?.pages ?? []).flatMap((page) => (page.authorization ? [page.authorization] : [])),
  ];
  return authorizations.length > 0 ? { authorizations } : null;
};

const fileQueryMeta = resourceAuthorityQueryMeta(resolveFileQueryAuthority);

const projectionScope = (
  accessContext: ContentAccessContext,
  libraryId: string | null,
): ProjectionScope | null => {
  if (!libraryId) return null;
  return accessContext.kind === "library"
    ? { kind: "library", libraryId }
    : { kind: "project", libraryId, projectId: accessContext.projectId };
};

const snapshotCursor = (snapshot: AuthorizedSnapshot<unknown> | undefined) =>
  snapshot ? { storeEpoch: snapshot.storeEpoch, commitSeq: snapshot.commitSeq } : null;

type FileReadKind =
  | "resolved_page_file"
  | "file"
  | "files"
  | "page_file_inventory"
  | "file_usages"
  | "file_versions";
type FileReadPayload<Kind extends FileReadKind> = Kind extends "resolved_page_file"
  ? LibraryPageFileItem
  : Kind extends "file"
    ? LibraryFile
    : Kind extends "files"
      ? LibraryFilePage
      : Kind extends "page_file_inventory"
        ? LibraryPageFileInventory
        : Kind extends "file_usages"
          ? LibraryFileUsagePage
          : LibraryFileVersionPage;

const requireFileRead = async <Kind extends FileReadKind>(
  accessContext: ContentAccessContext,
  read: Parameters<typeof readLibraryModule>[1]["read"],
  kind: Kind,
): Promise<AuthorizedSnapshot<FileReadPayload<Kind>>> => {
  const result = await readLibraryModule(accessContext, { read });
  if (!result.ok) throw new Error(result.error.message || "Couldn’t read Files");
  if (result.value.value.kind !== kind) {
    throw new Error(`Library read returned ${result.value.value.kind}, expected ${kind}`);
  }
  return await admitResourceAuthorityQuery(
    {
      value: result.value.value.value as FileReadPayload<Kind>,
      libraryId: result.value.libraryId,
      storeEpoch: result.value.storeEpoch,
      commitSeq: result.value.commitSeq,
      authorization: result.value.authorization,
    },
    resolveFileQueryAuthority,
  );
};

export interface PageFilesReadModel {
  readonly inventory: LibraryPageFileInventory | null;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: Error | null;
  readonly loadMore: () => Promise<void>;
  readonly refresh: () => Promise<LibraryPageFileInventory>;
}

const mergeInventory = (
  pages: readonly AuthorizedSnapshot<LibraryPageFileInventory>[] | undefined,
): LibraryPageFileInventory | null => {
  const first = pages?.[0];
  if (!first) return null;
  return { ...first.value, files: pages.flatMap((page) => page.value.files) };
};

export function usePageFiles(
  accessContext: ContentAccessContext,
  pageId: string,
  options: { readonly query?: string; readonly enabled?: boolean } = {},
): PageFilesReadModel {
  const queryClient = useQueryClient();
  const normalizedQuery = options.query?.trim() ?? "";
  const queryKey = queryKeys.library.pageFilesWindow(accessContext, pageId, normalizedQuery);
  const library = useLibraryMetadata(pageId.length > 0);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireFileRead(
        accessContext,
        {
          mode: "page_file_inventory",
          page_id: pageId,
          limit: PAGE_SIZE,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        "page_file_inventory",
      ),
    getNextPageParam: (page) => page.value.next_cursor ?? undefined,
    enabled: (options.enabled ?? true) && pageId.length > 0,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    meta: fileQueryMeta,
  });
  const latest = query.data?.pages.at(-1);
  const scope = projectionScope(
    accessContext,
    library.data?.libraryId ?? latest?.libraryId ?? null,
  );
  useProjectionRegistration(
    scope
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({ pageIds: [pageId] }),
          getCursor: () => snapshotCursor(query.data?.pages.at(-1)),
          invalidate: () => invalidateExactQuery(queryClient, queryKey),
        }
      : null,
  );

  return {
    inventory: mergeInventory(query.data?.pages),
    loading: query.status === "pending",
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    error: query.error instanceof Error ? query.error : null,
    loadMore: async () => {
      await query.fetchNextPage();
    },
    refresh: async () => {
      const refreshed = await query.refetch();
      const inventory = mergeInventory(refreshed.data?.pages);
      if (!inventory) throw refreshed.error ?? new Error("Couldn’t refresh Page Files");
      return inventory;
    },
  };
}

export interface LibraryFileCatalogReadModel {
  readonly files: readonly LibraryFile[];
  readonly total: number;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly hasMore: boolean;
  readonly error: Error | null;
  readonly loadMore: () => Promise<void>;
  readonly refresh: () => Promise<void>;
}

export function useLibraryFileCatalog(
  accessContext: ContentAccessContext,
  options: {
    readonly lifecycle: "live" | "trashed";
    readonly usage: LibraryFileUsageFilter;
    readonly query?: string;
    readonly enabled?: boolean;
  },
): LibraryFileCatalogReadModel {
  const queryClient = useQueryClient();
  const normalizedQuery = options.query?.trim() ?? "";
  const queryKey = queryKeys.libraryFiles.catalog(
    accessContext,
    options.lifecycle,
    options.usage,
    normalizedQuery,
  );
  const library = useLibraryMetadata(options.enabled ?? true);
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireFileRead(
        accessContext,
        {
          mode: "files",
          lifecycle: options.lifecycle,
          usage: options.usage,
          limit: PAGE_SIZE,
          ...(normalizedQuery ? { query: normalizedQuery } : {}),
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        "files",
      ),
    getNextPageParam: (page) => page.value.next_cursor ?? undefined,
    enabled: options.enabled ?? true,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
    meta: fileQueryMeta,
  });
  const latest = query.data?.pages.at(-1);
  const scope = projectionScope(
    accessContext,
    library.data?.libraryId ?? latest?.libraryId ?? null,
  );
  useProjectionRegistration(
    scope
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({
            fileIds: query.data?.pages.flatMap((page) =>
              page.value.items.map((file) => file.file_id),
            ),
          }),
          getCursor: () => snapshotCursor(query.data?.pages.at(-1)),
          invalidate: () => invalidateExactQuery(queryClient, queryKey),
        }
      : null,
  );

  return {
    files: query.data?.pages.flatMap((page) => page.value.items) ?? [],
    total: query.data?.pages[0]?.value.total ?? 0,
    loading: query.status === "pending",
    loadingMore: query.isFetchingNextPage,
    hasMore: query.hasNextPage,
    error: query.error instanceof Error ? query.error : null,
    loadMore: async () => {
      await query.fetchNextPage();
    },
    refresh: async () => {
      await query.refetch();
    },
  };
}

export interface LibraryFileDetailReadModel {
  readonly usages: readonly LibraryFileUsage[];
  readonly versions: readonly LibraryFileVersion[];
  readonly canWrite: boolean;
  readonly canTrash: boolean;
  readonly canRestore: boolean;
  readonly canPurge: boolean;
  readonly loading: boolean;
  readonly loadingMoreUsages: boolean;
  readonly loadingMoreVersions: boolean;
  readonly hasMoreUsages: boolean;
  readonly hasMoreVersions: boolean;
  readonly error: Error | null;
  readonly loadMoreUsages: () => Promise<void>;
  readonly loadMoreVersions: () => Promise<void>;
}

export function useLibraryFileDetail(
  accessContext: ContentAccessContext,
  fileId: string | null,
): LibraryFileDetailReadModel {
  const queryClient = useQueryClient();
  const usagesKey = queryKeys.libraryFiles.usages(accessContext, fileId ?? "");
  const versionsKey = queryKeys.libraryFiles.versions(accessContext, fileId ?? "");
  const library = useLibraryMetadata(Boolean(fileId));
  const usages = useInfiniteQuery({
    queryKey: usagesKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireFileRead(
        accessContext,
        {
          mode: "file_usages",
          file_id: fileId!,
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        "file_usages",
      ),
    getNextPageParam: (page) => page.value.next_cursor ?? undefined,
    enabled: Boolean(fileId),
    staleTime: 5_000,
    meta: fileQueryMeta,
  });
  const versions = useInfiniteQuery({
    queryKey: versionsKey,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      requireFileRead(
        accessContext,
        {
          mode: "file_versions",
          file_id: fileId!,
          limit: PAGE_SIZE,
          ...(pageParam ? { cursor: pageParam } : {}),
        },
        "file_versions",
      ),
    getNextPageParam: (page) => page.value.next_cursor ?? undefined,
    enabled: Boolean(fileId),
    staleTime: 5_000,
    meta: fileQueryMeta,
  });
  const scope = projectionScope(
    accessContext,
    library.data?.libraryId ?? usages.data?.pages.at(-1)?.libraryId ?? null,
  );
  const registration = (
    queryKey: readonly unknown[],
    latest: AuthorizedSnapshot<unknown> | undefined,
  ) =>
    scope && fileId
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({
            fileIds: [fileId],
            pageIds: usages.data?.pages.flatMap((page) =>
              page.value.items.flatMap((use) =>
                use.target.kind === "page" ? [use.target.page_id] : [],
              ),
            ),
            canvasIds: usages.data?.pages.flatMap((page) =>
              page.value.items.flatMap((use) =>
                use.target.kind === "canvas" ? [use.target.canvas_id] : [],
              ),
            ),
          }),
          getCursor: () => snapshotCursor(latest),
          invalidate: () => invalidateExactQuery(queryClient, queryKey),
        }
      : null;
  useProjectionRegistration(registration(usagesKey, usages.data?.pages.at(-1)));
  useProjectionRegistration(registration(versionsKey, versions.data?.pages.at(-1)));
  const capabilities = usages.data?.pages[0]?.value;

  return {
    usages: usages.data?.pages.flatMap((page) => page.value.items) ?? [],
    versions: versions.data?.pages.flatMap((page) => page.value.items) ?? [],
    canWrite: capabilities?.can_write ?? false,
    canTrash: capabilities?.can_trash ?? false,
    canRestore: capabilities?.can_restore ?? false,
    canPurge: capabilities?.can_purge ?? false,
    loading: usages.isPending || versions.isPending,
    loadingMoreUsages: usages.isFetchingNextPage,
    loadingMoreVersions: versions.isFetchingNextPage,
    hasMoreUsages: usages.hasNextPage,
    hasMoreVersions: versions.hasNextPage,
    error:
      usages.error instanceof Error
        ? usages.error
        : versions.error instanceof Error
          ? versions.error
          : null,
    loadMoreUsages: async () => {
      await usages.fetchNextPage();
    },
    loadMoreVersions: async () => {
      await versions.fetchNextPage();
    },
  };
}

/** Selected identity is independent of catalog pagination and filters. */
export function useLibraryFile(accessContext: ContentAccessContext, fileId: string | null) {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.libraryFiles.file(accessContext, fileId ?? "");
  const query = useQuery({
    queryKey,
    queryFn: () => requireFileRead(accessContext, { mode: "file", file_id: fileId! }, "file"),
    enabled: Boolean(fileId),
    retry: false,
    meta: fileQueryMeta,
  });
  const scope = projectionScope(accessContext, query.data?.libraryId ?? null);
  useProjectionRegistration(
    scope && fileId
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({ fileIds: [fileId] }),
          getCursor: () => snapshotCursor(query.data),
          invalidate: () => invalidateExactQuery(queryClient, queryKey),
        }
      : null,
  );
  return {
    file: query.data?.value ?? null,
    loading: Boolean(fileId) && query.isPending,
    error: query.error,
    refresh: async () => (await query.refetch()).data?.value ?? null,
  };
}

export function usePageFile(
  accessContext: ContentAccessContext,
  pageId: string,
  fileId: string | null,
) {
  const queryClient = useQueryClient();
  const queryKey = ["libraryFiles", "pageFile", accessContext, pageId, fileId] as const;
  const query = useQuery({
    queryKey,
    queryFn: () =>
      requireFileRead(
        accessContext,
        {
          mode: "resolve_page_file",
          page_id: pageId,
          selector: { kind: "file_id", file_id: fileId! },
        },
        "resolved_page_file",
      ),
    enabled: Boolean(fileId),
    retry: false,
    meta: fileQueryMeta,
  });
  const scope = projectionScope(accessContext, query.data?.libraryId ?? null);
  useProjectionRegistration(
    scope && fileId
      ? {
          scope,
          consumerKey: hashKey(queryKey),
          getDependencies: () => ({ pageIds: [pageId], fileIds: [fileId] }),
          getCursor: () => snapshotCursor(query.data),
          invalidate: () => invalidateExactQuery(queryClient, queryKey),
        }
      : null,
  );
  return { item: query.data?.value ?? null, error: query.error, refresh: query.refetch };
}
