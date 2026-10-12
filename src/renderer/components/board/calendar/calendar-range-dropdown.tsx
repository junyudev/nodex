import { PlusIcon } from "@/components/shared/icons";
import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import {
  type CalendarRangeMode,
  type CalendarRangeState,
  clampCalendarMultiDayCount,
  clampCalendarMultiWeekCount,
  formatCalendarRangeLabel,
  formatCalendarRangeStaticValue,
} from "@/lib/calendar-range";
import { cn } from "@/lib/utils";
import { Minus } from "@/components/shared/icons/generic-icons";

interface CalendarRangeDropdownProps {
  range: CalendarRangeState;
  onRangeChange: (range: CalendarRangeState) => void;
}

interface CalendarRangeOption {
  mode: CalendarRangeMode;
  label: string;
  shortcut?: string;
}

const RANGE_OPTIONS: CalendarRangeOption[] = [
  { mode: "day", label: "Day", shortcut: "D/1" },
  { mode: "week", label: "Week", shortcut: "W/2" },
  { mode: "multi-day", label: "Multi-Day" },
  { mode: "multi-week", label: "Multi-Week" },
];

export function CalendarRangeDropdown({ range, onRangeChange }: CalendarRangeDropdownProps) {
  const trigger = (
    <NodexDropdownButtonTrigger
      className="h-8 min-w-24 justify-center border-(--color-text-info) bg-text-info/10 px-3 text-sm font-medium text-info hover:bg-text-info/14 [&_svg]:text-(--color-text-info)"
      shape="pill"
      aria-label="Calendar range"
    >
      {formatCalendarRangeLabel(range)}
    </NodexDropdownButtonTrigger>
  );

  return (
    <NodexDropdownMenu
      triggerButton={trigger}
      align="end"
      contentWidth="menuWide"
      contentClassName="w-64"
    >
      {RANGE_OPTIONS.map((option, index) => {
        const selected = option.mode === range.mode;
        const row =
          option.mode === "multi-day" || option.mode === "multi-week" ? (
            <CalendarRangeEditableRow
              key={option.mode}
              option={option}
              range={range}
              selected={selected}
              onRangeChange={onRangeChange}
            />
          ) : (
            <NodexDropdownItem
              key={option.mode}
              onSelect={() => onRangeChange({ ...range, mode: option.mode })}
              leftSlot={<SelectionSlot selected={selected} />}
              keyboardShortcut={option.shortcut}
              className={cn(selected && "text-info")}
            >
              {option.label}
            </NodexDropdownItem>
          );

        if (index !== 2) return row;
        return (
          <div key="custom-range-group">
            <NodexDropdownSeparator />
            {row}
          </div>
        );
      })}
    </NodexDropdownMenu>
  );
}

function CalendarRangeEditableRow({
  option,
  range,
  selected,
  onRangeChange,
}: {
  option: CalendarRangeOption;
  range: CalendarRangeState;
  selected: boolean;
  onRangeChange: (range: CalendarRangeState) => void;
}) {
  const value =
    option.mode === "multi-day"
      ? clampCalendarMultiDayCount(range.multiDayCount)
      : clampCalendarMultiWeekCount(range.multiWeekCount);

  const applyStep = (delta: number) => {
    if (option.mode === "multi-day") {
      onRangeChange({
        ...range,
        mode: "multi-day",
        multiDayCount: clampCalendarMultiDayCount(value + delta),
      });
      return;
    }

    onRangeChange({
      ...range,
      mode: "multi-week",
      multiWeekCount: clampCalendarMultiWeekCount(value + delta),
    });
  };

  const handleStepperPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleStepperClick = (event: MouseEvent<HTMLButtonElement>, delta: number) => {
    event.preventDefault();
    event.stopPropagation();
    applyStep(delta);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft" || event.key === "-") {
      event.preventDefault();
      applyStep(-1);
      return;
    }

    if (event.key === "ArrowRight" || event.key === "+" || event.key === "=") {
      event.preventDefault();
      applyStep(1);
    }
  };

  return (
    <NodexDropdownItem
      onSelect={() => onRangeChange({ ...range, mode: option.mode })}
      onKeyDown={handleKeyDown}
      leftSlot={<SelectionSlot selected={selected} />}
      rightSlot={
        <span className="relative grid min-w-20 grid-cols-1 items-center justify-items-end">
          <span className="col-start-1 row-start-1 text-token-description-foreground group-hover/dropdown-range:opacity-0 group-focus-within/dropdown-range:opacity-0">
            {formatCalendarRangeStaticValue(option.mode, range)}
          </span>
          <span className="col-start-1 row-start-1 flex items-center gap-2 opacity-0 group-hover/dropdown-range:opacity-100 group-focus-within/dropdown-range:opacity-100">
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Decrease ${option.label}`}
              className="flex size-5 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/10 hover:text-token-foreground"
              onPointerDown={handleStepperPointerDown}
              onClick={(event) => handleStepperClick(event, -1)}
            >
              <Minus className="size-3.5" />
            </button>
            <span className="min-w-4 text-center text-token-foreground">{value}</span>
            <button
              type="button"
              tabIndex={-1}
              aria-label={`Increase ${option.label}`}
              className="flex size-5 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-foreground/10 hover:text-token-foreground"
              onPointerDown={handleStepperPointerDown}
              onClick={(event) => handleStepperClick(event, 1)}
            >
              <PlusIcon className="size-3.5" />
            </button>
          </span>
        </span>
      }
      className={cn("group/dropdown-range", selected && "text-info")}
    >
      {option.label}
    </NodexDropdownItem>
  );
}

function SelectionSlot({ selected }: { selected: boolean }) {
  if (selected) return <NodexDropdownSelectedIcon />;
  return <span className="block size-4" aria-hidden="true" />;
}
