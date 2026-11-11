import { useState } from "react";
import type { InboxItem } from "../../../shared/inbox";
import {
  NoteIcon,
  TodoIcon,
  CheckmarkIcon,
  DeleteIcon,
  ImportantFilledIcon,
  InboxIcon,
  PageIcon,
} from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { InboxCopyAction } from "./inbox-copy-action";
import { InboxIconAction, InboxIconActions } from "./inbox-icon-action";
import { formatLaterClock, formatLaterTime, laterSections } from "./inbox-later";
import { InboxLaterMenu } from "./inbox-later-menu";
import { InboxMessageDocument } from "./inbox-message-document";
import { INBOX_HOLD_LABELS, type InboxHold } from "./inbox-presentation";
import { useInboxClock } from "./use-inbox-clock";

export interface InboxLaterHandlers {
  readonly onOpenPage: (pageId: string) => void;
  /** Brings the message back to the Inbox now. */
  readonly onReturn: (pageId: string) => void;
  /** Changes when the message comes back. */
  readonly onReschedule: (pageId: string, remindAt: string) => void;
  /** Decides a message without bringing it back first: held as work or as a note, or done. */
  readonly onHold: (item: InboxItem, hold: InboxHold) => void;
  readonly onSetDone: (pageId: string) => void;
  readonly onDelete: (item: InboxItem) => void;
}

function LaterLine({
  item,
  now,
  handlers,
}: {
  readonly item: InboxItem;
  readonly now: Date;
  readonly handlers: InboxLaterHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!item.later) return null;
  const remindAt = item.later.until;
  const clock = formatLaterClock(remindAt);
  const reschedule = (
    <InboxLaterMenu
      label="Change time"
      current={remindAt}
      onChoose={(next) => handlers.onReschedule(item.pageId, next)}
    />
  );
  const returnNow = (
    <InboxIconAction
      label="Return to Inbox"
      icon={InboxIcon}
      onClick={() => handlers.onReturn(item.pageId)}
    />
  );
  return (
    <li
      data-testid="inbox-later-row"
      data-inbox-page-id={item.pageId}
      className="group/later border-b border-token-border/40 text-sm last:border-b-0"
    >
      <div className="flex min-h-8 items-center gap-1">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "cursor-interaction flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-token-foreground/5",
            expanded && "bg-token-foreground/5",
          )}
        >
          {/* A day's section names the date, so its rows only add the time of day. */}
          <time
            dateTime={remindAt}
            className="w-16 shrink-0 text-xs whitespace-nowrap text-token-description-foreground tabular-nums"
          >
            {clock}
          </time>
          <span className="min-w-0 flex-1 truncate text-token-foreground">{item.title}</span>
        </button>
        {/* The mark waits with the message and returns with it. */}
        {item.important ? (
          <span role="img" aria-label="Important" className="flex shrink-0 px-1">
            <ImportantFilledIcon className="icon-xs text-(--yellow-text)" />
          </span>
        ) : null}
        {/* The two ways out of Later stay within reach of the pointer, without opening the row. */}
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5 transition-opacity",
            expanded
              ? "hidden"
              : "opacity-0 group-hover/later:opacity-100 focus-within:opacity-100",
          )}
        >
          {reschedule}
          {returnNow}
        </div>
        {item.pageKey ? (
          <NodexTooltip tooltipContent="Open page">
            <NodexButton
              size="xs"
              variant="ghost"
              onClick={() => handlers.onOpenPage(item.pageId)}
              className="shrink-0 font-mono text-[11px] text-token-description-foreground"
            >
              {item.pageKey}
            </NodexButton>
          </NodexTooltip>
        ) : null}
      </div>
      {expanded ? (
        // Aligned with the title: the time and its gap come before it.
        <div className="flex flex-col gap-2 pr-1 pb-2 pl-[4.75rem] text-xs text-token-description-foreground">
          <div className="border-l-2 border-token-border pl-3 text-sm text-token-foreground/85">
            <InboxMessageDocument item={item} />
          </div>
          <div className="flex min-h-6 items-center gap-2">
            <span className="truncate">Returns {formatLaterTime(remindAt, now)}</span>
            <InboxIconActions>
              <InboxIconAction
                label="Open page"
                icon={PageIcon}
                onClick={() => handlers.onOpenPage(item.pageId)}
              />
              <InboxCopyAction item={item} />
              {reschedule}
              {/* Work that waits on the reader for another reason is decided on its own row. */}
              {item.rowKind === "intake" ? (
                <>
                  {(["todo", "notes"] as const).map((hold) => (
                    <InboxIconAction
                      key={hold}
                      label={INBOX_HOLD_LABELS[hold]}
                      icon={hold === "notes" ? NoteIcon : TodoIcon}
                      onClick={() => handlers.onHold(item, hold)}
                    />
                  ))}
                  <InboxIconAction
                    label="Mark done"
                    icon={CheckmarkIcon}
                    onClick={() => handlers.onSetDone(item.pageId)}
                  />
                </>
              ) : null}
              {returnNow}
              {/* A message filed into a Project is that Project's Page now; it is deleted there. */}
              {item.rowKind === "intake" && item.location.kind === "inbox" ? (
                <InboxIconAction
                  label="Delete"
                  icon={DeleteIcon}
                  tone="danger"
                  onClick={() => handlers.onDelete(item)}
                />
              ) : null}
            </InboxIconActions>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * What the reader set aside, in the order it comes back: grouped by day, soonest first. Each
 * message is still waiting for its decision, so a line expands to the message and the ways to
 * decide it without bringing it back first.
 */
export function InboxLaterView({
  items,
  ...handlers
}: { readonly items: readonly InboxItem[] } & InboxLaterHandlers) {
  const now = new Date(useInboxClock());
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-base font-medium text-token-foreground">Nothing set aside</p>
        <p className="max-w-sm text-sm text-balance text-token-description-foreground">
          A message that can wait leaves the Inbox with Later, and comes back when its time comes.
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {laterSections(items, now).map((section) => (
        <section key={section.key} aria-label={section.label} className="flex flex-col">
          <h3 className="px-1 pb-1 text-xs font-medium text-token-description-foreground">
            {section.label}
          </h3>
          <ul className="flex flex-col">
            {section.items.map((item) => (
              <LaterLine key={item.pageId} item={item} now={now} handlers={handlers} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
