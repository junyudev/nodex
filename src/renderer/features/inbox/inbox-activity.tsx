import { useState } from "react";
import type { ActivityFilter, ActivityRow, InboxItem } from "../../../shared/inbox";
import {
  ChatBubbleIcon,
  CheckmarkIcon,
  DeleteIcon,
  InboxIcon,
  NodexLogoMarkIcon,
  OpenExternalIcon,
  PageIcon,
  ProjectFolderIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import { PersonCircleIcon } from "@/components/shared/icons/customize-action-icons";
import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { openExternalUrl } from "@/lib/file-system-operations";
import { cn } from "@/lib/utils";
import { InboxCopyAction } from "./inbox-copy-action";
import { InboxIconAction, InboxIconActions } from "./inbox-icon-action";
import { InboxMessageDocument } from "./inbox-message-document";
import { InboxChatStatusDot } from "./inbox-outcome";
import {
  formatInboxTime,
  groupByDay,
  type InboxOutcome,
  type InboxOutcomeTarget,
} from "./inbox-presentation";
import { useInboxClock } from "./use-inbox-clock";
import { useInboxOutcomes } from "./use-inbox-outcome";

export const ACTIVITY_FILTER_LABELS: Readonly<Record<ActivityFilter, string>> = {
  all: "All",
  messages: "Messages",
  decisions: "Nodex & automations",
  problems: "Problems",
};

/** What collects under each filter, said where it has nothing yet. */
const EMPTY_DESCRIPTIONS: Readonly<Record<ActivityFilter, string>> = {
  all: "Messages you handle, and what Nodex, your Automations and GitHub do, collect here.",
  messages: "Messages you send to chats, file, keep, or finish collect here.",
  decisions: "What Nodex and your Automations decide collects here.",
  problems: "Problems with GitHub, and how they were fixed, collect here.",
};

export interface InboxActivityHandlers {
  readonly onOpenPage: (pageId: string) => void;
  readonly onOpenSession: (sessionId: string) => void;
  readonly onOpenAutomation?: (automationId: string) => void;
  readonly onOpenGitHubSettings: () => void;
  /** Opens where a handled message went: its chat, or the Project it was filed in. */
  readonly onOpenTarget: (target: InboxOutcomeTarget) => void;
  readonly onReturn: (pageId: string) => void;
  readonly onSetDone: (pageId: string, done: boolean) => void;
  readonly onDelete: (item: InboxItem) => void;
}

/** Activity's filters over its one timeline. */
export function InboxActivityFilters({
  filter,
  onChange,
}: {
  readonly filter: ActivityFilter;
  readonly onChange: (filter: ActivityFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Activity filter"
      className="mx-auto flex w-full max-w-(--thread-content-max-width) shrink-0 items-center gap-0.5 px-toolbar pt-2 pb-1"
    >
      {(Object.keys(ACTIVITY_FILTER_LABELS) as ActivityFilter[]).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={filter === option}
          onClick={() => onChange(option)}
          className={cn(
            "cursor-interaction rounded-md px-2 py-1 text-xs",
            filter === option
              ? "bg-token-foreground/5 text-token-foreground"
              : "text-token-description-foreground hover:text-token-foreground",
          )}
        >
          {ACTIVITY_FILTER_LABELS[option]}
        </button>
      ))}
    </div>
  );
}

function ActorGlyph({ row }: { readonly row: ActivityRow }) {
  const actor = row.actor;
  return (
    <NodexTooltip tooltipContent={row.actor_label}>
      <span
        role="img"
        aria-label={row.actor_label}
        className="flex size-3.5 shrink-0 items-center justify-center text-token-description-foreground"
      >
        {actor.type === "service" && actor.kind !== "sources" ? (
          <NodexLogoMarkIcon monochrome className="icon-2xs shrink-0" />
        ) : actor.type === "service" ? (
          <WebsiteGitHubIcon className="icon-2xs shrink-0" />
        ) : actor.type === "member" ? (
          <PersonCircleIcon className="icon-2xs shrink-0" />
        ) : (
          <ChatBubbleIcon className="icon-2xs shrink-0" />
        )}
      </span>
    </NodexTooltip>
  );
}

/** The live state a message's chat shows on the line, while its work is under way. */
const liveStatus = (row: ActivityRow, outcome: InboxOutcome | null) => {
  const subject = row.subject;
  if (!outcome?.inProgress || subject?.kind !== "chat") return null;
  if (outcome.open?.kind === "session" && outcome.open.sessionId !== subject.session_id) {
    return null;
  }
  return outcome.status ?? { label: "Delivering", tone: "working" as const };
};

function ActivityLine({
  row,
  outcome,
  arrivalToken,
  handlers,
}: {
  readonly row: ActivityRow;
  readonly outcome: InboxOutcome | null;
  /** Changes each time a navigation brings the reader to this message. */
  readonly arrivalToken: number | null;
  readonly handlers: InboxActivityHandlers;
}) {
  const [expanded, setExpanded] = useState(arrivalToken !== null);
  const [arrivedWith, setArrivedWith] = useState(arrivalToken);
  // A message the reader was brought to opens on arrival, as each further arrival does.
  if (arrivalToken !== arrivedWith) {
    setArrivedWith(arrivalToken);
    if (arrivalToken !== null) setExpanded(true);
  }
  const subject = row.subject;
  const item = row.message;
  const live = liveStatus(row, outcome);
  const openSubject = () => {
    if (!subject) return;
    switch (subject.kind) {
      case "page":
        handlers.onOpenPage(subject.page_id);
        return;
      case "chat":
        handlers.onOpenSession(subject.session_id);
        return;
      case "automation":
        handlers.onOpenAutomation?.(subject.automation_id);
        return;
      case "thread":
        void openExternalUrl(subject.url);
        return;
      case "source":
        handlers.onOpenGitHubSettings();
    }
  };
  const target = outcome?.open ?? null;
  return (
    <li
      data-activity-id={row.id}
      data-inbox-page-id={item?.pageId}
      className="border-b border-token-border/40 text-sm last:border-b-0"
    >
      <div className="flex min-h-8 items-center gap-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
          className={cn(
            "cursor-interaction flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-token-foreground/5",
            expanded && "bg-token-foreground/5",
          )}
        >
          <time
            dateTime={row.at}
            className="w-14 shrink-0 text-xs whitespace-nowrap text-token-description-foreground tabular-nums"
          >
            {formatInboxTime(row.at)}
          </time>
          <ActorGlyph row={row} />
          <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
            <span className="max-w-full shrink-0 truncate text-token-foreground">
              {row.description}
            </span>
            {row.reason ? (
              <span className="min-w-0 truncate text-xs text-token-description-foreground">
                {row.reason}
              </span>
            ) : null}
          </span>
        </button>
        {subject ? (
          <NodexTooltip tooltipContent={live ? `${subject.label} · ${live.label}` : subject.label}>
            <NodexButton
              size="xs"
              variant="ghost"
              onClick={openSubject}
              disabled={subject.kind === "automation" && !handlers.onOpenAutomation}
              className="max-w-[30%] shrink-0 gap-1.5"
            >
              {live ? <InboxChatStatusDot tone={live.tone} /> : null}
              <span className="truncate">{subject.label}</span>
            </NodexButton>
          </NodexTooltip>
        ) : null}
      </div>
      {expanded ? (
        // Aligned with the description: the time, its gap and the actor glyph come before it.
        <div className="flex flex-col gap-2 pr-1 pb-2 pl-[5.625rem] text-xs text-token-description-foreground">
          {item ? (
            <div className="border-l-2 border-token-border pl-3 text-sm text-token-foreground/85">
              <InboxMessageDocument item={item} />
            </div>
          ) : null}
          {row.reason ? <p className="whitespace-pre-wrap">{row.reason}</p> : null}
          <div className="flex min-h-6 items-center gap-2">
            <span className="truncate">{row.actor_label}</span>
            {item?.pageKey ? (
              <span className="shrink-0 font-mono text-[11px]">{item.pageKey}</span>
            ) : null}
            <InboxIconActions>
              {item && target ? (
                <InboxIconAction
                  label={target.kind === "session" ? "Open chat" : "Open in Project"}
                  icon={target.kind === "session" ? ThreadIcon : ProjectFolderIcon}
                  onClick={() => handlers.onOpenTarget(target)}
                />
              ) : null}
              {!item && row.session_id ? (
                <InboxIconAction
                  label="Open chat"
                  icon={ThreadIcon}
                  onClick={() => handlers.onOpenSession(row.session_id!)}
                />
              ) : null}
              {row.page_id ? (
                <InboxIconAction
                  label={item ? "Open page" : "Open card"}
                  icon={PageIcon}
                  onClick={() => handlers.onOpenPage(row.page_id!)}
                />
              ) : null}
              {row.url ? (
                <InboxIconAction
                  label="Open on GitHub"
                  icon={OpenExternalIcon}
                  onClick={() => void openExternalUrl(row.url!)}
                />
              ) : null}
              {!row.page_id && !row.session_id && !row.url && row.category === "problems" ? (
                <InboxIconAction
                  label="GitHub settings"
                  icon={WebsiteGitHubIcon}
                  onClick={handlers.onOpenGitHubSettings}
                />
              ) : null}
              {item ? <InboxCopyAction item={item} /> : null}
              {/* A finished chat leaves its work open until the user says it is done. */}
              {item && outcome && outcome.done !== null ? (
                <InboxIconAction
                  label={outcome.done ? "Reopen" : "Mark done"}
                  icon={CheckmarkIcon}
                  onClick={() => handlers.onSetDone(item.pageId, !outcome.done)}
                />
              ) : null}
              {item && outcome?.canReturn ? (
                <InboxIconAction
                  label="Return to Inbox"
                  icon={InboxIcon}
                  onClick={() => handlers.onReturn(item.pageId)}
                />
              ) : null}
              {/* A message filed into a Project is that Project's Page now; it is deleted there. */}
              {item?.location.kind === "inbox" ? (
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
 * Everything handled or done in this Inbox, newest first and grouped by day: messages sent,
 * filed, kept or finished, Nodex's and Automations' decisions, GitHub updates and Problems. A
 * line expands to its message, its reason and the ways back to its work.
 */
export function InboxActivity({
  rows,
  filter,
  arrival,
  ...handlers
}: {
  readonly rows: readonly ActivityRow[];
  readonly filter: ActivityFilter;
  /** The message a navigation last brought the reader to. */
  readonly arrival: { readonly pageId: string; readonly token: number };
} & InboxActivityHandlers) {
  const now = new Date(useInboxClock());
  const messages = rows.flatMap((row) => (row.message ? [row.message] : []));
  const outcomes = useInboxOutcomes(messages);
  // A navigation made while Activity shows opens the newest line about its message, once it is
  // loaded; that line keeps its arrival as later lines about the same message come in above it.
  const [opened, setOpened] = useState<{ readonly token: number; readonly rowId: string | null }>(
    () => ({ token: arrival.token, rowId: null }),
  );
  if (arrival.token !== opened.token) {
    const row = rows.find((candidate) => candidate.message?.pageId === arrival.pageId);
    if (row) setOpened({ token: arrival.token, rowId: row.id });
  }
  if (rows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-base font-medium text-token-foreground">Nothing here yet</p>
        <p className="max-w-sm text-sm text-balance text-token-description-foreground">
          {EMPTY_DESCRIPTIONS[filter]}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {groupByDay(rows, (row) => row.at, now).map((section) => (
        <section key={section.key} aria-label={section.label} className="flex flex-col">
          <h3 className="px-1 pb-1 text-xs font-medium text-token-description-foreground">
            {section.label}
          </h3>
          <ul className="flex flex-col">
            {section.items.map((row) => (
              <ActivityLine
                key={row.id}
                row={row}
                outcome={row.message ? (outcomes.get(row.message.pageId) ?? null) : null}
                arrivalToken={row.id === opened.rowId ? opened.token : null}
                handlers={handlers}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
