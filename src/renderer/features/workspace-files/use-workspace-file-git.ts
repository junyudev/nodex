import { useQuery } from "@tanstack/react-query";
import { createGitWorkerQuery } from "@/features/review/data/git-query";
import type { GitWorkerClient } from "@/lib/git-worker-client";
import {
  loadWorkspaceFileComparison,
  WorkspaceFileGitStaleError,
  type WorkspaceFileGitInput,
  type WorkspaceFileGitRead,
} from "./workspace-file-git-model";

export type {
  WorkspaceFileGitInput,
  WorkspaceFileGitSource,
  WorkspaceFileComparisonInput,
} from "./workspace-file-git-model";

/** A saved revision is the disk mtime or a save counter, never the keystroke/document version. */
export function workspaceFileComparisonQueryOptions(
  input: WorkspaceFileGitInput,
  client?: Pick<GitWorkerClient, "request">,
) {
  const requestInput: WorkspaceFileGitInput = {
    hostId: input.hostId,
    cwd: input.cwd,
    path: input.path,
    savedRevision: input.savedRevision,
    source: input.source ?? null,
    hasUnsavedChanges: input.hasUnsavedChanges ?? false,
  };
  const metadata = createGitWorkerQuery(
    { method: "stable-metadata", params: { cwd: input.cwd } },
    client,
  );
  // Transport object identity does not change repository data; requestInput captures the complete read selection.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  return {
    ...metadata,
    queryKey: ["workspace-file-git", "comparison", requestInput],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const read: WorkspaceFileGitRead = async (method, params) =>
        await createGitWorkerQuery({ method, params }, client).queryFn({ signal });
      return await loadWorkspaceFileComparison(requestInput, read);
    },
    enabled: input.hostId === "local" && Boolean(input.cwd && input.path),
    staleTime: 5_000,
    retry: (count: number, error: Error) =>
      error instanceof WorkspaceFileGitStaleError && count < 1,
  };
}

export function workspaceFileBlameQueryOptions(
  input: WorkspaceFileGitInput,
  client?: Pick<GitWorkerClient, "request">,
) {
  const query = createGitWorkerQuery(
    { method: "blame-file", params: { cwd: input.cwd, path: input.path } },
    client,
  );
  return {
    ...query,
    queryKey: [...query.queryKey, input.hostId, input.savedRevision],
    enabled: input.hostId === "local" && Boolean(input.cwd && input.path),
    staleTime: 5_000,
  };
}

export function useWorkspaceFileBlame(
  input: WorkspaceFileGitInput & {
    readonly enabled?: boolean;
  },
) {
  const options = workspaceFileBlameQueryOptions(input);
  return useQuery({ ...options, enabled: options.enabled && input.enabled !== false });
}

/** The comparison for a file's saved revision; the caller pairs it with the live draft. */
export function useWorkspaceFileGit(input: WorkspaceFileGitInput & { readonly enabled?: boolean }) {
  const options = workspaceFileComparisonQueryOptions(input);
  const query = useQuery({ ...options, enabled: options.enabled && input.enabled !== false });
  return { query, comparison: query.data ?? null };
}
