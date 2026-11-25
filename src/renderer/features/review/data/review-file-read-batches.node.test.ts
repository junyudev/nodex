import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  GitReviewCatFileInput,
  GitReviewCatFileOutput,
  ReviewDiffRequest,
  ReviewDiffResult,
} from "@/lib/types";
import {
  __resetReviewCatFileBatcherForTests,
  requestReviewCatFile,
} from "./review-cat-file-batcher";
import type { GitWorkerQueryClient } from "./git-query";
import { buildReviewFileSafety } from "../../../../shared/review-file-safety";
import {
  __resetReviewDiffBatcherForTests,
  requestReviewDiffPath,
  StaleReviewSnapshot,
} from "./review-diff-batcher";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  __resetReviewFullContentStoreForTests,
  loadReviewFullContent,
  readReviewFullContentState,
  type ReviewFullFileContents,
} from "./review-full-content-store";

describe("review cat file batcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetReviewCatFileBatcherForTests();
  });

  afterEach(() => {
    __resetReviewCatFileBatcherForTests();
    vi.useRealTimers();
  });

  describe("review cat-file batcher", () => {
    test("waits 40ms and packs complete row requests into four-object batches", async () => {
      const workerRequest = vi.fn(
        async (input: GitReviewCatFileInput): Promise<GitReviewCatFileOutput> => ({
          snapshotGeneration: input.snapshotGeneration,
          results: input.requests.map((request) => ({
            type: "success" as const,
            lines: [`${request.path}\n`],
          })),
        }),
      );
      const client = {
        request: async (input: { params: GitReviewCatFileInput }) => ({
          type: "success",
          value: await workerRequest(input.params),
        }),
        subscribe: () => () => undefined,
      } as GitWorkerQueryClient;
      const requestRow = (path: string) =>
        requestReviewCatFile({
          bucketKey: "local",
          cwd: "/repo",
          snapshotGeneration: 7,
          requests: [
            { oid: `${path}:old`, path },
            { oid: `${path}:new`, path },
          ],
          client,
        });

      const rows = [requestRow("a"), requestRow("b"), requestRow("c")];
      expect(workerRequest).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      const results = await Promise.all(rows);

      expect(workerRequest).toHaveBeenCalledTimes(2);
      expect(workerRequest.mock.calls[0]?.[0].requests).toHaveLength(4);
      expect(workerRequest.mock.calls[1]?.[0].requests).toHaveLength(2);
      expect(results[2]?.map((result) => result.type)).toEqual(["success", "success"]);
    });
  });
});

describe("review diff batcher", () => {
  function createWorkerClient(
    request: (input: ReviewDiffRequest) => Promise<ReviewDiffResult>,
    onAbort: () => void = () => undefined,
  ): GitWorkerQueryClient {
    return {
      request: async (input) => {
        input.signal?.addEventListener("abort", onAbort, { once: true });
        return (await request(input.params as ReviewDiffRequest)) as never;
      },
      subscribe: () => () => undefined,
    };
  }

  beforeEach(() => {
    __resetReviewDiffBatcherForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("review diff batcher", () => {
    test("double-microtask coalesces paths into separate tracked and untracked requests", async () => {
      const workerRequest = vi.fn(async (input: ReviewDiffRequest) => {
        const result: ReviewDiffResult = {
          type: "success",
          cwd: input.cwd,
          source: input.source,
          patch: "",
          files: (input.files ?? []).map((requestFile) => ({
            path: requestFile.path,
            previousPath: null,
            status: requestFile.status,
            rawStatus: null,
            oldOid: "old",
            newOid: "new",
            revision: requestFile.revision ?? requestFile.path,
            additions: 1,
            deletions: 0,
            safety: buildReviewFileSafety(),
            diff: `diff --git a/${requestFile.path} b/${requestFile.path}`,
            loadStatus: "loaded",
            renderKey: requestFile.path,
            diffBytes: 1,
            diffError: null,
            canApplyPatchActions: true,
            changedBytes: 1,
            tooLarge: false,
            tooLargeReason: null,
          })),
          isGitRepository: true,
          baseRef: null,
          currentBranch: "feature",
          defaultBranch: "main",
          errorMessage: null,
          snapshotGeneration: 3,
        };
        return result;
      });
      const request = {
        cwd: "/repo",
        source: "unstaged" as const,
        snapshotGeneration: 3,
      };

      const results = await Promise.all([
        requestReviewDiffPath({
          bucketKey: "snapshot-3",
          request,
          path: "tracked-a.ts",
          previousPath: null,
          untracked: false,
          status: "modified",
          revision: "tracked-a",
          client: createWorkerClient(workerRequest),
        }),
        requestReviewDiffPath({
          bucketKey: "snapshot-3",
          request,
          path: "tracked-b.ts",
          previousPath: null,
          untracked: false,
          status: "modified",
          revision: "tracked-b",
          client: createWorkerClient(workerRequest),
        }),
        requestReviewDiffPath({
          bucketKey: "snapshot-3",
          request,
          path: "untracked.ts",
          previousPath: null,
          untracked: true,
          status: "untracked",
          revision: "untracked",
          client: createWorkerClient(workerRequest),
        }),
      ]);

      const diffCalls = workerRequest.mock.calls;
      expect(diffCalls).toHaveLength(2);
      expect(diffCalls.map(([input]) => input.files)).toEqual([
        [
          {
            path: "tracked-a.ts",
            previousPath: null,
            status: "modified",
            revision: "tracked-a",
          },
          {
            path: "tracked-b.ts",
            previousPath: null,
            status: "modified",
            revision: "tracked-b",
          },
        ],
        [
          {
            path: "untracked.ts",
            previousPath: null,
            status: "untracked",
            revision: "untracked",
          },
        ],
      ]);
      expect(results.map((entry) => entry?.path)).toEqual([
        "tracked-a.ts",
        "tracked-b.ts",
        "untracked.ts",
      ]);
    });

    test("rejects only an aborted path and cancels main when the whole group is empty", async () => {
      let resolveDiff!: (result: ReviewDiffResult) => void;
      const workerRequest = vi.fn(async (input: ReviewDiffRequest) => {
        return new Promise<ReviewDiffResult>((resolve) => {
          resolveDiff = resolve;
        }).then((result) => ({ ...result, source: input.source }));
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const request = {
        cwd: "/repo",
        source: "unstaged" as const,
        snapshotGeneration: 3,
      };
      let workerAborts = 0;
      const workerClient = createWorkerClient(workerRequest, () => {
        workerAborts += 1;
      });
      const first = requestReviewDiffPath({
        bucketKey: "snapshot-3",
        request,
        path: "first.ts",
        previousPath: null,
        untracked: false,
        status: "modified",
        revision: "first",
        signal: firstController.signal,
        client: workerClient,
      });
      const second = requestReviewDiffPath({
        bucketKey: "snapshot-3",
        request,
        path: "second.ts",
        previousPath: null,
        untracked: false,
        status: "modified",
        revision: "second",
        signal: secondController.signal,
        client: workerClient,
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      firstController.abort();
      await expect(first).rejects.toMatchObject({ name: "AbortError" });
      expect(workerAborts).toBe(0);

      secondController.abort();
      await expect(second).rejects.toMatchObject({ name: "AbortError" });
      expect(workerAborts).toBe(1);

      resolveDiff({
        type: "success",
        cwd: "/repo",
        source: "unstaged",
        patch: "",
        files: [],
        isGitRepository: true,
        baseRef: null,
        currentBranch: "main",
        defaultBranch: "main",
        errorMessage: null,
        snapshotGeneration: 3,
      });
    });

    test("does not retry stale snapshot failures", async () => {
      const workerRequest = vi.fn(async () => {
        return { type: "stale-snapshot" as const, source: "unstaged" as const };
      });

      await expect(
        requestReviewDiffPath({
          bucketKey: "snapshot-2",
          request: {
            cwd: "/repo",
            source: "unstaged",
            snapshotGeneration: 2,
          },
          path: "stale.ts",
          previousPath: null,
          untracked: false,
          status: "modified",
          revision: "stale",
          client: createWorkerClient(workerRequest),
        }),
      ).rejects.toBeInstanceOf(StaleReviewSnapshot);

      expect(workerRequest.mock.calls).toHaveLength(1);
    });

    test("cancels the main request when a group reaches the fifteen second timeout", async () => {
      vi.useFakeTimers();
      const workerRequest = vi.fn(() => {
        return new Promise<never>(() => {});
      });
      let workerAborts = 0;
      const result = requestReviewDiffPath({
        bucketKey: "snapshot-timeout",
        request: {
          cwd: "/repo",
          source: "unstaged",
          snapshotGeneration: 3,
        },
        path: "slow.ts",
        previousPath: null,
        untracked: false,
        status: "modified",
        revision: "slow",
        client: createWorkerClient(workerRequest, () => {
          workerAborts += 1;
        }),
      });
      const rejection = expect(result).rejects.toThrow("timed out");
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);

      await rejection;
      expect(workerAborts).toBe(1);
      expect(workerRequest.mock.calls).toHaveLength(1);
    });
  });
});

describe("review full content store", () => {
  const FULL_CONTENTS: ReviewFullFileContents = {
    path: "src/example.ts",
    previousPath: null,
    oldText: "old\n",
    newText: "new\n",
    oldExists: true,
    newExists: true,
    oldStatus: "loaded",
    newStatus: "loaded",
    safety: buildReviewFileSafety(),
    errorMessage: null,
  };
  const FULL_METADATA = {
    name: "src/example.ts",
    isPartial: false,
  } as FileDiffMetadata;

  beforeEach(() => {
    __resetReviewFullContentStoreForTests();
  });

  describe("review full content store", () => {
    test("deduplicates the same cell identity and publishes one row-local result", async () => {
      const load = vi.fn(async () => FULL_CONTENTS);
      const input = {
        key: "snapshot-1:src/example.ts",
        identity: "snapshot-1",
        load,
        expand: () => FULL_METADATA,
      };

      await Promise.all([loadReviewFullContent(input), loadReviewFullContent(input)]);

      expect(load).toHaveBeenCalledTimes(1);
      expect(readReviewFullContentState(input.key)).toMatchObject({
        fullDiffMetadata: FULL_METADATA,
        fullContents: FULL_CONTENTS,
        fullContentLoadFailed: false,
        fullContentUnavailable: false,
        isLoadingFullContent: false,
      });
    });

    test("discards an older identity that resolves after a replacement load", async () => {
      let resolveOld!: (contents: ReviewFullFileContents) => void;
      const oldLoad = new Promise<ReviewFullFileContents>((resolve) => {
        resolveOld = resolve;
      });
      const key = "src/example.ts";
      const first = loadReviewFullContent({
        key,
        identity: "snapshot-1",
        load: () => oldLoad,
        expand: () => ({ ...FULL_METADATA, cacheKey: "old" }),
      });
      const second = loadReviewFullContent({
        key,
        identity: "snapshot-2",
        load: async () => FULL_CONTENTS,
        expand: () => ({ ...FULL_METADATA, cacheKey: "new" }),
      });

      await second;
      resolveOld(FULL_CONTENTS);
      await first;

      expect(readReviewFullContentState(key).fullDiffMetadata?.cacheKey).toBe("new");
    });

    test("keeps partial metadata when full content cannot be validated", async () => {
      const key = "snapshot-1:src/mismatch.ts";
      await loadReviewFullContent({
        key,
        identity: "snapshot-1",
        load: async () => FULL_CONTENTS,
        expand: () => null,
      });

      expect(readReviewFullContentState(key)).toMatchObject({
        fullDiffMetadata: null,
        fullContentLoadFailed: false,
        fullContentUnavailable: true,
        isLoadingFullContent: false,
      });
    });
  });
});
