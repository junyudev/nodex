import { AnimatePresence, motion } from "motion/react";
import { ImportantFilledIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { cn } from "@/lib/utils";
import type { InboxBuriedImportant } from "./inbox-presentation";
import { INBOX_EASE_OUT } from "./inbox-stream-item";

/**
 * Importance is calm gold, never alarm red: what is important is rarely urgent, and urgency
 * already announces itself.
 */
const IMPORTANT_TONE = "text-(--yellow-text)";

/**
 * The gold star of an important message, beside its bubble and inside its checkbox. It stays
 * through hover and selection, and choosing it takes the mark off; only the message menu marks a
 * message. Marking pops it in and unmarking shrinks it away; a message that arrives already
 * marked shows it at rest.
 */
export function InboxImportantStar({
  important,
  onUnmark,
}: {
  readonly important: boolean;
  readonly onUnmark: () => void;
}) {
  return (
    // The stream holds its first messages still, so the star keeps its own presence.
    <AnimatePresence initial={false}>
      {important ? (
        <motion.span
          key="important"
          initial={{ scale: 0.4, opacity: 0, rotate: -36 }}
          animate={{ scale: 1, opacity: 1, rotate: 0 }}
          exit={{ scale: 0.4, opacity: 0, transition: { duration: 0.14 } }}
          transition={{ type: "spring", stiffness: 520, damping: 24 }}
          className="flex shrink-0"
        >
          <NodexTooltip tooltipContent="Unmark important" side="top">
            <NodexButton
              size="icon-xs"
              variant="ghost"
              aria-label="Unmark important"
              onClick={onUnmark}
              className={cn(IMPORTANT_TONE, "hover:text-(--yellow-text)")}
            >
              <ImportantFilledIcon className="icon-xs" />
            </NodexButton>
          </NodexTooltip>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

/**
 * A soft gold ring on a message the reader was just brought to. It peaks once the scroll has
 * landed, then fades; every arrival plays it again.
 */
export function InboxArrivalRing({ token }: { readonly token: number | null }) {
  return (
    // Its own presence, so it plays inside a stream that holds its first messages still.
    <AnimatePresence>
      {token == null ? null : (
        <motion.span
          key={token}
          aria-hidden="true"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ duration: 2.2, times: [0, 0.25, 0.7, 1], ease: "easeOut" }}
          className="pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-(--yellow-text) ring-inset"
        />
      )}
    </AnimatePresence>
  );
}

/**
 * Floats at the top of the stream while an important message is out of view: the
 * longest-waiting one, how long it has waited, and a way back to it. It mirrors the selection
 * bar above the composer, so it never resizes or shifts the stream. Its surface stays opaque
 * under the pointer: the hover tint is translucent, so it lies over the surface instead of
 * replacing it, and the stream never shows through the words.
 */
export function InboxImportantBar({
  buried,
  nowMs,
  onJump,
}: {
  readonly buried: InboxBuriedImportant | null;
  readonly nowMs: number;
  readonly onJump: (pageId: string) => void;
}) {
  return (
    <AnimatePresence>
      {buried ? (
        <motion.div
          key="important-bar"
          initial={{ opacity: 0, y: -6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: INBOX_EASE_OUT }}
          className="pointer-events-none absolute inset-x-toolbar top-2 z-10 flex justify-center"
        >
          <button
            type="button"
            data-testid="inbox-important-bar"
            aria-label={`Go to important message: ${buried.message.title || "Untitled"}`}
            onClick={() => onJump(buried.message.pageId)}
            className="cursor-interaction pointer-events-auto flex h-8 max-w-[min(32rem,100%)] min-w-0 items-center gap-2 rounded-full border border-token-border bg-token-main-surface-primary pr-3 pl-2.5 text-sm shadow-lg hover:bg-[linear-gradient(var(--color-token-list-hover-background),var(--color-token-list-hover-background))]"
          >
            <ImportantFilledIcon className={cn("icon-xs shrink-0", IMPORTANT_TONE)} />
            <motion.span
              key={buried.message.pageId}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.18, ease: INBOX_EASE_OUT }}
              className="min-w-0 truncate text-token-foreground"
            >
              {buried.message.title || "Untitled"}
            </motion.span>
            <time
              dateTime={buried.message.submittedAt}
              className="shrink-0 text-token-description-foreground tabular-nums"
            >
              {formatCompactRelativeTime(Date.parse(buried.message.submittedAt), nowMs)}
            </time>
            {buried.total > 1 ? (
              <span className="shrink-0 text-xs text-token-text-tertiary tabular-nums">
                {buried.position}/{buried.total}
              </span>
            ) : null}
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
