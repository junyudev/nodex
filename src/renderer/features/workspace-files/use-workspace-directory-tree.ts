import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { workspaceDirectoryQueryOptions } from "@/lib/query-options";
import type { WorkspaceFileTreePath } from "./workspace-file-tree";

/**
 * Lists a local workspace folder's expanded directories as tree paths. Each expanded directory is
 * its own cached query, so every tree over the same folder shares the reads.
 */
export function useWorkspaceDirectoryTree({
  workspaceRoot,
  expandedPaths,
  enabled = true,
}: {
  readonly workspaceRoot: string | null;
  readonly expandedPaths: ReadonlySet<string>;
  readonly enabled?: boolean;
}) {
  const queryClient = useQueryClient();
  const directoryPaths = useMemo(
    () => (enabled && workspaceRoot ? [...expandedPaths].sort() : []),
    [enabled, expandedPaths, workspaceRoot],
  );
  const queryInput = useCallback(
    (directoryPath: string) =>
      workspaceDirectoryQueryOptions({
        hostId: "local",
        workspaceRoot: workspaceRoot ?? "",
        directoryPath,
        includeHidden: true,
      }),
    [workspaceRoot],
  );
  const queries = useQueries({ queries: directoryPaths.map(queryInput) });
  const byPath = new Map<string, WorkspaceFileTreePath>();
  for (const query of queries) {
    for (const entry of query.data?.entries ?? []) {
      byPath.set(entry.path, { path: entry.path, kind: entry.type });
    }
  }
  const paths = [...byPath.values()];
  const error = queries.find((query) => query.error)?.error ?? null;
  const isPending = (directoryPath: string) =>
    queries[directoryPaths.indexOf(directoryPath)]?.isPending ?? false;
  const refresh = useCallback(() => {
    for (const directoryPath of directoryPaths) {
      void queryClient.invalidateQueries({ queryKey: queryInput(directoryPath).queryKey });
    }
  }, [directoryPaths, queryClient, queryInput]);
  return { paths, error, isPending, refresh };
}
