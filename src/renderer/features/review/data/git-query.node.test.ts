import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  GitWorkerMessageForView,
  GitWorkerMethod,
  GitWorkerMethodMap,
} from "../../../../shared/git-worker-protocol";
import {
  acceptsGitLiveUpdate,
  buildGitWorkerQueryKey,
  createGitLiveWorkerQuery,
  GitLiveQueryCoordinator,
  type GitWorkerQueryClient,
} from "./git-query";

class FakeGitWorkerClient implements GitWorkerQueryClient {
  readonly requests: Array<{ method: GitWorkerMethod; params: unknown }> = [];
  readonly #listeners = new Set<(message: GitWorkerMessageForView) => void>();

  async request<Method extends GitWorkerMethod>(input: {
    method: Method;
    params: GitWorkerMethodMap[Method]["params"];
    signal?: AbortSignal;
  }): Promise<GitWorkerMethodMap[Method]["result"]> {
    this.requests.push({ method: input.method, params: input.params });
    const value =
      input.method === "subscribe-live-query"
        ? { subscribed: true }
        : input.method === "unsubscribe-live-query"
          ? { unsubscribed: true }
          : input.method === "recover-live-query"
            ? { recovered: true }
            : input.method === "refresh-live-query"
              ? { refreshed: true }
              : {
                  cwd: "/repo",
                  baseRef: "main",
                  files: [],
                  additions: 0,
                  deletions: 0,
                  isGitRepository: true,
                  currentBranch: "feature",
                  defaultBranch: "main",
                  errorMessage: null,
                };
    return value as GitWorkerMethodMap[Method]["result"];
  }

  subscribe(listener: (message: GitWorkerMessageForView) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(message: GitWorkerMessageForView): void {
    for (const listener of this.#listeners) listener(message);
  }
}

function subscriptionId(client: FakeGitWorkerClient): string {
  const request = client.requests.find((candidate) => candidate.method === "subscribe-live-query");
  if (!request) throw new Error("Expected a live query subscription");
  return (request.params as { subscriptionId: string }).subscriptionId;
}

afterEach(() => {
  vi.useRealTimers();
});

function statsResult(fileCount: number) {
  return {
    cwd: "/repo",
    baseRef: "main",
    files: [],
    fileCount,
    additions: fileCount,
    deletions: 0,
    untrackedFilesOmitted: 0,
    isGitRepository: true,
    currentBranch: "feature",
    defaultBranch: "main",
    errorMessage: null,
  };
}

/** One observed live query on a fake worker, with a controllable window focus. */
async function observeLiveStats(seed?: ReturnType<typeof statsResult>) {
  const queryClient = new QueryClient();
  const workerClient = new FakeGitWorkerClient();
  let focus = () => {};
  const coordinator = new GitLiveQueryCoordinator(queryClient, workerClient, (listener) => {
    focus = listener;
    return () => {};
  });
  const options = createGitLiveWorkerQuery(
    { method: "branch-diff-stats", params: { cwd: "/repo" } },
    workerClient,
  );
  if (seed) queryClient.setQueryData(options.queryKey, seed);
  const release = new QueryObserver(queryClient, options).subscribe(() => undefined);
  await Promise.resolve();
  const emit = (update: {
    generation: number;
    phase: "tracked" | "complete";
    fileCount: number;
    requiresRecovery?: boolean;
  }) =>
    workerClient.emit({
      type: "git-live-query-event",
      workerId: "git",
      event: {
        type: "git-live-query-updated",
        subscriptionId: subscriptionId(workerClient),
        generation: update.generation,
        requiresRecovery: update.requiresRecovery ?? false,
        phase: update.phase,
        method: "branch-diff-stats",
        result: statsResult(update.fileCount),
      },
    });
  const shownFileCount = () =>
    (queryClient.getQueryData(options.queryKey) as ReturnType<typeof statsResult>).fileCount;
  const recoveries = () =>
    workerClient.requests.filter((request) => request.method === "recover-live-query").length;
  return {
    workerClient,
    emit,
    shownFileCount,
    recoveries,
    focus: () => focus(),
    dispose: () => {
      release();
      coordinator.dispose();
    },
  };
}

describe("live update completeness", () => {
  test.each([
    ["accepts the first result", null, { generation: 1, phase: "tracked" }, true],
    [
      "completes the same generation",
      { generation: 1, phase: "tracked" },
      { generation: 1, phase: "complete" },
      true,
    ],
    [
      "keeps a complete result over a later partial one",
      { generation: 1, phase: "complete" },
      { generation: 2, phase: "tracked" },
      false,
    ],
    [
      "replaces a complete result with a later complete one",
      { generation: 1, phase: "complete" },
      { generation: 2, phase: "complete" },
      true,
    ],
    [
      "ignores a repeated complete result",
      { generation: 2, phase: "complete" },
      { generation: 2, phase: "complete" },
      false,
    ],
    [
      "ignores an older generation",
      { generation: 3, phase: "tracked" },
      { generation: 2, phase: "complete" },
      false,
    ],
    [
      "starts afresh after resubscribing, still never partial over complete",
      { generation: null, phase: "complete" },
      { generation: 1, phase: "tracked" },
      false,
    ],
    [
      "accepts any generation's complete result after resubscribing",
      { generation: null, phase: "complete" },
      { generation: 1, phase: "complete" },
      true,
    ],
  ] as const)("%s", (_name, accepted, update, expected) => {
    expect(acceptsGitLiveUpdate(accepted, update)).toBe(expected);
  });

  test("keeps showing a complete list while a newer partial phase arrives", async () => {
    const live = await observeLiveStats();
    live.emit({ generation: 3, phase: "complete", fileCount: 10 });
    live.emit({ generation: 4, phase: "tracked", fileCount: 0 });
    expect(live.shownFileCount()).toBe(10);
    live.emit({ generation: 4, phase: "complete", fileCount: 9 });
    expect(live.shownFileCount()).toBe(9);
    live.emit({ generation: 3, phase: "complete", fileCount: 1 });
    expect(live.shownFileCount()).toBe(9);
    live.dispose();
  });

  test("keeps cached and pre-restart lists until a complete result replaces them", async () => {
    const live = await observeLiveStats(statsResult(5));
    live.emit({ generation: 1, phase: "tracked", fileCount: 0 });
    expect(live.shownFileCount()).toBe(5);
    live.emit({ generation: 1, phase: "complete", fileCount: 6 });
    expect(live.shownFileCount()).toBe(6);

    live.workerClient.emit({ type: "worker-restarted", workerId: "git", epoch: 2 });
    live.emit({ generation: 0, phase: "tracked", fileCount: 0 });
    expect(live.shownFileCount()).toBe(6);
    live.emit({ generation: 0, phase: "complete", fileCount: 7 });
    expect(live.shownFileCount()).toBe(7);
    live.dispose();
  });

  test("catches up a degraded watch when the window regains focus, not on a timer", async () => {
    vi.useFakeTimers();
    const live = await observeLiveStats();
    live.emit({ generation: 1, phase: "complete", fileCount: 1, requiresRecovery: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(live.recoveries()).toBe(0);

    live.focus();
    expect(live.recoveries()).toBe(1);

    live.emit({ generation: 2, phase: "complete", fileCount: 1, requiresRecovery: false });
    live.focus();
    expect(live.recoveries()).toBe(1);
    live.dispose();
  });
});

describe("Git query adapter", () => {
  test("normalizes transient request fields out of repository query keys", () => {
    const repository = {
      hostId: "local" as const,
      commonDir: "/repo/.git",
      root: "/repo",
    };
    const first = buildGitWorkerQueryKey({
      method: "review-summary",
      params: { cwd: "/alias", source: "unstaged", requestId: "one" },
      repository,
    });
    const second = buildGitWorkerQueryKey({
      method: "review-summary",
      params: { cwd: "/alias", source: "unstaged", requestId: "two" },
      repository,
    });

    expect(first).toEqual(second);
  });

  test("shares one worker subscription for active observers and delays release", async () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const workerClient = new FakeGitWorkerClient();
    const coordinator = new GitLiveQueryCoordinator(queryClient, workerClient);
    const options = createGitLiveWorkerQuery(
      {
        method: "branch-diff-stats",
        params: { cwd: "/repo" },
        repository: {
          hostId: "local",
          commonDir: "/repo/.git",
          root: "/repo",
        },
      },
      workerClient,
    );
    const first = new QueryObserver(queryClient, options);
    const second = new QueryObserver(queryClient, options);
    const releaseFirst = first.subscribe(() => undefined);
    const releaseSecond = second.subscribe(() => undefined);
    await Promise.resolve();

    expect(
      workerClient.requests.filter((request) => request.method === "subscribe-live-query"),
    ).toHaveLength(1);

    releaseFirst();
    releaseSecond();
    await vi.advanceTimersByTimeAsync(249);
    expect(
      workerClient.requests.some((request) => request.method === "unsubscribe-live-query"),
    ).toBe(false);

    const remounted = new QueryObserver(queryClient, options);
    const releaseRemounted = remounted.subscribe(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(
      workerClient.requests.filter((request) => request.method === "subscribe-live-query"),
    ).toHaveLength(1);

    releaseRemounted();
    await vi.advanceTimersByTimeAsync(250);
    expect(
      workerClient.requests.filter((request) => request.method === "unsubscribe-live-query"),
    ).toHaveLength(1);
    coordinator.dispose();
  });

  test("publishes exact query data and resubscribes active queries after restart", async () => {
    const queryClient = new QueryClient();
    const workerClient = new FakeGitWorkerClient();
    const coordinator = new GitLiveQueryCoordinator(queryClient, workerClient);
    const options = createGitLiveWorkerQuery(
      {
        method: "branch-diff-stats",
        params: { cwd: "/repo" },
      },
      workerClient,
    );
    const observer = new QueryObserver(queryClient, options);
    const release = observer.subscribe(() => undefined);
    await Promise.resolve();
    const result = {
      cwd: "/repo",
      baseRef: "main",
      files: [],
      fileCount: 0,
      additions: 7,
      deletions: 3,
      untrackedFilesOmitted: 0,
      isGitRepository: true,
      currentBranch: "feature",
      defaultBranch: "main",
      errorMessage: null,
    };
    workerClient.emit({
      type: "git-live-query-event",
      workerId: "git",
      event: {
        type: "git-live-query-updated",
        subscriptionId: subscriptionId(workerClient),
        generation: 2,
        requiresRecovery: false,
        phase: "complete",
        method: "branch-diff-stats",
        result,
      },
    });

    expect(queryClient.getQueryData(options.queryKey)).toEqual(result);
    workerClient.emit({
      type: "worker-restarted",
      workerId: "git",
      epoch: 2,
    });
    expect(
      workerClient.requests.filter((request) => request.method === "subscribe-live-query"),
    ).toHaveLength(2);

    release();
    coordinator.dispose();
  });
});
