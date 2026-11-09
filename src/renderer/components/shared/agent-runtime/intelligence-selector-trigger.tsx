import { forwardRef, type ComponentPropsWithoutRef, type CSSProperties } from "react";
import { useReducedMotionConfig } from "motion/react";
import { ChevronDownIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import {
  IntelligenceModeIndicatorIcon,
  intelligenceEffortEmphasis,
  type IntelligenceModeIndicator,
} from "./intelligence-controls";
import { COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME } from "@/components/composer/composer-footer-controls";

export const INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX = 8;
const INDICATOR_SLOT_WIDTH_PX = 18;
const INDICATOR_STEP_PX = 16;
const INDICATOR_SLOT_TRANSITION = "inline-size 320ms cubic-bezier(0.23, 1, 0.32, 1)";

/** Mode icons sit before the label; the slot holds their room, and none without them. */
export function intelligenceIndicatorSlotWidth(indicatorCount: number): number {
  return indicatorCount > 0
    ? INDICATOR_SLOT_WIDTH_PX + (indicatorCount - 1) * INDICATOR_STEP_PX
    : 0;
}

function IntelligenceSelectorLabel({
  modelLabel,
  reasoningLabel,
  reasoningEffort,
  indicators,
}: {
  modelLabel: string;
  reasoningLabel: string | null;
  reasoningEffort?: string;
  indicators: readonly IntelligenceModeIndicator[];
}) {
  return (
    <span
      className="relative inline-flex w-max items-center gap-1 tabular-nums"
      data-fast-mode-indicator={indicators.includes("fast") ? "true" : undefined}
      data-ultracode-indicator={indicators.includes("ultracode") ? "true" : undefined}
    >
      {indicators.length > 0 ? (
        <span className="absolute end-full top-1/2 me-1 flex -translate-y-1/2 items-center gap-0.5">
          {indicators.map((mode) => (
            <IntelligenceModeIndicatorIcon key={mode} mode={mode} />
          ))}
        </span>
      ) : null}
      <span className="max-w-[110px] min-w-0 shrink truncate whitespace-nowrap text-token-foreground">
        {modelLabel}
      </span>
      {reasoningLabel ? (
        <span
          className={cn(
            "shrink-0 whitespace-nowrap",
            intelligenceEffortEmphasis(reasoningEffort) ?? "text-token-description-foreground",
          )}
        >
          {reasoningLabel}
        </span>
      ) : null}
    </span>
  );
}

interface IntelligenceSelectorTriggerProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "children" | "title"
> {
  modelLabel: string;
  reasoningLabel: string | null;
  /** The effort the label names, which decides its color. */
  reasoningEffort?: string;
  indicators: readonly IntelligenceModeIndicator[];
  title?: string;
}

/** The Composer's model button keeps the width of what it names, open or closed. */
export const IntelligenceSelectorTrigger = forwardRef<
  HTMLButtonElement,
  IntelligenceSelectorTriggerProps
>(function IntelligenceSelectorTrigger(
  { className, modelLabel, reasoningLabel, reasoningEffort, indicators, title, ...buttonProps },
  ref,
) {
  const prefersReducedMotion = useResolvedReducedMotion();
  const configuredReducedMotion = useReducedMotionConfig();
  const slotWidth = intelligenceIndicatorSlotWidth(indicators.length);
  const slotStyle = {
    inlineSize: slotWidth,
    transition:
      prefersReducedMotion || configuredReducedMotion ? "none" : INDICATOR_SLOT_TRANSITION,
  } satisfies CSSProperties;

  return (
    <NodexTooltip tooltipContent={title}>
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        aria-label="Select model"
        className={cn(COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME, "min-w-0", className)}
        data-intelligence-selector-trigger="true"
      >
        <span className="flex min-w-0 items-center">
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center overflow-hidden"
            data-fast-mode-slot="true"
            data-reserved={slotWidth > 0 ? "true" : undefined}
            style={slotStyle}
          />
          <span className="block min-w-0" data-intelligence-selector-trigger-content="true">
            <IntelligenceSelectorLabel
              modelLabel={modelLabel}
              reasoningLabel={reasoningLabel}
              reasoningEffort={reasoningEffort}
              indicators={indicators}
            />
          </span>
        </span>
        <ChevronDownIcon className="icon-2xs text-token-input-placeholder-foreground" />
      </button>
    </NodexTooltip>
  );
});
