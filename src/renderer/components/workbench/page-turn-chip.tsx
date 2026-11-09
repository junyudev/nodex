import type { ComponentType } from "react";
import type { PageTurn, TurnReason } from "../../../shared/page-turn";
import {
  ActivitySpinnerIcon,
  ClockIcon,
  DeniedCircleIcon,
  PlayIcon,
  SuccessCircleIcon,
  QuestionIcon,
} from "@/components/shared/icons";
import { WarningCircleIcon } from "@/components/shared/icons/plugin-detail-icons";
import { PauseIcon } from "@/components/shared/icons/canonical-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import {
  pageTurnPhrase,
  type PageTurnHolder,
  type PageTurnPhrase,
  type PageTurnTone,
} from "@/lib/page-turn-phrase";
import { cn } from "@/lib/utils";

const GLYPHS: Record<TurnReason, ComponentType<{ className?: string }>> = {
  paused: PauseIcon,
  working: ActivitySpinnerIcon,
  queued: ClockIcon,
  question: QuestionIcon,
  approval: SuccessCircleIcon,
  review: SuccessCircleIcon,
  blocked: WarningCircleIcon,
  failed: DeniedCircleIcon,
  stalled: WarningCircleIcon,
  ready_to_start: ClockIcon,
  starting: ClockIcon,
  waiting_on_prerequisite: ClockIcon,
};
const PAGE_TURN_TONE_CLASS_NAME: Record<PageTurnTone, string> = {
  attention: "text-token-warning-foreground",
  danger: "text-danger",
  quiet: "text-token-text-secondary",
};

/**
 * The turn phrase as one inline value. A prerequisite is a link to its Page, and a pause names who
 * paused how much in its tooltip; `glyph` leads the phrase where nothing else names its kind.
 */
export function PageTurnPhraseView({
  turn,
  phrase,
  glyph,
  onOpenPage,
  className,
}: {
  readonly turn: PageTurn;
  readonly phrase: PageTurnPhrase;
  readonly glyph: boolean;
  readonly onOpenPage?: (pageId: string) => void;
  readonly className?: string;
}) {
  const Glyph = turn.reason ? GLYPHS[turn.reason] : null;
  const body = (
    <>
      {glyph && Glyph ? <Glyph className="size-3.5 shrink-0" /> : null}
      <span className="truncate">{phrase.text}</span>
    </>
  );
  const shared = {
    "data-page-turn": turn.reason ?? undefined,
    className: cn(
      "inline-flex min-w-0 items-center gap-1 text-xs/4 [font-weight:450]",
      PAGE_TURN_TONE_CLASS_NAME[phrase.tone],
      className,
    ),
  };
  if (turn.actor.kind === "page") {
    const pageId = turn.actor.page_id;
    return (
      <a
        {...shared}
        className={cn(shared.className, "hover:text-token-text-primary hover:underline")}
        href={buildPageDeepLink({ pageId })}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpenPage?.(pageId);
        }}
      >
        {body}
      </a>
    );
  }
  if (phrase.detail)
    return (
      <NodexTooltip tooltipContent={phrase.detail}>
        <span {...shared} aria-label={phrase.detail}>
          {body}
        </span>
      </NodexTooltip>
    );
  return <span {...shared}>{body}</span>;
}

/** The turn as a card or row shows it: its glyph and phrase, or Start when the work can start. */
export function PageTurnChip({
  turn,
  holder,
  onStart,
  disabled = false,
  onOpenPage,
}: {
  readonly turn: PageTurn;
  readonly holder: PageTurnHolder;
  readonly onStart?: () => void;
  readonly disabled?: boolean;
  readonly onOpenPage?: (pageId: string) => void;
}) {
  const phrase = pageTurnPhrase(turn, holder);
  if (!phrase) return null;
  if (turn.reason === "ready_to_start" && onStart)
    return (
      <button
        type="button"
        data-page-turn="ready_to_start"
        disabled={disabled}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onStart();
        }}
        className="cursor-interaction inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs/4 [font-weight:450] text-token-text-secondary ring-[0.5px] ring-token-border ring-inset hover:bg-token-foreground/5 disabled:opacity-50"
      >
        <PlayIcon className="size-3 shrink-0" />
        Start
      </button>
    );
  return (
    <PageTurnPhraseView
      turn={turn}
      phrase={phrase}
      glyph
      onOpenPage={onOpenPage}
      className="h-6 px-0.5"
    />
  );
}
