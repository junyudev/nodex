import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  GITHUB_THREAD_SUMMARY_BATCH_LIMIT,
  gitHubThreadKey,
  type GitHubFileViewedState,
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

export const gitHubPullRequestFilesQueryPrefix = (ref: GitHubThreadRef) =>
  [...gitHubThreadQueryKey(ref), "files"] as const;

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
    queryKey: [...gitHubPullRequestFilesQueryPrefix(ref), headSha] as const,
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

export function gitHubThreadMediaQueryOptions(ref: GitHubThreadRef, url: string) {
  return queryOptions({
    queryKey: spaceQueryKey(["github-thread-media", gitHubThreadKey(ref), url]),
    queryFn: () => invokeRendererQuery("github:thread-media", { ref, url }),
    refetchOnWindowFocus: false,
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

/** A viewed mark is the viewer's own: the files it belongs to are patched, not read again. */
function markFileViewed(
  queryClient: QueryClient,
  ref: GitHubThreadRef,
  path: string,
  viewed: GitHubFileViewedState,
) {
  queryClient.setQueriesData<GitHubPullRequestFilesResult>(
    { queryKey: gitHubPullRequestFilesQueryPrefix(ref) },
    (result) =>
      result?.status === "ready"
        ? {
            ...result,
            files: {
              ...result.files,
              files: result.files.files.map((file) =>
                file.path === path ? { ...file, viewed } : file,
              ),
            },
          }
        : result,
  );
}

export async function runGitHubThreadCommand(
  queryClient: QueryClient,
  ref: GitHubThreadRef,
  command: GitHubThreadCommand,
): Promise<GitHubThreadCommandResult> {
  if (command.type === "set_file_viewed") {
    const result = await invokePlainCommand(threadCommand, ref, command);
    if (result.status === "applied")
      markFileViewed(queryClient, ref, command.path, command.viewed ? "viewed" : "unviewed");
    return result;
  }
  let result: GitHubThreadCommandResult | undefined;
  try {
    result = await invokePlainCommand(threadCommand, ref, command);
    return result;
  } finally {
    const summary = { queryKey: gitHubThreadSummaryQueryKey(ref), exact: true };
    // An initial summary request can still be reading the pre-command state.
    await queryClient.cancelQueries(summary);
    // Files belong to a head: a new head reads its own files, so they are left alone here.
    const detail = queryClient.invalidateQueries({
      queryKey: gitHubThreadQueryKey(ref),
      exact: true,
    });
    void queryClient.invalidateQueries(summary);
    // What a change wrote reads back before the control that wrote it lets go, so a draft gives
    // way to the comment it became rather than to a gap.
    if (result?.status === "applied") await detail;
  }
}

export const gitHubThreadCommandMutationKey = (ref: GitHubThreadRef) =>
  [...gitHubThreadQueryKey(ref), "command"] as const;

export const gitHubThreadMutationOptions = (queryClient: QueryClient, ref: GitHubThreadRef) =>
  mutationOptions({
    mutationKey: gitHubThreadCommandMutationKey(ref),
    mutationFn: (command: GitHubThreadCommand) => runGitHubThreadCommand(queryClient, ref, command),
    retry: false,
  });
