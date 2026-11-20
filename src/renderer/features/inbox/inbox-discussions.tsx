import { FormattedMessage, useIntl } from "@/lib/i18n";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { cn } from "@/lib/utils";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import {
  NodexLogoMarkIcon,
  TextActionCommentIcon,
  TextActionCommentPencilIcon,
} from "@/components/shared/icons/app-icons";
import { requestDiscussionReveal } from "@/features/page-discussions/discussion-reveal";
import type { DiscussionInboxEntry } from "../../../shared/discussions";
import type { InboxScope } from "../../../shared/inbox";
import { useDiscussionInbox } from "./use-inbox";

const REASON_LABELS = {
  needs_you: { id: "inbox.discussions.needsYou", defaultMessage: "Nodex is waiting for you" },
  suggested_edit: { id: "inbox.discussions.suggestedEdit", defaultMessage: "Suggested an edit" },
  mention: { id: "inbox.discussions.mention", defaultMessage: "Mentioned you" },
  answered: { id: "inbox.discussions.answered", defaultMessage: "Nodex answered" },
  reply: { id: "inbox.discussions.reply", defaultMessage: "New reply" },
} as const;

function ReasonIcon({ reason }: { readonly reason: DiscussionInboxEntry["reason"] }) {
  if (reason === "needs_you" || reason === "answered")
    return (
      <NodexLogoMarkIcon
        className={cn("size-3.5 shrink-0", reason === "needs_you" && "text-info")}
        monochrome
      />
    );
  if (reason === "suggested_edit") return <TextActionCommentPencilIcon className="size-4" />;
  return <TextActionCommentIcon className="size-4" />;
}

/**
 * What waits for the person in Page Discussions: Nodex's questions, answers to their Asks,
 * mentions, replies and suggested edits. A quiet pill at the top of the Inbox opens the list;
 * choosing an entry opens its Page at the Discussion.
 */
export function InboxDiscussions({
  scope,
  nowMs,
  onOpenPage,
}: {
  readonly scope: InboxScope;
  readonly nowMs: number;
  readonly onOpenPage: (pageId: string) => void;
}) {
  const intl = useIntl();
  const query = useDiscussionInbox(scope);
  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  if (entries.length === 0) return null;
  const needsYou = entries.some((entry) => entry.reason === "needs_you");
  return (
    <div className="pointer-events-none absolute top-2 right-toolbar z-10 flex">
      <NodexPopover>
        <NodexPopoverTrigger>
          <button
            type="button"
            data-testid="inbox-discussions"
            className="pointer-events-auto flex h-8 cursor-interaction items-center gap-1.5 rounded-full border border-token-border bg-token-main-surface-primary pr-3 pl-2.5 text-sm shadow-lg hover:bg-[linear-gradient(var(--color-token-list-hover-background),var(--color-token-list-hover-background))]"
          >
            <TextActionCommentIcon className={cn("size-4", needsYou && "text-info")} />
            <FormattedMessage
              id="inbox.discussions.pill"
              defaultMessage="{count, plural, one {# in your Pages} other {# in your Pages}}"
              values={{ count: entries.length }}
            />
          </button>
        </NodexPopoverTrigger>
        <NodexPopoverContent
          align="end"
          className="w-[min(26rem,calc(100vw-24px))] rounded-xl bg-token-dropdown-background/95 p-1 shadow-xl-spread ring-[0.5px] ring-token-border backdrop-blur-xl"
        >
          <ul
            aria-label={intl.formatMessage({
              id: "inbox.discussions.listLabel",
              defaultMessage: "Discussions in your Pages",
            })}
            className="flex max-h-[min(28rem,70vh)] flex-col overflow-y-auto"
          >
            {entries.map((entry) => (
              <li key={`${entry.discussionId}:${entry.commentId}:${entry.reason}`}>
                <button
                  type="button"
                  onClick={() => {
                    requestDiscussionReveal(entry.pageId, entry.discussionId);
                    onOpenPage(entry.pageId);
                  }}
                  className="flex w-full cursor-interaction items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-token-list-hover-background"
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-token-description-foreground">
                    <ReasonIcon reason={entry.reason} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {entry.title ||
                          intl.formatMessage({
                            id: "inbox.discussions.untitled",
                            defaultMessage: "Untitled",
                          })}
                      </span>
                      <time
                        dateTime={entry.occurredAt}
                        className="shrink-0 text-xs text-token-description-foreground tabular-nums"
                      >
                        {formatCompactRelativeTime(Date.parse(entry.occurredAt), nowMs)}
                      </time>
                    </span>
                    <span className="text-xs text-token-description-foreground">
                      {intl.formatMessage(REASON_LABELS[entry.reason])}
                    </span>
                    {entry.excerpt ? (
                      <span className="line-clamp-2 text-xs text-token-text-secondary">
                        {entry.excerpt}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </NodexPopoverContent>
      </NodexPopover>
    </div>
  );
}
