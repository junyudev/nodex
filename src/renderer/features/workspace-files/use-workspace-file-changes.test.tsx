import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import type { GitWorkerMessageForView } from "../../../shared/git-worker-protocol";
import { buildReviewFileSafety } from "../../../shared/review-file-safety";
import { getGitLiveQueryCoordinator } from "@/features/review/data/git-query";
import { useWorkspaceFileChanges } from "./use-workspace-file-changes";

const worker = vi.hoisted(() => ({ request: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/api", () => ({ getGitWorkerClient: () => worker }));

const cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose());
  vi.resetAllMocks();
});

function summary(path: string, source = "branch") {
  return {
    type: "success",
    source,
    snapshotGeneration: 1,
    files: [
      {
        path,
        status: "modified",
        previousPath: null,
        rawStatus: "M",
        oldOid: "old",
        newOid: "new",
        revision: "revision",
        additions: 1,
        deletions: 0,
        safety: buildReviewFileSafety(),
      },
    ],
    stageCounts: { stagedFileCount: 0, unstagedFileCount: 1, untrackedFileCount: 0 },
    untrackedFilesOmitted: 0,
  };
}

function setup() {
  let listener: ((message: GitWorkerMessageForView) => void) | undefined;
  worker.subscribe.mockImplementation((next) => {
    listener = next;
    return () => {
      listener = undefined;
    };
  });
  worker.request.mockImplementation(
    async ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method === "stable-metadata")
        return {
          cwd: params.cwd,
          root: params.cwd === "/other" ? "/other" : "/repo",
          gitDir: "/repo/.git",
          commonDir: "/repo/.git",
          isGitRepository: true,
          currentBranch: "feature",
          defaultBranch: "main",
          originUrl: null,
          errorMessage: null,
        };
      if (method === "base-branch")
        return { cwd: params.cwd, remote: "origin/main", local: "main", errorMessage: null };
      if (method === "review-summary") return summary("src/a.ts", String(params.source));
      if (method === "refresh-live-query") return { refreshed: true };
      return { subscribed: true, unsubscribed: true };
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cleanups.push(() => {
    getGitLiveQueryCoordinator(client).dispose();
    client.clear();
  });
  return {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
    emit: (message: GitWorkerMessageForView) => listener?.(message),
  };
}

test("uses live metadata/base/summary queries, projects nested-root files, and receives live changes", async () => {
  const { wrapper, emit } = setup();
  const hook = renderHook(() => useWorkspaceFileChanges("/repo/src"), { wrapper });
  cleanups.push(hook.unmount);
  await waitFor(() => expect(hook.result.current.files[0]?.path).toBe("a.ts"));
  expect(hook.result.current.reviewTarget).toEqual({
    repositoryRoot: "/repo",
    comparison: { kind: "git", mode: "branch", baseRef: "origin/main" },
  });
  expect(worker.request).toHaveBeenCalledWith(
    expect.objectContaining({
      method: "review-summary",
      params: expect.objectContaining({
        cwd: "/repo",
        source: "branch",
        baseBranch: "origin/main",
        includeUntrackedFiles: true,
      }),
    }),
  );
  const subscription = worker.request.mock.calls
    .map(([input]) => input)
    .find(
      (input) =>
        input.method === "subscribe-live-query" && input.params.query.method === "review-summary",
    );
  expect(subscription).toBeDefined();
  await act(async () => {
    emit({
      type: "git-live-query-event",
      workerId: "git",
      event: {
        type: "git-live-query-updated",
        subscriptionId: subscription.params.subscriptionId,
        method: "review-summary",
        generation: 2,
        phase: "complete",
        requiresRecovery: false,
        result: summary("src/live.ts"),
      },
    } as GitWorkerMessageForView);
  });
  await waitFor(() => expect(hook.result.current.files[0]?.path).toBe("live.ts"));
  await act(async () => {
    await hook.result.current.refresh();
  });
  expect(worker.request).toHaveBeenCalledWith(
    expect.objectContaining({ method: "refresh-live-query" }),
  );
});

test("fences root changes and disables local Git reads for remote or disabled roots", async () => {
  const { wrapper } = setup();
  const hook = renderHook(
    ({ root, hostId, enabled }) => useWorkspaceFileChanges(root, { hostId, enabled }),
    { wrapper, initialProps: { root: "/repo/src", hostId: "local", enabled: true } },
  );
  cleanups.push(hook.unmount);
  await waitFor(() => expect(hook.result.current.files).toHaveLength(1));
  hook.rerender({ root: "/other", hostId: "local", enabled: true });
  expect(hook.result.current.files).toEqual([]);
  expect(hook.result.current.reviewTarget).toBeNull();
  await waitFor(() => expect(hook.result.current.repository?.root).toBe("/other"));
  const previousRequests = worker.request.mock.calls.length;
  hook.rerender({ root: "/remote", hostId: "remote-host", enabled: true });
  expect(hook.result.current.files).toEqual([]);
  expect(hook.result.current.loading).toBe(false);
  expect(
    worker.request.mock.calls
      .slice(previousRequests)
      .some(([input]) => input.method === "stable-metadata"),
  ).toBe(false);
  hook.rerender({ root: "/repo/src", hostId: "local", enabled: false });
  expect(hook.result.current.files).toEqual([]);
  expect(hook.result.current.reviewTarget).toBeNull();
});

test("uses transcript changes directly and reports operational summary failures", async () => {
  const { wrapper } = setup();
  const turnFiles = [{ path: "deleted.ts", status: "deleted" }] as const;
  const transcript = renderHook(
    () =>
      useWorkspaceFileChanges("/repo", {
        comparison: { kind: "last-turn", threadId: "thread" },
        turnFiles,
      }),
    { wrapper },
  );
  cleanups.push(transcript.unmount);
  expect(transcript.result.current.files).toBe(turnFiles);
  expect(transcript.result.current.loading).toBe(false);
  await waitFor(() => expect(transcript.result.current.repository?.root).toBe("/repo"));
  expect(worker.request.mock.calls.some(([input]) => input.method === "review-summary")).toBe(
    false,
  );
  const original = worker.request.getMockImplementation()!;
  worker.request.mockImplementation((input) =>
    input.method === "review-summary"
      ? Promise.resolve({ type: "error", source: "unstaged", errorMessage: "Cannot read index" })
      : original(input),
  );
  const failed = renderHook(
    () =>
      useWorkspaceFileChanges("/repo", {
        comparison: { kind: "git", mode: "unstaged" },
        comparisonRoot: "/repo",
      }),
    { wrapper },
  );
  cleanups.push(failed.unmount);
  await waitFor(() => expect(failed.result.current.error?.message).toBe("Cannot read index"));
  expect(failed.result.current.files).toEqual([]);
  expect(failed.result.current.loading).toBe(false);
});

test("retains an explicit comparison and All changes for an empty matching repository", async () => {
  const { wrapper } = setup();
  const original = worker.request.getMockImplementation()!;
  worker.request.mockImplementation((input) =>
    input.method === "review-summary"
      ? Promise.resolve({ ...summary("unused", "staged"), files: [] })
      : original(input),
  );
  const hook = renderHook(
    () =>
      useWorkspaceFileChanges("/repo", {
        comparisonRoot: "/repo",
        comparison: { kind: "git", mode: "staged" },
      }),
    { wrapper },
  );
  cleanups.push(hook.unmount);
  await waitFor(() => expect(hook.result.current.summary?.type).toBe("success"));
  expect(hook.result.current.comparison).toEqual({ kind: "git", mode: "staged" });
  expect(hook.result.current.files).toEqual([]);
  expect(hook.result.current.showAllChanges).toBe(true);
  expect(worker.request.mock.calls.some(([input]) => input.method === "base-branch")).toBe(false);
});
