export type RecurringIndicatorVariant = "none" | "compact" | "badge";
export type RecurringIndicatorType = "none" | "series-start" | "recurring";

export function resolveRecurringIndicatorVariant(
  isRecurring: boolean,
  visibleDurationMinutes: number,
): RecurringIndicatorVariant {
  if (!isRecurring) return "none";
  if (visibleDurationMinutes <= 30) return "compact";
  return "badge";
}

export function resolveRecurringIndicatorType(
  isRecurring: boolean,
  isSeriesFirstOccurrence: boolean,
): RecurringIndicatorType {
  if (!isRecurring) return "none";
  return isSeriesFirstOccurrence ? "series-start" : "recurring";
}
