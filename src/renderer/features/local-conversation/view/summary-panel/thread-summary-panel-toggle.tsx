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
};

export const ThreadSummaryPanelToggleButton = forwardRef<
  HTMLButtonElement,
  ThreadSummaryPanelToggleButtonProps
>(function ThreadSummaryPanelToggleButton(
  { pressed, label = "Toggle pinned summary", className, type = "button", ...buttonProps },
  ref,
) {
  const ariaLabel = buttonProps["aria-label"] ?? label;
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
      <PinnedSummaryIcon
        className={density === "compact" ? "icon-xs shrink-0" : "shrink-0 overflow-visible"}
      />
    </button>
  );
});

type ThreadSummaryPanelToggleProps = ThreadSummaryPanelToggleButtonProps;

export function ThreadSummaryPanelToggle({
  pressed,
  onClick,
  label = "Toggle pinned summary",
  className,
  ...buttonProps
}: ThreadSummaryPanelToggleProps) {
  return (
    <NodexTooltip tooltipContent={label} side="bottom">
      <ThreadSummaryPanelToggleButton
        {...buttonProps}
        label={label}
        pressed={pressed}
        onClick={onClick}
        className={className}
      />
    </NodexTooltip>
  );
}
