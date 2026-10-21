import { useState } from "react";
import type { InboxItem } from "../../../shared/inbox";
import {
  CheckmarkIcon,
  DeleteIcon,
  InboxIcon,
  PageIcon,
  ProjectFolderIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import { InboxCopyAction } from "./inbox-copy-action";
import { InboxIconAction, InboxIconActions } from "./inbox-icon-action";
import { InboxMessageDocument } from "./inbox-message-document";
import { InboxOutcomeGlyph, InboxOutcomeLine } from "./inbox-outcome";
import {
  formatInboxTime,
  formatInboxWhen,
  groupInboxItemsByDay,
  type InboxOutcome,
  type InboxOutcomeTarget,
} from "./inbox-presentation";
import { useInboxOutcomes } from "./use-inbox-outcome";

interface HistoryHandlers {
  readonly onOpenTarget: (target: InboxOutcomeTarget) => void;
  readonly onOpenPage: (pageId: string) => void;
  readonly onReturn: (pageId: string) => void;
  readonly onSetDone: (pageId: string, done: boolean) => void;
  readonly onDelete: (item: InboxItem) => void;
}

function HistoryRow({
  item,
  outcome,
  when,
  handlers,
}: {
  readonly item: InboxItem;
  readonly outcome: InboxOutcome;
  readonly when: string;
  readonly handlers: HistoryHandlers;
}) {
  const [expanded, setExpanded] = useState(false);
  const target = outcome.open;
  return (
    <li data-testid="inbox-history-row" data-inbox-page-id={item.pageId} className="flex flex-col">
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
        <span className="text-xs text-token-description-foreground tabular-nums">{when}</span>
      </button>
      {expanded ? (
        <div className="mb-2 ml-9 flex flex-col gap-2 pt-1 pr-2">
          <div className="border-l-2 border-token-border pl-3 text-token-foreground/85">
            <InboxMessageDocument item={item} />
          </div>
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
                  onClick={() => handlers.onOpenTarget(target)}
                />
              ) : null}
              <InboxIconAction
                label="Open page"
                icon={PageIcon}
                onClick={() => handlers.onOpenPage(item.pageId)}
              />
              <InboxCopyAction item={item} />
              {/* A finished chat leaves its work open until the user says it is done. */}
              {outcome.done === null ? null : (
                <InboxIconAction
                  label={outcome.done ? "Reopen" : "Mark done"}
                  icon={CheckmarkIcon}
                  onClick={() => handlers.onSetDone(item.pageId, !outcome.done)}
                />
              )}
              {outcome.canReturn ? (
                <InboxIconAction
                  label="Return to Inbox"
                  icon={InboxIcon}
                  onClick={() => handlers.onReturn(item.pageId)}
                />
              ) : null}
              {/* A message filed into a Project is that Project's Page now; it is deleted there. */}
              {item.location.kind === "inbox" ? (
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

function HistorySection({
  label,
  items,
  outcomes,
  when,
  handlers,
}: {
  readonly label: string;
  readonly items: readonly InboxItem[];
  readonly outcomes: ReadonlyMap<string, InboxOutcome>;
  /** When each message was sent, as its line shows it under this heading. */
  readonly when: (item: InboxItem) => string;
  readonly handlers: HistoryHandlers;
}) {
  return (
    <section aria-label={label} className="flex flex-col gap-0.5">
      <h2 className="px-2 pb-1 text-xs font-medium text-token-description-foreground">{label}</h2>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <HistoryRow
            key={item.pageId}
            item={item}
            outcome={outcomes.get(item.pageId)!}
            when={when(item)}
            handlers={handlers}
          />
        ))}
      </ul>
    </section>
  );
}

/**
 * Everything already handled, newest first: one line per message naming it and where it went.
 * Work still under way leads, and the rest follows by day. Expanding a line shows the message
 * and the ways back to its work.
 */
export function InboxHistory({
  items,
  ...handlers
}: { readonly items: readonly InboxItem[] } & HistoryHandlers) {
  const now = new Date();
  const outcomes = useInboxOutcomes(items);
  const inProgress = items.filter((item) => outcomes.get(item.pageId)?.inProgress);
  const finished = items.filter((item) => !outcomes.get(item.pageId)?.inProgress);
  return (
    <div data-testid="inbox-history" className="flex flex-col gap-5">
      {inProgress.length > 0 ? (
        <HistorySection
          label="In progress"
          items={inProgress}
          outcomes={outcomes}
          when={(item) => formatInboxWhen(item.submittedAt, now)}
          handlers={handlers}
        />
      ) : null}
      {groupInboxItemsByDay(finished, now).map((section) => (
        <HistorySection
          key={section.key}
          label={section.label}
          items={section.items}
          outcomes={outcomes}
          when={(item) => formatInboxTime(item.submittedAt)}
          handlers={handlers}
        />
      ))}
    </div>
  );
}
