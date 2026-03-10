import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface CalendarToolbarProps {
  visibleDays: Date[];
  dayCount: number;
  onToday: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSetDayCount: (count: number) => void;
}

function formatDateRange(days: Date[]): string {
  if (days.length === 0) return "";
  const first = days[0];
  const last = days[days.length - 1];
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
  const yearOpts: Intl.DateTimeFormatOptions = { ...opts, year: "numeric" };

  if (first.getMonth() === last.getMonth()) {
    return `${first.toLocaleDateString(undefined, { month: "long" })} ${first.getDate()} – ${last.getDate()}, ${first.getFullYear()}`;
  }
  if (first.getFullYear() === last.getFullYear()) {
    return `${first.toLocaleDateString(undefined, opts)} – ${last.toLocaleDateString(undefined, yearOpts)}`;
  }
  return `${first.toLocaleDateString(undefined, yearOpts)} – ${last.toLocaleDateString(undefined, yearOpts)}`;
}

export function CalendarToolbar({
  visibleDays,
  dayCount,
  onToday,
  onPrev,
  onNext,
  onSetDayCount,
}: CalendarToolbarProps) {
  const btnBase =
    "h-7 px-2.5 text-base font-medium rounded-md transition-colors";
  const btnSecondary = cn(
    btnBase,
    `
      text-(--foreground-secondary)
      hover:bg-(--background-tertiary)
      dark:hover:bg-[rgba(255,255,255,0.06)]
    `,
  );
  const toggleBase =
    "h-7 px-2.5 text-base font-medium rounded-md transition-colors";

  return (
    <div className="flex items-center gap-2 px-4 py-2">
      <h2 className="mr-2 text-sm font-semibold text-(--foreground) select-none">
        {formatDateRange(visibleDays)}
      </h2>

      <button onClick={onToday} className={btnSecondary}>
        Today
      </button>

      <div className="flex items-center">
        <button
          onClick={onPrev}
          className="flex size-7 items-center justify-center rounded-md text-(--foreground-secondary) transition-colors hover:bg-(--background-tertiary) dark:hover:bg-[rgba(255,255,255,0.06)]"
          aria-label="Previous"
        >
          <ChevronLeft className="size-4" />
        </button>
        <button
          onClick={onNext}
          className="flex size-7 items-center justify-center rounded-md text-(--foreground-secondary) transition-colors hover:bg-(--background-tertiary) dark:hover:bg-[rgba(255,255,255,0.06)]"
          aria-label="Next"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>

      <div className="ml-auto flex items-center gap-0.5 rounded-lg bg-(--background-tertiary) p-0.5 dark:bg-[rgba(255,255,255,0.06)]">
        {[4, 7].map((count) => (
          <button
            key={count}
            onClick={() => onSetDayCount(count)}
            className={cn(
              toggleBase,
              dayCount === count
                ? "bg-(--background) text-(--foreground) shadow-sm dark:bg-[rgba(255,255,255,0.1)]"
                : "text-(--foreground-secondary) hover:text-(--foreground)",
            )}
          >
            {count === 4 ? "4 Days" : "Week"}
          </button>
        ))}
      </div>
    </div>
  );
}
