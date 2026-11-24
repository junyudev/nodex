import { useIntl } from "@/lib/i18n";
import { useState, type ReactElement } from "react";
import { ClockIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { Input } from "@/components/ui/input";
import {
  chatSnoozePresets,
  defaultCustomSnoozeInput,
  formatChatSnoozeTime,
  minimumCustomSnoozeInput,
  parseCustomSnoozeInput,
} from "@/lib/chat-snooze";

/**
 * The snooze choices every menu offers, read at `now`: each preset with when it brings the item
 * back beside its name, then Custom… for any other time.
 */
export function SnoozeMenuItems({
  now,
  onChoose,
  onCustom,
}: {
  readonly now: Date;
  readonly onChoose: (snoozedUntil: string) => void;
  readonly onCustom: () => void;
}) {
  const intl = useIntl();
  return (
    <>
      {chatSnoozePresets(now, intl.locale).map((preset) => (
        <NodexDropdownItem
          key={preset.id}
          rightSlot={
            <span className="text-token-description-foreground tabular-nums">{preset.when}</span>
          }
          onSelect={() => onChoose(preset.snoozedUntil)}
        >
          {preset.name}
        </NodexDropdownItem>
      ))}
      <NodexDropdownSeparator />
      <NodexDropdownItem onSelect={onCustom}>
        {intl.formatMessage({ id: "shared.snoozeMenu.custom", defaultMessage: "Custom…" })}
      </NodexDropdownItem>
    </>
  );
}

/** Picks any future date and time to snooze until, in the person's own time zone. */
export function CustomSnoozeDialog({
  open,
  onOpenChange,
  onChoose,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onChoose: (snoozedUntil: string) => void;
}) {
  return (
    <NodexDialog open={open} onOpenChange={onOpenChange}>
      <NodexDialogContent>
        {/* The form mounts with each opening, so it starts from the next morning after then. */}
        <CustomSnoozeForm
          onCancel={() => onOpenChange(false)}
          onChoose={(snoozedUntil) => {
            onChoose(snoozedUntil);
            onOpenChange(false);
          }}
        />
      </NodexDialogContent>
    </NodexDialog>
  );
}

function CustomSnoozeForm({
  onCancel,
  onChoose,
}: {
  readonly onCancel: () => void;
  readonly onChoose: (snoozedUntil: string) => void;
}) {
  const intl = useIntl();
  const [openedAt] = useState(() => new Date());
  const [value, setValue] = useState(() => defaultCustomSnoozeInput(openedAt));
  const snoozedUntil = parseCustomSnoozeInput(value, openedAt);
  return (
    <NodexDialogFrame>
      <NodexDialogForm
        onSubmit={(event) => {
          event.preventDefault();
          if (snoozedUntil) onChoose(snoozedUntil);
        }}
      >
        <NodexDialogHeader>
          <NodexDialogTitle>
            {intl.formatMessage({
              id: "shared.snoozeMenu.customTitle",
              defaultMessage: "Snooze until",
            })}
          </NodexDialogTitle>
        </NodexDialogHeader>
        <NodexDialogBody>
          <Input
            type="datetime-local"
            aria-label={intl.formatMessage({
              id: "shared.snoozeMenu.customTime",
              defaultMessage: "Date and time",
            })}
            value={value}
            min={minimumCustomSnoozeInput(openedAt)}
            onChange={(event) => setValue(event.target.value)}
            data-app-action-snooze-custom-time=""
          />
        </NodexDialogBody>
        <NodexDialogFooter>
          <NodexDialogAction onClick={onCancel}>
            {intl.formatMessage({ id: "shared.snoozeMenu.cancel", defaultMessage: "Cancel" })}
          </NodexDialogAction>
          <NodexDialogAction type="submit" tone="primary" disabled={!snoozedUntil}>
            {intl.formatMessage({ id: "shared.snoozeMenu.snooze", defaultMessage: "Snooze" })}
          </NodexDialogAction>
        </NodexDialogFooter>
      </NodexDialogForm>
    </NodexDialogFrame>
  );
}

/**
 * When something set aside comes back. Every place that snoozes a chat, a message or a Turn,
 * or changes when it returns, opens this one menu with the same choices.
 */
export function SnoozeMenu({
  label: suppliedLabel,
  current,
  trigger,
  align = "end",
  onChoose,
  onWake,
  onOpenChange,
  shortcutLabel,
}: {
  /** Names the trigger: its tooltip and accessible name. */
  readonly label?: string;
  readonly current?: string;
  /** Replaces the quiet clock button, where the menu completes a labeled decision. */
  readonly trigger?: ReactElement;
  readonly align?: "start" | "end";
  readonly onChoose: (snoozedUntil: string) => void;
  /** Ends a snooze early; offered while one is set. */
  readonly onWake?: () => void;
  readonly onOpenChange?: (open: boolean) => void;
  readonly shortcutLabel?: string;
}) {
  const intl = useIntl();
  const label =
    suppliedLabel ??
    intl.formatMessage({ id: "shared.snoozeMenu.snooze", defaultMessage: "Snooze" });
  // The presets are read when the menu opens, so "in 1 hour" counts from then.
  const [openedAt, setOpenedAt] = useState(() => new Date());
  const [customOpen, setCustomOpen] = useState(false);
  return (
    <>
      <NodexDropdownMenu
        align={align}
        triggerTooltipContent={label}
        triggerTooltipShortcutLabel={shortcutLabel}
        onOpenChange={(open) => {
          if (open) setOpenedAt(new Date());
          onOpenChange?.(open);
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
              {intl.formatMessage({ id: "shared.snoozeMenu.returns", defaultMessage: "Returns" })}{" "}
              {formatChatSnoozeTime(current, openedAt, intl.locale)}
            </NodexDropdownItem>
            {onWake ? (
              <NodexDropdownItem onSelect={onWake}>
                {intl.formatMessage({ id: "shared.snoozeMenu.wake", defaultMessage: "Wake" })}
              </NodexDropdownItem>
            ) : null}
            <NodexDropdownSeparator />
          </>
        ) : null}
        <SnoozeMenuItems now={openedAt} onChoose={onChoose} onCustom={() => setCustomOpen(true)} />
      </NodexDropdownMenu>
      <CustomSnoozeDialog open={customOpen} onOpenChange={setCustomOpen} onChoose={onChoose} />
    </>
  );
}
