import { defineMessages, getIntl, type IntlShape } from "@/lib/i18n";
export type ThreadWorkedForStatus = "working" | "worked" | "stopped";

export interface ThreadWorkedForTiming {
  status: ThreadWorkedForStatus;
  startedAtMs: number;
  completedAtMs: number | null;
}

type DurationUnit = "day" | "hour" | "minute" | "second";

const durationUnits = defineMessages<Record<DurationUnit, { value: string }>>({
  day: { id: "conversation.threadWorkedForTime.days", defaultMessage: "{value}d" },
  hour: { id: "conversation.threadWorkedForTime.hours", defaultMessage: "{value}h" },
  minute: { id: "conversation.threadWorkedForTime.minutes", defaultMessage: "{value}m" },
  second: { id: "conversation.threadWorkedForTime.seconds", defaultMessage: "{value}s" },
});

export function formatCompactDurationUnit(
  unit: keyof typeof durationUnits,
  value: number,
  intl: IntlShape = getIntl(),
): string {
  return intl.formatMessage(durationUnits[unit], {
    value: intl.formatNumber(value, { useGrouping: false }),
  });
}

export function formatWorkedForTimeLabel(
  durationMs: number,
  intl: IntlShape = getIntl(),
): string | null {
  if (!Number.isFinite(durationMs)) return null;

  const totalSeconds = Math.floor(Math.max(durationMs, 0) / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;

  const parts = [
    days > 0 ? formatCompactDurationUnit("day", days, intl) : null,
    hours > 0 ? formatCompactDurationUnit("hour", hours, intl) : null,
    minutes > 0 ? formatCompactDurationUnit("minute", minutes, intl) : null,
    seconds > 0 || totalSeconds === 0 ? formatCompactDurationUnit("second", seconds, intl) : null,
  ];
  return parts.filter(Boolean).join(" ");
}

export function resolveWorkedForElapsedMs(timing: ThreadWorkedForTiming, nowMs: number): number {
  return Math.max((timing.completedAtMs ?? nowMs) - timing.startedAtMs, 0);
}

export function resolveWorkedForLabelText(
  input: {
    timing: ThreadWorkedForTiming | null;
    durationMs: number | null;
    fallbackTimeLabel?: string | null;
    nowMs?: number;
  },
  intl: IntlShape = getIntl(),
): string | null {
  if (input.timing) {
    const elapsedMs = resolveWorkedForElapsedMs(input.timing, input.nowMs ?? Date.now());
    if (input.timing.status === "working") {
      if (elapsedMs < 1000)
        return intl.formatMessage({
          id: "conversation.threadWorkedForTime.working",
          defaultMessage: "Working",
        });
      const timeLabel = formatWorkedForTimeLabel(elapsedMs, intl);
      if (!timeLabel)
        return intl.formatMessage({
          id: "conversation.threadWorkedForTime.working",
          defaultMessage: "Working",
        });
      return intl.formatMessage(
        {
          id: "conversation.threadWorkedForTime.workingFor",
          defaultMessage: "Working for {timeLabel}",
        },
        { timeLabel },
      );
    }

    const timeLabel = formatWorkedForTimeLabel(elapsedMs, intl);
    if (!timeLabel) return null;
    return input.timing.status === "stopped"
      ? intl.formatMessage(
          {
            id: "conversation.threadWorkedForTime.stoppedFor",
            defaultMessage: "Stopped for {timeLabel}",
          },
          { timeLabel },
        )
      : intl.formatMessage(
          {
            id: "conversation.threadWorkedForTime.workedFor",
            defaultMessage: "Worked for {timeLabel}",
          },
          { timeLabel },
        );
  }

  const fallbackTimeLabel = input.fallbackTimeLabel?.trim() ?? "";
  if (fallbackTimeLabel.length > 0)
    return intl.formatMessage(
      {
        id: "conversation.threadWorkedForTime.workedFor",
        defaultMessage: "Worked for {timeLabel}",
      },
      { timeLabel: fallbackTimeLabel },
    );

  if (input.durationMs !== null) {
    const timeLabel = formatWorkedForTimeLabel(input.durationMs, intl);
    if (timeLabel)
      return intl.formatMessage(
        {
          id: "conversation.threadWorkedForTime.workedFor",
          defaultMessage: "Worked for {timeLabel}",
        },
        { timeLabel },
      );
  }

  return null;
}
