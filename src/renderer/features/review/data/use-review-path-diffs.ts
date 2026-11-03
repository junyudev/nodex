import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useLayoutEffect, useSyncExternalStore } from "react";
import type { GitReviewFileSummary, GitReviewSnapshot, ReviewDiffEntry } from "@/lib/types";
import { requestReviewDiffPath, StaleReviewSnapshot } from "./review-diff-batcher";
import type { GitWorkerQueryClient } from "./git-query";

const REVIEW_PATH_DIFF_STALE_TIME_MS = 5_000;
const REVIEW_PATH_DIFF_RETRY_COUNT = 3;
const REVIEW_PATH_DIFF_RETRY_BASE_DELAY_MS = 300;
const REVIEW_PATH_DIFF_RETRY_MAX_DELAY_MS = 2_000;

export interface ReviewPathDiffState {
  data: ReviewDiffEntry | null;
  error: Error | null;
  isFetching: boolean;
}

interface ReviewPathDiffQueryResult {
  data?: ReviewDiffEntry;
  error: unknown;
  isFetching: boolean;
}

interface ReviewPathDiffQueryInput {
  commitSha: string | null;
  commonDir: string | null;
  enabled: boolean;
  hideWhitespace: boolean;
  client: GitWorkerQueryClient;
  onStaleSnapshot: () => void;
  root: string | null;
  snapshot: GitReviewSnapshot | null;
}

interface ReviewInitialDiffGroup {
  entries: ReadonlyMap<string, ReviewDiffEntry>;
}

interface ReviewStaleRecoveryState {
  comparisonKey: string;
  highestGeneration: number;
  pathGenerations: Map<string, number>;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isStaleSnapshotError(error: unknown): boolean {
  return error instanceof StaleReviewSnapshot;
}

function shouldRetryReviewPathDiff(failureCount: number, error: unknown): boolean {
  return (
    failureCount < REVIEW_PATH_DIFF_RETRY_COUNT &&
    !isAbortError(error) &&
    !isStaleSnapshotError(error)
  );
}

function reviewPathDiffRetryDelay(attempt: number): number {
  return Math.min(
    REVIEW_PATH_DIFF_RETRY_BASE_DELAY_MS * 2 ** attempt,
    REVIEW_PATH_DIFF_RETRY_MAX_DELAY_MS,
  );
}

function buildReviewPathDiffComparisonKey(input: {
  baseRef: string | null;
  commitSha: string | null;
  commonDir: string | null;
  cwd: string;
  hideWhitespace: boolean;
  root: string | null;
  source: GitReviewSnapshot["source"];
}): string {
  return JSON.stringify([
    "local",
    input.commonDir,
    input.root,
    input.cwd,
    input.source,
    input.baseRef,
    input.source === "commit" ? input.commitSha : null,
    input.hideWhitespace,
  ]);
}

function buildReviewFileIdentity(file: GitReviewFileSummary): string {
  return JSON.stringify([file.path, file.previousPath, file.status, file.revision]);
}

function buildReviewPathDiffQueryKey(input: { comparisonKey: string; file: GitReviewFileSummary }) {
  return ["review", "path-diff", input.comparisonKey, buildReviewFileIdentity(input.file)] as const;
}

function buildReviewInitialDiffQueryKey(input: {
  comparisonKey: string;
  files: readonly GitReviewFileSummary[];
  group: "tracked" | "untracked";
}) {
  return [
    "review",
    "initial-path-diffs",
    input.comparisonKey,
    input.group,
    input.files.map(buildReviewFileIdentity),
  ] as const;
}

function isLoadedReviewDiffEntry(file: GitReviewFileSummary): file is ReviewDiffEntry {
  const candidate = file as Partial<ReviewDiffEntry>;
  return typeof candidate.diff === "string" && typeof candidate.loadStatus === "string";
}

function isReviewPathDiffEligible(file: GitReviewFileSummary): boolean {
  return file.safety.renderable && !isLoadedReviewDiffEntry(file);
}

function isMatchingReviewDiffEntry(
  entry: ReviewDiffEntry | undefined,
  file: GitReviewFileSummary,
): entry is ReviewDiffEntry {
  if (!entry) return false;
  return (
    entry.path === file.path &&
    entry.previousPath === file.previousPath &&
    entry.status === file.status &&
    entry.revision === file.revision
  );
}

function toReviewPathDiffError(error: unknown): Error | null {
  if (error instanceof Error) return error;
  if (error == null) return null;
  return new Error(String(error));
}

export function useReviewPathDiffs(
  input: ReviewPathDiffQueryInput,
): ReadonlyMap<string, ReviewPathDiffState> {
  const onStaleSnapshotRef = useRef(input.onStaleSnapshot);
  useLayoutEffect(() => {
    onStaleSnapshotRef.current = input.onStaleSnapshot;
  }, [input.onStaleSnapshot]);

  const snapshot = input.snapshot;
  const files = useMemo(() => snapshot?.files ?? [], [snapshot]);
  const eligibleFiles = useMemo(() => files.filter(isReviewPathDiffEligible), [files]);
  const trackedFiles = useMemo(
    () => eligibleFiles.filter((file) => file.status !== "untracked"),
    [eligibleFiles],
  );
  const untrackedFiles = useMemo(
    () => eligibleFiles.filter((file) => file.status === "untracked"),
    [eligibleFiles],
  );
  const baseRef = snapshot?.baseRef ?? null;
  const cwd = snapshot?.cwd ?? "";
  const source = snapshot?.source ?? "unstaged";
  const snapshotGeneration = snapshot?.snapshotGeneration ?? 0;
  const comparisonKey = buildReviewPathDiffComparisonKey({
    baseRef,
    commitSha: input.commitSha,
    commonDir: input.commonDir,
    cwd,
    hideWhitespace: input.hideWhitespace,
    root: input.root,
    source,
  });
  const recovery = useMemo(() => createStaleRecovery(comparisonKey), [comparisonKey]);
  const staleRecovery = useSyncExternalStore(recovery.subscribe, recovery.getSnapshot);

  const recordStaleSnapshot = useCallback(
    (pathIdentities: readonly string[], generation: number, nextComparisonKey: string) => {
      if (nextComparisonKey !== comparisonKey) return;
      if (recovery.record(pathIdentities, generation)) onStaleSnapshotRef.current();
    },
    [comparisonKey, recovery],
  );

  const clearRecoveredPath = useCallback(
    (pathIdentity: string, generation: number, nextComparisonKey: string) => {
      if (nextComparisonKey === comparisonKey) recovery.clear(pathIdentity, generation);
    },
    [comparisonKey, recovery],
  );

  const requestEntry = useCallback(
    async (inputFile: {
      file: GitReviewFileSummary;
      signal: AbortSignal;
    }): Promise<ReviewDiffEntry> => {
      if (!snapshot) throw new Error("Missing review diff metadata.");
      const pathIdentity = buildReviewFileIdentity(inputFile.file);
      const entry = await requestReviewDiffPath({
        bucketKey: JSON.stringify([comparisonKey, snapshotGeneration]),
        request: {
          cwd,
          source,
          baseRef,
          commitSha: source === "commit" ? input.commitSha : null,
          hideWhitespace: input.hideWhitespace,
          snapshotGeneration,
          operationSource: "review_model",
        },
        path: inputFile.file.path,
        previousPath: inputFile.file.previousPath,
        untracked: inputFile.file.status === "untracked",
        status: inputFile.file.status,
        revision: inputFile.file.revision,
        signal: inputFile.signal,
        client: input.client,
      }).catch((error: unknown) => {
        if (isStaleSnapshotError(error)) {
          recordStaleSnapshot([pathIdentity], snapshotGeneration, comparisonKey);
        }
        throw error;
      });
      if (!entry) throw new Error(`Could not load review diff for ${inputFile.file.path}.`);
      clearRecoveredPath(pathIdentity, snapshotGeneration, comparisonKey);
      return entry;
    },
    [
      baseRef,
      clearRecoveredPath,
      comparisonKey,
      cwd,
      input.client,
      input.commitSha,
      input.hideWhitespace,
      recordStaleSnapshot,
      snapshot,
      snapshotGeneration,
      source,
    ],
  );

  const initialQueryEnabled = input.enabled && snapshot !== null && snapshotGeneration > 0;
  const requestInitialGroup = useCallback(
    async (
      groupFiles: readonly GitReviewFileSummary[],
      signal: AbortSignal,
    ): Promise<ReviewInitialDiffGroup> => {
      const results = await Promise.allSettled(
        groupFiles.map((file) => requestEntry({ file, signal })),
      );
      const staleFailure = results.find(
        (result) => result.status === "rejected" && isStaleSnapshotError(result.reason),
      );
      if (staleFailure?.status === "rejected") throw staleFailure.reason;
      const entries = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      return { entries: new Map(entries.map((entry) => [entry.path, entry])) };
    },
    [requestEntry],
  );
  // The comparison and file revisions in the key are the semantic identity.
  // Callback identity is deliberately excluded so parent rerenders cannot
  // restart an otherwise identical initial group.
  const trackedInitialQuery = useQuery<ReviewInitialDiffGroup>({
    queryKey: buildReviewInitialDiffQueryKey({
      comparisonKey,
      files: trackedFiles,
      group: "tracked",
    }),
    queryFn: ({ signal }) => requestInitialGroup(trackedFiles, signal),
    enabled: initialQueryEnabled && trackedFiles.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: shouldRetryReviewPathDiff,
    retryDelay: reviewPathDiffRetryDelay,
  });
  // See the tracked group above: the key, not the callback object, owns cache
  // identity for this immutable comparison.
  const untrackedInitialQuery = useQuery<ReviewInitialDiffGroup>({
    queryKey: buildReviewInitialDiffQueryKey({
      comparisonKey,
      files: untrackedFiles,
      group: "untracked",
    }),
    queryFn: ({ signal }) => requestInitialGroup(untrackedFiles, signal),
    enabled: initialQueryEnabled && untrackedFiles.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: (previous) => previous,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    retry: shouldRetryReviewPathDiff,
    retryDelay: reviewPathDiffRetryDelay,
  });
  const trackedInitialData = trackedInitialQuery.data;
  const trackedInitialError = trackedInitialQuery.error;
  const trackedInitialIsFetched = trackedInitialQuery.isFetched;
  const trackedInitialIsFetching = trackedInitialQuery.isFetching;
  const untrackedInitialData = untrackedInitialQuery.data;
  const untrackedInitialError = untrackedInitialQuery.error;
  const untrackedInitialIsFetched = untrackedInitialQuery.isFetched;
  const untrackedInitialIsFetching = untrackedInitialQuery.isFetching;
  const fallbackResults = useQueries({
    queries: files.map((file) => {
      const untracked = file.status === "untracked";
      const initialData = untracked ? untrackedInitialData : trackedInitialData;
      const initialEntry = initialData?.entries.get(file.path);
      const hasMatchingInitialEntry = isMatchingReviewDiffEntry(initialEntry, file);
      const pathIdentity = buildReviewFileIdentity(file);
      const staleGeneration = staleRecovery.pathGenerations.get(pathIdentity);
      const staleGenerationRecovered =
        staleGeneration === undefined || snapshotGeneration > staleGeneration;
      const shouldFallback =
        (untracked ? untrackedInitialIsFetched : trackedInitialIsFetched) &&
        !(untracked ? untrackedInitialIsFetching : trackedInitialIsFetching) &&
        !hasMatchingInitialEntry;

      return {
        queryKey: snapshot
          ? buildReviewPathDiffQueryKey({ comparisonKey, file })
          : (["review", "path-diff", "disabled", file.path] as const),
        queryFn: ({ signal }: { signal: AbortSignal }) => requestEntry({ file, signal }),
        enabled:
          initialQueryEnabled &&
          isReviewPathDiffEligible(file) &&
          staleGenerationRecovered &&
          shouldFallback,
        placeholderData: hasMatchingInitialEntry ? initialEntry : undefined,
        staleTime: REVIEW_PATH_DIFF_STALE_TIME_MS,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        retry: shouldRetryReviewPathDiff,
        retryDelay: reviewPathDiffRetryDelay,
      };
    }),
    combine: useCallback((results: readonly ReviewPathDiffQueryResult[]) => results, []),
  });

  return useMemo(() => {
    const byPath = new Map<string, ReviewPathDiffState>();
    for (const [index, file] of files.entries()) {
      if (!isReviewPathDiffEligible(file)) continue;
      const untracked = file.status === "untracked";
      const initialData = untracked ? untrackedInitialData : trackedInitialData;
      const initialEntry = initialData?.entries.get(file.path);
      if (isMatchingReviewDiffEntry(initialEntry, file)) {
        byPath.set(file.path, {
          data: initialEntry,
          error: null,
          isFetching: false,
        });
        continue;
      }
      const fallback = fallbackResults[index];
      byPath.set(file.path, {
        data: fallback?.data ?? null,
        error: toReviewPathDiffError(
          fallback?.error ?? (untracked ? untrackedInitialError : trackedInitialError),
        ),
        isFetching:
          (untracked ? untrackedInitialIsFetching : trackedInitialIsFetching) ||
          fallback?.isFetching === true,
      });
    }
    return byPath;
  }, [
    fallbackResults,
    files,
    trackedInitialData,
    trackedInitialError,
    trackedInitialIsFetching,
    untrackedInitialData,
    untrackedInitialError,
    untrackedInitialIsFetching,
  ]);
}

/** Query callbacks publish immutable observations; rendering never reads the mutable request guard. */
function createStaleRecovery(comparisonKey: string) {
  let snapshot: ReviewStaleRecoveryState = {
    comparisonKey,
    highestGeneration: 0,
    pathGenerations: new Map(),
  };
  const listeners = new Set<() => void>();
  const publish = (next: ReviewStaleRecoveryState) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    record: (paths: readonly string[], generation: number): boolean => {
      const notify = generation > snapshot.highestGeneration;
      const pathGenerations = new Map(snapshot.pathGenerations);
      for (const path of paths) pathGenerations.set(path, generation);
      publish({
        ...snapshot,
        highestGeneration: Math.max(generation, snapshot.highestGeneration),
        pathGenerations,
      });
      return notify;
    },
    clear: (path: string, generation: number) => {
      const stale = snapshot.pathGenerations.get(path);
      if (stale === undefined || generation <= stale) return;
      const pathGenerations = new Map(snapshot.pathGenerations);
      pathGenerations.delete(path);
      publish({ ...snapshot, pathGenerations });
    },
  };
}
