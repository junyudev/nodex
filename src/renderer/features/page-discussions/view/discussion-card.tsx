import type { ReactNode } from "react";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { FormattedMessage, useIntl } from "@/lib/i18n";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { cn } from "@/lib/utils";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  CloseIcon,
  NodexLogoMarkIcon,
  UndoIcon,
} from "@/components/shared/icons/app-icons";
import type {
  AskState,
  CommentView,
  DiscussionView,
  EvidenceView,
  SuggestedEditView,
  VerdictResult,
} from "../discussion-view-model";
import { isActiveAsk } from "../discussion-view-model";
import { MemberAvatar } from "./member-avatar";

/** Everything a card can do; the owning feature Module implements each action. */
export interface DiscussionCardActions {
  readonly resolve: (discussionId: string) => void;
  readonly reopen: (discussionId: string) => void;
  readonly acceptSuggestedEdit: (commentId: string) => void;
  readonly rejectSuggestedEdit: (commentId: string) => void;
  readonly askNodex: (discussionId: string) => void;
  readonly stopAsk: (commentId: string) => void;
  readonly retryAsk: (commentId: string) => void;
  readonly openConversation: (sessionId: string) => void;
  readonly undoAsk: (discussionId: string) => void;
}

export interface DiscussionCardProps {
  readonly discussion: DiscussionView;
  readonly active: boolean;
  readonly nowMs: number;
  readonly actions: DiscussionCardActions;
  /** The reply composer, shown only while the card is active. */
  readonly composer: ReactNode;
  readonly onActivate: () => void;
  readonly className?: string;
}

/** Collapsed cards show the opening Comment and a reply summary; the active card shows all. */
const COLLAPSED_TAIL = 1;
const CARD_CONTROLS = "button, a, input, textarea, [role='button'], [role='link']";

export function DiscussionCard({
  discussion,
  active,
  nowMs,
  actions,
  composer,
  onActivate,
  className,
}: DiscussionCardProps) {
  const intl = useIntl();
  const comments = discussion.comments.filter((comment) => !comment.deleted || active);
  const [first, ...rest] = comments;
  const hidden = active ? 0 : Math.max(0, rest.length - COLLAPSED_TAIL);
  const tail = active ? rest : rest.slice(rest.length - Math.min(rest.length, COLLAPSED_TAIL));
  const canUndoAsk =
    discussion.latestAsk?.kind === "in_place" && discussion.latestAsk.state === "answered";

  return (
    <article
      data-discussion-card={discussion.id}
      data-active={active ? "true" : undefined}
      aria-label={intl.formatMessage({
        id: "pageDiscussions.discussionCard.label",
        defaultMessage: "Discussion",
      })}
      onPointerDown={
        active
          ? undefined
          : (event) => {
              // A control acts on its own: activating first would re-lay out the margin and move
              // the control out from under the click.
              if (event.target instanceof Element && event.target.closest(CARD_CONTROLS)) return;
              onActivate();
            }
      }
      className={cn(
        "group/discussion flex w-full flex-col rounded-xl bg-token-main-surface-primary text-sm text-token-foreground ring-[0.5px] ring-token-border",
        active ? "shadow-xl-spread" : "cursor-interaction hover:shadow-md",
        discussion.resolved && !active && "opacity-60",
        className,
      )}
    >
      {discussion.orphaned ? <OrphanedQuote quote={discussion.quote} /> : null}
      <div className="flex flex-col gap-3 px-3 pt-2.5 pb-3">
        {first ? (
          <CommentEntry
            comment={first}
            nowMs={nowMs}
            actions={actions}
            collapsed={!active}
            headerActions={
              <DiscussionHeaderActions
                discussion={discussion}
                actions={actions}
                canUndoAsk={canUndoAsk}
              />
            }
          />
        ) : null}
        {hidden > 0 ? (
          <button
            type="button"
            className="-my-1 self-start text-xs text-token-description-foreground hover:text-token-foreground"
            onClick={onActivate}
          >
            <FormattedMessage
              id="pageDiscussions.discussionCard.moreReplies"
              defaultMessage="{count, plural, one {# more reply} other {# more replies}}"
              values={{ count: hidden }}
            />
          </button>
        ) : null}
        {tail.map((comment) => (
          <CommentEntry
            key={comment.id}
            comment={comment}
            nowMs={nowMs}
            actions={actions}
            collapsed={!active}
          />
        ))}
        {discussion.offerAskNodex ? (
          <div className="flex items-center gap-2 text-xs text-token-description-foreground">
            <NodexLogoMarkIcon className="size-3.5 shrink-0" monochrome />
            <span className="min-w-0 flex-1 truncate">
              <FormattedMessage
                id="pageDiscussions.discussionCard.offer"
                defaultMessage="Nodex can look into this"
              />
            </span>
            <NodexButton
              variant="ghostSecondary"
              size="xs"
              onClick={(event) => {
                event.stopPropagation();
                actions.askNodex(discussion.id);
              }}
            >
              <FormattedMessage
                id="pageDiscussions.discussionCard.askNodex"
                defaultMessage="Ask Nodex"
              />
            </NodexButton>
          </div>
        ) : null}
      </div>
      {active && !discussion.resolved ? (
        <div className="border-t-[0.5px] border-token-border px-2 py-1.5">{composer}</div>
      ) : null}
    </article>
  );
}

function DiscussionHeaderActions({
  discussion,
  actions,
  canUndoAsk,
}: {
  readonly discussion: DiscussionView;
  readonly actions: DiscussionCardActions;
  readonly canUndoAsk: boolean;
}) {
  const intl = useIntl();
  return (
    <div className="flex shrink-0 items-center gap-0.5 opacity-0 group-hover/discussion:opacity-100 group-data-[active=true]/discussion:opacity-100 has-focus-visible:opacity-100">
      {canUndoAsk ? (
        <NodexIconButton
          size="xs"
          icon={UndoIcon}
          ariaLabel={intl.formatMessage({
            id: "pageDiscussions.discussionCard.undoAsk",
            defaultMessage: "Undo this Ask",
          })}
          onClick={(event) => {
            event.stopPropagation();
            actions.undoAsk(discussion.id);
          }}
        />
      ) : null}
      {discussion.canResolve ? (
        discussion.resolved ? (
          <NodexButton
            variant="ghostSecondary"
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              actions.reopen(discussion.id);
            }}
          >
            <FormattedMessage id="pageDiscussions.discussionCard.reopen" defaultMessage="Reopen" />
          </NodexButton>
        ) : (
          <NodexIconButton
            size="xs"
            icon={CheckmarkIcon}
            ariaLabel={intl.formatMessage({
              id: "pageDiscussions.discussionCard.resolve",
              defaultMessage: "Resolve",
            })}
            onClick={(event) => {
              event.stopPropagation();
              actions.resolve(discussion.id);
            }}
          />
        )
      ) : null}
    </div>
  );
}

function OrphanedQuote({ quote }: { readonly quote: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b-[0.5px] border-token-border px-3 py-2 text-xs">
      <span className="text-token-description-foreground">
        <FormattedMessage
          id="pageDiscussions.discussionCard.originalDeleted"
          defaultMessage="Original text deleted"
        />
      </span>
      {quote ? (
        <span className="line-clamp-2 text-token-text-secondary line-through">{quote}</span>
      ) : null}
    </div>
  );
}

function CommentEntry({
  comment,
  nowMs,
  actions,
  collapsed,
  headerActions,
}: {
  readonly comment: CommentView;
  readonly nowMs: number;
  readonly actions: DiscussionCardActions;
  readonly collapsed: boolean;
  readonly headerActions?: ReactNode;
}) {
  return (
    <div data-comment={comment.id} className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <CommentAuthor comment={comment} nowMs={nowMs} />
        {headerActions}
      </div>
      {comment.deleted ? (
        <p className="text-token-description-foreground italic">
          <FormattedMessage id="pageDiscussions.comment.deleted" defaultMessage="Comment deleted" />
        </p>
      ) : (
        <>
          {comment.verdict ? <VerdictLine result={comment.verdict.result} /> : null}
          {comment.bodyMarkdown ? (
            <MarkdownRenderer
              content={comment.bodyMarkdown}
              parseIncompleteMarkdown={false}
              className={cn("text-sm leading-5 break-words", collapsed && "line-clamp-4")}
            />
          ) : null}
          {comment.verdict && comment.verdict.evidence.length > 0 && !collapsed ? (
            <EvidenceList evidence={comment.verdict.evidence} />
          ) : null}
          {comment.suggestedEdit ? (
            <SuggestedEditPreview
              edit={comment.suggestedEdit}
              collapsed={collapsed}
              onAccept={() => actions.acceptSuggestedEdit(comment.id)}
              onReject={() => actions.rejectSuggestedEdit(comment.id)}
            />
          ) : null}
          {comment.ask && comment.ask.state !== "answered" ? (
            <AskStatusLine
              state={comment.ask.state}
              onStop={() => actions.stopAsk(comment.id)}
              onRetry={() => actions.retryAsk(comment.id)}
              onOpen={
                comment.ask.sessionId
                  ? () => actions.openConversation(comment.ask!.sessionId!)
                  : null
              }
            />
          ) : null}
        </>
      )}
    </div>
  );
}

function CommentAuthor({
  comment,
  nowMs,
}: {
  readonly comment: CommentView;
  readonly nowMs: number;
}) {
  const intl = useIntl();
  const time = formatCompactRelativeTime(comment.createdAtMs, nowMs);
  if (comment.author.kind === "nodex") {
    const onBehalfOf = comment.author.onBehalfOf;
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full bg-token-foreground/8">
          <NodexLogoMarkIcon className="size-3" monochrome />
        </span>
        <span className="shrink-0 font-medium">Nodex</span>
        {onBehalfOf ? (
          <span className="min-w-0 truncate text-xs text-token-description-foreground">
            {intl.formatMessage(
              { id: "pageDiscussions.comment.onBehalfOf", defaultMessage: "for {name}" },
              { name: onBehalfOf.name },
            )}
          </span>
        ) : null}
        <span className="shrink-0 text-xs text-token-description-foreground tabular-nums">
          {time}
        </span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <MemberAvatar memberId={comment.author.memberId} name={comment.author.name} size={18} />
      <span className="min-w-0 truncate font-medium">{comment.author.name}</span>
      <span className="shrink-0 text-xs text-token-description-foreground tabular-nums">
        {time}
        {comment.edited ? (
          <>
            {" · "}
            <FormattedMessage id="pageDiscussions.comment.edited" defaultMessage="edited" />
          </>
        ) : null}
      </span>
    </div>
  );
}

const VERDICT_PRESENTATION: Record<
  VerdictResult,
  {
    readonly glyph: string;
    readonly tone: string;
    readonly label: { id: string; defaultMessage: string };
  }
> = {
  true: {
    glyph: "●",
    tone: "text-success",
    label: { id: "pageDiscussions.verdict.true", defaultMessage: "True" },
  },
  partly_true: {
    glyph: "◐",
    tone: "text-warning",
    label: { id: "pageDiscussions.verdict.partlyTrue", defaultMessage: "Partly true" },
  },
  false: {
    glyph: "✕",
    tone: "text-danger",
    label: { id: "pageDiscussions.verdict.false", defaultMessage: "Not true" },
  },
  unverifiable: {
    glyph: "?",
    tone: "text-token-description-foreground",
    label: { id: "pageDiscussions.verdict.unverifiable", defaultMessage: "Can't verify" },
  },
};

function VerdictLine({ result }: { readonly result: VerdictResult }) {
  const intl = useIntl();
  const presentation = VERDICT_PRESENTATION[result];
  return (
    <div data-verdict={result} className="flex items-center gap-1.5 text-sm font-medium">
      <span
        aria-hidden="true"
        className={cn("w-3 shrink-0 text-center text-xs", presentation.tone)}
      >
        {presentation.glyph}
      </span>
      <span>{intl.formatMessage(presentation.label)}</span>
    </div>
  );
}

function EvidenceList({ evidence }: { readonly evidence: readonly EvidenceView[] }) {
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-token-description-foreground">
      {evidence.map((item, index) => (
        <li key={`${index}:${item.title}`} className="flex min-w-0 gap-1.5">
          <span aria-hidden="true" className="shrink-0">
            ↳
          </span>
          {item.url ? (
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer"
              className="min-w-0 truncate underline decoration-token-border underline-offset-2 hover:text-token-foreground"
            >
              {item.title}
            </a>
          ) : (
            <span className="min-w-0 truncate">{item.title}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function SuggestedEditPreview({
  edit,
  collapsed,
  onAccept,
  onReject,
}: {
  readonly edit: SuggestedEditView;
  readonly collapsed: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}) {
  const intl = useIntl();
  return (
    <div data-suggested-edit={edit.state} className="flex flex-col gap-1.5">
      <div
        className={cn(
          "rounded-lg bg-token-foreground/[0.03] px-2 py-1.5 text-sm leading-5 break-words whitespace-pre-wrap",
          collapsed && "line-clamp-4",
          edit.state !== "open" && "opacity-70",
        )}
      >
        {edit.diff.kind === "segments" ? (
          edit.diff.segments.map((segment, index) =>
            segment.kind === "equal" ? (
              <span key={index}>{segment.text}</span>
            ) : segment.kind === "delete" ? (
              <del
                key={index}
                className="text-token-description-foreground decoration-text-danger/60"
              >
                {segment.text}
              </del>
            ) : (
              <ins
                key={index}
                className="rounded-[3px] bg-text-info/12 text-token-foreground no-underline"
              >
                {segment.text}
              </ins>
            ),
          )
        ) : (
          <span>{edit.newMarkdown}</span>
        )}
      </div>
      {edit.state === "open" ? (
        edit.canAccept || edit.canReject ? (
          <div className="flex items-center gap-1">
            {edit.canAccept ? (
              <NodexButton
                variant="primary"
                size="xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onAccept();
                }}
              >
                <CheckmarkIcon className="size-3" />
                <FormattedMessage
                  id="pageDiscussions.suggestedEdit.accept"
                  defaultMessage="Accept"
                />
              </NodexButton>
            ) : null}
            {edit.canReject ? (
              <NodexIconButton
                size="xs"
                icon={CloseIcon}
                ariaLabel={intl.formatMessage({
                  id: "pageDiscussions.suggestedEdit.reject",
                  defaultMessage: "Reject",
                })}
                onClick={(event) => {
                  event.stopPropagation();
                  onReject();
                }}
              />
            ) : null}
          </div>
        ) : null
      ) : (
        <span className="text-xs text-token-description-foreground">
          <SuggestedEditOutcome edit={edit} />
        </span>
      )}
    </div>
  );
}

function SuggestedEditOutcome({ edit }: { readonly edit: SuggestedEditView }) {
  switch (edit.state) {
    case "accepted":
      return edit.decidedBy ? (
        <FormattedMessage
          id="pageDiscussions.suggestedEdit.acceptedBy"
          defaultMessage="Accepted by {name}"
          values={{ name: edit.decidedBy }}
        />
      ) : (
        <FormattedMessage id="pageDiscussions.suggestedEdit.accepted" defaultMessage="Accepted" />
      );
    case "rejected":
      return (
        <FormattedMessage id="pageDiscussions.suggestedEdit.rejected" defaultMessage="Rejected" />
      );
    case "stale":
      return (
        <FormattedMessage
          id="pageDiscussions.suggestedEdit.stale"
          defaultMessage="The original changed after this was suggested"
        />
      );
    case "open":
      return null;
  }
}

function AskStatusLine({
  state,
  onStop,
  onRetry,
  onOpen,
}: {
  readonly state: AskState;
  readonly onStop: () => void;
  readonly onRetry: () => void;
  readonly onOpen: (() => void) | null;
}) {
  const active = isActiveAsk(state);
  return (
    <div data-ask-state={state} className="flex h-6 items-center gap-1.5 text-xs">
      {active ? (
        <ActivitySpinnerIcon className="size-3 shrink-0 text-info" />
      ) : (
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            state === "failed" ? "bg-(--color-text-danger)" : "bg-token-foreground/30",
          )}
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          state === "failed" ? "text-danger" : "text-token-description-foreground",
        )}
      >
        <AskStateLabel state={state} />
      </span>
      {onOpen ? (
        <NodexButton
          variant="ghostSecondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <FormattedMessage id="pageDiscussions.ask.viewWork" defaultMessage="View" />
        </NodexButton>
      ) : null}
      {active ? (
        <NodexButton
          variant="ghostSecondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            onStop();
          }}
        >
          <FormattedMessage id="pageDiscussions.ask.stop" defaultMessage="Stop" />
        </NodexButton>
      ) : state === "failed" || state === "stopped" ? (
        <NodexButton
          variant="ghostSecondary"
          size="xs"
          onClick={(event) => {
            event.stopPropagation();
            onRetry();
          }}
        >
          <FormattedMessage id="pageDiscussions.ask.retry" defaultMessage="Retry" />
        </NodexButton>
      ) : null}
    </div>
  );
}

/** The product's one vocabulary for Agent work states, shared with Prompt blocks. */
export function AskStateLabel({ state }: { readonly state: AskState }) {
  switch (state) {
    case "queued":
      return <FormattedMessage id="pageDiscussions.ask.queued" defaultMessage="Queued" />;
    case "working":
      return <FormattedMessage id="pageDiscussions.ask.working" defaultMessage="Working…" />;
    case "needs_you":
      return <FormattedMessage id="pageDiscussions.ask.needsYou" defaultMessage="Needs you" />;
    case "answered":
      return <FormattedMessage id="pageDiscussions.ask.answered" defaultMessage="Answered" />;
    case "failed":
      return <FormattedMessage id="pageDiscussions.ask.failed" defaultMessage="Failed" />;
    case "stopped":
      return <FormattedMessage id="pageDiscussions.ask.stopped" defaultMessage="Stopped" />;
  }
}
