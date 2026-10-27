import { useState, type ComponentType, type ReactNode } from "react";
import {
  FastModeIcon,
  SlashReasoningIcon,
  UltracodeIcon,
  type ModeIconProps,
} from "@/components/shared/icons";
import { NodexSlider, NodexSliderThumb, NodexSliderTrack } from "@/components/ui/slider";
import { NodexTooltip } from "@/components/ui/tooltip";
import { THINKING_OFF_EFFORT_STOP, type IntelligenceEffortStop } from "@/lib/intelligence-effort";
import { cn } from "@/lib/utils";
import "./intelligence-controls.css";

/** Standing modes that change cost or behavior, each with one icon and color wherever it shows. */
export type IntelligenceMode = "fast" | "ultracode" | "thinking";
/** Modes the composer trigger shows while they are on. */
export type IntelligenceModeIndicator = Exclude<IntelligenceMode, "thinking">;

const MODES: Record<
  IntelligenceMode,
  {
    readonly label: string;
    readonly icon: ComponentType<ModeIconProps>;
    readonly color: string;
    readonly tint: string;
  }
> = {
  fast: {
    label: "Fast",
    icon: FastModeIcon,
    color: "text-token-charts-blue",
    tint: "bg-token-charts-blue/12 hover:bg-token-charts-blue/18",
  },
  ultracode: {
    label: "Ultracode",
    icon: UltracodeIcon,
    color: "text-token-charts-orange",
    tint: "bg-token-charts-orange/12 hover:bg-token-charts-orange/18",
  },
  thinking: {
    label: "Thinking",
    icon: SlashReasoningIcon,
    color: "text-token-foreground",
    tint: "bg-token-foreground/10 hover:bg-token-foreground/15",
  },
};

export function IntelligenceModeIndicatorIcon({ mode }: { mode: IntelligenceModeIndicator }) {
  const { icon: Icon, color } = MODES[mode];
  return <Icon className={cn("icon-2xs shrink-0", color)} />;
}

// The track's motion: quick to leave, soft to land, as a physical control settles.
const TRACK_EASE = "ease-[cubic-bezier(0.23,1,0.32,1)]";
// The thumb is 28px, so stop centers sit 14px inside each end of the pill.
const THUMB_PX = 28;

/** Max is the costly end of the scale, so it takes its own color; Off has none. */
function effortTone(value: string | undefined) {
  if (value === THINKING_OFF_EFFORT_STOP)
    return { text: "text-token-description-foreground", fill: "bg-transparent" };
  if (value === "max") return { text: "text-token-charts-purple", fill: "bg-token-charts-purple" };
  return { text: "text-token-charts-blue", fill: "bg-token-charts-blue" };
}

/**
 * Effort is ordinal: one track with a stop per level, dragged, clicked or stepped with the
 * arrow keys. The level reads at the head of the control in the track's own color.
 */
export function IntelligenceEffortSlider({
  stops,
  value,
  isDefault,
  flowing = false,
  disabled = false,
  accessory,
  onChange,
}: {
  readonly stops: readonly IntelligenceEffortStop[];
  readonly value: string | null;
  /** The thumb rests on the model default because the user has not chosen a level. */
  readonly isDefault: boolean;
  /** Fast is on: light streams through the filled part of the track. */
  readonly flowing?: boolean;
  readonly disabled?: boolean;
  /** Mode toggles that share the head of the control, so it stays two lines tall. */
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
  const tone = effortTone(active?.value);
  const indexOf = (next: number | readonly number[]) => (typeof next === "number" ? next : next[0]);
  return (
    <div className="flex flex-col gap-1 px-[var(--padding-row-x)] pt-0.5 pb-2">
      <IntelligenceControlsHeader accessory={accessory}>
        <NodexTooltip tooltipContent={active?.description} side="top">
          <span className="min-w-0 truncate tabular-nums">
            <span
              key={active?.value}
              className={cn(
                "font-medium transition-colors duration-200 animate-in fade-in-0 slide-in-from-bottom-0.5 motion-reduce:animate-none",
                tone.text,
              )}
            >
              {active?.label ?? "—"}
            </span>
            {isDefault && preview === null ? (
              <span className="text-token-description-foreground"> · Default</span>
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
        className="group/effort h-7"
        // The control's padding keeps the thumb inside the pill at both ends of its travel.
        controlClassName="cursor-interaction px-3.5"
      >
        <NodexSliderTrack className="overflow-visible rounded-none bg-transparent data-[orientation=horizontal]:h-full">
          <span
            aria-hidden="true"
            className="absolute -inset-x-3.5 top-1/2 h-6 -translate-y-1/2 overflow-hidden rounded-full bg-token-foreground/[0.08] shadow-[inset_0_0_0_0.5px_var(--color-token-border)]"
          >
            <span
              className={cn(
                "absolute inset-y-0 start-0 overflow-hidden rounded-full transition-[width,background-color] duration-300 motion-reduce:transition-none",
                TRACK_EASE,
                tone.fill,
              )}
              // From the pill's start to the thumb's far edge.
              style={{ width: `calc(${fraction} * (100% - ${THUMB_PX}px) + ${THUMB_PX}px)` }}
            >
              <IntelligenceTrackFlow active={flowing} />
            </span>
          </span>
          {stops.map((stop, stopIndex) => {
            const filled = stopIndex <= index && active?.value !== THINKING_OFF_EFFORT_STOP;
            return (
              <span
                key={stop.value}
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 size-1 -translate-y-1/2 rounded-full transition-[background-color,opacity,translate,scale] duration-300 hover:scale-200 hover:brightness-90 motion-reduce:transition-none",
                  TRACK_EASE,
                  filled ? "bg-white/45" : "bg-token-foreground/25",
                  // Under Fast the filled stops slip back into the stream.
                  filled && flowing
                    ? "-translate-x-[calc(50%+10px)] opacity-0"
                    : "-translate-x-1/2",
                )}
                style={{ insetInlineStart: `${(stopIndex / last) * 100}%` }}
              />
            );
          })}
          <NodexSliderThumb
            aria-label="Effort"
            getAriaValueText={(_formatted, next) => stops[next]?.label ?? ""}
            className={cn(
              "size-7 border-[0.5px] border-token-border bg-white shadow-[0_0_2px_rgb(0_0_0/0.1),0_1px_3px_rgb(0_0_0/0.08)] transition-[inset-inline-start,scale,box-shadow] duration-300 hover:scale-[1.06] hover:shadow-[0_0_2px_rgb(0_0_0/0.12),0_2px_6px_rgb(0_0_0/0.12)] focus-visible:ring-0 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-token-focus-border data-[dragging]:scale-[0.97] data-[dragging]:duration-150 motion-reduce:transition-none",
              TRACK_EASE,
            )}
          />
        </NodexSliderTrack>
      </NodexSlider>
    </div>
  );
}

// Deterministic noise, so the particles keep their places between renders.
const noise = (index: number, seed: number) => {
  const value = Math.sin((index + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return value - Math.floor(value);
};
const FLOW_SECONDS = 1.9;
const FLOW_PARTICLES = Array.from({ length: 14 }, (_, index) => {
  const duration = FLOW_SECONDS / (1 + (noise(index, 21) - 0.5) * 0.4);
  return {
    // Negative delays start every particle mid-journey, so the stream is full at once.
    delay: (index * FLOW_SECONDS) / 14 - duration,
    duration,
    top: 12 + noise(index, 23) * 76,
    opacity: 0.4 + noise(index, 11) * 0.6,
    scale: 0.5 + noise(index, 12) * 0.45,
  };
});

function IntelligenceTrackFlow({ active }: { readonly active: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 transition-opacity duration-500 motion-reduce:hidden",
        active ? "opacity-100" : "opacity-0",
      )}
    >
      {active
        ? FLOW_PARTICLES.map((particle, index) => (
            <span
              key={index}
              className="absolute inset-x-0 h-0 animate-[nodex-intelligence-track-flow_linear_infinite] will-change-transform"
              style={{
                top: `${particle.top}%`,
                animationDuration: `${particle.duration}s`,
                animationDelay: `${particle.delay}s`,
              }}
            >
              <span
                className="absolute top-0 left-0 size-[3px] -translate-1/2 rounded-full bg-white/75 shadow-[0_0_5px_rgb(255_255_255/0.35)]"
                style={{ opacity: particle.opacity, scale: String(particle.scale) }}
              />
            </span>
          ))
        : null}
    </span>
  );
}

/** The head of the controls: the current value, then the mode toggles at the end. */
export function IntelligenceControlsHeader({
  children,
  accessory,
}: {
  readonly children?: ReactNode;
  readonly accessory?: ReactNode;
}) {
  return (
    <div className="flex min-h-7 min-w-0 items-center gap-1.5 text-sm">
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
  const { label, icon: Icon, color, tint } = MODES[mode];
  const unavailable = unavailableReason !== undefined;
  const on = pressed && !unavailable;
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
        aria-pressed={on}
        disabled={disabled}
        // Stays hoverable so its tooltip can explain why it is off.
        aria-disabled={unavailable || undefined}
        onClick={() => {
          if (!unavailable) onPressedChange(!pressed);
        }}
        className={cn(
          "flex size-7 cursor-interaction items-center justify-center rounded-lg outline-hidden transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-token-focus-border active:scale-90 disabled:cursor-default disabled:opacity-50 aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:active:scale-100 motion-reduce:transition-none",
          on
            ? cn(color, tint)
            : "text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground",
        )}
      >
        <Icon filled={on} className="icon-2xs" />
      </button>
    </NodexTooltip>
  );
}
