import { getIntl } from "@/lib/i18n";

function normalizePreviewText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^\s*(?:>\s*|#{1,6}\s+|(?:[-*+]|\d+\.)\s+)*/u, "")
    .trim();
}

export function formatSubagentObjective(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizePreviewText(value);
  if (!normalized) return null;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 59).trimEnd()}…`;
}

export function formatSubagentElapsedTime(elapsedMs: number, intl = getIntl()): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (elapsedSeconds < 60)
    return intl.formatMessage(
      { id: "conversation.subagentsPanel.seconds", defaultMessage: "{count}s" },
      { count: intl.formatNumber(elapsedSeconds) },
    );
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60)
    return intl.formatMessage(
      { id: "conversation.subagentsPanel.minutes", defaultMessage: "{count}m" },
      { count: intl.formatNumber(elapsedMinutes) },
    );
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24)
    return intl.formatMessage(
      { id: "conversation.subagentsPanel.hours", defaultMessage: "{count}h" },
      { count: intl.formatNumber(elapsedHours) },
    );
  return intl.formatMessage(
    { id: "conversation.subagentsPanel.days", defaultMessage: "{count}d" },
    { count: intl.formatNumber(Math.floor(elapsedHours / 24)) },
  );
}

export function formatSubagentRelativeTime(
  timestampMs: number,
  nowMs = Date.now(),
  intl = getIntl(),
): string {
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < 60_000)
    return intl.formatMessage({ id: "conversation.subagentsPanel.now", defaultMessage: "now" });
  if (elapsedMs < 3_600_000)
    return intl.formatMessage(
      { id: "conversation.subagentsPanel.minutes", defaultMessage: "{count}m" },
      { count: intl.formatNumber(Math.floor(elapsedMs / 60_000)) },
    );
  if (elapsedMs < 86_400_000)
    return intl.formatMessage(
      { id: "conversation.subagentsPanel.hours", defaultMessage: "{count}h" },
      { count: intl.formatNumber(Math.floor(elapsedMs / 3_600_000)) },
    );
  return intl.formatMessage(
    { id: "conversation.subagentsPanel.days", defaultMessage: "{count}d" },
    { count: intl.formatNumber(Math.floor(elapsedMs / 86_400_000)) },
  );
}
