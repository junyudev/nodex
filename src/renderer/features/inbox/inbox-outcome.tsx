import {
  ActivitySpinnerIcon,
  ArchiveIcon,
  CheckmarkIcon,
  InboxIcon,
  MoveToIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import type { InboxChatTone, InboxOutcome, InboxOutcomeIcon } from "./inbox-presentation";

const TONE_DOT: Readonly<Record<InboxChatTone, string>> = {
  working: "bg-token-charts-blue animate-pulse",
  attention: "bg-token-charts-orange",
  error: "bg-token-error-foreground",
  quiet: "bg-token-description-foreground/50",
};

export function InboxOutcomeGlyph({
  icon,
  className,
}: {
  readonly icon: InboxOutcomeIcon;
  readonly className?: string;
}) {
  const shared = cn("icon-xs shrink-0", className);
  switch (icon) {
    case "chat":
      return <ThreadIcon className={shared} />;
    case "pending":
      return <ActivitySpinnerIcon className={shared} />;
    case "move":
      return <MoveToIcon className={shared} />;
    case "keep":
      return <ArchiveIcon className={shared} />;
    case "done":
      return <CheckmarkIcon className={shared} />;
    case "inbox":
      return <InboxIcon className={shared} />;
  }
}

/** Where a handled message went, with the receiving chat's live state when there is one. */
export function InboxOutcomeLine({
  outcome,
  glyph = true,
  className,
}: {
  readonly outcome: InboxOutcome;
  /** Off where the row already leads with the glyph. */
  readonly glyph?: boolean;
  readonly className?: string;
}) {
  return (
    <span
      className={cn(
        "flex min-w-0 items-center gap-1.5 text-xs text-token-description-foreground",
        className,
      )}
    >
      {glyph ? <InboxOutcomeGlyph icon={outcome.icon} /> : null}
      <span className="min-w-0 truncate">{outcome.label}</span>
      {outcome.status ? (
        <span className="flex shrink-0 items-center gap-1">
          <span aria-hidden="true">·</span>
          <span
            aria-hidden="true"
            className={cn("size-1.5 rounded-full", TONE_DOT[outcome.status.tone])}
          />
          {outcome.status.label}
        </span>
      ) : null}
    </span>
  );
}
