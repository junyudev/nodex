import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  GITHUB_THREAD_SUMMARY_BATCH_LIMIT,
  gitHubThreadKey,
  type GitHubThreadCommand,
  type GitHubThreadCommandResult,
  type GitHubThreadDetail,
  type GitHubThreadReadResult,
  type GitHubThreadRef,
  type GitHubThreadSummariesResult,
  type GitHubThreadSummary,
  type GitHubUnavailable,
  type GitHubPullRequestFilesResult,
} from "../../shared/github-thread";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { spaceQueryKey } from "./renderer-space";

export type GitHubThreadSummaryResult =
  | { readonly status: "ready"; readonly summary: GitHubThreadSummary }
  | GitHubUnavailable
  | null;

type SummaryBatchTransport = (
  refs: readonly GitHubThreadRef[],
) => Promise<GitHubThreadSummariesResult>;

interface SummaryWaiter {
  readonly resolve: (result: GitHubThreadSummaryResult) => void;
  readonly reject: (error: unknown) => void;
}

interface PendingSummary {
  readonly ref: GitHubThreadRef;
  readonly waiters: SummaryWaiter[];
}

function readySummary(summary: GitHubThreadSummary | null): GitHubThreadSummaryResult {
  return summary === null ? null : { status: "ready", summary };
}

export function createGitHubThreadSummaryBatcher(transport: SummaryBatchTransport) {
  const pendingByScope = new Map<string, Map<string, PendingSummary>>();
  let flushScheduled = false;

  async function readBatch(batch: readonly (readonly [string, PendingSummary])[]) {
    try {
      const response = await transport(batch.map(([, request]) => request.ref));
      for (const [key, { waiters }] of batch) {
        const result =
          response.status === "ready" ? readySummary(response.summaries[key] ?? null) : response;
        for (const waiter of waiters) waiter.resolve(result);
      }
    } catch (error) {
      for (const [, { waiters }] of batch) for (const waiter of waiters) waiter.reject(error);
    }
  }

  function flush() {
    flushScheduled = false;
    const scopes = [...pendingByScope.values()];
    pendingByScope.clear();
    for (const scope of scopes) {
      const requests = [...scope];
      for (let start = 0; start < requests.length; start += GITHUB_THREAD_SUMMARY_BATCH_LIMIT) {
        void readBatch(requests.slice(start, start + GITHUB_THREAD_SUMMARY_BATCH_LIMIT));
      }
    }
  }

  return (spaceId: string, ref: GitHubThreadRef) =>
    new Promise<GitHubThreadSummaryResult>((resolve, reject) => {
      const scopeKey = JSON.stringify([spaceId, ref.host]);
      const scope = pendingByScope.get(scopeKey) ?? new Map<string, PendingSummary>();
      const key = gitHubThreadKey(ref);
      const existing = scope.get(key);
      if (existing) {
        existing.waiters.push({ resolve, reject });
        return;
      }
      scope.set(key, { ref, waiters: [{ resolve, reject }] });
      pendingByScope.set(scopeKey, scope);
      if (flushScheduled) return;
      flushScheduled = true;
      setTimeout(flush, 0);
    });
}

const readSummary = createGitHubThreadSummaryBatcher((refs) =>
  invokeRendererQuery("github:thread-summaries", refs),
);
const summaryStaleTime = 60_000;

export function projectGitHubThreadSummary(detail: GitHubThreadDetail): GitHubThreadSummary {
  const { ref, kind, url, title, state } = detail;
  const summary = { ref, kind, url, title, state };
  return kind === "issue"
    ? { ...summary, draft: false, stateReason: detail.stateReason }
    : { ...summary, draft: detail.draft };
}

export const gitHubThreadQueryKey = (ref: GitHubThreadRef) =>
  spaceQueryKey(["github-thread", gitHubThreadKey(ref)]);

export const gitHubThreadSummaryQueryKey = (ref: GitHubThreadRef) =>
  spaceQueryKey(["github-thread-summary", gitHubThreadKey(ref)]);

export const gitHubThreadQueryOptions = (ref: GitHubThreadRef) =>
  queryOptions({
    queryKey: gitHubThreadQueryKey(ref),
    queryFn: async (context) => {
      const result = await invokeRendererQuery("github:thread", ref);
      if (result.status === "ready" && !context.signal.aborted) {
        context.client.setQueryData(
          gitHubThreadSummaryQueryKey(ref),
          readySummary(projectGitHubThreadSummary(result.detail)),
        );
      }
      return result;
    },
    retry: false,
  });

export function gitHubThreadSummaryQueryOptions(ref: GitHubThreadRef) {
  const queryKey = gitHubThreadSummaryQueryKey(ref);
  return queryOptions({
    queryKey,
    queryFn: async ({ client, queryKey }): Promise<GitHubThreadSummaryResult> => {
      const detail = client.getQueryState<GitHubThreadReadResult>(gitHubThreadQueryKey(ref));
      if (
        detail?.data?.status === "ready" &&
        !detail.isInvalidated &&
        Date.now() - detail.dataUpdatedAt < summaryStaleTime
      ) {
        return readySummary(projectGitHubThreadSummary(detail.data.detail));
      }

      const before = client.getQueryState<GitHubThreadSummaryResult>(queryKey)?.dataUpdateCount;
      const result = await readSummary(queryKey[1], ref);
      const current = client.getQueryState<GitHubThreadSummaryResult>(queryKey);
      // A detail read can publish a fresh summary while the batch is on the wire.
      if (current?.data?.status === "ready" && current.dataUpdateCount !== before)
        return current.data;
      return result;
    },
    staleTime: summaryStaleTime,
    gcTime: 30 * 60_000,
    retry: false,
  });
}

export function gitHubPullRequestFilesQueryOptions(ref: GitHubThreadRef, headSha: string) {
  return queryOptions({
    queryKey: [...gitHubThreadQueryKey(ref), "files", headSha] as const,
    queryFn: async ({ client }): Promise<GitHubPullRequestFilesResult> => {
      const result = await invokeRendererQuery("github:thread-files", ref);
      if (result.status !== "ready" || result.files.headSha === headSha) return result;
      void client.invalidateQueries({ queryKey: gitHubThreadQueryKey(ref), exact: true });
      return {
        status: "unavailable",
        reason: "failed",
        message: "The pull request head changed. Refresh to see the latest files.",
        retryAt: null,
      };
    },
    retry: false,
  });
}

const threadCommand = defineRendererCommand({
  key: "github.changeThread",
  channel: "github:thread-command",
  authority: "external",
  owner: "GitHub Threads",
  protocol: { kind: "returned_value" },
});

export async function runGitHubThreadCommand(
  queryClient: QueryClient,
  ref: GitHubThreadRef,
  command: GitHubThreadCommand,
): Promise<GitHubThreadCommandResult> {
  try {
    return await invokePlainCommand(threadCommand, ref, command);
  } finally {
    const summary = { queryKey: gitHubThreadSummaryQueryKey(ref), exact: true };
    // An initial summary request can still be reading the pre-command state.
    await queryClient.cancelQueries(summary);
    void queryClient.invalidateQueries({ queryKey: gitHubThreadQueryKey(ref) });
    void queryClient.invalidateQueries(summary);
  }
}

export const gitHubThreadMutationOptions = (queryClient: QueryClient, ref: GitHubThreadRef) =>
  mutationOptions({
    mutationFn: (command: GitHubThreadCommand) => runGitHubThreadCommand(queryClient, ref, command),
    retry: false,
  });
