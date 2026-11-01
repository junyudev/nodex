import { CloseIcon, SuccessCircleIcon } from "@/components/shared/icons";
import type { ThreadTurnModel } from "../thread-stage-types";

/** The last assistant answer of a turn, as one line of text. */
export function resolveFloatingConversationAnswerPreview(turn: ThreadTurnModel): string | null {
  for (let index = turn.searchUnits.length - 1; index >= 0; index -= 1) {
    const unit = turn.searchUnits[index];
    if (unit?.blockType !== "assistantMessage") continue;
    const text = unit.text.replace(/\s+/g, " ").trim();
    if (text) return text;
  }
  return null;
}

/** A completed, unread response announced above a compact floating composer. */
export function FloatingConversationCompletionPreview({
  title,
  preview,
  onOpen,
  onDismiss,
}: {
  title: string;
  preview: string | null;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      data-floating-conversation-completion-preview="true"
      className="composer-surface-chrome relative flex shrink-0 rounded-2xl bg-token-input-background select-none electron:dark:bg-token-dropdown-background"
    >
      <button
        type="button"
        aria-label={`Open completed response: ${title}`}
        className="min-w-0 flex-1 cursor-interaction rounded-[inherit] px-4 py-3 text-start focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none focus-visible:ring-inset"
        onClick={onOpen}
      >
        <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-token-foreground">
          <SuccessCircleIcon className="icon-sm shrink-0 text-token-charts-green" />
          <span className="truncate">{title}</span>
        </span>
        <span className="block truncate text-sm text-token-description-foreground">
          {preview || "Response ready"}
        </span>
      </button>
      <div className="absolute -top-1 -left-1 flex rounded-full bg-token-input-background">
        <button
          type="button"
          aria-label="Dismiss and mark as read"
          className="flex size-5 cursor-interaction items-center justify-center rounded-full border border-token-border text-token-description-foreground hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
          onClick={onDismiss}
        >
          <CloseIcon className="pointer-events-none size-3" />
        </button>
      </div>
    </div>
  );
}
