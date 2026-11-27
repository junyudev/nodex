import { useIntl } from "@/lib/i18n";
import type { ReactNode } from "react";
import {
  ActivitySpinnerIcon,
  BellIcon,
  ChevronDownIcon,
  DictationMicrophoneIcon,
  NewChatIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MINI_SURFACE_CLASS } from "./mini-card";

const DOCK_BUTTON_CLASS =
  "cursor-interaction relative flex size-8 items-center justify-center rounded-full text-token-text-secondary [-webkit-app-region:no-drag] hover:bg-token-foreground/[0.08] hover:text-token-foreground";

/**
 * Mini at rest: start a chat, start one by voice, and how your chats stand. The count is only what
 * waits on you; running work shows as a spinner. Dragging the dock moves Mini to another corner
 * or edge.
 */
export function MiniDock({
  canDictate,
  cardCount,
  attentionCount,
  cardsShown,
  onNewChat,
  onDictate,
  onToggleCards,
}: {
  readonly canDictate: boolean;
  readonly cardCount: number;
  readonly attentionCount: number;
  readonly cardsShown: boolean;
  readonly onNewChat: () => void;
  readonly onDictate: () => void;
  readonly onToggleCards: () => void;
}) {
  const intl = useIntl();
  return (
    <div
      data-mini-drawn
      data-mini-dock
      className={cn(
        "flex h-10 items-center gap-0.5 rounded-full px-1 [-webkit-app-region:drag]",
        MINI_SURFACE_CLASS,
      )}
    >
      <DockButton
        label={intl.formatMessage({ id: "mini.dock.newChat", defaultMessage: "New chat" })}
        onClick={onNewChat}
      >
        <NewChatIcon className="icon-sm" />
      </DockButton>
      {canDictate ? (
        <>
          <DockDivider />
          <DockButton
            label={intl.formatMessage({ id: "mini.dock.dictate", defaultMessage: "Dictate" })}
            onClick={onDictate}
          >
            <DictationMicrophoneIcon className="icon-sm" />
          </DockButton>
        </>
      ) : null}
      {cardCount > 0 ? (
        <>
          <DockDivider />
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
            onClick={onToggleCards}
          >
            {cardsShown ? (
              <ChevronDownIcon className="icon-xs" />
            ) : attentionCount > 0 ? (
              <>
                <BellIcon className="icon-sm" />
                <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-composer-primary px-1 text-[10px] font-semibold text-composer-primary">
                  {attentionCount}
                </span>
              </>
            ) : (
              <ActivitySpinnerIcon className="icon-xs" />
            )}
          </DockButton>
        </>
      ) : null}
    </div>
  );
}

function DockButton({
  label,
  onClick,
  children,
}: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={label} side="top">
      <button type="button" aria-label={label} className={DOCK_BUTTON_CLASS} onClick={onClick}>
        {children}
      </button>
    </NodexTooltip>
  );
}

function DockDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-token-foreground/[0.12]" />;
}
