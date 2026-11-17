import { defineMessage, getIntl, useIntl } from "@/lib/i18n";
import { createContext, forwardRef, useContext, type ComponentPropsWithoutRef } from "react";
import { PinnedSummaryIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";

const SUMMARY_TOGGLE_BASE_CLASS =
  "border-token-border no-drag cursor-interaction flex overflow-visible items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 border-transparent justify-center";
const SUMMARY_TOGGLE_PRESSED_CLASS =
  "text-token-foreground bg-token-foreground/5 enabled:hover:bg-token-foreground/10 data-[state=open]:bg-token-foreground/10";
const SUMMARY_TOGGLE_IDLE_CLASS =
  "text-token-text-tertiary enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background";
const SUMMARY_TOGGLE_SIZE_CLASS = {
  toolbar:
    "rounded-lg h-token-button-composer px-2 py-0 text-base leading-[18px] aspect-square !px-0",
  compact: "size-5 rounded-md p-0.5",
} as const;

/**
 * The summary control's size: a titlebar toolbar button, or a compact control beside the
 * workspace controls while full view hides the Chat's title row.
 */
export const ThreadSummaryToggleDensityContext = createContext<"toolbar" | "compact">("toolbar");

function appendClassName(baseClassName: string, className: string | undefined): string {
  const trimmedClassName = className?.trim();
  if (!trimmedClassName) return baseClassName;
  return `${baseClassName} ${trimmedClassName}`;
}

type ThreadSummaryPanelToggleButtonProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "title"
> & {
  pressed: boolean;
  label?: string;
  /** Live background tasks the summary lists; a closed summary marks that work is running. */
  backgroundCount?: number;
};

const PINNED_SUMMARY = defineMessage({
  id: "conversation.threadSummaryPanelToggle.pinnedSummary",
  defaultMessage: "Toggle pinned summary",
});

/** The toggle's name also says what the closed summary is holding. */
export function threadSummaryToggleLabel(
  label: string,
  backgroundCount: number,
  intl = getIntl(),
): string {
  if (backgroundCount === 0) return label;
  return intl.formatMessage(
    {
      id: "conversation.threadSummaryPanelToggle.backgroundCount",
      defaultMessage:
        "{label} · {count, plural, one {# background task} other {# background tasks}}",
    },
    { label, count: backgroundCount },
  );
}

export const ThreadSummaryPanelToggleButton = forwardRef<
  HTMLButtonElement,
  ThreadSummaryPanelToggleButtonProps
>(function ThreadSummaryPanelToggleButton(
  { pressed, label, backgroundCount = 0, className, type = "button", ...buttonProps },
  ref,
) {
  const intl = useIntl();
  const ariaLabel =
    buttonProps["aria-label"] ??
    threadSummaryToggleLabel(label ?? intl.formatMessage(PINNED_SUMMARY), backgroundCount, intl);
  const density = useContext(ThreadSummaryToggleDensityContext);
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      aria-label={ariaLabel}
      aria-pressed={pressed}
      data-thread-summary-toggle-density={density}
      className={appendClassName(
        `${SUMMARY_TOGGLE_BASE_CLASS} ${SUMMARY_TOGGLE_SIZE_CLASS[density]} ${
          pressed ? SUMMARY_TOGGLE_PRESSED_CLASS : SUMMARY_TOGGLE_IDLE_CLASS
        }`,
        className,
      )}
    >
      <span className="relative inline-flex">
        <PinnedSummaryIcon
          className={density === "compact" ? "icon-xs shrink-0" : "shrink-0 overflow-visible"}
        />
        {backgroundCount > 0 && !pressed ? (
          <span
            aria-hidden="true"
            data-thread-summary-background-indicator=""
            className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-current"
          />
        ) : null}
      </span>
    </button>
  );
});

type ThreadSummaryPanelToggleProps = ThreadSummaryPanelToggleButtonProps;

export function ThreadSummaryPanelToggle({
  pressed,
  onClick,
  label,
  backgroundCount = 0,
  className,
  ...buttonProps
}: ThreadSummaryPanelToggleProps) {
  const intl = useIntl();
  return (
    <NodexTooltip
      tooltipContent={threadSummaryToggleLabel(
        label ?? intl.formatMessage(PINNED_SUMMARY),
        backgroundCount,
        intl,
      )}
      side="bottom"
    >
      <ThreadSummaryPanelToggleButton
        {...buttonProps}
        label={label}
        backgroundCount={backgroundCount}
        pressed={pressed}
        onClick={onClick}
        className={className}
      />
    </NodexTooltip>
  );
}
