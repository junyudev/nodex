import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "react-day-picker/locale/zh-CN";
import { useAppLocale } from "@/lib/i18n";
import { NODEX_DAY_PICKER_CLASS_NAMES } from "@/components/ui/date-calendar";

export interface DateMentionCalendarProps {
  readonly hasEndDate: boolean;
  readonly selectedRange: DateRange;
  readonly selectedDate: Date;
  readonly month: Date;
  readonly onMonthChange: (month: Date) => void;
  readonly onSelectDate: (date: Date | undefined) => void;
  readonly onSelectRange: (range: DateRange | undefined) => void;
}

export function DateMentionCalendar({
  hasEndDate,
  selectedRange,
  selectedDate,
  month,
  onMonthChange,
  onSelectDate,
  onSelectRange,
}: DateMentionCalendarProps) {
  const locale = useAppLocale() === "zh-CN" ? zhCN : undefined;
  if (hasEndDate) {
    return (
      <DayPicker
        mode="range"
        locale={locale}
        selected={selectedRange}
        month={month}
        onMonthChange={onMonthChange}
        onSelect={onSelectRange}
        showOutsideDays
        fixedWeeks
        hideNavigation
        classNames={NODEX_DAY_PICKER_CLASS_NAMES}
      />
    );
  }

  return (
    <DayPicker
      mode="single"
      locale={locale}
      selected={selectedDate}
      month={month}
      onMonthChange={onMonthChange}
      onSelect={onSelectDate}
      showOutsideDays
      fixedWeeks
      hideNavigation
      classNames={NODEX_DAY_PICKER_CLASS_NAMES}
    />
  );
}
