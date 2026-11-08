import { useQueries, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { workspaceDirectoryQueryOptions } from "@/lib/query-options";
import type { WorkspaceDirectoryEntriesResult } from "@/lib/types";
import type { WorkspaceFileTreePath } from "./workspace-file-tree";

export interface WorkspaceDirectoryTree {
  /** Entries of the listed folder and of every expanded folder, folders included. */
  readonly paths: readonly WorkspaceFileTreePath[];
  /** Expanded folders, other than the listed one, whose first listing is still loading. */
  readonly loadingDirectoryPaths: readonly string[];
  /** The listed folder's entries have not arrived yet. */
  readonly isLoading: boolean;
  /** A listing that is already shown is being read again. */
  readonly isRefreshing: boolean;
  /** The listed folder is empty. */
  readonly isEmpty: boolean;
  /** The listed folder could not be read; a nested folder that cannot be read shows no entries. */
  readonly error: Error | null;
}

/** Combines the listed folder's and each expanded folder's listings, in that order. */
export function combineWorkspaceDirectoryListings(
  directoryPaths: readonly string[],
  results: readonly Pick<
    UseQueryResult<WorkspaceDirectoryEntriesResult>,
    "data" | "error" | "isFetching" | "isPending"
  >[],
): WorkspaceDirectoryTree {
  const byPath = new Map<string, WorkspaceFileTreePath>();
  const loadingDirectoryPaths: string[] = [];
  let isRefreshing = false;
  results.forEach((result, index) => {
    if (index > 0 && result.isPending && !result.data)
      loadingDirectoryPaths.push(directoryPaths[index]!);
    if (result.isFetching && result.data) isRefreshing = true;
    for (const entry of result.data?.entries ?? [])
      byPath.set(entry.path, { path: entry.path, kind: entry.type });
  });
  const listed = results[0];
  return {
    paths: [...byPath.values()],
    loadingDirectoryPaths,
    isLoading: Boolean(listed?.isPending && !listed.data),
    isRefreshing,
    isEmpty: listed?.data?.entries.length === 0,
    error: listed?.error ?? null,
  };
}

/**
 * Lists a local workspace folder and its expanded folders as one tree. Each folder is its own
 * cached query, so every tree over the same workspace shares the reads.
 */
export function useWorkspaceDirectoryTree({
  workspaceRoot,
  directoryPath = "",
  expandedPaths,
  enabled = true,
}: {
  readonly workspaceRoot: string | null;
  /** The listed folder, relative to the workspace root; the root by default. */
  readonly directoryPath?: string;
  /** Expanded folders, relative to the workspace root. */
  readonly expandedPaths: readonly string[];
  readonly enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const directoryPaths =
    enabled && workspaceRoot
      ? [
          directoryPath,
          ...[...new Set(expandedPaths)].filter((path) => path && path !== directoryPath).sort(),
        ]
      : [];
  const queryInput = (directoryPath: string) =>
    workspaceDirectoryQueryOptions({
      hostId: "local",
      workspaceRoot: workspaceRoot ?? "",
      directoryPath,
      includeHidden: true,
    });
  const refresh = () => {
    for (const directoryPath of directoryPaths)
      void queryClient.invalidateQueries({ queryKey: queryInput(directoryPath).queryKey });
  };
  return useQueries({
    queries: directoryPaths.map(queryInput),
    combine: (results) => ({
      ...combineWorkspaceDirectoryListings(directoryPaths, results),
      refresh,
    }),
  });
}
