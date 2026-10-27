import { useState, type ReactNode } from "react";
import { FastModeIcon, SlashReasoningIcon, UltracodeIcon } from "@/components/shared/icons";
import { NodexSlider, NodexSliderThumb, NodexSliderTrack } from "@/components/ui/slider";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { IntelligenceEffortStop } from "@/lib/intelligence-effort";
import { cn } from "@/lib/utils";

/** Standing modes that change cost or behavior, each with one icon and color wherever it shows. */
export type IntelligenceMode = "fast" | "ultracode" | "thinking";
/** Modes the composer trigger shows while they are on. */
export type IntelligenceModeIndicator = Exclude<IntelligenceMode, "thinking">;

const MODES = {
  fast: {
    label: "Fast",
    icon: FastModeIcon,
    on: "text-token-charts-blue bg-token-charts-blue/12 hover:bg-token-charts-blue/18",
    indicator: "text-token-charts-blue",
  },
  ultracode: {
    label: "Ultracode",
    icon: UltracodeIcon,
    on: "text-token-charts-orange bg-token-charts-orange/12 hover:bg-token-charts-orange/18",
    indicator: "text-token-charts-orange",
  },
  thinking: {
    label: "Thinking",
    icon: SlashReasoningIcon,
    on: "text-token-foreground bg-token-foreground/10 hover:bg-token-foreground/15",
    indicator: "text-token-foreground",
  },
} as const;

export function IntelligenceModeIndicatorIcon({ mode }: { mode: IntelligenceModeIndicator }) {
  const Icon = MODES[mode].icon;
  return <Icon className={cn("icon-2xs shrink-0", MODES[mode].indicator)} />;
}

/** Effort is ordinal: one track with a stop per level, dragged or clicked, previewed live. */
export function IntelligenceEffortSlider({
  label = "Effort",
  stops,
  value,
  isDefault,
  disabled = false,
  accessory,
  onChange,
}: {
  readonly label?: string;
  readonly stops: readonly IntelligenceEffortStop[];
  readonly value: string | null;
  /** The thumb rests on the model default because the user has not chosen a level. */
  readonly isDefault: boolean;
  readonly disabled?: boolean;
  /** Mode toggles that share the header, so the whole control stays two lines tall. */
  readonly accessory?: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const committed = Math.max(
    0,
    stops.findIndex((stop) => stop.value === value),
  );
  const index = preview ?? committed;
  const last = Math.max(stops.length - 1, 1);
  const fraction = index / last;
  const active = stops[index];
  const indexOf = (next: number | readonly number[]) => (typeof next === "number" ? next : next[0]);
  return (
    <div className="flex flex-col gap-1 px-[var(--padding-row-x)] pt-0.5 pb-2">
      <IntelligenceControlsHeader label={label} accessory={accessory}>
        <NodexTooltip tooltipContent={active?.description} side="top">
          <span className="min-w-0 truncate text-token-description-foreground tabular-nums">
            {active?.label ?? "—"}
            {isDefault && preview === null ? (
              <span className="text-token-input-placeholder-foreground"> · Default</span>
            ) : null}
          </span>
        </NodexTooltip>
      </IntelligenceControlsHeader>
      <NodexSlider
        min={0}
        max={last}
        step={1}
        value={index}
        disabled={disabled || stops.length < 2}
        onValueChange={(next) => setPreview(indexOf(next) ?? null)}
        onValueCommitted={(next) => {
          setPreview(null);
          const stop = stops[indexOf(next) ?? committed];
          if (stop && (stop.value !== value || isDefault)) onChange(stop.value);
        }}
        className="h-5"
        // The pill is the control; its 10px padding keeps the 20px thumb inside at both ends.
        controlClassName="cursor-interaction rounded-full bg-token-foreground/[0.07] px-2.5 shadow-[inset_0_0_0_0.5px_var(--color-token-border)]"
      >
        <NodexSliderTrack className="overflow-visible rounded-none bg-transparent data-[orientation=horizontal]:h-full">
          <span
            aria-hidden="true"
            className="absolute inset-y-0 -start-2.5 rounded-full bg-token-foreground/[0.09] transition-[width] duration-150 ease-out"
            style={{ width: `calc(${fraction * 100}% + 20px)` }}
          />
          {stops.map((stop, stopIndex) => (
            <span
              key={stop.value}
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 size-1 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-150",
                stopIndex <= index ? "bg-token-foreground/35" : "bg-token-foreground/20",
              )}
              style={{ insetInlineStart: `${(stopIndex / last) * 100}%` }}
            />
          ))}
          <NodexSliderThumb
            aria-label={label}
            getAriaValueText={(_formatted, next) => stops[next]?.label ?? ""}
            className="size-5 border-2 border-transparent bg-white bg-clip-padding shadow-none drop-shadow-[0_0_1.5px_rgb(0_0_0/0.22)] transition-[inset-inline-start] duration-150 ease-out focus-visible:ring-0 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-token-focus-border data-[dragging]:transition-none"
          />
        </NodexSliderTrack>
      </NodexSlider>
    </div>
  );
}

/** One line: what the control is, its current value, then the mode toggles at the end. */
export function IntelligenceControlsHeader({
  label,
  children,
  accessory,
}: {
  readonly label: string;
  readonly children?: ReactNode;
  readonly accessory?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-1.5 text-sm">
      <span className="shrink-0 text-token-foreground">{label}</span>
      {children}
      {accessory ? (
        <span className="-me-1 ms-auto flex shrink-0 items-center gap-0.5">{accessory}</span>
      ) : null}
    </div>
  );
}

/** An icon that turns a mode on or off; its name, state and cost live in the tooltip. */
export function IntelligenceModeToggle({
  mode,
  description,
  pressed,
  disabled = false,
  unavailableReason,
  onPressedChange,
}: {
  readonly mode: IntelligenceMode;
  readonly description: string;
  readonly pressed: boolean;
  readonly disabled?: boolean;
  /** The mode exists here but cannot be turned on; the toggle stays visible to say why. */
  readonly unavailableReason?: string;
  readonly onPressedChange: (pressed: boolean) => void;
}) {
  const { label, icon: Icon, on } = MODES[mode];
  const unavailable = unavailableReason !== undefined;
  return (
    <NodexTooltip
      side="top"
      tooltipBodyClassName="max-w-60"
      tooltipContent={
        <span className="flex flex-col gap-0.5">
          <span>
            {label}
            <span className="text-token-description-foreground">
              {" · "}
              {unavailable ? "Unavailable" : pressed ? "On" : "Off"}
            </span>
          </span>
          <span className="text-token-description-foreground">
            {unavailableReason ?? description}
          </span>
        </span>
      }
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={pressed && !unavailable}
        disabled={disabled}
        // Stays hoverable so its tooltip can explain why it is off.
        aria-disabled={unavailable || undefined}
        onClick={() => {
          if (!unavailable) onPressedChange(!pressed);
        }}
        className={cn(
          "flex size-6 cursor-interaction items-center justify-center rounded-md outline-hidden transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-40",
          pressed && !unavailable
            ? on
            : "text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground",
        )}
      >
        <Icon className="icon-2xs" />
      </button>
    </NodexTooltip>
  );
}
