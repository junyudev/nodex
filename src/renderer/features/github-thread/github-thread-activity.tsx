import { FormattedMessage, useIntl, type IntlShape } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import {
  AssigneeIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  PullRequestDraftIcon,
  PullRequestMergedIcon,
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
import {
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
} from "@/components/ui/dropdown";
import type {
  GitHubReviewState,
  GitHubReviewThread,
  GitHubThreadDetail,
  GitHubTimelineEvent,
  GitHubTimelineItem,
} from "../../../shared/github-thread";
import {
  GitHubWrittenItemActions,
  GitHubWrittenItemBody,
  useGitHubWrittenItem,
} from "./github-thread-comment";
import {
  commitAuthors,
  GITHUB_ACTIVITY_FILTERS,
  projectGitHubActivity,
  type GitHubActivityFilter,
  type GitHubActivityRow,
  type GitHubChatContextSubject,
} from "./github-thread-model";
import {
  GitHubActorName,
  GitHubAvatar,
  GitHubLabelChip,
  GitHubRelativeTime,
  GitHubSectionHeading,
  GitHubThreadReferenceChip,
  useOpenOnGitHub,
} from "./github-thread-parts";
import { useGitHubActivityFilter } from "./github-thread-preferences";
import { GitHubReviewThreadCard } from "./github-thread-review-thread";
import { GitHubThreadStateIcon, gitHubThreadStateOf } from "./github-thread-state";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

type AddToChat = ((subject: GitHubChatContextSubject) => void) | null;

function activityFilterLabel(intl: IntlShape, filter: GitHubActivityFilter): string {
  return intl.formatMessage(
    {
      id: "githubThread.activity.filter",
      defaultMessage:
        "{filter, select, comments {Comments} people {Comments from people} other {All activity}}",
    },
    { filter },
  );
}

/** Everything that happened on the thread, oldest first, the way the reader catches up. */
export function GitHubThreadActivity({
  detail,
  run,
  onAddToChat,
}: {
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: AddToChat;
}) {
  const intl = useIntl();
  const openOnGitHub = useOpenOnGitHub();
  const [filter, setFilter] = useGitHubActivityFilter();
  const rows = projectGitHubActivity(detail.timeline, detail.kind, {
    threads: detail.kind === "pull_request" ? detail.reviewThreads : [],
    filter,
  });
  return (
    <section
      aria-label={intl.formatMessage({
        id: "githubThread.activity.label",
        defaultMessage: "Activity",
      })}
      className="flex flex-col gap-1"
    >
      <GitHubSectionHeading
        trailing={
          <NodexDropdownMenu
            align="end"
            triggerButton={
              <button
                type="button"
                className="cursor-interaction flex h-6 items-center gap-1 rounded-md px-1.5 text-sm font-normal text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-text-primary aria-expanded:bg-token-foreground/5"
              >
                {activityFilterLabel(intl, filter)}
                <ChevronDownIcon className="icon-2xs" />
              </button>
            }
          >
            <NodexDropdownRadioGroup
              value={filter}
              onValueChange={(value) => setFilter(value as GitHubActivityFilter)}
            >
              {GITHUB_ACTIVITY_FILTERS.map((value) => (
                <NodexDropdownRadioItem key={value} value={value}>
                  {activityFilterLabel(intl, value)}
                </NodexDropdownRadioItem>
              ))}
            </NodexDropdownRadioGroup>
          </NodexDropdownMenu>
        }
      >
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
          {filter === "all" ? (
            <FormattedMessage
              id="githubThread.activity.empty"
              defaultMessage="Nothing has happened yet."
            />
          ) : (
            <FormattedMessage
              id="githubThread.activity.emptyFiltered"
              defaultMessage="Nothing to show with this filter."
            />
          )}
        </p>
      ) : (
        <ol className="flex flex-col">
          {rows.map((row) => (
            <li key={row.id}>
              <ActivityRow row={row} detail={detail} run={run} onAddToChat={onAddToChat} />
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
  run,
  onAddToChat,
}: {
  readonly row: GitHubActivityRow;
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: AddToChat;
}) {
  switch (row.kind) {
    case "comment":
      return <CommentEntry item={row} detail={detail} run={run} onAddToChat={onAddToChat} />;
    case "review":
      return <ReviewEntry row={row} detail={detail} run={run} onAddToChat={onAddToChat} />;
    case "commits":
      return <CommitsEntry commits={row.commits} />;
    case "event":
      return <EventEntry item={row} detail={detail} />;
  }
}

/**
 * A person speaking: their avatar on the rail, a header line, then what they said. What follows
 * it (a review's conversations) sits outside its hover group, so pointing at a reply does not
 * light up the review's own actions.
 */
function ConversationEntry({
  anchor,
  rail,
  header,
  actions,
  children,
  after,
}: {
  readonly anchor: string;
  readonly rail: ReactNode;
  readonly header: ReactNode;
  readonly actions?: ReactNode;
  readonly children?: ReactNode;
  readonly after?: ReactNode;
}) {
  return (
    <article
      id={anchor}
      data-github-anchor={anchor}
      className="grid scroll-mt-16 grid-cols-[20px_minmax(0,1fr)] gap-x-2.5 py-2 data-[revealed=true]:rounded-lg data-[revealed=true]:bg-token-foreground/5"
    >
      <div className="pt-px">{rail}</div>
      <div className="min-w-0">
        <div className="group/entry">
          <div className="flex h-5 min-w-0 items-center gap-1.5 text-sm">
            {header}
            {actions ? (
              <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 has-[[aria-expanded=true]]:opacity-100">
                {actions}
              </span>
            ) : null}
          </div>
          {children ? <div className="mt-1 min-w-0">{children}</div> : null}
        </div>
        {after}
      </div>
    </article>
  );
}

function CommentEntry({
  item,
  detail,
  run,
  onAddToChat,
}: {
  readonly item: Extract<GitHubTimelineItem, { kind: "comment" }>;
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: AddToChat;
}) {
  const state = useGitHubWrittenItem(
    {
      id: item.id,
      body: item.body,
      url: item.url,
      reactions: item.reactions,
      edit: item.canEdit ? { kind: "issue_comment", id: item.id } : null,
      remove: item.canDelete ? { kind: "issue_comment", id: item.id } : null,
    },
    run,
  );
  return (
    <ConversationEntry
      anchor={item.anchor}
      rail={<GitHubAvatar actor={item.author} size={20} />}
      header={
        <>
          <GitHubActorName actor={item.author} avatar={false} />
          <GitHubRelativeTime at={item.createdAt} href={item.url} />
          {item.edited ? (
            <span className="text-token-description-foreground">
              <FormattedMessage id="githubThread.activity.edited" defaultMessage="edited" />
            </span>
          ) : null}
        </>
      }
      actions={
        <GitHubWrittenItemActions
          state={state}
          onAddToChat={onAddToChat ? () => onAddToChat({ kind: "comment", item }) : null}
        />
      }
    >
      <GitHubWrittenItemBody state={state} thread={detail.ref} />
    </ConversationEntry>
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
  run,
  onAddToChat,
}: {
  readonly row: Extract<GitHubActivityRow, { kind: "review" }>;
  readonly detail: GitHubThreadDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onAddToChat: AddToChat;
}) {
  const { review } = row;
  const state = useGitHubWrittenItem(
    {
      id: review.id,
      body: review.body,
      url: review.url,
      reactions: review.reactions,
      edit: review.canEdit ? { kind: "review", id: review.id } : null,
      remove: null,
    },
    run,
  );
  const open = row.threads.filter((thread) => !thread.resolved);
  const resolved = row.threads.filter((thread) => thread.resolved);
  // A review without words has nothing to react to; GitHub offers reactions only on its body.
  const hasBody =
    review.body.trim().length > 0 || state.mode !== "read" || review.reactions.groups.length > 0;
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
        <GitHubWrittenItemActions
          state={state}
          onAddToChat={onAddToChat ? () => onAddToChat({ kind: "review", item: review }) : null}
        />
      }
      after={
        detail.kind === "pull_request" && row.threads.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2">
            {open.map((thread) => (
              <GitHubReviewThreadCard
                key={thread.id}
                thread={thread}
                pr={detail}
                run={run}
                placement="activity"
                onAddToChat={onAddToChat}
              />
            ))}
            {resolved.length > 0 ? (
              <ResolvedThreads
                threads={resolved}
                render={(thread) => (
                  <GitHubReviewThreadCard
                    key={thread.id}
                    thread={thread}
                    pr={detail}
                    run={run}
                    placement="activity"
                    onAddToChat={onAddToChat}
                  />
                )}
              />
            ) : null}
          </div>
        ) : null
      }
    >
      {hasBody ? <GitHubWrittenItemBody state={state} thread={detail.ref} /> : null}
    </ConversationEntry>
  );
}

/** Settled conversations stay out of the way, one line to bring them back. */
function ResolvedThreads({
  threads,
  render,
}: {
  readonly threads: readonly GitHubReviewThread[];
  readonly render: (thread: GitHubReviewThread) => ReactNode;
}) {
  const [shown, setShown] = useState(threads.length === 1);
  if (shown) return <>{threads.map(render)}</>;
  return (
    <button
      type="button"
      aria-expanded={false}
      onClick={() => setShown(true)}
      className="cursor-interaction flex items-center gap-1 self-start text-sm text-token-description-foreground hover:text-token-text-primary"
    >
      <ChevronRightIcon className="icon-2xs" />
      <FormattedMessage
        id="githubThread.activity.resolvedConversations"
        defaultMessage="{count, plural, one {# resolved conversation} other {# resolved conversations}}"
        values={{ count: threads.length }}
      />
    </button>
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
