import type {
  DatabaseDateFormatV2,
  DatabaseNumberFormatV2,
  DatabaseTimeFormatV2,
} from "../../shared/database-module-v2";

export const formatDatabaseNumber = (
  value: number,
  format: DatabaseNumberFormatV2,
  locale?: string,
): string => {
  if (format.kind === "percent") {
    return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 6 }).format(
      value,
    );
  }
  if (format.kind === "currency") {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: format.currencyCode.toUpperCase(),
      maximumFractionDigits: 6,
    }).format(value);
  }
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 15 }).format(value);
};

const localDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

const relativeDate = (date: Date, now: Date): string => {
  const dayOffset = Math.round((localDay(date).getTime() - localDay(now).getTime()) / 86_400_000);
  if (dayOffset === 0) return "Today";
  if (dayOffset === 1) return "Tomorrow";
  if (dayOffset === -1) return "Yesterday";
  return dayOffset > 0 ? `In ${dayOffset} days` : `${Math.abs(dayOffset)} days ago`;
};

const dateOptions = (format: DatabaseDateFormatV2): Intl.DateTimeFormatOptions => {
  if (format === "full") return { year: "numeric", month: "long", day: "numeric" };
  if (format === "month_day_year") {
    return { year: "numeric", month: "2-digit", day: "2-digit" };
  }
  if (format === "day_month_year") {
    return { year: "numeric", month: "2-digit", day: "2-digit" };
  }
  return { year: "numeric", month: "2-digit", day: "2-digit" };
};

const localeForDateFormat = (format: DatabaseDateFormatV2, locale?: string): string | undefined => {
  if (format === "month_day_year") return "en-US";
  if (format === "day_month_year") return "en-GB";
  if (format === "year_month_day") return "sv-SE";
  return locale;
};

export const formatDatabaseDate = (input: {
  readonly date: Date;
  readonly dateFormat: DatabaseDateFormatV2;
  readonly timeFormat?: DatabaseTimeFormatV2;
  readonly locale?: string;
  readonly now?: Date;
}): string => {
  if (input.dateFormat === "relative") {
    const relative = relativeDate(input.date, input.now ?? new Date());
    if (!input.timeFormat) return relative;
    const time = new Intl.DateTimeFormat(input.locale, {
      hour: "numeric",
      minute: "2-digit",
      hour12: input.timeFormat === "twelve_hour",
    }).format(input.date);
    return `${relative}, ${time}`;
  }
  return new Intl.DateTimeFormat(localeForDateFormat(input.dateFormat, input.locale), {
    ...dateOptions(input.dateFormat),
    ...(input.timeFormat
      ? {
          hour: "numeric" as const,
          minute: "2-digit" as const,
          hour12: input.timeFormat === "twelve_hour",
        }
      : {}),
  }).format(input.date);
};
