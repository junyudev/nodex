import { useCallback, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { GitReviewSource } from "@/lib/types";
import type { BranchDiffStatsResult, GitStatusSummaryResult } from "../../../../shared/git-review";
import {
  buildGitWorkerQueryKey,
  createGitLiveWorkerQuery,
  getGitLiveQueryCoordinator,
  type GitQueryRepositoryIdentity,
} from "@/features/review/data/git-query";

export interface SummaryGitState {
  additions: number;
  currentBranch: string | null;
  cwd: string | null;
  defaultBranch: string | null;
  deletions: number;
  error: boolean;
  hasBranchChanges: boolean;
  hasRepository: boolean;
  hasUncommittedChanges: boolean;
  loading: boolean;
  primarySource: GitReviewSource;
  refresh(): Promise<void>;
}

export function resolveSummaryPrimaryGitSource(input: {
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number | null;
}): GitReviewSource {
  if (input.stagedCount > 0) return "staged";
  if (input.unstagedCount > 0 || (input.untrackedCount ?? 0) > 0) {
    return "unstaged";
  }
  return "branch";
}

function isSuccessfulStatus(
  result: GitStatusSummaryResult | undefined,
): result is Extract<GitStatusSummaryResult, { type: "success" }> {
  return result?.type === "success";
}

function isStaleSnapshotResult(result: unknown): result is { type: "stale-snapshot" } {
  return (
    typeof result === "object" &&
    result !== null &&
    "type" in result &&
    result.type === "stale-snapshot"
  );
}

export function useSummaryGitState(cwd: string | null, enabled: boolean): SummaryGitState {
  const queryClient = useQueryClient();
  const normalizedCwd = cwd?.trim() || null;
  const metadataInput = useMemo(
    () => ({
      method: "stable-metadata" as const,
      params: { cwd: normalizedCwd ?? "" },
    }),
    [normalizedCwd],
  );
  const metadata = useQuery({
    ...createGitLiveWorkerQuery(metadataInput),
    enabled: enabled && normalizedCwd !== null,
  });
  const repository = useMemo<GitQueryRepositoryIdentity | null>(() => {
    if (!metadata.data?.isGitRepository || !metadata.data.commonDir || !metadata.data.root) {
      return null;
    }
    return {
      hostId: "local",
      commonDir: metadata.data.commonDir,
      root: metadata.data.root,
    };
  }, [metadata.data]);
  const statusInput = useMemo(
    () => ({
      method: "status-summary" as const,
      params: {
        cwd: repository?.root ?? normalizedCwd ?? "",
        includeUntrackedFiles: true,
      },
      repository,
    }),
    [normalizedCwd, repository],
  );
  const statusQueryKey = useMemo(() => buildGitWorkerQueryKey(statusInput), [statusInput]);
  const status = useQuery({
    ...createGitLiveWorkerQuery(statusInput),
    enabled: enabled && repository !== null,
  });
  const [lastSuccessfulStatus, setLastSuccessfulStatus] = useState<Extract<
    GitStatusSummaryResult,
    { type: "success" }
  > | null>(null);
  if (status.data?.type === "success" && status.data !== lastSuccessfulStatus) {
    setLastSuccessfulStatus(status.data);
  }
  const statusFallbackEnabled =
    enabled &&
    repository !== null &&
    status.data?.type === "error" &&
    lastSuccessfulStatus === null;
  const stagedFallbackInput = useMemo(
    () => ({
      method: "review-summary" as const,
      params: {
        cwd: repository?.root ?? normalizedCwd ?? "",
        source: "staged" as const,
        includeUntrackedFiles: false,
      },
      repository,
    }),
    [normalizedCwd, repository],
  );
  const stagedFallback = useQuery({
    ...createGitLiveWorkerQuery(stagedFallbackInput),
    enabled: statusFallbackEnabled,
  });
  const unstagedFallbackInput = useMemo(
    () => ({
      method: "review-summary" as const,
      params: {
        cwd: repository?.root ?? normalizedCwd ?? "",
        source: "unstaged" as const,
        includeUntrackedFiles: true,
      },
      repository,
    }),
    [normalizedCwd, repository],
  );
  const unstagedFallback = useQuery({
    ...createGitLiveWorkerQuery(unstagedFallbackInput),
    enabled: statusFallbackEnabled,
  });
  const branchStatsInput = useMemo(
    () => ({
      method: "branch-diff-stats" as const,
      params: {
        cwd: repository?.root ?? normalizedCwd ?? "",
        includeUntrackedFiles: true,
      },
      repository,
    }),
    [normalizedCwd, repository],
  );
  const branchStatsQueryKey = useMemo(
    () => buildGitWorkerQueryKey(branchStatsInput),
    [branchStatsInput],
  );
  const branchStats = useQuery({
    ...createGitLiveWorkerQuery(branchStatsInput),
    enabled: enabled && repository !== null,
  });
  const coordinator = useMemo(() => getGitLiveQueryCoordinator(queryClient), [queryClient]);

  const refresh = useCallback(async () => {
    await Promise.all([
      coordinator.refresh(statusQueryKey),
      coordinator.refresh(branchStatsQueryKey),
      coordinator.refresh(buildGitWorkerQueryKey(metadataInput)),
    ]);
  }, [branchStatsQueryKey, coordinator, metadataInput, statusQueryKey]);

  const statusResult = status.data;
  const fallbackStageCounts =
    stagedFallback.data?.type === "success"
      ? stagedFallback.data.stageCounts
      : unstagedFallback.data?.type === "success"
        ? unstagedFallback.data.stageCounts
        : null;
  const fallbackStatus = fallbackStageCounts
    ? {
        type: "success" as const,
        stagedCount: fallbackStageCounts.stagedFileCount,
        unstagedCount: fallbackStageCounts.unstagedFileCount,
        untrackedCount: fallbackStageCounts.untrackedFileCount,
        snapshotGeneration: 0,
      }
    : null;
  const statusData = isSuccessfulStatus(statusResult)
    ? statusResult
    : (lastSuccessfulStatus ?? fallbackStatus);
  const branchResult = branchStats.data;
  const branchData: BranchDiffStatsResult | null =
    branchResult && !isStaleSnapshotResult(branchResult) ? branchResult : null;
  const stagedCount = statusData?.stagedCount ?? 0;
  const unstagedCount = statusData?.unstagedCount ?? 0;
  const untrackedCount = statusData?.untrackedCount ?? null;
  const hasUncommittedChanges = stagedCount > 0 || unstagedCount > 0 || (untrackedCount ?? 0) > 0;
  const hasBranchChanges = (branchData?.fileCount ?? 0) > 0;
  const loading =
    enabled &&
    normalizedCwd !== null &&
    (metadata.isLoading ||
      (repository !== null &&
        (status.isLoading ||
          (statusFallbackEnabled && stagedFallback.isLoading && unstagedFallback.isLoading) ||
          statusData?.untrackedCount === null ||
          branchStats.isLoading)));

  return {
    additions: branchData?.additions ?? 0,
    currentBranch: branchData?.currentBranch ?? metadata.data?.currentBranch ?? null,
    cwd: normalizedCwd,
    defaultBranch: branchData?.defaultBranch ?? metadata.data?.defaultBranch ?? null,
    deletions: branchData?.deletions ?? 0,
    error:
      metadata.isError || status.isError || (status.data?.type === "error" && statusData === null),
    hasBranchChanges,
    hasRepository: metadata.data?.isGitRepository === true,
    hasUncommittedChanges,
    loading,
    primarySource: resolveSummaryPrimaryGitSource({
      stagedCount,
      unstagedCount,
      untrackedCount,
    }),
    refresh,
  };
}
