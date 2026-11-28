import { FormattedMessage, useIntl } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  GitHubPullRequestDetail,
  GitHubReviewComment,
  GitHubReviewThread,
} from "../../../shared/github-thread";
import {
  GitHubPendingBadge,
  GitHubWrittenItemActions,
  GitHubWrittenItemBody,
  useGitHubWrittenItem,
} from "./github-thread-comment";
import { GitHubMarkdownEditor } from "./github-thread-editor";
import {
  diffHunkTail,
  gitHubThreadLines,
  updateGitHubReviewThread,
  type GitHubChatContextSubject,
} from "./github-thread-model";
import { GitHubActorName, GitHubAvatar, GitHubRelativeTime } from "./github-thread-parts";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

type AddToChat = ((subject: GitHubChatContextSubject) => void) | null;

/**
 * One conversation on the change. In Activity it names the lines and shows them; beside the
 * diff the lines are already there. Resolved conversations fold to one line.
 */
export function GitHubReviewThreadCard({
  thread,
  pr,
  run,
  placement,
  onAddToChat,
}: {
  readonly thread: GitHubReviewThread;
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly placement: "activity" | "diff";
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const [unfolded, setUnfolded] = useState(false);
  const open = !thread.resolved || unfolded;
  const first = thread.comments[0];
  const lines = gitHubThreadLines(thread);
  const position = lines
    ? lines.start !== lines.end
      ? `${lines.start}–${lines.end}`
      : `${lines.end}`
    : null;
  const resolve = (resolved: boolean) =>
    void run.run(
      { type: "resolve_thread", threadId: thread.id, resolved },
      {
        // Whoever may resolve a conversation may reopen it, and the other way round.
        optimistic: (detail) =>
          updateGitHubReviewThread(detail, thread.id, (current) => {
            const allowed = current.canResolve || current.canUnresolve;
            return {
              ...current,
              resolved,
              canResolve: !resolved && allowed,
              canUnresolve: resolved && allowed,
            };
          }),
      },
    );
  const canToggleResolved = thread.resolved ? thread.canUnresolve : thread.canResolve;
  const resolveButton = canToggleResolved ? (
    <NodexButton
      size="xs"
      variant="ghostSecondary"
      onClick={() => resolve(!thread.resolved)}
      className="shrink-0"
    >
      {thread.resolved
        ? intl.formatMessage({
            id: "githubThread.thread.reopen",
            defaultMessage: "Reopen",
          })
        : intl.formatMessage({
            id: "githubThread.thread.resolve",
            defaultMessage: "Resolve",
          })}
    </NodexButton>
  ) : null;

  const header = (
    <div
      className={cn(
        "flex h-8 min-w-0 items-center gap-1.5 px-2.5 text-xs text-token-description-foreground",
        open && "border-b-[0.5px] border-token-border",
      )}
    >
      {thread.resolved ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setUnfolded((value) => !value)}
          className="cursor-interaction -ml-1 flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-token-foreground/5 hover:text-token-text-primary"
          aria-label={intl.formatMessage({
            id: "githubThread.thread.toggleResolved",
            defaultMessage: "Show resolved conversation",
          })}
        >
          <ChevronRightIcon
            className={cn("icon-2xs transition-transform duration-150", open && "rotate-90")}
          />
        </button>
      ) : null}
      {placement === "activity" ? (
        <span className="flex min-w-0 font-mono">
          <span className="min-w-0 truncate">{thread.path}</span>
          {position && thread.subject === "line" ? (
            <span className="shrink-0 tabular-nums">:{position}</span>
          ) : null}
        </span>
      ) : thread.resolved && first ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <GitHubActorName actor={first.author} avatar={false} className="max-w-40" />
          <span className="min-w-0 truncate">{first.body.split("\n")[0]}</span>
        </span>
      ) : null}
      {thread.outdated ? (
        <span className="shrink-0 rounded-sm bg-token-foreground/5 px-1">
          <FormattedMessage id="githubThread.activity.outdated" defaultMessage="Outdated" />
        </span>
      ) : null}
      {thread.resolved ? (
        <span className="shrink-0 rounded-sm bg-token-foreground/5 px-1">
          <FormattedMessage id="githubThread.activity.resolved" defaultMessage="Resolved" />
        </span>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-0.5">{resolveButton}</span>
    </div>
  );

  const tail = placement === "activity" ? diffHunkTail(thread.diffHunk) : [];
  const showHeader = placement === "activity" || thread.resolved;
  return (
    <div
      id={first?.anchor}
      data-github-anchor={first?.anchor}
      data-github-review-thread={thread.id}
      className={cn(
        "scroll-mt-16 overflow-hidden rounded-lg bg-token-main-surface-primary ring-[0.5px] ring-token-border ring-inset data-[revealed=true]:bg-token-foreground/5",
        placement === "diff" && "my-1.5 font-sans whitespace-normal",
      )}
    >
      {showHeader ? header : null}
      {open ? (
        <>
          {tail.length > 0 ? <DiffTail lines={tail} /> : null}
          <ol className="flex flex-col">
            {thread.comments.map((comment, index) => (
              <li
                key={comment.id}
                className={cn(index > 0 && "border-t-[0.5px] border-token-border/60")}
              >
                <ThreadComment
                  comment={comment}
                  pr={pr}
                  run={run}
                  onAddToChat={
                    onAddToChat && index === 0
                      ? () => onAddToChat({ kind: "review_thread", thread })
                      : null
                  }
                />
              </li>
            ))}
          </ol>
          <ThreadFooter
            thread={thread}
            pr={pr}
            run={run}
            resolveButton={showHeader ? null : resolveButton}
          />
        </>
      ) : null}
    </div>
  );
}

function DiffTail({ lines }: { readonly lines: readonly string[] }) {
  return (
    <pre className="overflow-x-auto border-b-[0.5px] border-token-border bg-token-foreground/[0.03] px-2.5 py-1 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <div
          key={index}
          className={cn(
            "whitespace-pre",
            line.startsWith("+") && "text-token-git-decoration-added-resource-foreground",
            line.startsWith("-") && "text-token-git-decoration-deleted-resource-foreground",
            !line.startsWith("+") && !line.startsWith("-") && "text-token-description-foreground",
          )}
        >
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function ThreadComment({
  comment,
  pr,
  run,
  onAddToChat,
}: {
  readonly comment: GitHubReviewComment;
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: (() => void) | null;
}) {
  const state = useGitHubWrittenItem(
    {
      id: comment.id,
      body: comment.body,
      url: comment.pending ? null : comment.url,
      reactions: comment.reactions,
      edit: comment.canEdit ? { kind: "review_comment", id: comment.id } : null,
      remove: comment.canDelete ? { kind: "review_comment", id: comment.id } : null,
    },
    run,
  );
  return (
    <article
      id={comment.anchor}
      data-github-anchor={comment.anchor}
      className="group/comment grid scroll-mt-16 grid-cols-[20px_minmax(0,1fr)] gap-x-2 px-2.5 py-2 data-[revealed=true]:bg-token-foreground/5"
    >
      <GitHubAvatar actor={comment.author} size={20} />
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-1.5 text-sm">
          <GitHubActorName actor={comment.author} avatar={false} />
          {comment.pending ? (
            <GitHubPendingBadge />
          ) : (
            <GitHubRelativeTime at={comment.createdAt} href={comment.url} />
          )}
          {comment.edited ? (
            <span className="text-xs text-token-description-foreground">
              <FormattedMessage id="githubThread.activity.edited" defaultMessage="edited" />
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/comment:opacity-100 group-hover/comment:opacity-100 has-[[aria-expanded=true]]:opacity-100">
            <GitHubWrittenItemActions state={state} onAddToChat={onAddToChat} />
          </span>
        </div>
        <div className="mt-0.5">
          <GitHubWrittenItemBody state={state} thread={pr.ref} />
        </div>
      </div>
    </article>
  );
}

function ThreadFooter({
  thread,
  pr,
  run,
  resolveButton,
}: {
  readonly thread: GitHubReviewThread;
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly resolveButton: ReactNode;
}) {
  const intl = useIntl();
  const [replying, setReplying] = useState(false);
  if (!thread.canReply && !resolveButton) return null;
  const pending = pr.pendingReview;
  if (replying) {
    return (
      <div className="border-t-[0.5px] border-token-border p-2">
        <GitHubMarkdownEditor
          ariaLabel={intl.formatMessage({
            id: "githubThread.thread.replyLabel",
            defaultMessage: "Reply to this conversation",
          })}
          placeholder={intl.formatMessage({
            id: "githubThread.thread.replyPlaceholder",
            defaultMessage: "Reply",
          })}
          hint={
            pending
              ? intl.formatMessage({
                  id: "githubThread.review.pendingHint",
                  defaultMessage: "Only you see it until you submit your review",
                })
              : null
          }
          onCancel={() => setReplying(false)}
          actions={[
            {
              id: "reply",
              label: pending
                ? intl.formatMessage({
                    id: "githubThread.review.addToReview",
                    defaultMessage: "Add to review",
                  })
                : intl.formatMessage({
                    id: "githubThread.thread.reply",
                    defaultMessage: "Reply",
                  }),
              submit: async (body) => {
                const done = await run.run({
                  type: "reply",
                  threadId: thread.id,
                  body,
                  delivery: pending
                    ? { kind: "pending_review", reviewId: pending.id }
                    : { kind: "publish" },
                });
                if (done) setReplying(false);
                return done;
              },
            },
          ]}
        />
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 border-t-[0.5px] border-token-border px-2.5 py-1.5">
      {thread.canReply ? (
        <button
          type="button"
          onClick={() => setReplying(true)}
          className="cursor-text flex h-7 min-w-0 flex-1 items-center rounded-md px-2 text-left text-sm text-token-input-placeholder-foreground ring-[0.5px] ring-token-border ring-inset hover:bg-token-foreground/[0.03]"
        >
          <FormattedMessage id="githubThread.thread.replyPlaceholder" defaultMessage="Reply" />
        </button>
      ) : (
        <span className="flex-1" />
      )}
      {resolveButton}
    </div>
  );
}
