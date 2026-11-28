import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getIntl } from "@/lib/i18n";
import { toast } from "@/components/ui/toast";
import { toastFailure } from "@/lib/failure-toast";
import {
  gitHubPullRequestFilesQueryOptions,
  gitHubThreadCommandMutationKey,
  gitHubThreadMutationOptions,
  gitHubThreadQueryKey,
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
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

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

/**
 * Runs changes against the thread and reports each outcome the way every other action does: a
 * quiet confirmation when it applied, a failure toast naming what did not happen otherwise. An
 * optimistic change shows at once and is taken back if GitHub does not apply it.
 */
export function useGitHubThreadCommands(ref: GitHubThreadRef): GitHubThreadCommandRunner {
  const queryClient = useQueryClient();
  const mutation = useMutation(gitHubThreadMutationOptions(queryClient, ref));
  const pending = useIsMutating({ mutationKey: gitHubThreadCommandMutationKey(ref) }) > 0;
  const run: GitHubThreadCommandRunner["run"] = async (command, options) => {
    const key = gitHubThreadQueryKey(ref);
    let restore: GitHubThreadReadResult | undefined;
    if (options?.optimistic) {
      await queryClient.cancelQueries({ queryKey: key, exact: true });
      restore = queryClient.getQueryData<GitHubThreadReadResult>(key);
      if (restore?.status === "ready") {
        const shown: GitHubThreadReadResult = {
          status: "ready",
          detail: options.optimistic(restore.detail),
        };
        queryClient.setQueryData(key, shown);
      }
    }
    const applied = await mutation.mutateAsync(command).then(
      (result) => {
        reportGitHubCommandResult(command, result, options?.quiet);
        return result.status === "applied";
      },
      (error: unknown) => {
        toastFailure(commandFailureTitle(command), error);
        return false;
      },
    );
    if (!applied && restore) queryClient.setQueryData(key, restore);
    return applied;
  };
  return { pending, run };
}

function reportGitHubCommandResult(
  command: GitHubThreadCommand,
  result: GitHubThreadCommandResult,
  quiet: boolean | undefined,
) {
  const intl = getIntl();
  if (result.status === "applied") return;
  if (result.status === "head_changed") {
    toast.danger(
      intl.formatMessage({
        id: "githubThread.command.headChanged",
        defaultMessage: "New commits arrived meanwhile",
      }),
      {
        description: intl.formatMessage({
          id: "githubThread.command.headChangedDescription",
          defaultMessage: "Look over the latest changes, then try again.",
        }),
      },
    );
    return;
  }
  if (result.status === "review_changed") {
    toast.danger(
      intl.formatMessage({
        id: "githubThread.command.reviewChanged",
        defaultMessage: "Your pending review changed on GitHub",
      }),
      {
        description: intl.formatMessage({
          id: "githubThread.command.reviewChangedDescription",
          defaultMessage: "Check your pending comments, then try again.",
        }),
      },
    );
    return;
  }
  if (quiet) return;
  toastFailure(
    commandFailureTitle(command),
    result.status === "rejected"
      ? result.message
      : (result.message ?? gitHubUnavailableTitle(intl, result.reason)),
  );
}

function commandFailureTitle(command: GitHubThreadCommand): string {
  const intl = getIntl();
  switch (command.type) {
    case "comment":
    case "add_review_comment":
    case "reply":
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
    case "edit":
    case "edit_comment":
      return intl.formatMessage({
        id: "githubThread.command.editFailed",
        defaultMessage: "Couldn’t save the change",
      });
    case "delete_comment":
      return intl.formatMessage({
        id: "githubThread.command.deleteFailed",
        defaultMessage: "Couldn’t delete the comment",
      });
    case "react":
      return intl.formatMessage({
        id: "githubThread.command.reactFailed",
        defaultMessage: "Couldn’t update the reaction",
      });
    case "resolve_thread":
      return command.resolved
        ? intl.formatMessage({
            id: "githubThread.command.resolveFailed",
            defaultMessage: "Couldn’t resolve the conversation",
          })
        : intl.formatMessage({
            id: "githubThread.command.reopenConversationFailed",
            defaultMessage: "Couldn’t reopen the conversation",
          });
    case "submit_review":
      return intl.formatMessage({
        id: "githubThread.command.submitReviewFailed",
        defaultMessage: "Couldn’t submit the review",
      });
    case "discard_review":
      return intl.formatMessage({
        id: "githubThread.command.discardReviewFailed",
        defaultMessage: "Couldn’t discard the review",
      });
    case "enable_auto_merge":
    case "disable_auto_merge":
      return intl.formatMessage({
        id: "githubThread.command.autoMergeFailed",
        defaultMessage: "Couldn’t change auto-merge",
      });
    case "set_file_viewed":
      return intl.formatMessage({
        id: "githubThread.command.viewedFailed",
        defaultMessage: "Couldn’t update the viewed mark",
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
