import { useState } from "react";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { cn } from "@/lib/utils";
import { ActivitySpinnerIcon, NodexLogoMarkIcon } from "@/components/shared/icons/app-icons";
import {
  countDiscussionFilters,
  matchesDiscussionFilter,
  type DiscussionFilter,
  type DiscussionView,
} from "../discussion-view-model";
import { commentPreviewText } from "../comment-preview";
import { MemberAvatar } from "./member-avatar";

const FILTERS: readonly {
  readonly id: DiscussionFilter;
  readonly label: { id: string; defaultMessage: string };
}[] = [
  { id: "open", label: { id: "pageDiscussions.panel.open", defaultMessage: "Open" } },
  { id: "me", label: { id: "pageDiscussions.panel.forMe", defaultMessage: "For me" } },
  { id: "nodex", label: { id: "pageDiscussions.panel.nodex", defaultMessage: "Nodex" } },
  { id: "resolved", label: { id: "pageDiscussions.panel.resolved", defaultMessage: "Resolved" } },
];

/**
 * Every Discussion on the Page in one list, filtered by what it waits for. Choosing a row reveals
 * its anchor and opens its card; resolved Discussions are reachable only here.
 */
export function DiscussionsPanel({
  discussions,
  nowMs,
  onSelect,
  initialFilter = "open",
}: {
  readonly discussions: readonly DiscussionView[];
  readonly nowMs: number;
  readonly onSelect: (discussionId: string) => void;
  readonly initialFilter?: DiscussionFilter;
}) {
  const intl = useIntl();
  const [filter, setFilter] = useState<DiscussionFilter>(initialFilter);
  const counts = countDiscussionFilters(discussions);
  const visible = discussions
    .filter((discussion) => matchesDiscussionFilter(discussion, filter))
    .toSorted((a, b) => b.lastActivityMs - a.lastActivityMs);
  return (
    <div className="flex max-h-[min(36rem,70vh)] w-80 max-w-full flex-col text-sm">
      <div
        role="tablist"
        aria-label={intl.formatMessage({
          id: "pageDiscussions.panel.filters",
          defaultMessage: "Show Discussions",
        })}
        className="flex items-center gap-0.5 border-b-[0.5px] border-token-border p-1"
      >
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={filter === option.id}
            onClick={() => setFilter(option.id)}
            className={cn(
              "flex h-6 cursor-interaction items-center gap-1 rounded-md px-2 text-xs",
              filter === option.id
                ? "bg-token-foreground/10 text-token-foreground"
                : "text-token-description-foreground hover:bg-token-foreground/5",
            )}
          >
            {intl.formatMessage(option.label)}
            {counts[option.id] > 0 ? (
              <span className="tabular-nums opacity-70">{counts[option.id]}</span>
            ) : null}
          </button>
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-pretty text-token-description-foreground">
          <EmptyMessage filter={filter} />
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col overflow-y-auto p-1">
          {visible.map((discussion) => (
            <li key={discussion.id}>
              <DiscussionRow discussion={discussion} nowMs={nowMs} onSelect={onSelect} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiscussionRow({
  discussion,
  nowMs,
  onSelect,
}: {
  readonly discussion: DiscussionView;
  readonly nowMs: number;
  readonly onSelect: (discussionId: string) => void;
}) {
  const first = discussion.comments.find((comment) => !comment.deleted) ?? discussion.comments[0];
  const last = discussion.comments.at(-1);
  const replies = discussion.comments.filter((comment) => !comment.deleted).length - 1;
  return (
    <button
      type="button"
      onClick={() => onSelect(discussion.id)}
      className="flex w-full cursor-interaction flex-col gap-1 rounded-lg px-2 py-2 text-left hover:bg-token-list-hover-background"
    >
      {discussion.quote ? (
        <span
          className={cn(
            "line-clamp-1 border-l-2 border-(--color-token-charts-yellow) pl-1.5 text-xs text-token-description-foreground",
            discussion.orphaned && "line-through",
          )}
        >
          {discussion.quote}
        </span>
      ) : null}
      {first ? (
        <span className="flex min-w-0 items-start gap-1.5">
          {first.author.kind === "member" ? (
            <MemberAvatar
              memberId={first.author.memberId}
              name={first.author.name}
              size={16}
              className="mt-0.5"
            />
          ) : (
            <NodexLogoMarkIcon className="mt-0.5 size-4 shrink-0" />
          )}
          <span className="line-clamp-2 min-w-0 flex-1">
            {commentPreviewText(first.bodyMarkdown)}
          </span>
        </span>
      ) : null}
      <span className="flex items-center gap-1.5 pl-[22px] text-xs text-token-description-foreground">
        {discussion.waiting === "nodex" ? (
          <ActivitySpinnerIcon className="size-3 text-info" />
        ) : null}
        {discussion.waiting === "me" ? (
          <span className="text-info">
            <FormattedMessage
              id="pageDiscussions.panel.waitingForYou"
              defaultMessage="Waiting for you"
            />
          </span>
        ) : null}
        {replies > 0 ? (
          <FormattedMessage
            id="pageDiscussions.panel.replies"
            defaultMessage="{count, plural, one {# reply} other {# replies}}"
            values={{ count: replies }}
          />
        ) : null}
        {last ? (
          <span className="tabular-nums">{formatCompactRelativeTime(last.createdAtMs, nowMs)}</span>
        ) : null}
      </span>
    </button>
  );
}

function EmptyMessage({ filter }: { readonly filter: DiscussionFilter }) {
  switch (filter) {
    case "open":
      return (
        <FormattedMessage
          id="pageDiscussions.panel.emptyOpen"
          defaultMessage="No open Discussions. Select text to comment, or ask Nodex."
        />
      );
    case "me":
      return (
        <FormattedMessage
          id="pageDiscussions.panel.emptyForMe"
          defaultMessage="Nothing is waiting for you"
        />
      );
    case "nodex":
      return (
        <FormattedMessage
          id="pageDiscussions.panel.emptyNodex"
          defaultMessage="Nodex isn't working on anything here"
        />
      );
    case "resolved":
      return (
        <FormattedMessage
          id="pageDiscussions.panel.emptyResolved"
          defaultMessage="No resolved Discussions"
        />
      );
  }
}
