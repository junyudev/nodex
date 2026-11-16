import { getIntl, type IntlShape } from "@/lib/i18n";
import { formatWorkedForTimeLabel } from "./thread-worked-for-time";

/** A settled Thought's label: how long it took once that is known and at least a second. */
export function formatThoughtLabel(
  durationMs: number | null | undefined,
  intl: IntlShape = getIntl(),
): string {
  if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 1_000)
    return intl.formatMessage({
      id: "conversation.threadThoughtLabel.thought",
      defaultMessage: "Thought",
    });
  return intl.formatMessage(
    { id: "conversation.threadThoughtLabel.thoughtFor", defaultMessage: "Thought for {duration}" },
    { duration: formatWorkedForTimeLabel(durationMs, intl) },
  );
}

/** Consecutive Thoughts took their summed time; one Thought without a reported time leaves it unknown. */
export function sumThoughtDurations(
  durations: readonly (number | null | undefined)[],
): number | null {
  let total = 0;
  for (const duration of durations) {
    if (duration == null || !Number.isFinite(duration)) return null;
    total += Math.max(0, duration);
  }
  return durations.length === 0 ? null : total;
}
