import { useIntl } from "@/lib/i18n";
import { useState, type ReactElement } from "react";
import { ClockIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { chatReminderPresets } from "@/lib/chat-reminder";
import { formatLaterTime } from "./inbox-later";

/**
 * When a message set aside comes back: the times a chat reminder offers. Every place
 * that sets a message aside, or changes when it returns, opens this one menu.
 */
export function InboxLaterMenu({
  label: suppliedLabel,
  current,
  trigger,
  align = "end",
  onChoose,
}: {
  /** Names the trigger: its tooltip and accessible name. */
  readonly label?: string;
  readonly current?: string;
  /** Replaces the quiet clock button, where the menu completes a labeled decision. */
  readonly trigger?: ReactElement;
  readonly align?: "start" | "end";
  readonly onChoose: (remindAt: string) => void;
}) {
  const intl = useIntl();
  const label =
    suppliedLabel ??
    intl.formatMessage({ id: "inbox.inboxLaterMenu.later", defaultMessage: "Later" });
  // The presets are read when the menu opens, so "in 1 hour" counts from then.
  const [openedAt, setOpenedAt] = useState(() => new Date());
  return (
    <NodexDropdownMenu
      align={align}
      triggerTooltipContent={label}
      onOpenChange={(open) => {
        if (open) setOpenedAt(new Date());
      }}
      triggerButton={
        trigger ?? (
          <NodexButton
            size="icon-xs"
            variant="ghost"
            aria-label={label}
            className="text-token-description-foreground hover:text-token-foreground"
          >
            <ClockIcon className="icon-xs" />
          </NodexButton>
        )
      }
    >
      {current ? (
        <>
          <NodexDropdownItem disabled>
            {intl.formatMessage({ id: "inbox.inboxLaterMenu.returns", defaultMessage: "Returns" })}{" "}
            {formatLaterTime(current, openedAt, intl.locale)}
          </NodexDropdownItem>
          <NodexDropdownSeparator />
        </>
      ) : null}
      {chatReminderPresets(openedAt).map((preset) => (
        <NodexDropdownItem key={preset.id} onSelect={() => onChoose(preset.remindAt)}>
          {preset.label}
        </NodexDropdownItem>
      ))}
    </NodexDropdownMenu>
  );
}
