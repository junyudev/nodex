import { DayFlag, DayPicker, SelectionState, UI } from "react-day-picker";
import { cn } from "@/lib/utils";
import { NodexDateCalendarHeader } from "./date-calendar-header";

export { addCalendarMonth, NodexDateCalendarHeader } from "./date-calendar-header";

export const NODEX_DAY_PICKER_CLASS_NAMES = {
  [UI.Root]: "notion-date-property-menu notranslate w-full select-none px-2 pb-2",
  [UI.Months]: "flex w-full flex-col",
  [UI.Month]: "w-full",
  [UI.MonthCaption]: "sr-only",
  [UI.CaptionLabel]: "sr-only",
  [UI.MonthGrid]: "w-full table-fixed border-separate border-spacing-0",
  [UI.Weekdays]: "grid grid-cols-7",
  [UI.Weekday]:
    "flex h-6 items-center justify-center text-[11px] font-normal text-token-description-foreground",
  [UI.Weeks]: "block",
  [UI.Week]: "grid grid-cols-7",
  [UI.Day]: "rdp-day flex size-8 items-center justify-center p-0 text-center text-sm leading-none",
  [UI.DayButton]: cn(
    "flex size-7 items-center justify-center rounded-md text-sm leading-none outline-hidden",
    "hover:bg-token-list-hover-background focus-visible:ring-token-focus-border focus-visible:ring-2",
  ),
  [DayFlag.outside]: "rdp-day_outside [&>button]:text-token-description-foreground/55",
  [DayFlag.today]:
    "rdp-day_today [&>button]:font-medium [&>button]:ring-[0.5px] [&>button]:ring-token-border",
  [DayFlag.focused]: "rdp-day_focused",
  [SelectionState.selected]:
    "rdp-day_selected [&>button]:bg-chart-blue [&>button]:text-(--app-color-text-on-accent) [&>button]:ring-0",
  [SelectionState.range_start]:
    "rdp-day_start [&>button]:bg-chart-blue [&>button]:text-(--app-color-text-on-accent) [&>button]:ring-0",
  [SelectionState.range_middle]:
    "rdp-day_range_middle [&>button]:bg-(--color-background-info-soft) [&>button]:text-info [&>button]:ring-0",
  [SelectionState.range_end]:
    "rdp-day_end [&>button]:bg-chart-blue [&>button]:text-(--app-color-text-on-accent) [&>button]:ring-0",
} as const;

export function NodexDateCalendar({
  selected,
  month,
  onMonthChange,
  onSelect,
  onToday,
  disabled = false,
}: {
  readonly selected?: Date;
  readonly month: Date;
  readonly onMonthChange: (month: Date) => void;
  readonly onSelect: (date: Date | undefined) => void;
  readonly onToday: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <>
      <NodexDateCalendarHeader
        month={month}
        onMonthChange={onMonthChange}
        onToday={onToday}
        disabled={disabled}
      />
      <DayPicker
        mode="single"
        selected={selected}
        month={month}
        onMonthChange={onMonthChange}
        onSelect={onSelect}
        disabled={disabled}
        showOutsideDays
        fixedWeeks
        hideNavigation
        classNames={NODEX_DAY_PICKER_CLASS_NAMES}
      />
    </>
  );
}
