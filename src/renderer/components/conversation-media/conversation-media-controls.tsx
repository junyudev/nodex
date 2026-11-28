import {
  forwardRef,
  useRef,
  type ButtonHTMLAttributes,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  NodexSlider,
  NodexSliderRange,
  NodexSliderThumb,
  NodexSliderTrack,
} from "@/components/ui/slider";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { displayTime, seekMedia } from "./conversation-media-playback";

/** The speeds every conversation player offers. */
export const MEDIA_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** A player's icon control; its label is both its tooltip and its accessible name. */
export const MediaControlButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string }
>(function MediaControlButton({ label, className, ...props }, ref) {
  return (
    <NodexTooltip tooltipContent={label}>
      <button
        ref={ref}
        type="button"
        aria-label={label}
        className={cn(
          "no-drag cursor-interaction flex h-token-button-composer aspect-square shrink-0 items-center justify-center gap-1 rounded-lg border border-transparent !px-0 py-0 text-sm leading-[18px] whitespace-nowrap semantic-text-secondary select-none",
          "focus:outline-hidden focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40",
          "not-disabled:not-aria-disabled:hover:bg-(--color-background-primary-ghost-hover) aria-expanded:bg-(--color-background-primary-ghost-hover)",
          className,
        )}
        {...props}
      />
    </NodexTooltip>
  );
});

export function MediaSlider({
  label,
  valueText,
  min,
  max,
  step,
  value,
  disabled,
  onValueChange,
  onPointerDownCapture,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly disabled?: boolean;
  readonly onValueChange: (value: number) => void;
  readonly onPointerDownCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerUp?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onPointerCancel?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  readonly onLostPointerCapture?: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <NodexSlider
      className="relative flex h-6 w-auto min-w-0 flex-1 touch-none items-center data-[disabled]:opacity-40"
      thumbAlignment="edge"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? 0) : next)}
      onPointerDownCapture={onPointerDownCapture}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onLostPointerCapture={onLostPointerCapture}
    >
      <NodexSliderTrack className="relative h-0.5 grow overflow-visible rounded-full bg-(--color-border) data-[orientation=horizontal]:h-0.5">
        <NodexSliderRange className="absolute h-full rounded-full bg-(--color-text)" />
        <NodexSliderThumb
          aria-label={label}
          getAriaValueText={() => valueText}
          className="block size-4 cursor-interaction rounded-full border border-default bg-surface-tertiary shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border data-[disabled]:cursor-default"
        />
      </NodexSliderTrack>
    </NodexSlider>
  );
}

/** Scrubbing holds playback and resumes it where the pointer lets go. */
export function MediaTimeline({
  element,
  isCurrent,
  label,
  time,
  duration,
  onTimeChange,
  resume,
}: {
  readonly element: HTMLMediaElement | null;
  readonly isCurrent: () => boolean;
  readonly label: string;
  readonly time: number;
  readonly duration: number;
  readonly onTimeChange: (time: number) => void;
  /** Resumes the playback a scrub held. */
  readonly resume: (element: HTMLMediaElement) => void;
}) {
  // A scrub belongs to the element it paused; a replaced element neither continues nor resumes it.
  const seeking = useRef<{
    readonly element: HTMLMediaElement;
    readonly pointerId: number;
    readonly wasPlaying: boolean;
  } | null>(null);
  const finish = (pointerId: number) => {
    const current = seeking.current;
    if (!current || current.pointerId !== pointerId) return;
    seeking.current = null;
    if (current.wasPlaying && current.element === element && isCurrent()) resume(current.element);
  };
  return (
    <MediaSlider
      label={label}
      valueText={`${displayTime(time)} / ${displayTime(duration)}`}
      disabled={duration <= 0}
      min={0}
      max={duration || 1}
      step={0.1}
      value={Math.min(time, duration)}
      onPointerDownCapture={(event) => {
        if (
          !element ||
          duration <= 0 ||
          event.button !== 0 ||
          seeking.current?.element === element ||
          !isCurrent()
        )
          return;
        seeking.current = { element, pointerId: event.pointerId, wasPlaying: !element.paused };
        element.pause();
      }}
      onPointerUp={(event) => finish(event.pointerId)}
      onPointerCancel={(event) => finish(event.pointerId)}
      onLostPointerCapture={(event) => finish(event.pointerId)}
      onValueChange={(next) => {
        if (element && isCurrent()) onTimeChange(seekMedia(element, next));
      }}
    />
  );
}
