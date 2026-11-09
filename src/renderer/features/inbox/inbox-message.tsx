import { WebsiteGitHubIcon } from "@/components/shared/icons/website-icons";
import { openExternalUrl } from "@/lib/file-system-operations";
import {
  INBOX_ENTRY_KINDS,
  type InboxEntryKind,
  type InboxItem,
  type InboxPageStatus,
} from "../../../shared/inbox";
import {
  AutomationMoreIcon,
  AutomationsIcon,
  CheckmarkIcon,
  DeleteIcon,
  DispatchIcon,
  ImportantFilledIcon,
  ImportantIcon,
  PageIcon,
  RefreshIcon,
  TagsIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexDropdownSummarySubmenuItem,
} from "@/components/ui/dropdown";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { NodexCheckbox } from "@/components/ui/settings";
import { PageChatActivityControl } from "@/components/workbench/page-chat-activity-control";
import { StatusIcon } from "@/lib/status-presentation";
import type { PageChatActivitySummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { INBOX_KIND_ICONS, InboxIconAction } from "./inbox-icon-action";
import { InboxArrivalRing, InboxImportantStar } from "./inbox-important";
import { InboxMessageDocument } from "./inbox-message-document";
import { NodexAuthor } from "./inbox-nodex";
import {
  INBOX_KIND_LABELS,
  formatInboxTime,
  inboxEntryKind,
  inboxPageStatusMark,
  type InboxRowOffers,
} from "./inbox-presentation";

export interface InboxMessageMenuHandlers {
  readonly onDispatch: () => void;
  /** Absent while suggestions are off. */
  readonly onSuggestAgain?: () => void;
  readonly onSetDone: (done: boolean) => void;
  readonly onSetKind: (kind: InboxEntryKind) => void;
  readonly onSetImportant: (important: boolean) => void;
  readonly onDelete: () => void;
}

/**
 * The message's less frequent actions: the first icon in its row, ahead of the others. It holds
 * only what the message does not already offer, so no action appears twice. A Nodex post takes no
 * advice: nothing about it is suggested, dispatched or classified, so it has no menu.
 */
export function InboxMessageMenu({
  item,
  handlers,
  rowOffers,
}: {
  readonly item: InboxItem;
  readonly handlers: InboxMessageMenuHandlers;
  readonly rowOffers: InboxRowOffers;
}) {
  if (item.source.kind === "nodex") return null;
  const done = item.state === "done";
  const kind = inboxEntryKind(item);
  return (
    <NodexDropdownMenu
      align="end"
      triggerTooltipContent="Message actions"
      triggerButton={
        <NodexButton
          size="icon-xs"
          variant="ghost"
          aria-label="Message actions"
          className="text-token-description-foreground hover:text-token-foreground"
        >
          <AutomationMoreIcon className="icon-xs" />
        </NodexButton>
      }
    >
      {rowOffers.handleManually ? null : (
        <NodexDropdownItem
          leftSlot={<DispatchIcon className="icon-xs" />}
          onSelect={handlers.onDispatch}
        >
          Handle manually
        </NodexDropdownItem>
      )}
      {/* A held Automation decision carries its frozen action, never routing advice. */}
      {item.state === "open" &&
      !rowOffers.suggest &&
      !item.automationDecision &&
      handlers.onSuggestAgain ? (
        <NodexDropdownItem
          leftSlot={<RefreshIcon className="icon-xs" />}
          onSelect={handlers.onSuggestAgain}
        >
          Suggest again
        </NodexDropdownItem>
      ) : null}
      {done || !rowOffers.done ? (
        <NodexDropdownItem
          leftSlot={<CheckmarkIcon className="icon-xs" />}
          onSelect={() => handlers.onSetDone(!done)}
        >
          {done ? "Reopen" : "Mark done"}
        </NodexDropdownItem>
      ) : null}
      {item.state === "open" ? (
        <NodexDropdownItem
          leftSlot={
            item.important ? (
              <ImportantFilledIcon className="icon-xs" />
            ) : (
              <ImportantIcon className="icon-xs" />
            )
          }
          onSelect={() => handlers.onSetImportant(!item.important)}
        >
          {item.important ? "Unmark important" : "Mark important"}
        </NodexDropdownItem>
      ) : null}
      {/* What kind of thought it is only steers suggestions, so it is corrected here, not shown. */}
      <NodexDropdownSummarySubmenuItem
        label="Kind"
        leftSlot={<TagsIcon className="icon-xs" />}
        value={kind ? INBOX_KIND_LABELS[kind] : "None"}
      >
        {INBOX_ENTRY_KINDS.map((option) => {
          const KindIcon = INBOX_KIND_ICONS[option];
          return (
            <NodexDropdownItem
              key={option}
              leftSlot={<KindIcon className="icon-xs" />}
              rightSlot={option === kind ? <NodexDropdownSelectedIcon /> : null}
              onSelect={() => handlers.onSetKind(option)}
            >
              {INBOX_KIND_LABELS[option]}
            </NodexDropdownItem>
          );
        })}
      </NodexDropdownSummarySubmenuItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        className="text-token-error-foreground"
        leftSlot={<DeleteIcon className="icon-xs" />}
        onSelect={handlers.onDelete}
      >
        Delete
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

/** The Board status of a Page that has moved on; it only says where the Page stands. */
function InboxPageStatusMark({ status }: { readonly status: InboxPageStatus }) {
  return (
    <NodexTooltip tooltipContent={status.label} side="top">
      <span
        role="img"
        aria-label={`Status: ${status.label}`}
        className="flex h-5 items-center pr-1"
      >
        <StatusIcon statusId={status.id} className="size-3.5" />
      </span>
    </NodexTooltip>
  );
}

/**
 * One captured message in the Inbox: a card holding the message and, joined beneath it, what
 * Nodex made of it, with the ways to act in one row under the card. The user's own messages
 * sit on the right like chat user messages; messages another Agent or the command line sent
 * sit on the left and name their source.
 */
export function InboxMessage({
  item,
  selected,
  selectionActive,
  onToggleSelected,
  linkedChats,
  onOpenChat,
  onOpenAutomation,
  onOpenPage,
  onUnmarkImportant,
  arrivalToken = null,
  editor,
  messageActions,
  strip,
  actions,
}: {
  readonly item: InboxItem;
  readonly selected: boolean;
  /** While any message is selected, every row shows its checkbox. */
  readonly selectionActive: boolean;
  readonly onToggleSelected: () => void;
  /**
   * The chats the message's Page is linked to, shown at the start of its text; null when its row
   * already opens the chat.
   */
  readonly linkedChats: PageChatActivitySummary | null;
  /** Opens a chat: the one that sent the message, or one its Page is linked to. */
  readonly onOpenChat: (sessionId: string) => void;
  /** Opens the automation a waiting run came from. */
  readonly onOpenAutomation?: (automationId: string) => void;
  /** Opens the message's Page, from the action on its text or from its time. */
  readonly onOpenPage: () => void;
  readonly onUnmarkImportant: () => void;
  /** Set while the reader has just been brought to this message; changes on every arrival. */
  readonly arrivalToken?: number | null;
  /** Takes the message text's place while the user rewrites it. */
  readonly editor: React.ReactNode;
  /**
   * Copy and Edit. They follow `Open page` on the text's bottom-right corner, shown while the
   * message is hovered or one of them is focused.
   */
  readonly messageActions: React.ReactNode;
  /** What Nodex made of the message, inside the card; null leaves the message alone. */
  readonly strip: React.ReactNode;
  /** The row of ways to act, under the card and exactly as wide. */
  readonly actions: React.ReactNode;
}) {
  const fromUser = item.source.kind === "user";
  const status = inboxPageStatusMark(item);
  const chats = linkedChats && linkedChats.relatedCount > 0 ? linkedChats : null;
  // Where the message's Page already stands, read before its words: its Board status once it
  // has left Triage, then its chats.
  const marks =
    status || chats ? (
      <span data-testid="inbox-page-marks" className="flex items-center">
        {status ? <InboxPageStatusMark status={status} /> : null}
        {chats ? (
          <PageChatActivityControl
            pageId={item.pageId}
            summary={chats}
            onOpenChat={onOpenChat}
            className="hover:bg-current/10"
          />
        ) : null}
      </span>
    ) : null;
  // The checkbox and, beside the bubble, an important message's star. The time hangs beneath on
  // the bubble's side, so a star never moves it.
  const gutter = (
    <span
      className={cn(
        "relative mt-1.5 flex shrink-0 items-center gap-1",
        fromUser ? "flex-row" : "flex-row-reverse",
      )}
    >
      {item.rowKind === "intake" ? (
        <>
          <span
            className={cn(
              "flex size-6 items-center justify-center transition-opacity",
              selected || selectionActive
                ? "opacity-100"
                : "opacity-0 group-hover/message:opacity-100 focus-within:opacity-100",
            )}
          >
            <NodexCheckbox
              ariaLabel={selected ? "Deselect message" : "Select message"}
              checked={selected}
              onCheckedChange={onToggleSelected}
            />
          </span>
          <InboxImportantStar important={item.important} onUnmark={onUnmarkImportant} />
        </>
      ) : null}
      {/* The exact time surfaces only after a lingering hover and takes no room. It is also a
          link to the message's Page, so it can be chosen only once it shows; it is named by the
          time it reads. */}
      <NodexTooltip tooltipContent="Open page" side="bottom">
        <button
          type="button"
          onClick={onOpenPage}
          className={cn(
            "cursor-interaction invisible absolute top-full mt-1 text-[11px] whitespace-nowrap text-token-description-foreground opacity-0 transition-[opacity,visibility] duration-200 select-none hover:text-token-foreground hover:underline",
            "group-hover/message:visible group-hover/message:opacity-100 group-hover/message:delay-1000",
            fromUser ? "right-0" : "left-0",
          )}
        >
          <time dateTime={item.submittedAt}>{formatInboxTime(item.submittedAt)}</time>
        </button>
      </NodexTooltip>
    </span>
  );

  return (
    <article
      data-testid="inbox-message"
      data-inbox-page-id={item.pageId}
      data-inbox-source={item.source.kind}
      className={cn(
        "group/message flex flex-col gap-1 [--inbox-card-radius:var(--radius-2xl)]",
        fromUser ? "items-end" : "items-start",
      )}
    >
      {item.handback ? (
        <p className="max-w-[80%] whitespace-pre-wrap text-xs text-token-description-foreground">
          <button
            type="button"
            className="cursor-interaction hover:text-token-foreground"
            onClick={() => onOpenChat(item.handback!.chat.session_id)}
          >
            {item.handback.chat.display_title}
          </button>{" "}
          sent this back: {item.handback.reason}
        </p>
      ) : null}
      {item.source.kind === "nodex" ? (
        <NodexAuthor />
      ) : item.source.kind === "github" ? (
        <a
          href={item.source.url}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (item.source.kind === "github") void openExternalUrl(item.source.url);
          }}
          className="inline-flex max-w-[80%] min-w-0 items-center gap-1 pl-1 text-xs text-token-description-foreground hover:text-token-foreground"
        >
          <WebsiteGitHubIcon className="icon-2xs shrink-0" />
          <span className="truncate">
            {item.source.repository} #{item.source.number} · @{item.source.actorLogin}
          </span>
        </a>
      ) : item.source.kind === "agent" ? (
        <button
          type="button"
          disabled={!item.source.sessionId}
          onClick={() =>
            item.source.kind === "agent" &&
            item.source.sessionId &&
            onOpenChat(item.source.sessionId)
          }
          className="cursor-interaction max-w-[80%] truncate pl-1 text-xs text-token-description-foreground hover:text-token-foreground disabled:cursor-default disabled:hover:text-token-description-foreground"
        >
          From {item.source.label}
        </button>
      ) : item.source.kind === "automation" ? (
        <button
          type="button"
          disabled={!onOpenAutomation}
          onClick={() =>
            item.source.kind === "automation" && onOpenAutomation?.(item.source.automationId)
          }
          className="cursor-interaction flex max-w-[80%] min-w-0 items-center gap-1 pl-1 text-xs text-token-description-foreground hover:text-token-foreground disabled:cursor-default disabled:hover:text-token-description-foreground"
        >
          <AutomationsIcon className="icon-2xs shrink-0" />
          <span className="min-w-0 truncate">From {item.source.label}</span>
        </button>
      ) : item.source.kind === "command_line" ? (
        <span className="max-w-[80%] truncate pl-1 text-xs text-token-description-foreground">
          From {item.source.label}
        </span>
      ) : null}
      <div
        className={cn(
          "flex w-full items-start gap-1",
          fromUser ? "justify-end" : "flex-row-reverse justify-end",
        )}
      >
        {gutter}
        <div
          className={cn(
            "flex max-w-[80%] min-w-[min(18rem,80%)] flex-col gap-1.5",
            // A rewrite gets the stream's full message width to work in.
            editor == null ? "w-fit" : "w-full",
          )}
        >
          {/* One object: the message on top and, joined to it, the strip about it. */}
          <div
            data-testid="inbox-message-unit"
            className={cn(
              "relative flex flex-col overflow-hidden rounded-(--inbox-card-radius) border",
              fromUser ? "border-background-user-message" : "border-token-border",
              selected && "outline-2 -outline-offset-1 outline-token-focus-border",
            )}
          >
            <div
              className={cn(
                "relative px-3 py-2 break-words",
                fromUser
                  ? "bg-background-user-message text-text-user-message"
                  : "text-token-foreground",
                !fromUser && strip != null && "border-b border-token-border",
              )}
            >
              {editor ?? <InboxMessageDocument item={item} lead={marks} />}
              {editor == null ? (
                // Floats over the end of the last line on the text's own color, so showing it
                // never moves the text. It stays above all of the text, even beside a live mark
                // animating in the first line, which can lift that line into its own layer.
                // The message is its Page's body, so the way to that Page sits on it too.
                <div
                  data-testid="inbox-message-actions"
                  className={cn(
                    "pointer-events-none absolute right-1.5 bottom-1 z-10 flex items-center gap-0.5 rounded-md opacity-0 transition-opacity",
                    "group-hover/message:pointer-events-auto group-hover/message:opacity-100 focus-within:opacity-100",
                    fromUser ? "bg-background-user-message" : "bg-token-main-surface-primary",
                  )}
                >
                  <InboxIconAction label="Open page" icon={PageIcon} onClick={onOpenPage} />
                  {messageActions}
                </div>
              ) : null}
            </div>
            {strip == null ? null : (
              <div data-testid="inbox-triage" className="px-3 py-2.5">
                {strip}
              </div>
            )}
            <InboxArrivalRing token={arrivalToken} />
          </div>
          {actions == null ? null : (
            <div data-testid="inbox-actions" className="pl-1">
              {actions}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
