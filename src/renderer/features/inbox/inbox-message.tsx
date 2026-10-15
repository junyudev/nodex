import type { InboxItem } from "../../../shared/inbox";
import {
  AutomationMoreIcon,
  CheckmarkIcon,
  DeleteIcon,
  DispatchIcon,
  PageIcon,
  AskAiIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexButton } from "@/components/ui/button";
import { NodexCheckbox } from "@/components/ui/settings";
import { UserMessageText } from "@/features/local-conversation/view/shared/user-message-collapse";
import { cn } from "@/lib/utils";
import { formatInboxTime } from "./inbox-presentation";

export interface InboxMessageMenuHandlers {
  readonly onOpenPage: () => void;
  readonly onDispatch: () => void;
  readonly onSuggestAgain: () => void;
  readonly onSetDone: (done: boolean) => void;
  readonly onDelete: () => void;
}

/** The message's less frequent actions: the first icon in its row, ahead of the others. */
export function InboxMessageMenu({
  item,
  handlers,
}: {
  readonly item: InboxItem;
  readonly handlers: InboxMessageMenuHandlers;
}) {
  const done = item.state === "done";
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
      <NodexDropdownItem
        leftSlot={<PageIcon className="icon-xs" />}
        rightSlot={
          item.pageKey ? (
            <span className="font-mono text-[11px] text-token-description-foreground">
              {item.pageKey}
            </span>
          ) : null
        }
        onSelect={handlers.onOpenPage}
      >
        Open as Page
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<DispatchIcon className="icon-xs" />}
        onSelect={handlers.onDispatch}
      >
        Dispatch…
      </NodexDropdownItem>
      {item.state === "open" ? (
        <NodexDropdownItem
          leftSlot={<AskAiIcon className="icon-xs" />}
          onSelect={handlers.onSuggestAgain}
        >
          Suggest again
        </NodexDropdownItem>
      ) : null}
      <NodexDropdownItem
        leftSlot={<CheckmarkIcon className="icon-xs" />}
        onSelect={() => handlers.onSetDone(!done)}
      >
        {done ? "Reopen" : "Mark done"}
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        className="text-token-error-foreground"
        leftSlot={<DeleteIcon className="icon-xs" />}
        onSelect={handlers.onDelete}
      >
        Delete…
      </NodexDropdownItem>
    </NodexDropdownMenu>
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
  onOpenSource,
  editor,
  strip,
  actions,
}: {
  readonly item: InboxItem;
  readonly selected: boolean;
  /** While any message is selected, every row shows its checkbox. */
  readonly selectionActive: boolean;
  readonly onToggleSelected: () => void;
  readonly onOpenSource: (sessionId: string) => void;
  /** Takes the message text's place while the user rewrites it. */
  readonly editor: React.ReactNode;
  /** What Nodex made of the message, inside the card; null leaves the message alone. */
  readonly strip: React.ReactNode;
  /** The row of ways to act, under the card and exactly as wide. */
  readonly actions: React.ReactNode;
}) {
  const fromUser = item.source.kind === "user";
  const checkbox = (
    <span className="relative mt-1.5 flex size-6 shrink-0 items-center justify-center">
      <span
        className={cn(
          "flex transition-opacity",
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
      {/* The exact time surfaces only after a lingering hover, and takes no room. */}
      <time
        dateTime={item.submittedAt}
        className={cn(
          "pointer-events-none absolute top-full mt-1 text-[11px] whitespace-nowrap text-token-description-foreground opacity-0 transition-opacity duration-200 select-none",
          "group-hover/message:opacity-100 group-hover/message:delay-1000",
          fromUser ? "right-0" : "left-0",
        )}
      >
        {formatInboxTime(item.submittedAt)}
      </time>
    </span>
  );

  return (
    <article
      data-testid="inbox-message"
      data-inbox-page-id={item.pageId}
      data-inbox-source={item.source.kind}
      className={cn("group/message flex flex-col gap-1", fromUser ? "items-end" : "items-start")}
    >
      {item.source.kind === "agent" ? (
        <button
          type="button"
          disabled={!item.source.sessionId}
          onClick={() =>
            item.source.kind === "agent" &&
            item.source.sessionId &&
            onOpenSource(item.source.sessionId)
          }
          className="cursor-interaction max-w-[80%] truncate pl-1 text-xs text-token-description-foreground hover:text-token-foreground disabled:cursor-default disabled:hover:text-token-description-foreground"
        >
          From {item.source.label}
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
        {checkbox}
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
              "flex flex-col overflow-hidden rounded-2xl border",
              fromUser ? "border-background-user-message" : "border-token-border",
              selected && "outline-2 -outline-offset-1 outline-token-focus-border",
            )}
          >
            <div
              className={cn(
                "px-3 py-2 break-words",
                fromUser
                  ? "bg-background-user-message text-text-user-message"
                  : "text-token-foreground",
                !fromUser && strip != null && "border-b border-token-border",
              )}
            >
              {editor ?? <UserMessageText text={item.body} />}
            </div>
            {strip == null ? null : (
              <div data-testid="inbox-triage" className="px-3 py-2.5">
                {strip}
              </div>
            )}
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
