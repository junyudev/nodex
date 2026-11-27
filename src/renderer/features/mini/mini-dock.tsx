import { useIntl } from "@/lib/i18n";
import type { ReactNode } from "react";
import { DictationMicrophoneIcon, NewChatIcon, NodexLogoMarkIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MINI_SURFACE_CLASS } from "./mini-card";
import type { MiniStatus } from "./mini-model";

const DOCK_BUTTON_CLASS =
  "cursor-interaction relative flex size-8 items-center justify-center rounded-full text-token-text-secondary hover:bg-token-foreground/[0.08] hover:text-token-foreground";

/** The dot beside the Nodex mark: nothing when all is quiet. */
const STATUS_DOT: Record<MiniStatus, string | null> = {
  idle: null,
  working: "bg-token-charts-green motion-safe:animate-pulse",
  attention: "bg-composer-primary",
  failed: "bg-(--yellow-text)",
};

/**
 * Mini at rest: the Nodex mark, then start a chat or start one by voice. A dot beside the mark
 * tells how your chats stand (pulsing green while work is under way, blue when something needs
 * you, amber when something failed), and the mark shows or hides their cards; with the cards
 * hidden it carries the count of what waits on you, never what is merely running.
 */
export function MiniDock({
  canDictate,
  cardCount,
  attentionCount,
  cardsShown,
  status,
  onNewChat,
  onDictate,
  onToggleCards,
}: {
  readonly canDictate: boolean;
  readonly cardCount: number;
  readonly attentionCount: number;
  readonly cardsShown: boolean;
  readonly status: MiniStatus;
  readonly onNewChat: () => void;
  readonly onDictate: () => void;
  readonly onToggleCards: () => void;
}) {
  const intl = useIntl();
  const counted = !cardsShown && attentionCount > 0;
  const dot = counted ? null : STATUS_DOT[status];
  const mark = (
    <>
      <NodexLogoMarkIcon monochrome className="icon-sm" />
      {dot ? (
        <span
          aria-hidden
          className={cn(
            "absolute right-1 bottom-1 size-2 rounded-full ring-2 ring-background-composer-surface",
            dot,
          )}
        />
      ) : null}
      {counted ? (
        <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-composer-primary px-1 text-[10px] font-semibold text-composer-primary">
          {attentionCount}
        </span>
      ) : null}
    </>
  );
  return (
    <div
      data-mini-drawn
      data-mini-dock
      data-mini-content
      data-mini-base
      className={cn("flex h-10 items-center gap-0.5 rounded-full px-1", MINI_SURFACE_CLASS)}
    >
      {cardCount > 0 ? (
        <DockButton
          label={
            cardsShown
              ? intl.formatMessage({
                  id: "mini.dock.hideActivity",
                  defaultMessage: "Hide activity",
                })
              : intl.formatMessage({
                  id: "mini.dock.showActivity",
                  defaultMessage: "Show activity",
                })
          }
          expanded={cardsShown}
          onClick={onToggleCards}
        >
          {mark}
        </DockButton>
      ) : (
        <span className="relative flex size-8 items-center justify-center text-token-text-secondary">
          {mark}
        </span>
      )}
      <DockDivider />
      <DockButton
        label={intl.formatMessage({ id: "mini.dock.newChat", defaultMessage: "New chat" })}
        onClick={onNewChat}
      >
        <NewChatIcon className="icon-sm" />
      </DockButton>
      {canDictate ? (
        <DockButton
          label={intl.formatMessage({ id: "mini.dock.dictate", defaultMessage: "Dictate" })}
          onClick={onDictate}
        >
          <DictationMicrophoneIcon className="icon-sm" />
        </DockButton>
      ) : null}
    </div>
  );
}

function DockButton({
  label,
  expanded,
  onClick,
  children,
}: {
  readonly label: string;
  readonly expanded?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <button
        type="button"
        aria-label={label}
        aria-expanded={expanded}
        className={DOCK_BUTTON_CLASS}
        onClick={onClick}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

function DockDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-token-foreground/[0.12]" />;
}
