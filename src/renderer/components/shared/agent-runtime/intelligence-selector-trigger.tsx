import {
  forwardRef,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ForwardedRef,
  type RefObject,
} from "react";
import { useReducedMotionConfig } from "motion/react";
import { FastModeIcon, ChevronDownIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME } from "../../../features/local-conversation/view/shared/composer-footer-controls";

export const INTELLIGENCE_SELECTOR_MENU_WIDTH_PX = 224;
export const INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX = 18;
export const INTELLIGENCE_SELECTOR_SIDE_OFFSET_PX = 8;

const INTELLIGENCE_SELECTOR_ALIGN_NUDGE_PX = 1;
const INTELLIGENCE_SELECTOR_WIDTH_TRANSITION = "inline-size 320ms cubic-bezier(0.23, 1, 0.32, 1)";

export interface IntelligenceSelectorLabelCandidate {
  id: string;
  modelLabel: string;
  reasoningLabel: string | null;
  reserveModelLabelWidth?: boolean;
}

interface IntelligenceSelectorMeasurements {
  maxLabelWidth: number | null;
  triggerChromeWidth: number | null;
}

export interface IntelligenceSelectorTriggerGeometry {
  alignOffset: number | undefined;
  expandedContentWidth: number | undefined;
  measurementRef: RefObject<HTMLSpanElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  wrapperRef: RefObject<HTMLSpanElement | null>;
}

export function buildIntelligenceSelectorLabelMeasurementKey(
  labelCandidates: readonly IntelligenceSelectorLabelCandidate[],
): string {
  return JSON.stringify(
    labelCandidates.map(({ modelLabel, reasoningLabel, reserveModelLabelWidth }) => [
      modelLabel,
      reasoningLabel,
      reserveModelLabelWidth === true,
    ]),
  );
}

function roundToDevicePixel(value: number): number {
  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.round(value * scale) / scale;
}

export function resolveIntelligenceSelectorExpandedContentWidth(input: {
  maxLabelWidth: number | null;
  triggerChromeWidth: number | null;
}): number | undefined {
  if (input.maxLabelWidth === null || input.triggerChromeWidth === null) {
    return undefined;
  }

  return Math.max(
    input.maxLabelWidth,
    INTELLIGENCE_SELECTOR_MENU_WIDTH_PX -
      input.triggerChromeWidth -
      INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX,
  );
}

export function resolveIntelligenceSelectorAlignOffset(input: {
  expandedContentWidth: number | undefined;
  triggerChromeWidth: number | null;
}): number | undefined {
  if (input.expandedContentWidth === undefined || input.triggerChromeWidth === null) {
    return undefined;
  }

  const expandedTriggerWidth =
    input.triggerChromeWidth +
    INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX +
    input.expandedContentWidth;
  return (
    (expandedTriggerWidth - INTELLIGENCE_SELECTOR_MENU_WIDTH_PX) / 2 -
    INTELLIGENCE_SELECTOR_ALIGN_NUDGE_PX
  );
}

export function useIntelligenceSelectorTriggerGeometry(
  labelCandidates: readonly IntelligenceSelectorLabelCandidate[],
): IntelligenceSelectorTriggerGeometry {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const measurementRef = useRef<HTMLSpanElement>(null);
  const initialMeasurements: IntelligenceSelectorMeasurements = {
    maxLabelWidth: null,
    triggerChromeWidth: null,
  };
  const measurementsRef = useRef(initialMeasurements);
  const [measurements, setMeasurements] = useState(initialMeasurements);
  const labelMeasurementKey = buildIntelligenceSelectorLabelMeasurementKey(labelCandidates);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const wrapper = wrapperRef.current;
    const measurement = measurementRef.current;
    if (!trigger || !wrapper || !measurement) return;

    const maxLabelWidth = roundToDevicePixel(measurement.getBoundingClientRect().width);
    const triggerChromeWidth = roundToDevicePixel(
      trigger.getBoundingClientRect().width - wrapper.getBoundingClientRect().width,
    );
    if (maxLabelWidth <= 0 || triggerChromeWidth < 0) return;

    const current = measurementsRef.current;
    // Guard before dispatch: pending React work can enqueue an otherwise equal state update.
    if (
      current.maxLabelWidth !== null &&
      current.triggerChromeWidth !== null &&
      Math.abs(current.maxLabelWidth - maxLabelWidth) <= 0.5 &&
      Math.abs(current.triggerChromeWidth - triggerChromeWidth) <= 0.5
    ) {
      return;
    }

    const next = { maxLabelWidth, triggerChromeWidth };
    measurementsRef.current = next;
    setMeasurements(next);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [labelMeasurementKey, measure]);

  useLayoutEffect(() => {
    let active = true;
    void document.fonts?.ready.then(() => {
      if (active) measure();
    });

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => {
        active = false;
        window.removeEventListener("resize", measure);
      };
    }

    const observer = new ResizeObserver(measure);
    const trigger = triggerRef.current;
    const wrapper = wrapperRef.current;
    const measurement = measurementRef.current;
    if (trigger) observer.observe(trigger);
    if (wrapper) observer.observe(wrapper);
    if (measurement) observer.observe(measurement);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [measure]);

  const expandedContentWidth = resolveIntelligenceSelectorExpandedContentWidth(measurements);
  return {
    alignOffset: resolveIntelligenceSelectorAlignOffset({
      expandedContentWidth,
      triggerChromeWidth: measurements.triggerChromeWidth,
    }),
    expandedContentWidth,
    measurementRef,
    triggerRef,
    wrapperRef,
  };
}

function IntelligenceSelectorLabel({
  modelLabel,
  reasoningLabel,
  reserveModelLabelWidth = false,
  showFastIndicator = false,
}: {
  modelLabel: string;
  reasoningLabel: string | null;
  reserveModelLabelWidth?: boolean;
  showFastIndicator?: boolean;
}) {
  return (
    <span
      className="relative inline-flex w-max items-center gap-1 tabular-nums"
      data-fast-mode-indicator={showFastIndicator ? "true" : undefined}
    >
      {showFastIndicator ? (
        <FastModeIcon className="absolute end-full top-1/2 me-1 icon-2xs shrink-0 -translate-y-1/2 text-token-foreground" />
      ) : null}
      <span
        className={cn(
          "min-w-0 shrink truncate whitespace-nowrap text-token-foreground",
          reserveModelLabelWidth ? "w-[110px]" : "max-w-[110px]",
        )}
      >
        {modelLabel}
      </span>
      {reasoningLabel ? (
        <span className="shrink-0 whitespace-nowrap text-token-description-foreground">
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
  geometry: IntelligenceSelectorTriggerGeometry;
  isOpen: boolean;
  labelCandidates: readonly IntelligenceSelectorLabelCandidate[];
  modelLabel: string;
  reasoningLabel: string | null;
  showFastIndicator: boolean;
  title?: string;
}

function setForwardedRef<T>(ref: ForwardedRef<T>, value: T | null): void {
  if (typeof ref === "function") {
    ref(value);
  } else if (ref) {
    ref.current = value;
  }
}

export const IntelligenceSelectorTrigger = forwardRef<
  HTMLButtonElement,
  IntelligenceSelectorTriggerProps
>(function IntelligenceSelectorTrigger(
  {
    className,
    geometry,
    isOpen,
    labelCandidates,
    modelLabel,
    reasoningLabel,
    showFastIndicator,
    title,
    ...buttonProps
  },
  forwardedRef,
) {
  const prefersReducedMotion = useResolvedReducedMotion();
  const configuredReducedMotion = useReducedMotionConfig();
  const shouldReduceMotion = Boolean(prefersReducedMotion || configuredReducedMotion);
  const setTriggerRef = useCallback(
    (element: HTMLButtonElement | null) => {
      geometry.triggerRef.current = element;
      setForwardedRef(forwardedRef, element);
    },
    [forwardedRef, geometry.triggerRef],
  );
  const reserveFastSlot = isOpen || showFastIndicator;
  const transition = shouldReduceMotion ? "none" : INTELLIGENCE_SELECTOR_WIDTH_TRANSITION;
  const fastSlotStyle = {
    inlineSize: reserveFastSlot ? INTELLIGENCE_SELECTOR_FAST_SLOT_WIDTH_PX : 0,
    transition,
  } satisfies CSSProperties;
  const contentStyle = {
    inlineSize:
      isOpen && geometry.expandedContentWidth !== undefined
        ? geometry.expandedContentWidth
        : undefined,
    interpolateSize: "allow-keywords",
    transition,
  } satisfies CSSProperties;

  return (
    <NodexTooltip tooltipContent={title}>
      <button
        {...buttonProps}
        ref={setTriggerRef}
        type="button"
        aria-label="Select model"
        className={cn(COMPOSER_FOOTER_GHOST_BUTTON_CLASS_NAME, "relative min-w-0", className)}
        data-intelligence-selector-trigger="true"
      >
        <span
          ref={geometry.measurementRef}
          aria-hidden="true"
          className="pointer-events-none absolute start-0 top-0 invisible grid w-max whitespace-nowrap text-sm [&>*]:col-start-1 [&>*]:row-start-1"
          data-intelligence-selector-label-measurement="true"
        >
          {labelCandidates.map((candidate) => (
            <IntelligenceSelectorLabel
              key={candidate.id}
              modelLabel={candidate.modelLabel}
              reasoningLabel={candidate.reasoningLabel}
              reserveModelLabelWidth={candidate.reserveModelLabelWidth}
            />
          ))}
        </span>

        <span
          ref={geometry.wrapperRef}
          className="flex min-w-0 items-center"
          data-intelligence-selector-trigger-wrapper="true"
        >
          <span
            aria-hidden="true"
            className="flex shrink-0 items-center overflow-hidden"
            data-fast-mode-slot="true"
            data-reserved={reserveFastSlot ? "true" : undefined}
            style={fastSlotStyle}
          />
          <span
            className="block min-w-0 text-center"
            data-intelligence-selector-trigger-content="true"
            style={contentStyle}
          >
            <IntelligenceSelectorLabel
              modelLabel={modelLabel}
              reasoningLabel={reasoningLabel}
              showFastIndicator={showFastIndicator}
            />
          </span>
        </span>
        <ChevronDownIcon className="icon-2xs text-token-input-placeholder-foreground" />
      </button>
    </NodexTooltip>
  );
});
