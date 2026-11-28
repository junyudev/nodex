import { NativeMenuIcon } from "@/components/shared/icons/native-menu-icon";
import { useIntl } from "@/lib/i18n";
import { lazy, Suspense, useRef, useState, type ReactElement } from "react";
import { ClockIcon } from "@/components/shared/icons";
import { NodexButton } from "@/components/ui/button";
import { NodexDialog, NodexDialogContent } from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { chatSnoozePresets, describeChatSnooze, formatChatSnoozeTime } from "@/lib/chat-snooze";
import { cn } from "@/lib/utils";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";

let customSnoozeFormPromise: Promise<typeof import("./custom-snooze-form")> | undefined;

/** Warms the custom picker, with its calendar and phrase reader, while a snooze menu is open. */
export function preloadCustomSnoozeForm() {
  customSnoozeFormPromise ??= import("./custom-snooze-form");
  return customSnoozeFormPromise;
}

const LazyCustomSnoozeForm = lazy(async () => ({
  default: (await preloadCustomSnoozeForm()).CustomSnoozeForm,
}));

/**
 * The snooze choices every menu offers, read at `now`: each preset with when it brings the item
 * back beside its name, then Custom for any other time.
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
      <NodexDropdownItem leftSlot={<ClockIcon className="icon-xs" />} onSelect={onCustom}>
        {intl.formatMessage({ id: "shared.snoozeMenu.custom", defaultMessage: "Custom" })}
      </NodexDropdownItem>
    </>
  );
}

/**
 * Opens the custom snooze dialog from a menu. The dialog waits until the menu has closed and
 * returned focus to its trigger, then opens over it from the window's modal host, so a row that
 * holds the menu never receives the dialog's clicks; closing it returns focus to that trigger.
 */
export function useCustomSnoozeHandoff(onChoose: (snoozedUntil: string) => void) {
  const openCustomSnooze = useOpenCustomSnooze(onChoose);
  const requested = useRef(false);
  return {
    /** Custom was chosen; the dialog opens as the menu finishes closing. */
    request: () => {
      requested.current = true;
    },
    /**
     * Called from the menu's `finalFocus`: true when Custom was chosen, so the menu returns focus
     * to its trigger before the dialog opens.
     */
    handOff: (): boolean => {
      if (!requested.current) return false;
      requested.current = false;
      requestAnimationFrame(() => {
        const focused = document.activeElement;
        openCustomSnooze(focused instanceof HTMLElement ? focused : null);
      });
      return true;
    },
  };
}

/**
 * Opens the custom snooze dialog from the window's modal host, over whatever offered it; closing
 * it returns focus to `returnFocus` while that is still on screen.
 */
export function useOpenCustomSnooze(onChoose: (snoozedUntil: string) => void) {
  const appHandle = useScopeHandle(appScope);
  return (returnFocus: HTMLElement | null) => {
    openModal(appHandle, CustomSnoozeDialog, { onChoose, returnFocus });
  };
}

/** Picks any future date and time to snooze until, in the person's own time zone. */
function CustomSnoozeDialog({
  onClose,
  onChoose,
  returnFocus,
}: ModalCloseProps & {
  readonly onChoose: (snoozedUntil: string) => void;
  /** Where focus returns when the dialog closes: the control that offered it. */
  readonly returnFocus: HTMLElement | null;
}) {
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <NodexDialogContent
        size="narrow"
        finalFocus={() => (returnFocus?.isConnected ? returnFocus : true)}
      >
        <Suspense fallback={<div aria-hidden="true" className="h-[420px]" />}>
          <LazyCustomSnoozeForm
            onChoose={(snoozedUntil) => {
              onChoose(snoozedUntil);
              onClose();
            }}
          />
        </Suspense>
      </NodexDialogContent>
    </NodexDialog>
  );
}

const SNOOZE_STRIP_BUTTON_CLASS =
  "flex h-5 shrink-0 cursor-interaction items-center justify-center rounded-md text-sm leading-5 whitespace-nowrap hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:bg-token-list-hover-background focus-visible:text-token-foreground focus-visible:outline-none";

/**
 * The snooze choices laid out on one line, for a surface that offers them without a menu, read at
 * `now`. A clock leads and opens Custom; each preset follows by its brief name and says, on hover,
 * when it brings the item back. While a snooze is set, the line says when the item returns and
 * offers Wake instead. Without `onChoose` the line only says when a set snooze returns.
 *
 * It lines up with facts listed beside 16px icons: the clock centers on their icon column and the
 * text starts where theirs does, once the caller bleeds the line by `-mx-1` for hover padding.
 */
export function SnoozeStrip({
  now,
  current,
  onChoose,
  onCustom,
  onWake,
  className,
}: {
  readonly now: Date;
  readonly current?: string | null;
  readonly onChoose?: (snoozedUntil: string) => void;
  /** Custom was chosen; the caller opens the picker, usually with `useOpenCustomSnooze`. */
  readonly onCustom?: () => void;
  /** Ends a snooze early; offered while one is set. */
  readonly onWake?: () => void;
  readonly className?: string;
}) {
  const intl = useIntl();
  if (!current && !onChoose) return null;
  const customLabel = intl.formatMessage({
    id: "shared.snoozeMenu.snoozeUntilEllipsis",
    defaultMessage: "Snooze until…",
  });
  const clock =
    onChoose && onCustom ? (
      <NodexTooltip tooltipContent={customLabel} side="bottom">
        <button
          type="button"
          aria-label={customLabel}
          className={cn(SNOOZE_STRIP_BUTTON_CLASS, "ml-0.5 w-5 text-token-description-foreground")}
          data-snooze-strip-custom=""
          onPointerEnter={() => void preloadCustomSnoozeForm()}
          onFocus={() => void preloadCustomSnoozeForm()}
          onClick={onCustom}
        >
          <ClockIcon className="icon-xs" />
        </button>
      </NodexTooltip>
    ) : (
      <span
        aria-hidden="true"
        className="ml-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-token-description-foreground"
      >
        <ClockIcon className="icon-xs" />
      </span>
    );
  if (current) {
    return (
      <div className={cn("flex h-6 min-w-0 items-center", className)} data-snooze-strip="snoozed">
        {clock}
        <span className="min-w-0 flex-1 truncate pl-1 text-sm leading-5 text-token-foreground">
          {describeChatSnooze(current, now, intl.locale)}
        </span>
        {onWake ? (
          <button
            type="button"
            className={cn(SNOOZE_STRIP_BUTTON_CLASS, "ml-2 px-1 text-token-text-secondary")}
            data-snooze-strip-wake=""
            onClick={onWake}
          >
            {intl.formatMessage({ id: "shared.snoozeMenu.wake", defaultMessage: "Wake" })}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div
      role="group"
      aria-label={intl.formatMessage({ id: "shared.snoozeMenu.snooze", defaultMessage: "Snooze" })}
      className={cn("flex h-6 min-w-0 items-center", className)}
      data-snooze-strip="choices"
    >
      {clock}
      <div className="flex min-w-0 items-center gap-1.5">
        {chatSnoozePresets(now, intl.locale).map((preset) => (
          <NodexTooltip
            key={preset.id}
            side="bottom"
            tooltipContent={intl.formatMessage(
              { id: "shared.snoozeMenu.snoozeUntil", defaultMessage: "Snooze until {time}" },
              { time: formatChatSnoozeTime(preset.snoozedUntil, now, intl.locale) },
            )}
          >
            <button
              type="button"
              className={cn(SNOOZE_STRIP_BUTTON_CLASS, "px-1 text-token-text-secondary")}
              data-snooze-strip-preset={preset.id}
              onClick={() => onChoose?.(preset.snoozedUntil)}
            >
              {preset.brief}
            </button>
          </NodexTooltip>
        ))}
      </div>
    </div>
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
  const customSnooze = useCustomSnoozeHandoff(onChoose);
  return (
    <NodexDropdownMenu
      align={align}
      finalFocus={() => {
        customSnooze.handOff();
        return true;
      }}
      triggerTooltipContent={label}
      triggerTooltipShortcutLabel={shortcutLabel}
      onOpenChange={(open) => {
        if (open) {
          setOpenedAt(new Date());
          void preloadCustomSnoozeForm();
        }
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
            <NodexDropdownItem leftSlot={<NativeMenuIcon iconKey="play" />} onSelect={onWake}>
              {intl.formatMessage({ id: "shared.snoozeMenu.wake", defaultMessage: "Wake" })}
            </NodexDropdownItem>
          ) : null}
          <NodexDropdownSeparator />
        </>
      ) : null}
      <SnoozeMenuItems now={openedAt} onChoose={onChoose} onCustom={customSnooze.request} />
    </NodexDropdownMenu>
  );
}
