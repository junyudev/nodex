import { FormattedMessage, getIntl, useIntl } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import {
  AssigneeIcon,
  ChevronRightIcon,
  CopyIcon,
  EditIcon,
  PullRequestDraftIcon,
  PullRequestMergedIcon,
  SendToChatIcon,
  SuccessCircleIcon,
  TagsIcon,
  ThreadSummaryCommitIcon,
  VisibilityIcon,
} from "@/components/shared/icons";
import { BranchIcon } from "@/components/shared/icons/customize-action-icons";
import {
  ChatBubblesIcon16,
  SlashCircleIcon,
  WarningCircleIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { NodexIconButton } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import type {
  GitHubReviewComment,
  GitHubReviewState,
  GitHubThreadDetail,
  GitHubTimelineEvent,
  GitHubTimelineItem,
} from "../../../shared/github-thread";
import {
  commitAuthors,
  diffHunkTail,
  projectGitHubActivity,
  type GitHubActivityRow,
  type GitHubChatContextSubject,
} from "./github-thread-model";
import {
  GitHubActorName,
  GitHubAvatar,
  GitHubLabelChip,
  GitHubMarkdown,
  GitHubRelativeTime,
  GitHubSectionHeading,
  GitHubThreadReferenceChip,
  useOpenOnGitHub,
} from "./github-thread-parts";
import { GitHubThreadStateIcon, gitHubThreadStateOf } from "./github-thread-state";

type AddToChat = ((subject: GitHubChatContextSubject) => void) | null;

/** Everything that happened on the thread, oldest first, the way the reader catches up. */
export function GitHubThreadActivity({
  detail,
  onAddToChat,
}: {
  readonly detail: GitHubThreadDetail;
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const rows = projectGitHubActivity(detail.timeline, detail.kind);
  return (
    <section
      aria-label={intl.formatMessage({
        id: "githubThread.activity.label",
        defaultMessage: "Activity",
      })}
      className="flex flex-col gap-1"
    >
      <GitHubSectionHeading>
        <FormattedMessage id="githubThread.activity.heading" defaultMessage="Activity" />
      </GitHubSectionHeading>
      {detail.timelineTruncated ? (
        <a
          href={detail.url}
          onClick={(event) => openOnGitHub(detail.url, event)}
          className="mb-1 self-start text-sm text-token-description-foreground hover:text-token-text-primary hover:underline"
        >
          <FormattedMessage
            id="githubThread.activity.earlier"
            defaultMessage="Earlier activity is on GitHub"
          />
        </a>
      ) : null}
      {rows.length === 0 ? (
        <p className="text-sm text-token-description-foreground">
          <FormattedMessage
            id="githubThread.activity.empty"
            defaultMessage="Nothing has happened yet."
          />
        </p>
      ) : (
        <ol className="flex flex-col">
          {rows.map((row) => (
            <li key={row.id}>
              <ActivityRow row={row} detail={detail} onAddToChat={onAddToChat} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function ActivityRow({
  row,
  detail,
  onAddToChat,
}: {
  readonly row: GitHubActivityRow;
  readonly detail: GitHubThreadDetail;
  readonly onAddToChat: AddToChat;
}) {
  switch (row.kind) {
    case "comment":
      return (
        <ConversationEntry
          anchor={row.anchor}
          rail={<GitHubAvatar actor={row.author} size={20} />}
          header={
            <>
              <GitHubActorName actor={row.author} avatar={false} />
              <GitHubRelativeTime at={row.createdAt} href={row.url} />
              {row.edited ? (
                <span className="text-token-description-foreground">
                  <FormattedMessage id="githubThread.activity.edited" defaultMessage="edited" />
                </span>
              ) : null}
            </>
          }
          actions={
            <EntryActions
              url={row.url}
              onAddToChat={onAddToChat ? () => onAddToChat({ kind: "comment", item: row }) : null}
            />
          }
        >
          <GitHubMarkdown markdown={row.body} thread={detail.ref} />
        </ConversationEntry>
      );
    case "review":
      return <ReviewEntry row={row} detail={detail} onAddToChat={onAddToChat} />;
    case "commits":
      return <CommitsEntry commits={row.commits} />;
    case "event":
      return <EventEntry item={row} detail={detail} />;
  }
}

/** A person speaking: their avatar on the rail, a header line, then what they said. */
function ConversationEntry({
  anchor,
  rail,
  header,
  actions,
  children,
}: {
  readonly anchor: string;
  readonly rail: ReactNode;
  readonly header: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <article
      id={anchor}
      data-github-anchor={anchor}
      className="group/entry grid scroll-mt-16 grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 py-2 data-[revealed=true]:rounded-lg data-[revealed=true]:bg-token-foreground/5"
    >
      <div className="pt-px">{rail}</div>
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-1.5 text-sm">
          {header}
          {actions ? (
            <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover/entry:opacity-100 group-focus-within/entry:opacity-100">
              {actions}
            </span>
          ) : null}
        </div>
        {children ? <div className="mt-1 min-w-0">{children}</div> : null}
      </div>
    </article>
  );
}

function EntryActions({
  url,
  onAddToChat,
}: {
  readonly url: string;
  readonly onAddToChat: (() => void) | null;
}) {
  const intl = useIntl();
  return (
    <>
      {onAddToChat ? (
        <NodexIconButton
          size="xs"
          icon={SendToChatIcon}
          ariaLabel={intl.formatMessage({
            id: "githubThread.activity.addToChat",
            defaultMessage: "Add to chat",
          })}
          title={intl.formatMessage({
            id: "githubThread.activity.addToChat",
            defaultMessage: "Add to chat",
          })}
          onClick={onAddToChat}
        />
      ) : null}
      <NodexIconButton
        size="xs"
        icon={CopyIcon}
        ariaLabel={intl.formatMessage({
          id: "githubThread.activity.copyLink",
          defaultMessage: "Copy link",
        })}
        title={intl.formatMessage({
          id: "githubThread.activity.copyLink",
          defaultMessage: "Copy link",
        })}
        onClick={() => void copyLink(url)}
      />
    </>
  );
}

async function copyLink(url: string) {
  const intl = getIntl();
  if (await writeTextToClipboard(url))
    toast.success(
      intl.formatMessage({ id: "githubThread.copiedLink", defaultMessage: "Copied link" }),
    );
  else
    toast.danger(
      intl.formatMessage({
        id: "githubThread.copyLinkFailed",
        defaultMessage: "Couldn’t copy the link",
      }),
    );
}

const REVIEW_GLYPH: Record<GitHubReviewState, ReactNode> = {
  approved: <SuccessCircleIcon className="icon-2xs shrink-0 text-token-charts-green" />,
  changes_requested: <WarningCircleIcon className="icon-2xs shrink-0 text-token-charts-red" />,
  commented: <ChatBubblesIcon16 className="icon-2xs shrink-0 text-token-description-foreground" />,
  dismissed: <SlashCircleIcon className="icon-2xs shrink-0 text-token-description-foreground" />,
};

function ReviewEntry({
  row,
  detail,
  onAddToChat,
}: {
  readonly row: Extract<GitHubActivityRow, { kind: "review" }>;
  readonly detail: GitHubThreadDetail;
  readonly onAddToChat: AddToChat;
}) {
  const { review } = row;
  const [showResolved, setShowResolved] = useState(false);
  return (
    <ConversationEntry
      anchor={review.anchor}
      rail={<GitHubAvatar actor={review.author} size={20} />}
      header={
        <>
          <GitHubActorName actor={review.author} avatar={false} />
          {REVIEW_GLYPH[review.state]}
          <span className="shrink-0 text-token-description-foreground">
            <FormattedMessage
              id="githubThread.activity.reviewVerb"
              defaultMessage="{state, select, approved {approved} changes_requested {requested changes} dismissed {review dismissed} other {reviewed}}"
              values={{ state: review.state }}
            />
          </span>
          <GitHubRelativeTime at={review.submittedAt} href={review.url} />
        </>
      }
      actions={
        <EntryActions
          url={review.url}
          onAddToChat={onAddToChat ? () => onAddToChat({ kind: "review", item: review }) : null}
        />
      }
    >
      {review.body.trim() || row.openComments.length > 0 || row.resolvedComments.length > 0 ? (
        <div className="flex flex-col gap-2">
          {review.body.trim() ? (
            <GitHubMarkdown markdown={review.body} thread={detail.ref} />
          ) : null}
          {row.openComments.map((comment) => (
            <ReviewCommentCard
              key={comment.id}
              comment={comment}
              detail={detail}
              onAddToChat={onAddToChat}
            />
          ))}
          {row.resolvedComments.length > 0 ? (
            <div className="flex flex-col gap-2">
              <button
                type="button"
                aria-expanded={showResolved}
                onClick={() => setShowResolved((open) => !open)}
                className="cursor-interaction flex items-center gap-1 self-start text-sm text-token-description-foreground hover:text-token-text-primary"
              >
                <ChevronRightIcon
                  className={cn(
                    "icon-2xs transition-transform duration-150",
                    showResolved && "rotate-90",
                  )}
                />
                <FormattedMessage
                  id="githubThread.activity.resolvedComments"
                  defaultMessage="{count, plural, one {# resolved comment} other {# resolved comments}}"
                  values={{ count: row.resolvedComments.length }}
                />
              </button>
              {showResolved
                ? row.resolvedComments.map((comment) => (
                    <ReviewCommentCard
                      key={comment.id}
                      comment={comment}
                      detail={detail}
                      onAddToChat={onAddToChat}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </ConversationEntry>
  );
}

/** One inline comment: where in the change it points, the lines it points at, and the words. */
function ReviewCommentCard({
  comment,
  detail,
  onAddToChat,
}: {
  readonly comment: GitHubReviewComment;
  readonly detail: GitHubThreadDetail;
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const tail = diffHunkTail(comment.diffHunk);
  const position =
    comment.line === null
      ? null
      : comment.startLine && comment.startLine !== comment.line
        ? `${comment.startLine}–${comment.line}`
        : String(comment.line);
  return (
    <div
      id={comment.anchor}
      data-github-anchor={comment.anchor}
      className="group/card scroll-mt-16 overflow-hidden rounded-lg ring-[0.5px] ring-token-border ring-inset data-[revealed=true]:bg-token-foreground/5"
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5 border-b-[0.5px] border-token-border px-2.5 text-xs text-token-description-foreground">
        <span className="flex min-w-0 font-mono">
          <span className="min-w-0 truncate">{comment.path}</span>
          {position ? <span className="shrink-0 tabular-nums">:{position}</span> : null}
        </span>
        {comment.outdated ? (
          <span className="shrink-0 rounded-sm bg-token-foreground/5 px-1">
            <FormattedMessage id="githubThread.activity.outdated" defaultMessage="Outdated" />
          </span>
        ) : null}
        {comment.resolved ? (
          <span className="shrink-0 rounded-sm bg-token-foreground/5 px-1">
            <FormattedMessage id="githubThread.activity.resolved" defaultMessage="Resolved" />
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100">
          {onAddToChat ? (
            <NodexIconButton
              size="xs"
              icon={SendToChatIcon}
              ariaLabel={intl.formatMessage({
                id: "githubThread.activity.addToChat",
                defaultMessage: "Add to chat",
              })}
              title={intl.formatMessage({
                id: "githubThread.activity.addToChat",
                defaultMessage: "Add to chat",
              })}
              onClick={() => onAddToChat({ kind: "review_comment", comment })}
            />
          ) : null}
        </span>
      </div>
      {tail.length > 0 ? (
        <pre className="overflow-x-auto bg-token-foreground/[0.03] px-2.5 py-1 font-mono text-xs leading-5">
          {tail.map((line, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre",
                line.startsWith("+") && "text-token-git-decoration-added-resource-foreground",
                line.startsWith("-") && "text-token-git-decoration-deleted-resource-foreground",
                !line.startsWith("+") &&
                  !line.startsWith("-") &&
                  "text-token-description-foreground",
              )}
            >
              {line || " "}
            </div>
          ))}
        </pre>
      ) : null}
      <div className="flex gap-2 px-2.5 py-2">
        <GitHubAvatar actor={comment.author} />
        <div className="min-w-0 flex-1">
          <div className="flex h-4 items-center gap-1.5 text-xs">
            <GitHubActorName actor={comment.author} avatar={false} />
            <GitHubRelativeTime at={comment.createdAt} href={comment.url} />
          </div>
          <GitHubMarkdown markdown={comment.body} thread={detail.ref} className="mt-1" />
        </div>
      </div>
    </div>
  );
}

function CommitsEntry({
  commits,
}: {
  readonly commits: readonly Extract<GitHubTimelineItem, { kind: "commit" }>[];
}) {
  const openOnGitHub = useOpenOnGitHub();
  const authors = commitAuthors(commits);
  const last = commits.at(-1);
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 py-1.5">
      <span className="flex h-5 items-center justify-center text-token-description-foreground">
        <ThreadSummaryCommitIcon className="icon-2xs" />
      </span>
      <div className="min-w-0">
        <div className="flex h-5 min-w-0 items-center gap-1.5 text-sm text-token-description-foreground">
          <span className="min-w-0 truncate">
            <FormattedMessage
              id="githubThread.activity.pushed"
              defaultMessage="{authors} pushed {count, plural, one {# commit} other {# commits}}"
              values={{
                authors: (
                  <span className="font-medium text-token-text-primary">{authors.join(", ")}</span>
                ),
                count: commits.length,
              }}
            />
          </span>
          {last ? <GitHubRelativeTime at={last.committedAt} /> : null}
        </div>
        <ul className="mt-0.5 flex flex-col">
          {commits.map((commit) => (
            <li key={commit.id} className="flex h-6 min-w-0 items-center gap-2 text-sm">
              <span className="min-w-0 truncate">{commit.headline}</span>
              <a
                href={commit.url}
                onClick={(event) => openOnGitHub(commit.url, event)}
                className="ml-auto shrink-0 font-mono text-xs text-token-description-foreground hover:text-token-text-primary hover:underline"
              >
                {commit.oid.slice(0, 7)}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function eventGlyph(event: GitHubTimelineEvent, detail: GitHubThreadDetail): ReactNode {
  const muted = "icon-2xs shrink-0 text-token-description-foreground";
  switch (event.type) {
    case "merged":
      return <PullRequestMergedIcon className="icon-2xs shrink-0 text-token-charts-purple" />;
    case "closed":
      return (
        <GitHubThreadStateIcon
          className="icon-2xs"
          state={gitHubThreadStateOf(
            detail.kind === "pull_request"
              ? { kind: "pull_request", state: "closed" }
              : { kind: "issue", state: "closed", stateReason: event.reason },
          )}
        />
      );
    case "reopened":
      return (
        <GitHubThreadStateIcon
          className="icon-2xs"
          state={detail.kind === "pull_request" ? "pull_open" : "issue_open"}
        />
      );
    case "ready_for_review":
      return <GitHubThreadStateIcon className="icon-2xs" state="pull_open" />;
    case "converted_to_draft":
      return <PullRequestDraftIcon className={muted} />;
    case "review_requested":
    case "review_request_removed":
      return <VisibilityIcon className={muted} />;
    case "labeled":
    case "unlabeled":
      return <TagsIcon className={muted} />;
    case "assigned":
    case "unassigned":
      return <AssigneeIcon className={muted} />;
    case "renamed":
      return <EditIcon className={muted} />;
    case "head_force_pushed":
    case "base_changed":
      return <BranchIcon className={muted} />;
    case "cross_referenced":
      return (
        <GitHubThreadStateIcon className="icon-2xs" state={gitHubThreadStateOf(event.source)} />
      );
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      return <PullRequestMergedIcon className={muted} />;
  }
}

/** Something that changed about the thread: one quiet line. */
function EventEntry({
  item,
  detail,
}: {
  readonly item: Extract<GitHubTimelineItem, { kind: "event" }>;
  readonly detail: GitHubThreadDetail;
}) {
  const { event } = item;
  const actor = <GitHubActorName actor={item.actor} avatar={false} className="max-w-48" />;
  const strong = (text: string) => (
    <span className="font-medium text-token-text-primary">{text}</span>
  );
  const code = (text: string) => (
    <span className="rounded-sm bg-token-foreground/5 px-1 font-mono text-xs text-token-text-primary">
      {text}
    </span>
  );
  let sentence: ReactNode;
  switch (event.type) {
    case "closed":
      sentence = (
        <FormattedMessage
          id="githubThread.event.closed"
          defaultMessage="{actor} closed this{reason, select, not_planned { as not planned} duplicate { as a duplicate} completed { as completed} other {}}"
          values={{ actor, reason: detail.kind === "issue" ? (event.reason ?? "none") : "none" }}
        />
      );
      break;
    case "reopened":
      sentence = (
        <FormattedMessage
          id="githubThread.event.reopened"
          defaultMessage="{actor} reopened this"
          values={{ actor }}
        />
      );
      break;
    case "merged":
      sentence = (
        <FormattedMessage
          id="githubThread.event.merged"
          defaultMessage="{actor} merged into {branch}"
          values={{ actor, branch: code(event.baseBranch) }}
        />
      );
      break;
    case "ready_for_review":
      sentence = (
        <FormattedMessage
          id="githubThread.event.readyForReview"
          defaultMessage="{actor} marked this ready for review"
          values={{ actor }}
        />
      );
      break;
    case "converted_to_draft":
      sentence = (
        <FormattedMessage
          id="githubThread.event.convertedToDraft"
          defaultMessage="{actor} converted this to a draft"
          values={{ actor }}
        />
      );
      break;
    case "review_requested":
      sentence = (
        <FormattedMessage
          id="githubThread.event.reviewRequested"
          defaultMessage="{actor} requested a review from {reviewer}"
          values={{ actor, reviewer: strong(event.reviewer) }}
        />
      );
      break;
    case "review_request_removed":
      sentence = (
        <FormattedMessage
          id="githubThread.event.reviewRequestRemoved"
          defaultMessage="{actor} removed the review request for {reviewer}"
          values={{ actor, reviewer: strong(event.reviewer) }}
        />
      );
      break;
    case "labeled":
    case "unlabeled":
      sentence = (
        <FormattedMessage
          id="githubThread.event.labeled"
          defaultMessage="{actor} {added, select, true {added} other {removed}} {label}"
          values={{
            actor,
            added: String(event.type === "labeled"),
            label: <GitHubLabelChip label={event.label} />,
          }}
        />
      );
      break;
    case "assigned":
    case "unassigned":
      sentence = (
        <FormattedMessage
          id="githubThread.event.assigned"
          defaultMessage="{actor} {assigned, select, true {assigned} other {unassigned}} {assignee}"
          values={{
            actor,
            assigned: String(event.type === "assigned"),
            assignee: strong(event.assignee),
          }}
        />
      );
      break;
    case "renamed":
      sentence = (
        <FormattedMessage
          id="githubThread.event.renamed"
          defaultMessage="{actor} renamed this from {from}"
          values={{ actor, from: <span className="line-through">{event.from}</span> }}
        />
      );
      break;
    case "head_force_pushed":
      sentence = (
        <FormattedMessage
          id="githubThread.event.forcePushed"
          defaultMessage="{actor} force-pushed the branch"
          values={{ actor }}
        />
      );
      break;
    case "base_changed":
      sentence = (
        <FormattedMessage
          id="githubThread.event.baseChanged"
          defaultMessage="{actor} changed the base branch to {branch}"
          values={{ actor, branch: code(event.to ?? "?") }}
        />
      );
      break;
    case "cross_referenced":
      sentence = (
        <FormattedMessage
          id="githubThread.event.crossReferenced"
          defaultMessage="{actor} mentioned this in {source}"
          values={{
            actor,
            source: <GitHubThreadReferenceChip thread={event.source} from={detail.ref} />,
          }}
        />
      );
      break;
    case "auto_merge_enabled":
    case "auto_merge_disabled":
      sentence = (
        <FormattedMessage
          id="githubThread.event.autoMerge"
          defaultMessage="{actor} {enabled, select, true {enabled} other {disabled}} auto-merge"
          values={{ actor, enabled: String(event.type === "auto_merge_enabled") }}
        />
      );
      break;
  }
  return (
    <div className="grid grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 py-1.5">
      <span className="flex h-6 items-center justify-center">{eventGlyph(event, detail)}</span>
      <div className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-token-description-foreground">
        <span className="flex min-w-0 flex-wrap items-center gap-x-1">{sentence}</span>
        <GitHubRelativeTime at={item.createdAt} />
      </div>
    </div>
  );
}
