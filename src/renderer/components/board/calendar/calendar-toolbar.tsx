import { ChevronRightIcon, PlusIcon } from "@/components/shared/icons";
import { ChevronLeft } from "@/components/shared/icons/generic-icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import type { CalendarRangeState } from "@/lib/calendar-range";
import { formatCalendarToolbarMonthYear } from "@/lib/calendar-view-state";
import { cn } from "@/lib/utils";
import { CalendarRangeDropdown } from "./calendar-range-dropdown";

interface CalendarToolbarControlsProps {
  range: CalendarRangeState;
  onRangeChange: (range: CalendarRangeState) => void;
  onCreate: () => void;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
}

export function CalendarToolbarMonthLabel({ visibleDays }: { visibleDays: Date[] }) {
  return (
    <span className="hidden max-w-40 shrink-0 truncate text-left text-sm font-medium text-token-foreground select-none sm:block">
      {formatCalendarToolbarMonthYear(visibleDays)}
    </span>
  );
}

export function CalendarToolbarControls({
  range,
  onRangeChange,
  onCreate,
  onToday,
  onPrev,
  onNext,
}: CalendarToolbarControlsProps) {
  const iconButton =
    "flex size-8 items-center justify-center rounded-full text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-token-focus-border focus-visible:ring-2 focus-visible:outline-hidden";
  const groupedButton =
    "flex h-8 items-center justify-center border-l border-token-border px-3 text-sm font-medium text-token-foreground first:border-l-0 hover:bg-token-foreground/5 focus-visible:ring-token-focus-border focus-visible:ring-2 focus-visible:outline-hidden";

  return (
    <div className="flex shrink-0 items-center gap-2">
      <NodexTooltip tooltipContent="Create calendar task" side="bottom">
        <button
          type="button"
          onClick={onCreate}
          className={iconButton}
          aria-label="Create calendar task"
        >
          <PlusIcon className="size-4" />
        </button>
      </NodexTooltip>

      <CalendarRangeDropdown range={range} onRangeChange={onRangeChange} />

      <div className="flex overflow-hidden rounded-full border border-token-border bg-token-foreground/3">
        <button
          type="button"
          onClick={onPrev}
          className={cn(groupedButton, "w-8 px-0")}
          aria-label="Previous"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button type="button" onClick={onToday} className={groupedButton}>
          Today
        </button>
        <button
          type="button"
          onClick={onNext}
          className={cn(groupedButton, "w-8 px-0")}
          aria-label="Next"
        >
          <ChevronRightIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
