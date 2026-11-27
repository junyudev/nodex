import { FormattedMessage, useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexButton } from "@/components/ui/button";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
  NodexLogoMarkIcon,
} from "@/components/shared/icons/app-icons";
import type { AskState } from "../discussion-view-model";
import { isActiveAsk } from "../discussion-view-model";
import { AskStateLabel } from "./discussion-card";

/** One recent step of the Run, newest last. */
export interface PendingStepView {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
}

export interface PendingBlockViewProps {
  /** Nodex's one-sentence intent, or the request until Nodex sets one. */
  readonly title: string;
  /** Null for a placeholder an Agent wrote without an Ask (a section it is about to write). */
  readonly state: AskState | null;
  readonly steps: readonly PendingStepView[];
  readonly requesterName: string | null;
  readonly elapsedLabel: string | null;
  readonly failureMessage: string | null;
  readonly onStop: (() => void) | null;
  readonly onRetry: (() => void) | null;
  readonly onRemove: (() => void) | null;
  readonly onOpenConversation: (() => void) | null;
  /** Opens the Ask's Discussion, where Nodex replied or asked something. */
  readonly onOpenDiscussion: (() => void) | null;
}

/** The most recent steps worth showing; older ones live in the conversation. */
export const PENDING_VISIBLE_STEPS = 3;

/**
 * A reserved place in the Page where Nodex is working. It shows what Nodex intends to put here,
 * the latest steps, and Stop; when the Run finishes, Nodex replaces this block with its result.
 */
export function PendingBlockView({
  title,
  state,
  steps,
  requesterName,
  elapsedLabel,
  failureMessage,
  onStop,
  onRetry,
  onRemove,
  onOpenConversation,
  onOpenDiscussion,
}: PendingBlockViewProps) {
  const intl = useIntl();
  const active = state === null || isActiveAsk(state);
  const failed = state === "failed" || state === "stopped";
  // Nodex finished or paused without filling this place; its Discussion says why.
  const waiting = state === "answered" || state === "needs_you";
  const visibleSteps = steps.slice(-PENDING_VISIBLE_STEPS);
  return (
    <div
      contentEditable={false}
      data-pending-block-state={state ?? "placeholder"}
      role="status"
      aria-label={intl.formatMessage({
        id: "pageDiscussions.pending.label",
        defaultMessage: "Nodex is working here",
      })}
      className="my-1 flex w-full flex-col gap-2 rounded-xl bg-token-foreground/[0.025] px-3 py-2.5 text-sm ring-[0.5px] ring-token-border select-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {active ? (
            <ActivitySpinnerIcon className="size-3.5 text-info" />
          ) : (
            <NodexLogoMarkIcon className="size-3.5" monochrome />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        {state ? (
          <span
            className={cn(
              "shrink-0 text-xs",
              state === "failed" ? "text-danger" : "text-token-description-foreground",
            )}
          >
            <AskStateLabel state={state} />
          </span>
        ) : null}
      </div>
      {visibleSteps.length > 0 && !failed ? (
        <ol className="flex flex-col gap-1 pl-6 text-xs text-token-description-foreground">
          {visibleSteps.map((step, index) => {
            const current = !step.done && index === visibleSteps.length - 1 && active;
            return (
              <li key={step.id} className="flex min-w-0 items-center gap-1.5">
                <span className="flex size-3 shrink-0 items-center justify-center">
                  {step.done ? (
                    <CheckmarkIcon className="size-3 text-token-description-foreground" />
                  ) : current ? (
                    <span className="size-1.5 animate-pulse rounded-full bg-(--color-text-info)" />
                  ) : (
                    <span className="size-1.5 rounded-full bg-token-foreground/20" />
                  )}
                </span>
                <span className={cn("min-w-0 truncate", current && "text-token-foreground")}>
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {failed && failureMessage ? (
        <p className="pl-6 text-xs text-token-text-secondary">{failureMessage}</p>
      ) : null}
      {waiting ? (
        <p className="pl-6 text-xs text-token-text-secondary">
          {state === "needs_you" ? (
            <FormattedMessage
              id="pageDiscussions.pending.needsYou"
              defaultMessage="Nodex has a question before it can fill this place."
            />
          ) : (
            <FormattedMessage
              id="pageDiscussions.pending.answeredElsewhere"
              defaultMessage="Nodex replied in the Discussion without filling this place."
            />
          )}
        </p>
      ) : null}
      {state ? (
        <div className="flex min-w-0 items-center gap-1 pl-6 text-xs text-token-description-foreground">
          <span className="min-w-0 flex-1 truncate tabular-nums">
            {requesterName
              ? intl.formatMessage(
                  {
                    id: "pageDiscussions.pending.forRequester",
                    defaultMessage: "Nodex for {name}",
                  },
                  { name: requesterName },
                )
              : "Nodex"}
            {elapsedLabel ? ` · ${elapsedLabel}` : null}
          </span>
          {waiting && onOpenDiscussion ? (
            <NodexButton variant="ghostSecondary" size="xs" onClick={onOpenDiscussion}>
              <FormattedMessage
                id="pageDiscussions.pending.openDiscussion"
                defaultMessage="Open Discussion"
              />
            </NodexButton>
          ) : null}
          {onOpenConversation ? (
            <NodexButton variant="ghostSecondary" size="xs" onClick={onOpenConversation}>
              <FormattedMessage id="pageDiscussions.pending.viewWork" defaultMessage="View work" />
            </NodexButton>
          ) : null}
          {active && onStop ? (
            <NodexButton variant="ghostSecondary" size="xs" onClick={onStop}>
              <FormattedMessage id="pageDiscussions.pending.stop" defaultMessage="Stop" />
            </NodexButton>
          ) : null}
          {failed && onRetry ? (
            <NodexButton variant="ghostSecondary" size="xs" onClick={onRetry}>
              <FormattedMessage id="pageDiscussions.pending.retry" defaultMessage="Retry" />
            </NodexButton>
          ) : null}
          {(failed || state === "answered") && onRemove ? (
            <NodexButton variant="ghostSecondary" size="xs" onClick={onRemove}>
              <FormattedMessage id="pageDiscussions.pending.remove" defaultMessage="Remove" />
            </NodexButton>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
