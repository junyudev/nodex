import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import {
  gitHubThreadKey,
  type GitHubThreadCommand,
  type GitHubThreadCommandResult,
  type GitHubThreadRef,
  type GitHubPullRequestFilesResult,
} from "../../shared/github-thread";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";
import { spaceQueryKey } from "./renderer-space";

export const gitHubThreadQueryKey = (ref: GitHubThreadRef) =>
  spaceQueryKey(["github-thread", gitHubThreadKey(ref)]);

export const gitHubThreadQueryOptions = (ref: GitHubThreadRef) =>
  queryOptions({
    queryKey: gitHubThreadQueryKey(ref),
    queryFn: () => invokeRendererQuery("github:thread", ref),
    retry: false,
  });

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
    void queryClient.invalidateQueries({ queryKey: gitHubThreadQueryKey(ref) });
  }
}

export const gitHubThreadMutationOptions = (queryClient: QueryClient, ref: GitHubThreadRef) =>
  mutationOptions({
    mutationFn: (command: GitHubThreadCommand) => runGitHubThreadCommand(queryClient, ref, command),
    retry: false,
  });
