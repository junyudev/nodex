import { useState } from "react";
import type { InboxItem } from "../../../shared/inbox";
import {
  DeleteIcon,
  InboxIcon,
  PageIcon,
  ProjectFolderIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { InboxIconAction, InboxIconActions } from "./inbox-icon-action";
import { InboxOutcomeGlyph, InboxOutcomeLine } from "./inbox-outcome";
import {
  describeInboxOutcome,
  formatInboxTime,
  groupInboxItemsByDay,
  type InboxOutcomeTarget,
} from "./inbox-presentation";

function HistoryRow({
  item,
  onOpenTarget,
  onOpenPage,
  onReturn,
  onDelete,
}: {
  readonly item: InboxItem;
  readonly onOpenTarget: (target: InboxOutcomeTarget) => void;
  readonly onOpenPage: () => void;
  readonly onReturn: () => void;
  readonly onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outcome = describeInboxOutcome(item);
  const target = outcome.open;
  return (
    <li data-testid="inbox-history-row" className="flex flex-col">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        className={cn(
          "cursor-interaction grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-token-list-hover-background",
          expanded && "bg-token-list-hover-background",
        )}
      >
        <InboxOutcomeGlyph icon={outcome.icon} className="text-token-description-foreground" />
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 shrink truncate text-sm text-token-foreground">
            {item.title}
          </span>
          <InboxOutcomeLine outcome={outcome} glyph={false} className="max-w-[55%] shrink-0" />
        </span>
        <span className="text-xs text-token-description-foreground tabular-nums">
          {formatInboxTime(item.submittedAt)}
        </span>
      </button>
      {expanded ? (
        <div className="mb-2 ml-9 flex flex-col gap-2 pt-1 pr-2">
          <p className="border-l-2 border-token-border pl-3 text-sm leading-relaxed whitespace-pre-wrap text-token-foreground/85">
            {item.body}
          </p>
          <div className="flex items-center gap-2">
            {item.pageKey ? (
              <span className="font-mono text-[11px] text-token-description-foreground">
                {item.pageKey}
              </span>
            ) : null}
            <InboxIconActions>
              {target ? (
                <InboxIconAction
                  label={target.kind === "session" ? "Open chat" : "Open in Project"}
                  icon={target.kind === "session" ? ThreadIcon : ProjectFolderIcon}
                  onClick={() => onOpenTarget(target)}
                />
              ) : null}
              <InboxIconAction label="Open Page" icon={PageIcon} onClick={onOpenPage} />
              {outcome.canReturn ? (
                <InboxIconAction label="Return to Inbox" icon={InboxIcon} onClick={onReturn} />
              ) : null}
              {/* A message filed into a Project is that Project's Page now; it is deleted there. */}
              {item.location.kind === "inbox" ? (
                <InboxIconAction
                  label="Delete"
                  icon={DeleteIcon}
                  tone="danger"
                  onClick={onDelete}
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
 * Everything already handled, newest first: one line per message naming it and where it went.
 * Expanding a line shows the message and the ways back to its work.
 */
export function InboxHistory({
  items,
  onOpenTarget,
  onOpenPage,
  onReturn,
  onDelete,
}: {
  readonly items: readonly InboxItem[];
  readonly onOpenTarget: (target: InboxOutcomeTarget) => void;
  readonly onOpenPage: (pageId: string) => void;
  readonly onReturn: (pageId: string) => void;
  readonly onDelete: (item: InboxItem) => void;
}) {
  const sections = groupInboxItemsByDay(items, new Date());
  return (
    <div data-testid="inbox-history" className="flex flex-col gap-5">
      {sections.map((section) => (
        <section key={section.key} className="flex flex-col gap-0.5">
          <h2 className="px-2 pb-1 text-xs font-medium text-token-description-foreground">
            {section.label}
          </h2>
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item) => (
              <HistoryRow
                key={item.pageId}
                item={item}
                onOpenTarget={onOpenTarget}
                onOpenPage={() => onOpenPage(item.pageId)}
                onReturn={() => onReturn(item.pageId)}
                onDelete={() => onDelete(item)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
