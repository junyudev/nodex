import { useIntl } from "@/lib/i18n";
import { ChevronRightIcon } from "@/components/shared/icons";

export const addCalendarMonth = (month: Date, delta: number): Date =>
  new Date(month.getFullYear(), month.getMonth() + delta, 1);

const NAVIGATION_BUTTON_CLASS =
  "flex size-7 items-center justify-center rounded-md text-token-description-foreground enabled:hover:bg-token-list-hover-background enabled:hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-hidden disabled:opacity-40";

export function NodexDateCalendarHeader({
  month,
  onMonthChange,
  onToday,
  disabled = false,
  minDate,
}: {
  readonly month: Date;
  readonly onMonthChange: (month: Date) => void;
  readonly onToday: () => void;
  readonly disabled?: boolean;
  /** The earliest day that can be chosen; the header goes no further back than its month. */
  readonly minDate?: Date;
}) {
  const intl = useIntl();
  const atEarliestMonth =
    minDate !== undefined &&
    month.getFullYear() * 12 + month.getMonth() <= minDate.getFullYear() * 12 + minDate.getMonth();
  return (
    <div className="flex h-9 items-center gap-1 px-2">
      <button
        type="button"
        disabled={disabled}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm text-token-foreground hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-hidden"
        onClick={onToday}
      >
        {intl.formatMessage({ id: "ui.dateCalendarHeader.today", defaultMessage: "Today" })}
      </button>
      <div className="min-w-0 flex-1 text-center text-sm font-medium text-token-foreground">
        {intl.formatDate(month, { month: "long", year: "numeric" })}
      </div>
      <button
        type="button"
        aria-label={intl.formatMessage({
          id: "ui.dateCalendarHeader.previousMonth",
          defaultMessage: "Previous month",
        })}
        disabled={disabled || atEarliestMonth}
        className={NAVIGATION_BUTTON_CLASS}
        onClick={() => onMonthChange(addCalendarMonth(month, -1))}
      >
        <ChevronRightIcon className="icon-2xs rotate-180" />
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({
          id: "ui.dateCalendarHeader.nextMonth",
          defaultMessage: "Next month",
        })}
        disabled={disabled}
        className={NAVIGATION_BUTTON_CLASS}
        onClick={() => onMonthChange(addCalendarMonth(month, 1))}
      >
        <ChevronRightIcon className="icon-2xs" />
      </button>
    </div>
  );
}
