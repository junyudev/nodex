export type ThreadWorkedForStatus = "working" | "worked" | "stopped";

export interface ThreadWorkedForTiming {
  status: ThreadWorkedForStatus;
  startedAtMs: number;
  completedAtMs: number | null;
}

export function formatWorkedForTimeLabel(durationMs: number): string | null {
  if (!Number.isFinite(durationMs)) return null;

  const totalSeconds = Math.floor(Math.max(durationMs, 0) / 1000);
  if (totalSeconds < 1) return "0s";
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const days = Math.floor(totalSeconds / 86_400);
  const hoursPart = Math.floor(totalSeconds / 3600) % 24;
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0 || hoursPart > 0) {
    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hoursPart > 0) parts.push(`${hoursPart}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (seconds > 0) parts.push(`${seconds}s`);
    return parts.join(" ");
  }

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

export function resolveWorkedForElapsedMs(timing: ThreadWorkedForTiming, nowMs: number): number {
  return Math.max((timing.completedAtMs ?? nowMs) - timing.startedAtMs, 0);
}

export function resolveWorkedForLabelText(input: {
  timing: ThreadWorkedForTiming | null;
  durationMs: number | null;
  fallbackTimeLabel?: string | null;
  nowMs?: number;
}): string | null {
  if (input.timing) {
    const elapsedMs = resolveWorkedForElapsedMs(input.timing, input.nowMs ?? Date.now());
    if (input.timing.status === "working") {
      if (elapsedMs < 1000) return "Working";
      const timeLabel = formatWorkedForTimeLabel(elapsedMs);
      if (!timeLabel) return "Working";
      return `Working for ${timeLabel}`;
    }

    const timeLabel = formatWorkedForTimeLabel(elapsedMs);
    if (!timeLabel) return null;
    return `${input.timing.status === "stopped" ? "Stopped" : "Worked"} for ${timeLabel}`;
  }

  const fallbackTimeLabel = input.fallbackTimeLabel?.trim() ?? "";
  if (fallbackTimeLabel.length > 0) return `Worked for ${fallbackTimeLabel}`;

  if (input.durationMs !== null) {
    const timeLabel = formatWorkedForTimeLabel(input.durationMs);
    if (timeLabel) return `Worked for ${timeLabel}`;
  }

  return null;
}
