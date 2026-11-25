import { useQuery } from "@tanstack/react-query";
import { NODEX_BUTTON_COLOR_CLASS } from "@/components/ui/button";
import { PageTurnPhraseView } from "@/components/workbench/page-turn-chip";
import { useIntl } from "@/lib/i18n";
import { acceptReviewWithUndo, useReviewAccepted } from "@/lib/page-accept-undo";
import { pageTurnPhrase, type PageTurnHolder, type PageTurnPhrase } from "@/lib/page-turn-phrase";
import { projectSessionDetailQueryOptions } from "@/lib/query-options";
import { useSessionLinkedPage } from "@/lib/session-linked-page";
import { cn } from "@/lib/utils";
import type { PageTurn } from "../../../../../shared/page-turn";
import type { SessionLinkedPage } from "../../../../../shared/types";
import { useNodexReferenceInteraction } from "@/components/nodex-reference/nodex-reference";
import { COMPOSER_ATTACHED_TAB_CLASS, ComposerAttachedTabSlot } from "../composer-context-rail";

/** A chat's own Turn is always the reader's, so it is worded for them. */
const READER: PageTurnHolder = { you: true, name: "" };

export interface ChatReview {
  readonly turn: PageTurn;
  readonly phrase: PageTurnPhrase;
  /** The Page under review, when the chat's linked Page is that one. */
  readonly page: SessionLinkedPage | null;
}

/**
 * The review this chat's Page waits on the reader for, or null. A review the reader just accepted
 * no longer asks, even while its Undo is still offered.
 */
export function useChatReview(sessionId: string | null): ChatReview | null {
  const detail = useQuery({
    ...projectSessionDetailQueryOptions(sessionId ?? ""),
    enabled: sessionId !== null,
  });
  const turn = detail.data?.pageTurn ?? null;
  const review = turn?.reason === "review" ? turn : null;
  const accepted = useReviewAccepted(review);
  const linked = useSessionLinkedPage(sessionId);
  const phrase = review ? pageTurnPhrase(review, READER) : null;
  if (!review || !phrase || accepted) return null;
  return { turn: review, phrase, page: linked?.pageId === review.page_id ? linked : null };
}

/**
 * Work ready for the reader's review, decided where they read it: one line attached to the
 * composer names the Page and offers Accept. Replying instead asks the Agent for changes, and the
 * Page goes back to work when the Agent picks the reply up.
 */
export function ComposerReviewRail({
  review,
  placement,
}: {
  review: ChatReview;
  placement: "attached" | "inset";
}) {
  const intl = useIntl();
  const { turn, phrase, page } = review;
  const pageName = page ? [page.pageKey, page.title].filter(Boolean).join(" ") : null;
  const pageReference = useNodexReferenceInteraction({
    destination: { kind: "page", pageId: turn.page_id },
    openable: true,
    ...(page?.title ? { title: page.title } : {}),
  });
  const row = (
    <div
      role="group"
      aria-label={intl.formatMessage({
        id: "conversation.composerReviewRail.label",
        defaultMessage: "Review",
      })}
      data-composer-review=""
      className={cn(
        "relative flex min-w-0 animate-in items-center gap-2 bg-[var(--color-background-composer-action-bar)] text-size-chat-sm leading-5 duration-150 select-none fade-in-0 slide-in-from-bottom-1",
        placement === "attached"
          ? cn(COMPOSER_ATTACHED_TAB_CLASS, "pr-1 pl-3")
          : // Concentric with the floating card: its 22px corner less this 8px inset.
            "mx-2 mt-2 rounded-[14px] py-1 pr-1 pl-2.5",
      )}
    >
      <PageTurnPhraseView turn={turn} phrase={phrase} glyph className="shrink-0" />
      {pageName ? (
        <button
          type="button"
          className="min-w-0 truncate-fade text-left text-token-description-foreground hover:text-token-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-token-focus-border disabled:no-underline"
          disabled={!pageReference.interactive}
          {...pageReference.handlers}
        >
          {pageName}
        </button>
      ) : null}
      <span aria-hidden="true" className="flex-1" />
      <button
        type="button"
        className={cn(
          NODEX_BUTTON_COLOR_CLASS.primary,
          "h-6 shrink-0 cursor-interaction rounded-full px-2.5 whitespace-nowrap focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-token-focus-border",
        )}
        data-composer-review-accept=""
        onClick={() => acceptReviewWithUndo(turn)}
      >
        {intl.formatMessage({
          id: "conversation.composerReviewRail.accept",
          defaultMessage: "Accept",
        })}
      </button>
    </div>
  );
  return placement === "attached" ? <ComposerAttachedTabSlot>{row}</ComposerAttachedTabSlot> : row;
}
