import { getIntl } from "@/lib/i18n";
import type { ReviewDiffEntry, ReviewDiffRequest, ReviewDiffResult } from "@/lib/types";
import { recordReviewRuntimeEvent } from "@/features/review/testing/review-runtime-probe";
import type { GitWorkerQueryClient } from "./git-query";

interface ReviewDiffWaiter {
  path: string;
  previousPath: string | null;
  untracked: boolean;
  status: ReviewDiffEntry["status"];
  revision: string | null;
  signal?: AbortSignal;
  resolve: (entry: ReviewDiffEntry | null) => void;
  reject: (error: unknown) => void;
}

interface ReviewDiffBucket {
  request: Omit<ReviewDiffRequest, "files" | "requestId">;
  client: GitWorkerQueryClient;
  waiters: ReviewDiffWaiter[];
}

const REVIEW_DIFF_TIMEOUT_MS = 15_000;
const buckets = new Map<string, ReviewDiffBucket>();

export class StaleReviewSnapshot extends Error {
  constructor() {
    super("The Git review snapshot is stale");
    this.name = "StaleReviewSnapshot";
  }
}

function buildAbortError(): DOMException {
  return new DOMException("Review diff request aborted", "AbortError");
}

function findReviewDiffEntry(
  result: ReviewDiffResult,
  waiter: ReviewDiffWaiter,
): ReviewDiffEntry | null {
  if (result.type === "stale-snapshot") {
    throw new StaleReviewSnapshot();
  }
  return (
    result.files.find(
      (entry) =>
        entry.path === waiter.path ||
        entry.previousPath === waiter.path ||
        (waiter.previousPath !== null && entry.path === waiter.previousPath),
    ) ?? null
  );
}

async function invokeReviewDiffGroup(
  bucket: ReviewDiffBucket,
  waiters: ReviewDiffWaiter[],
): Promise<void> {
  const activeWaiters = waiters.filter((waiter) => !waiter.signal?.aborted);
  for (const waiter of waiters) {
    if (waiter.signal?.aborted) waiter.reject(buildAbortError());
  }
  if (activeWaiters.length === 0) return;

  recordReviewRuntimeEvent({
    type: "diff-batch",
    pathCount: activeWaiters.length,
    untracked: activeWaiters.every((waiter) => waiter.untracked),
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  const settledWaiters = new Set<ReviewDiffWaiter>();
  let groupCancelled = false;
  const cancelGroup = () => {
    if (groupCancelled) return;
    groupCancelled = true;
    recordReviewRuntimeEvent({ type: "abort", operation: "diff" });
    controller.abort();
  };
  const rejectWaiter = (waiter: ReviewDiffWaiter, error: unknown) => {
    if (settledWaiters.has(waiter)) return;
    settledWaiters.add(waiter);
    waiter.reject(error);
  };
  const resolveWaiter = (waiter: ReviewDiffWaiter, entry: ReviewDiffEntry | null) => {
    if (settledWaiters.has(waiter)) return;
    settledWaiters.add(waiter);
    waiter.resolve(entry);
  };
  const abortListeners = activeWaiters.map((waiter) => {
    const listener = () => {
      rejectWaiter(waiter, buildAbortError());
      if (activeWaiters.every((candidate) => candidate.signal?.aborted)) {
        cancelGroup();
      }
    };
    waiter.signal?.addEventListener("abort", listener, { once: true });
    return { waiter, listener };
  });
  try {
    const result = (await Promise.race([
      bucket.client.request({
        method: "review-diff",
        signal: controller.signal,
        params: {
          ...bucket.request,
          files: activeWaiters.map((waiter) => ({
            path: waiter.path,
            previousPath: waiter.previousPath,
            status: waiter.status,
            revision: waiter.revision,
          })),
        },
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          cancelGroup();
          reject(
            new Error(
              getIntl().formatMessage({
                id: "review.reviewDiffBatcher.timeout",
                defaultMessage: "Review diff request timed out.",
              }),
            ),
          );
        }, REVIEW_DIFF_TIMEOUT_MS);
      }),
    ])) as ReviewDiffResult;
    if (result.type === "stale-snapshot") {
      recordReviewRuntimeEvent({ type: "stale-discard", operation: "diff" });
      throw new StaleReviewSnapshot();
    }
    if (
      bucket.request.snapshotGeneration !== undefined &&
      bucket.request.snapshotGeneration !== null &&
      result.snapshotGeneration !== bucket.request.snapshotGeneration
    ) {
      recordReviewRuntimeEvent({ type: "stale-discard", operation: "diff" });
      throw new StaleReviewSnapshot();
    }
    for (const waiter of activeWaiters) {
      if (waiter.signal?.aborted) {
        rejectWaiter(waiter, buildAbortError());
        continue;
      }
      resolveWaiter(waiter, findReviewDiffEntry(result, waiter));
    }
  } catch (error) {
    cancelGroup();
    for (const waiter of activeWaiters) rejectWaiter(waiter, error);
  } finally {
    if (timeout !== null) clearTimeout(timeout);
    for (const { waiter, listener } of abortListeners) {
      waiter.signal?.removeEventListener("abort", listener);
    }
  }
}

async function flushBucket(key: string, bucket: ReviewDiffBucket) {
  if (buckets.get(key) === bucket) buckets.delete(key);
  const tracked = bucket.waiters.filter((waiter) => !waiter.untracked);
  const untracked = bucket.waiters.filter((waiter) => waiter.untracked);
  await Promise.all([
    invokeReviewDiffGroup(bucket, tracked),
    invokeReviewDiffGroup(bucket, untracked),
  ]);
}

function scheduleBucketFlush(key: string, bucket: ReviewDiffBucket): void {
  queueMicrotask(() => {
    queueMicrotask(() => {
      void flushBucket(key, bucket);
    });
  });
}

export function requestReviewDiffPath(input: {
  bucketKey: string;
  request: Omit<ReviewDiffRequest, "files" | "requestId">;
  path: string;
  previousPath: string | null;
  untracked: boolean;
  status: ReviewDiffEntry["status"];
  revision: string | null;
  signal?: AbortSignal;
  client: GitWorkerQueryClient;
}): Promise<ReviewDiffEntry | null> {
  if (input.signal?.aborted) return Promise.reject(buildAbortError());

  return new Promise((resolve, reject) => {
    const key = JSON.stringify([input.bucketKey, input.request]);
    const waiter: ReviewDiffWaiter = {
      path: input.path,
      previousPath: input.previousPath,
      untracked: input.untracked,
      status: input.status,
      revision: input.revision,
      signal: input.signal,
      resolve,
      reject,
    };
    const existing = buckets.get(key);
    if (existing) {
      existing.waiters.push(waiter);
      return;
    }

    const bucket: ReviewDiffBucket = {
      request: input.request,
      client: input.client,
      waiters: [waiter],
    };
    buckets.set(key, bucket);
    scheduleBucketFlush(key, bucket);
  });
}

export function __resetReviewDiffBatcherForTests(): void {
  buckets.clear();
}
