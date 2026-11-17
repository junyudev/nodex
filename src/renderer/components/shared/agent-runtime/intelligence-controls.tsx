import { useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useState, type ComponentType, type ReactNode } from "react";
import {
  FastModeIcon,
  SlashReasoningIcon,
  UltracodeIcon,
  UltrafastModeIcon,
  type ModeIconProps,
} from "@/components/shared/icons";
import {
  NodexDropdownContent,
  NodexDropdownPortal,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownRoot,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexSlider, NodexSliderThumb, NodexSliderTrack } from "@/components/ui/slider";
import { NodexTooltip } from "@/components/ui/tooltip";
import { THINKING_OFF_EFFORT_STOP, type IntelligenceEffortStop } from "@/lib/intelligence-effort";
import { cn } from "@/lib/utils";
import "./intelligence-controls.css";

/** Standing modes that change cost or behavior, each with one icon and color wherever it shows. */
export type IntelligenceMode = "fast" | "ultrafast" | "ultracode" | "thinking";
/** Modes the composer trigger shows while they are on. */
export type IntelligenceModeIndicator = Exclude<IntelligenceMode, "thinking">;

const MODES: Record<
  IntelligenceMode,
  {
    readonly label: MessageDescriptor;
    readonly icon: ComponentType<ModeIconProps>;
    readonly color: string;
    readonly tint: string;
  }
> = {
  fast: {
    label: { id: "components.intelligenceControls.fast", defaultMessage: "Fast" },
    icon: FastModeIcon,
    color: "text-token-charts-blue",
    tint: "bg-token-charts-blue/12 hover:bg-token-charts-blue/18",
  },
  // A faster Fast: the same color, told apart by its double bolt.
  ultrafast: {
    label: { id: "components.intelligenceControls.ultrafast", defaultMessage: "Ultrafast" },
    icon: UltrafastModeIcon,
    color: "text-token-charts-blue",
    tint: "bg-token-charts-blue/12 hover:bg-token-charts-blue/18",
  },
  ultracode: {
    label: { id: "components.intelligenceControls.ultracode", defaultMessage: "Ultracode" },
    icon: UltracodeIcon,
    color: "text-token-charts-orange",
    tint: "bg-token-charts-orange/12 hover:bg-token-charts-orange/18",
  },
  thinking: {
    label: { id: "components.intelligenceControls.thinking", defaultMessage: "Thinking" },
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

/** Max and Ultra are the costly end of the scale, so they take their own color; Off has none. */
function effortTone(value: string | undefined) {
  if (value === THINKING_OFF_EFFORT_STOP)
    return { text: "text-token-description-foreground", fill: "bg-transparent" };
  if (value === "max" || value === "ultra")
    return { text: "text-token-charts-purple", fill: "bg-token-charts-purple" };
  return { text: "text-token-charts-blue", fill: "bg-token-charts-blue" };
}

/** Ultra hands each task to a team of Agents, so a selector names it in its scale color. */
export function intelligenceEffortEmphasis(value: string | undefined): string | undefined {
  return value === "ultra" ? effortTone(value).text : undefined;
}

/**
 * Effort is ordinal: one track with a stop per level, dragged, clicked or stepped with the
 * arrow keys. The level reads at the head of the control in the track's own color.
 */
export function IntelligenceEffortSlider({
  stops,
  value,
  isDefault,
  flow = null,
  disabled = false,
  accessory,
  onChange,
}: {
  readonly stops: readonly IntelligenceEffortStop[];
  readonly value: string | null;
  /** The thumb rests on the model default because the user has not chosen a level. */
  readonly isDefault: boolean;
  /** A speed tier is on: light streams through the filled part of the track, quicker for Ultrafast. */
  readonly flow?: IntelligenceSpeed | null;
  readonly disabled?: boolean;
  /** Mode toggles that share the head of the control, so it stays two lines tall. */
  readonly accessory?: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  const intl = useIntl();
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
              <span className="text-token-description-foreground">
                {intl.formatMessage({
                  id: "components.intelligenceControls.default",
                  defaultMessage: " · Default",
                })}
              </span>
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
              <IntelligenceTrackFlow flow={flow} />
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
                  filled && flow ? "-translate-x-[calc(50%+10px)] opacity-0" : "-translate-x-1/2",
                )}
                style={{ insetInlineStart: `${(stopIndex / last) * 100}%` }}
              />
            );
          })}
          <NodexSliderThumb
            aria-label={intl.formatMessage({
              id: "components.intelligenceControls.effort",
              defaultMessage: "Effort",
            })}
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

// Ultrafast streams at a little under twice Fast's pace.
const FLOW_PACE: Record<IntelligenceSpeed, number> = { fast: 1, ultrafast: 0.55 };

function IntelligenceTrackFlow({ flow }: { readonly flow: IntelligenceSpeed | null }) {
  const active = flow !== null;
  const pace = flow ? FLOW_PACE[flow] : 1;
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
                animationDuration: `${particle.duration * pace}s`,
                animationDelay: `${particle.delay * pace}s`,
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
  const intl = useIntl();
  const { label: labelMessage, icon: Icon, color, tint } = MODES[mode];
  const label = intl.formatMessage(labelMessage);
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
              {unavailable
                ? intl.formatMessage({
                    id: "components.intelligenceControls.unavailable",
                    defaultMessage: "Unavailable",
                  })
                : pressed
                  ? intl.formatMessage({
                      id: "components.intelligenceControls.on",
                      defaultMessage: "On",
                    })
                  : intl.formatMessage({
                      id: "components.intelligenceControls.off",
                      defaultMessage: "Off",
                    })}
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

/** A speed above Standard, by its Nodex name. */
export type IntelligenceSpeed = "fast" | "ultrafast";

export interface IntelligenceSpeedTier {
  readonly value: IntelligenceSpeed;
  /** The catalog's name and cost note for the tier, when it gives them. */
  readonly label?: string;
  readonly description?: string;
}

const STANDARD_SPEED = "standard";

const SPEED_COPY = {
  standard: {
    label: { id: "components.intelligenceControls.standard", defaultMessage: "Standard" },
    description: {
      id: "components.intelligenceControls.standardDescription",
      defaultMessage: "Default speed",
    },
  },
  fast: {
    label: MODES.fast.label,
    description: {
      id: "components.intelligenceControls.fastDescription",
      defaultMessage: "Faster responses, more usage",
    },
  },
  ultrafast: {
    label: MODES.ultrafast.label,
    description: {
      id: "components.intelligenceControls.ultrafastDescription",
      defaultMessage: "Even faster, more expensive",
    },
  },
} satisfies Record<
  IntelligenceSpeed | typeof STANDARD_SPEED,
  { readonly label: MessageDescriptor; readonly description: MessageDescriptor }
>;

/**
 * Speed is one control: its glyph shows the tier in force, and hovering or pressing it lists
 * Standard and every faster tier the model offers, each with what it costs.
 */
export function IntelligenceSpeedControl({
  tiers,
  value,
  disabled = false,
  onChange,
}: {
  /** The faster tiers the model offers, slowest first. */
  readonly tiers: readonly IntelligenceSpeedTier[];
  readonly value: IntelligenceSpeed | null;
  readonly disabled?: boolean;
  readonly onChange: (value: IntelligenceSpeed | null) => void;
}) {
  const intl = useIntl();
  const { icon: Icon, color, tint } = MODES[value ?? "fast"];
  const rows = [
    {
      value: STANDARD_SPEED,
      label: intl.formatMessage(SPEED_COPY.standard.label),
      description: intl.formatMessage(SPEED_COPY.standard.description),
    },
    ...tiers.map((tier) => ({
      value: tier.value,
      label: tier.label || intl.formatMessage(SPEED_COPY[tier.value].label),
      description: tier.description || intl.formatMessage(SPEED_COPY[tier.value].description),
    })),
  ];
  const current = rows.find((row) => row.value === (value ?? STANDARD_SPEED));
  return (
    <NodexDropdownRoot>
      <NodexDropdownTrigger openOnHover delay={120} closeDelay={120} disabled={disabled}>
        <button
          type="button"
          aria-label={intl.formatMessage({
            id: "components.intelligenceControls.speed",
            defaultMessage: "Speed",
          })}
          aria-description={current?.label}
          className={cn(
            "flex size-7 items-center justify-center rounded-lg outline-hidden transition-[background-color,color,scale] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-token-focus-border active:scale-90 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none",
            value
              ? cn(color, tint)
              : "text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground data-[popup-open]:bg-token-list-hover-background data-[popup-open]:text-token-foreground",
          )}
        >
          <Icon filled={value !== null} className="icon-2xs" />
        </button>
      </NodexDropdownTrigger>
      <NodexDropdownPortal>
        <NodexDropdownContent side="top" align="end" sideOffset={6} className="w-60">
          <NodexDropdownRadioGroup
            value={value ?? STANDARD_SPEED}
            onValueChange={(next) =>
              onChange(next === STANDARD_SPEED ? null : (next as IntelligenceSpeed))
            }
          >
            {rows.map((row) => (
              <NodexDropdownRadioItem key={row.value} value={row.value} allowWrap>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span>{row.label}</span>
                  <span className="text-xs text-pretty text-token-description-foreground">
                    {row.description}
                  </span>
                </span>
              </NodexDropdownRadioItem>
            ))}
          </NodexDropdownRadioGroup>
        </NodexDropdownContent>
      </NodexDropdownPortal>
    </NodexDropdownRoot>
  );
}
