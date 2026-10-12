import { ChevronRightIcon } from "@/components/shared/icons";

export const addCalendarMonth = (month: Date, delta: number): Date =>
  new Date(month.getFullYear(), month.getMonth() + delta, 1);

export function NodexDateCalendarHeader({
  month,
  onMonthChange,
  onToday,
  disabled = false,
}: {
  readonly month: Date;
  readonly onMonthChange: (month: Date) => void;
  readonly onToday: () => void;
  readonly disabled?: boolean;
}) {
  return (
    <div className="flex h-9 items-center gap-1 px-2">
      <button
        type="button"
        disabled={disabled}
        className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-sm text-token-foreground hover:bg-token-list-hover-background focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-hidden"
        onClick={onToday}
      >
        Today
      </button>
      <div className="min-w-0 flex-1 text-center text-sm font-medium text-token-foreground">
        {new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(month)}
      </div>
      <button
        type="button"
        aria-label="Previous month"
        disabled={disabled}
        className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-hidden"
        onClick={() => onMonthChange(addCalendarMonth(month, -1))}
      >
        <ChevronRightIcon className="icon-2xs rotate-180" />
      </button>
      <button
        type="button"
        aria-label="Next month"
        disabled={disabled}
        className="flex size-7 items-center justify-center rounded-md text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-hidden"
        onClick={() => onMonthChange(addCalendarMonth(month, 1))}
      >
        <ChevronRightIcon className="icon-2xs" />
      </button>
    </div>
  );
}
