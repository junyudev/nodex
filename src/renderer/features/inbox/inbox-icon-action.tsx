import type { ComponentType } from "react";
import type { InboxDispatchAction } from "../../../shared/inbox";
import { ArchiveIcon, MoveToIcon, NewChatIcon, SendToChatIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export type InboxIcon = ComponentType<{ readonly className?: string }>;

/** One glyph per kind of dispatch, wherever that action is offered or chosen. */
export const INBOX_ACTION_ICONS: Readonly<Record<InboxDispatchAction["type"], InboxIcon>> = {
  keep: ArchiveIcon,
  new_chat: NewChatIcon,
  send_to_chat: SendToChatIcon,
  move_to_project: MoveToIcon,
};

/**
 * A familiar action shown as its icon alone; the label is its tooltip and accessible name.
 * Only the decision a strip asks for keeps a text label.
 */
export function InboxIconAction({
  label,
  icon: Icon,
  tone = "default",
  disabled,
  onClick,
}: {
  readonly label: string;
  readonly icon: InboxIcon;
  readonly tone?: "default" | "danger";
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <NodexButton
        size="icon-xs"
        variant="ghost"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "text-token-description-foreground hover:text-token-foreground",
          tone === "danger" && "hover:text-token-error-foreground",
        )}
      >
        <Icon className="icon-xs" />
      </NodexButton>
    </NodexTooltip>
  );
}

/**
 * Secondary actions sit together at the trailing edge, so every strip ends the same way. When
 * they end the row, the last glyph ends where the card's corner curve meets its bottom edge,
 * as the waiting spinner does; a decision after them stays flush with the card instead.
 */
export function InboxIconActions({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="ml-auto flex shrink-0 items-center gap-0.5 last:mr-[calc(var(--inbox-card-radius,0px)_-_var(--spacing))]">
      {children}
    </div>
  );
}
