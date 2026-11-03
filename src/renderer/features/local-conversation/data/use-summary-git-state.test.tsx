import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import { useSummaryGitState } from "./use-summary-git-state";

const queries = vi.hoisted(() => ({
  status: {
    type: "success",
    stagedCount: 1,
    unstagedCount: 0,
    untrackedCount: 0,
    snapshotGeneration: 1,
  } as unknown,
}));
vi.mock("@/features/review/data/git-query", () => ({
  buildGitWorkerQueryKey: ({ method, params }: { method: string; params: unknown }) => [
    method,
    params,
  ],
  getGitLiveQueryCoordinator: () => ({ refresh: async () => {} }),
  createGitLiveWorkerQuery: ({ method, params }: { method: string; params: unknown }) => ({
    queryKey: [method, params],
    queryFn: async () => {
      if (method === "stable-metadata")
        return { isGitRepository: true, commonDir: "/repo/.git", root: "/repo" };
      if (method === "status-summary") return queries.status;
      if (method === "review-summary")
        return {
          type: "success",
          stageCounts: { stagedFileCount: 0, unstagedFileCount: 2, untrackedFileCount: 0 },
        };
      return { fileCount: 0 };
    },
  }),
}));
const failedStatus = {
  type: "error",
  failureReason: "status-command",
  errorMessage: "Git unavailable",
};
function setup() {
  const client = createTestQueryClient();
  const hook = renderHook(() => useSummaryGitState("/repo", true), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <TestQueryProvider client={client}>{children}</TestQueryProvider>
      </StrictMode>
    ),
  });
  return { ...hook, client };
}

describe("summary Git observations", () => {
  beforeEach(() => {
    queries.status = {
      type: "success",
      stagedCount: 1,
      unstagedCount: 0,
      untrackedCount: 0,
      snapshotGeneration: 1,
    };
  });
  test("keeps the latest successful status through errors and replaces it with the next success", async () => {
    const hook = setup();
    await waitFor(() => expect(hook.result.current.primarySource).toBe("staged"));
    await act(async () => {
      hook.client.setQueriesData({ queryKey: ["status-summary"] }, failedStatus);
    });
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        primarySource: "staged",
        hasUncommittedChanges: true,
        error: false,
        loading: false,
      }),
    );
    await act(async () => {
      hook.client.setQueriesData(
        { queryKey: ["status-summary"] },
        {
          type: "success",
          stagedCount: 0,
          unstagedCount: 0,
          untrackedCount: 0,
          snapshotGeneration: 2,
        },
      );
    });
    await waitFor(() => expect(hook.result.current.hasUncommittedChanges).toBe(false));
    await act(async () => {
      hook.client.setQueriesData({ queryKey: ["status-summary"] }, failedStatus);
    });
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        primarySource: "branch",
        hasUncommittedChanges: false,
        error: false,
      }),
    );
    hook.unmount();
    hook.client.clear();
  });
  test("uses review summaries when no successful status has arrived", async () => {
    queries.status = failedStatus;
    const hook = setup();
    await waitFor(() =>
      expect(hook.result.current).toMatchObject({
        primarySource: "unstaged",
        hasUncommittedChanges: true,
        error: false,
        loading: false,
      }),
    );
    hook.unmount();
    hook.client.clear();
  });
});
