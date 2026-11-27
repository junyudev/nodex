import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIntl } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { toastFailure } from "@/lib/failure-toast";
import {
  gitHubPullRequestFilesQueryOptions,
  gitHubThreadMutationOptions,
  gitHubThreadQueryOptions,
  gitHubThreadSummaryQueryOptions,
} from "@/lib/github-threads";
import { gitHubThreadLinksQueryOptions } from "@/lib/github-thread-links";
import { createPastedTextAttachment } from "@/lib/api";
import type { CodexPromptInput } from "@/lib/types";
import type {
  GitHubThreadCommand,
  GitHubThreadCommandResult,
  GitHubThreadReadResult,
  GitHubThreadRef,
  GitHubThreadSummary,
} from "../../../shared/github-thread";
import { summarizeGitHubChecks, type GitHubChatContext } from "./github-thread-model";
import { gitHubUnavailableTitle } from "./github-thread-copy";

/** Open threads that are still settling are read often; everything else rarely. */
export function gitHubThreadRefetchInterval(result: GitHubThreadReadResult | undefined) {
  if (!result || result.status !== "ready") return false;
  const { detail } = result;
  if (detail.kind !== "pull_request" || detail.state !== "open") return 120_000;
  const checks = summarizeGitHubChecks(detail.checks);
  return checks.counts.running > 0 || detail.mergeable === "unknown" ? 30_000 : 120_000;
}

/** The thread's detail, kept fresh while its tab is showing. */
export function useGitHubThread(ref: GitHubThreadRef) {
  return useQuery({
    ...gitHubThreadQueryOptions(ref),
    staleTime: 20_000,
    refetchOnWindowFocus: true,
    refetchInterval: (query) => gitHubThreadRefetchInterval(query.state.data),
    refetchIntervalInBackground: false,
  });
}

export function useGitHubPullRequestFiles(ref: GitHubThreadRef, headSha: string | null) {
  return useQuery({
    ...gitHubPullRequestFilesQueryOptions(ref, headSha ?? ""),
    enabled: headSha !== null,
    staleTime: 60_000,
  });
}

export function useGitHubThreadLinks(ref: GitHubThreadRef) {
  return useQuery(gitHubThreadLinksQueryOptions(ref));
}

export type GitHubThreadCommandOutcome = GitHubThreadCommandResult["status"];

/**
 * Runs one change against the thread and reports its outcome the way every other action does:
 * a quiet confirmation when it applied, a failure toast naming what did not happen otherwise.
 */
export function useGitHubThreadCommand(ref: GitHubThreadRef) {
  const queryClient = useQueryClient();
  return useMutation({
    ...gitHubThreadMutationOptions(queryClient, ref),
    onError: (error, command) => toastFailure(commandFailureTitle(command), error),
    onSuccess: (result, command) => {
      const intl = getIntl();
      if (result.status === "applied") return;
      if (result.status === "head_changed") {
        toast.danger(
          intl.formatMessage({
            id: "githubThread.command.headChanged",
            defaultMessage: "New commits arrived before the merge",
          }),
          {
            description: intl.formatMessage({
              id: "githubThread.command.headChangedDescription",
              defaultMessage: "Review the latest changes, then merge again.",
            }),
          },
        );
        return;
      }
      toastFailure(
        commandFailureTitle(command),
        result.status === "rejected"
          ? result.message
          : (result.message ?? gitHubUnavailableTitle(intl, result.reason)),
      );
    },
  });
}

function commandFailureTitle(command: GitHubThreadCommand): string {
  const intl = getIntl();
  switch (command.type) {
    case "comment":
      return intl.formatMessage({
        id: "githubThread.command.commentFailed",
        defaultMessage: "Couldn’t post the comment",
      });
    case "merge":
      return intl.formatMessage({
        id: "githubThread.command.mergeFailed",
        defaultMessage: "Couldn’t merge the pull request",
      });
    case "set_state":
      return command.state === "closed"
        ? intl.formatMessage({
            id: "githubThread.command.closeFailed",
            defaultMessage: "Couldn’t close it",
          })
        : intl.formatMessage({
            id: "githubThread.command.reopenFailed",
            defaultMessage: "Couldn’t reopen it",
          });
    case "set_draft":
      return command.draft
        ? intl.formatMessage({
            id: "githubThread.command.convertToDraftFailed",
            defaultMessage: "Couldn’t convert it to a draft",
          })
        : intl.formatMessage({
            id: "githubThread.command.readyFailed",
            defaultMessage: "Couldn’t mark it ready for review",
          });
  }
}

/**
 * GitHub context reaches a chat's draft the way long pasted text does: as a file the draft holds,
 * named by a short preview, so the person's own words stay theirs.
 */
export async function gitHubChatContextPromptInput(
  context: GitHubChatContext,
): Promise<CodexPromptInput> {
  const attachment = await createPastedTextAttachment({ text: context.text });
  return { text: "", textAttachments: [{ ...attachment, preview: context.preview }] };
}

/**
 * A thread's title and state for a link that names it inline, read in batches with every other
 * link on screen. Null until known, and whenever it cannot be known.
 */
export function useGitHubThreadSummary(
  ref: GitHubThreadRef,
  enabled: boolean,
): GitHubThreadSummary | null {
  const { data } = useQuery({ ...gitHubThreadSummaryQueryOptions(ref), enabled });
  return data?.status === "ready" ? data.summary : null;
}
