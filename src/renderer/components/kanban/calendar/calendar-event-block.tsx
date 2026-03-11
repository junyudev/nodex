import { memo } from "react";
import { Repeat2Icon } from "lucide-react";
import { formatTimeRange } from "@/lib/calendar-utils";
import { resolveKanbanPriorityOption } from "@/lib/kanban-options";
import { estimateStyles } from "@/lib/types";
import type { Priority, Estimate } from "@/lib/types";
import { extractPlainText } from "@/lib/nfm/extract-text";
import { cn } from "@/lib/utils";
import {
  resolveRecurringIndicatorType,
  resolveRecurringIndicatorVariant,
} from "./calendar-recurring-indicator";

interface CalendarEventBlockProps {
  id: string;
  title: string;
  accentColor: string;
  scheduledStart: Date;
  scheduledEnd: Date;
  hourHeight: number;
  lane: number;
  totalLanes: number;
  isActive: boolean;
  isInteracting: boolean;
  interactive?: boolean;
  // Card detail props
  priority?: Priority;
  estimate?: Estimate;
  tags: string[];
  assignee?: string;
  agentStatus?: string;
  description?: string;
  isRecurring?: boolean;
  isSeriesFirstOccurrence?: boolean;
  muted?: boolean;
  dragVisual?: "default" | "source-ghost" | "overlay-ghost";
  zIndex?: number;
  onMarkDone?: () => void;
  onSkip?: () => void;
  onOpen: () => void;
  onDragStartMove?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragEndMove?: (event: React.DragEvent<HTMLDivElement>) => void;
  onPointerDownResize: (
    edge: "start" | "end",
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
  onLostPointerCapture: (event: React.PointerEvent<HTMLDivElement>) => void;
}

const BADGE = "inline-flex items-center h-[calc(var(--spacing)*3.5)] text-xs px-[calc(var(--spacing)*1)] rounded-sm leading-none shrink-0";
const RECURRING_BADGE_BASE = cn(BADGE, "gap-0.5");
const RECURRING_BADGE = cn(
  RECURRING_BADGE_BASE,
  `
    border border-(--border)/70 bg-(--background)/70
    text-(--foreground-secondary)
  `,
);
const RECURRING_BADGE_ORIGIN = cn(
  RECURRING_BADGE_BASE,
  "border border-(--accent-blue)/25 bg-(--accent-blue)/10 text-(--accent-blue)",
);

export const CalendarEventBlock = memo(function CalendarEventBlock({
  id,
  title,
  accentColor,
  scheduledStart,
  scheduledEnd,
  hourHeight,
  lane,
  totalLanes,
  isActive,
  isInteracting,
  interactive = true,
  priority,
  estimate,
  tags,
  assignee,
  agentStatus,
  description,
  isRecurring = false,
  isSeriesFirstOccurrence = false,
  muted = false,
  dragVisual = "default",
  zIndex,
  onMarkDone,
  onSkip,
  onOpen,
  onDragStartMove,
  onDragEndMove,
  onPointerDownResize,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onLostPointerCapture,
}: CalendarEventBlockProps) {
  const startOfDay = new Date(scheduledStart);
  startOfDay.setHours(0, 0, 0, 0);

  const startOffsetMinutes = (scheduledStart.getTime() - startOfDay.getTime()) / 60000;
  const startMinutes = Math.max(0, Math.min(startOffsetMinutes, 24 * 60 - 1));
  const durationMinutes = Math.max(
    (scheduledEnd.getTime() - scheduledStart.getTime()) / 60000,
    15,
  );
  const visibleDurationMinutes = Math.max(
    15,
    Math.min(durationMinutes, 24 * 60 - startMinutes),
  );

  const top = startMinutes * (hourHeight / 60);
  const height = visibleDurationMinutes * (hourHeight / 60);

  // Overlap layout
  const laneWidth = 100 / totalLanes;
  const left = `calc(${lane * laneWidth}% + 2px)`;
  const width = `calc(${laneWidth}% - 4px)`;

  // Progressive disclosure tiers
  const isShort = visibleDurationMinutes <= 30;   // tier 1: row layout
  const isMedium = visibleDurationMinutes <= 60;  // tier 2: title + time + priority
  const isLarge = visibleDurationMinutes <= 120;  // tier 3: + estimate + tags

  const handleResizePointerDown = (
    edge: "start" | "end",
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    event.stopPropagation();
    event.preventDefault();
    onPointerDownResize(edge, event);
  };

  const timeRange = formatTimeRange(scheduledStart, scheduledEnd);
  const descriptionText = description ? extractPlainText(description, 80) : undefined;
  const priorityOption = resolveKanbanPriorityOption(priority);
  const priorityLabel = priorityOption?.shortLabel ?? null;
  const isSourceGhost = dragVisual === "source-ghost";
  const isOverlayGhost = dragVisual === "overlay-ghost";
  const recurringIndicatorVariant = resolveRecurringIndicatorVariant(isRecurring, visibleDurationMinutes);
  const recurringIndicatorType = resolveRecurringIndicatorType(isRecurring, isSeriesFirstOccurrence);
  const recurringIndicatorLabel = recurringIndicatorType === "series-start"
    ? "Recurring series starts here"
    : "Recurring occurrence";
  const isSeriesStartIndicator = recurringIndicatorType === "series-start";

  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={`${title} ${timeRange}`}
      data-calendar-event-block=""
      data-card-id={id}
      draggable={interactive}
      onDragStart={interactive ? onDragStartMove : undefined}
      onDragEnd={interactive ? onDragEndMove : undefined}
      onClick={(event) => {
        if (!interactive) return;
        event.stopPropagation();
        onOpen();
      }}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerCancel : undefined}
      onLostPointerCapture={interactive ? onLostPointerCapture : undefined}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen();
      }}
      className={cn(
        "absolute touch-none overflow-hidden rounded-sm",
        "border-l-[calc(var(--spacing)*0.75)]",
        "group text-left outline-none select-none",
        interactive && "cursor-default active:cursor-grabbing",
        isActive || isInteracting
          ? "shadow-md ring-2 ring-(--accent-blue)"
          : undefined,
        interactive && "focus-visible:ring-2 focus-visible:ring-(--accent-blue)",
        muted && "opacity-60",
        isSourceGhost && "opacity-35 saturate-75",
        isOverlayGhost && "opacity-80 shadow-lg ring-2 ring-(--accent-blue)/45",
      )}
      style={{
        top,
        height: Math.max(height, hourHeight / 4),
        left,
        width,
        borderLeftColor: accentColor,
        zIndex,
        backgroundColor: muted
          ? `color-mix(in srgb, ${accentColor} 6%, var(--background))`
          : isOverlayGhost
            ? `color-mix(in srgb, ${accentColor} 24%, var(--background))`
            : `color-mix(in srgb, ${accentColor} 14%, var(--background))`,
      }}
    >
      {interactive && (
        <div
          className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-ns-resize"
          draggable={false}
          onPointerDown={(event) => handleResizePointerDown("start", event)}
        />
      )}

      {(onMarkDone || onSkip) && (
        <div className="absolute top-1 right-1 z-30 hidden items-center gap-1 group-focus-within:flex group-hover:flex">
          {onMarkDone && (
            <button
              type="button"
              draggable={false}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onMarkDone();
              }}
              className="h-5 rounded-sm bg-(--background)/95 px-1.5 text-xs font-medium text-(--foreground-secondary) hover:text-(--foreground)"
            >
              Done
            </button>
          )}
          {onSkip && isRecurring && (
            <button
              type="button"
              draggable={false}
              onPointerDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onSkip();
              }}
              className="h-5 rounded-sm bg-(--background)/95 px-1.5 text-xs font-medium text-(--foreground-secondary) hover:text-(--foreground)"
            >
              Skip
            </button>
          )}
        </div>
      )}

      {/* Tier 1: ≤30 min — compact row */}
      {isShort ? (
        <div className="flex h-full flex-row items-center gap-1.5 px-1.5 py-0.5">
          <span
            className="truncate text-xs/tight font-medium"
            style={{ color: accentColor }}
          >
            {title}
          </span>
          {recurringIndicatorVariant === "compact" && recurringIndicatorType !== "none" && (
            <span
              aria-label={recurringIndicatorLabel}
              className={cn(
                "inline-flex h-3.5 shrink-0 items-center justify-center rounded-sm border px-[calc(var(--spacing)*1)]",
                isSeriesStartIndicator
                  ? "border-(--accent-blue)/25 bg-(--accent-blue)/10 text-(--accent-blue)"
                  : "border-(--border)/70 bg-(--background)/70 text-(--foreground-secondary)",
              )}
            >
              <Repeat2Icon className="size-2.5" />
              <span className="sr-only">{recurringIndicatorLabel}</span>
            </span>
          )}
          <span className="shrink-0 truncate text-xs/tight text-(--foreground-tertiary)">
            {timeRange}
          </span>
        </div>
      ) : (
        <div className="flex h-full min-h-0 flex-col px-1.5 py-0.5">
          {/* Title */}
          <div className="flex min-w-0 shrink-0 items-start gap-1">
            <span
              className="min-w-0 shrink-0 truncate text-xs/tight font-medium"
              style={{ color: accentColor }}
            >
              {title}
            </span>
            {recurringIndicatorVariant === "badge" && recurringIndicatorType !== "none" && (
              <span
                aria-label={recurringIndicatorLabel}
                className={isSeriesStartIndicator ? RECURRING_BADGE_ORIGIN : RECURRING_BADGE}
              >
                <Repeat2Icon className="size-2.5" />
                <span className="sr-only">{recurringIndicatorLabel}</span>
              </span>
            )}
          </div>

          {/* Tier 2: 31–60 min — time + priority on same row */}
          {isMedium ? (
            <div className="mt-0.5 flex min-w-0 items-center gap-1">
              <span className="truncate text-xs/tight text-(--foreground-tertiary)">
                {timeRange}
              </span>
              {priorityOption && priorityLabel ? (
                <span className={cn(BADGE, priorityOption.className)}>
                  {priorityLabel}
                </span>
              ) : null}
            </div>
          ) : (
            <>
              {/* Time */}
              <span className="mt-0.5 shrink-0 truncate text-xs/tight text-(--foreground-tertiary)">
                {timeRange}
              </span>

              {/* Tier 4 only: agent status + description */}
              {!isLarge && agentStatus && (
                <p className="mt-0.5 shrink-0 truncate font-mono text-xs/tight text-(--blue-text)">
                  {agentStatus}
                </p>
              )}
              {!isLarge && descriptionText && (
                <p className="mt-0.5 line-clamp-2 shrink-0 text-xs/tight wrap-break-word text-(--foreground-secondary)">
                  {descriptionText}
                </p>
              )}

              {/* Tier 3+: badges row */}
              <div className="mt-1 flex min-w-0 flex-wrap items-center gap-0.75">
                {priorityOption && priorityLabel ? (
                  <span className={cn(BADGE, priorityOption.className)}>
                    {priorityLabel}
                  </span>
                ) : null}
                {estimate && (
                  <span className={cn(BADGE, estimateStyles[estimate].className)}>
                    {estimateStyles[estimate].label}
                  </span>
                )}
                {(isLarge ? tags.slice(0, 2) : tags).map((tag) => (
                  <span
                    key={tag}
                    className={cn(BADGE, "bg-(--gray-bg) text-(--foreground-secondary)")}
                  >
                    {tag}
                  </span>
                ))}
                {assignee && !isLarge && (
                  <span className="ml-auto shrink-0 truncate text-xs text-(--foreground-tertiary)">
                    @{assignee}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {interactive && (
        <div
          className="absolute inset-x-0 bottom-0 z-20 h-1.5 cursor-ns-resize"
          draggable={false}
          onPointerDown={(event) => handleResizePointerDown("end", event)}
        />
      )}
    </div>
  );
});
