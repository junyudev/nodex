import { FormattedMessage, useIntl, type IntlShape } from "@/lib/i18n";
import { useState, type ReactNode } from "react";
import { SuccessCircleIcon } from "@/components/shared/icons";
import {
  ChatBubblesIcon16,
  WarningCircleIcon,
} from "@/components/shared/icons/plugin-detail-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { toast } from "@/components/ui/toast";
import { ViewerButton } from "@/components/ui/viewer-header";
import { cn } from "@/lib/utils";
import type { GitHubPullRequestDetail } from "../../../shared/github-thread";
import { GitHubMarkdownEditor } from "./github-thread-editor";
import { gitHubReviewNeedsBody, type GitHubReviewEvent } from "./github-thread-model";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

const EVENTS: readonly GitHubReviewEvent[] = ["comment", "approve", "request_changes"];

const EVENT_GLYPH: Record<GitHubReviewEvent, ReactNode> = {
  comment: <ChatBubblesIcon16 className="icon-xs text-token-description-foreground" />,
  approve: <SuccessCircleIcon className="icon-xs text-token-charts-green" />,
  request_changes: <WarningCircleIcon className="icon-xs text-token-charts-red" />,
};

function eventLabel(intl: IntlShape, event: GitHubReviewEvent): string {
  return intl.formatMessage(
    {
      id: "githubThread.review.event",
      defaultMessage:
        "{event, select, approve {Approve} request_changes {Request changes} other {Comment}}",
    },
    { event },
  );
}

/** Why the viewer cannot give a verdict, when they cannot. */
function verdictUnavailable(intl: IntlShape, pr: GitHubPullRequestDetail): string | null {
  if (pr.state !== "open")
    return intl.formatMessage({
      id: "githubThread.review.closedVerdict",
      defaultMessage: "Only an open pull request can be approved or sent back",
    });
  if (!pr.viewer.canApprove)
    return intl.formatMessage({
      id: "githubThread.review.ownVerdict",
      defaultMessage: "You can’t approve or request changes on your own pull request",
    });
  if (pr.draft)
    return intl.formatMessage({
      id: "githubThread.review.draftVerdict",
      defaultMessage: "A draft can’t be approved or sent back yet",
    });
  return null;
}

/**
 * The toolbar's Review: finish the viewer's pending review, or review the change in one step.
 * It says how many pending comments wait, since only the viewer sees them until then.
 */
export function GitHubReviewButton({
  pr,
  run,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);
  const pending = pr.pendingReview;
  if (!pending && (pr.state !== "open" || !pr.viewer.canComment)) return null;
  const count = pending?.commentCount ?? 0;
  const label = intl.formatMessage({ id: "githubThread.review.button", defaultMessage: "Review" });
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <ViewerButton
          aria-label={
            count > 0
              ? intl.formatMessage(
                  {
                    id: "githubThread.review.buttonPending",
                    defaultMessage:
                      "Review, {count, plural, one {# pending comment} other {# pending comments}}",
                  },
                  { count },
                )
              : label
          }
          className="aria-expanded:bg-token-foreground/5"
        >
          <span>{label}</span>
          {count > 0 ? (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-token-charts-orange/15 px-1 text-[11px] font-medium tabular-nums text-token-charts-orange">
              {count}
            </span>
          ) : null}
        </ViewerButton>
      </NodexPopoverTrigger>
      <NodexPopoverContent align="end" className="w-[400px] gap-2 p-3">
        {open ? <ReviewForm pr={pr} run={run} onDone={() => setOpen(false)} /> : null}
      </NodexPopoverContent>
    </NodexPopover>
  );
}

function ReviewForm({
  pr,
  run,
  onDone,
}: {
  readonly pr: GitHubPullRequestDetail;
  readonly run: GitHubThreadCommandRunner;
  readonly onDone: () => void;
}) {
  const intl = useIntl();
  const [event, setEvent] = useState<GitHubReviewEvent>("comment");
  const [discarding, setDiscarding] = useState(false);
  const pending = pr.pendingReview;
  const count = pending?.commentCount ?? 0;
  const verdictBlocked = verdictUnavailable(intl, pr);
  const needsBody = gitHubReviewNeedsBody(event, count);
  const stale = pending?.commitSha && pending.commitSha !== pr.headSha;

  const submit = async (body: string) => {
    const done = await run.run({
      type: "submit_review",
      event,
      body,
      expectedHeadSha: pending?.commitSha ?? pr.headSha,
      pendingReviewId: pending?.id ?? null,
    });
    if (!done) return false;
    toast.success(
      intl.formatMessage(
        {
          id: "githubThread.review.submitted",
          defaultMessage:
            "{event, select, approve {Approved} request_changes {Requested changes} other {Review submitted}}",
        },
        { event },
      ),
    );
    onDone();
    return true;
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2 px-0.5">
        <span className="text-sm font-medium text-token-text-primary">
          {pending ? (
            <FormattedMessage
              id="githubThread.review.finishTitle"
              defaultMessage="Finish your review"
            />
          ) : (
            <FormattedMessage id="githubThread.review.title" defaultMessage="Review changes" />
          )}
        </span>
        {pending ? (
          <span className="text-xs text-token-description-foreground">
            <FormattedMessage
              id="githubThread.review.pendingCount"
              defaultMessage="{count, plural, =0 {No pending comments} one {# pending comment} other {# pending comments}}"
              values={{ count }}
            />
          </span>
        ) : null}
      </div>
      <div role="radiogroup" className="flex flex-col">
        {EVENTS.map((value) => {
          const disabled = value !== "comment" && verdictBlocked !== null;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={event === value}
              disabled={disabled}
              onClick={() => setEvent(value)}
              className={cn(
                "cursor-interaction flex h-8 items-center gap-2 rounded-lg px-2 text-left text-sm disabled:cursor-default disabled:opacity-50",
                event === value
                  ? "bg-token-foreground/[0.07] text-token-text-primary"
                  : "text-token-text-secondary not-disabled:hover:bg-token-foreground/5",
              )}
            >
              {EVENT_GLYPH[value]}
              <span className="min-w-0 flex-1 truncate">{eventLabel(intl, value)}</span>
              <span
                aria-hidden
                className={cn(
                  "size-3.5 shrink-0 rounded-full ring-1 ring-token-border ring-inset",
                  event === value && "ring-4 ring-token-text-primary",
                )}
              />
            </button>
          );
        })}
      </div>
      {verdictBlocked ? (
        <p className="px-0.5 text-xs text-token-description-foreground">{verdictBlocked}</p>
      ) : null}
      {stale ? (
        <p className="px-0.5 text-xs text-token-charts-orange">
          <FormattedMessage
            id="githubThread.review.stale"
            defaultMessage="New commits arrived after you started this review. Your comments stay on the lines you saw."
          />
        </p>
      ) : null}
      <GitHubMarkdownEditor
        autoFocus
        ariaLabel={intl.formatMessage({
          id: "githubThread.review.bodyLabel",
          defaultMessage: "Review summary",
        })}
        placeholder={
          needsBody
            ? intl.formatMessage({
                id: "githubThread.review.bodyRequired",
                defaultMessage: "Leave a comment",
              })
            : intl.formatMessage({
                id: "githubThread.review.bodyOptional",
                defaultMessage: "Leave a comment (optional)",
              })
        }
        hint={
          pending && !discarding ? (
            <button
              type="button"
              onClick={() => setDiscarding(true)}
              className="cursor-interaction text-xs text-token-description-foreground hover:text-danger"
            >
              <FormattedMessage id="githubThread.review.discard" defaultMessage="Discard review" />
            </button>
          ) : null
        }
        actions={[
          {
            id: "submit",
            label: intl.formatMessage({
              id: "githubThread.review.submit",
              defaultMessage: "Submit review",
            }),
            requiresText: needsBody,
            disabled: discarding,
            submit,
          },
        ]}
      />
      {pending && discarding ? (
        <div
          role="alert"
          className="flex min-h-9 items-center gap-2 rounded-lg bg-(--color-background-danger-surface) px-3 py-1 text-sm"
        >
          <span className="min-w-0 flex-1 text-danger">
            <FormattedMessage
              id="githubThread.review.discardConfirm"
              defaultMessage="{count, plural, =0 {Discard this review?} one {Discard this review and its pending comment?} other {Discard this review and its # pending comments?}}"
              values={{ count }}
            />
          </span>
          <NodexButton size="toolbar" variant="ghost" onClick={() => setDiscarding(false)}>
            <FormattedMessage id="githubThread.review.keep" defaultMessage="Keep" />
          </NodexButton>
          <NodexButton
            size="toolbar"
            variant="destructive"
            onClick={() =>
              void run
                .run({ type: "discard_review", pendingReviewId: pending.id })
                .then((done) => (done ? onDone() : setDiscarding(false)))
            }
          >
            <FormattedMessage id="githubThread.review.discardAction" defaultMessage="Discard" />
          </NodexButton>
        </div>
      ) : null}
    </div>
  );
}
