import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createGitLiveWorkerQuery,
  getGitLiveQueryCoordinator,
  type GitQueryRepositoryIdentity,
} from "@/features/review/data/git-query";
import {
  projectWorkspaceFileChanges,
  resolveWorkspaceFileComparison,
  shouldDeriveWorkspaceFileComparison,
  type WorkspaceFileComparison,
} from "./workspace-file-changes";
import type { WorkspaceFileChange } from "./workspace-file-changes-tree-model";

export interface UseWorkspaceFileChangesOptions {
  readonly enabled?: boolean;
  readonly hostId?: string;
  readonly comparison?: WorkspaceFileComparison | null;
  readonly comparisonRoot?: string | null;
  /** Transcript changes are supplied by the conversation owner, never inferred from working-tree status. */
  readonly turnFiles?: readonly WorkspaceFileChange[];
}

/** Shares Review's live repository queries and coordinator; no independent watcher or polling loop. */
export function useWorkspaceFileChanges(
  workspaceRoot: string | null,
  options: UseWorkspaceFileChangesOptions = {},
) {
  const queryClient = useQueryClient();
  const coordinator = getGitLiveQueryCoordinator(queryClient);
  const enabled =
    options.enabled !== false && (options.hostId ?? "local") === "local" && !!workspaceRoot;
  const metadata = useQuery({
    ...createGitLiveWorkerQuery({
      method: "stable-metadata",
      params: { cwd: workspaceRoot ?? "" },
    }),
    enabled,
  });
  const value = enabled ? metadata.data : undefined;
  const repository: GitQueryRepositoryIdentity | null =
    value?.isGitRepository && value.root && value.commonDir
      ? { hostId: "local", root: value.root, commonDir: value.commonDir }
      : null;
  const comparisonContext = {
    comparison: options.comparison,
    comparisonRoot: options.comparisonRoot,
    repositoryRoot: repository?.root ?? null,
  };
  const deriveComparison = shouldDeriveWorkspaceFileComparison(comparisonContext);
  const baseBranch = useQuery({
    ...createGitLiveWorkerQuery({
      method: "base-branch",
      params: { cwd: repository?.root ?? "" },
      repository,
    }),
    enabled: enabled && repository !== null && deriveComparison,
  });
  const comparison = enabled
    ? resolveWorkspaceFileComparison({
        ...comparisonContext,
        baseBranch: baseBranch.isError ? null : baseBranch.data,
      })
    : null;
  const gitComparison =
    comparison?.kind === "git" || comparison?.kind === "commit" ? comparison : null;
  const summaryOptions = createGitLiveWorkerQuery({
    method: "review-summary",
    params: {
      cwd: repository?.root ?? "",
      source: gitComparison?.kind === "commit" ? "commit" : (gitComparison?.mode ?? "unstaged"),
      baseBranch:
        gitComparison?.kind === "git" && gitComparison.mode === "branch"
          ? gitComparison.baseRef
          : null,
      commitSha: gitComparison?.kind === "commit" ? gitComparison.sha : null,
      hideWhitespace: false,
      includeUntrackedFiles: true,
    },
    repository,
  });
  const summary = useQuery({
    ...summaryOptions,
    enabled: enabled && repository !== null && gitComparison !== null,
  });
  const result = enabled && gitComparison !== null ? summary.data : undefined;
  const isTranscript = comparison?.kind === "last-turn" || comparison?.kind === "selected-turn";
  const files: readonly WorkspaceFileChange[] = isTranscript
    ? (options.turnFiles ?? [])
    : result?.type === "success" && repository && workspaceRoot
      ? projectWorkspaceFileChanges({
          files: result.files,
          repositoryRoot: repository.root,
          workspaceRoot,
        })
      : [];
  return {
    files,
    comparison,
    repository,
    summary: result,
    loading:
      enabled &&
      !isTranscript &&
      (metadata.isPending || (repository !== null && (comparison === null || summary.isPending))),
    error: enabled
      ? (metadata.error ??
        (value?.errorMessage ? new Error(value.errorMessage) : null) ??
        (gitComparison
          ? (summary.error ??
            (result?.type === "error"
              ? new Error(result.errorMessage ?? "Could not load changes")
              : null))
          : null))
      : null,
    /** Independent of filtering; pass this to the All changes action. */
    reviewTarget:
      comparison && (repository || isTranscript)
        ? { repositoryRoot: repository?.root ?? null, comparison }
        : null,
    showAllChanges:
      enabled &&
      comparison !== null &&
      (files.length > 0 ||
        (repository !== null &&
          options.comparisonRoot === repository.root &&
          options.comparison != null)),
    refresh: async () => {
      if (!enabled) return;
      await metadata.refetch();
      if (!repository || !gitComparison) return;
      if (deriveComparison) await baseBranch.refetch();
      if (!(await coordinator.refresh(summaryOptions.queryKey))) await summary.refetch();
    },
  };
}
