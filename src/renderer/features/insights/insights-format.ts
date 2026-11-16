import { getIntl, type IntlShape } from "@/lib/i18n";
/** Number and name formatting shared by the page and the cards. */

export function compactNumber(value: number, intl = getIntl()): string {
  if (intl.locale !== "en-US") {
    return intl.formatNumber(value, { notation: "compact", maximumFractionDigits: 1 });
  }
  const trimmed = (scaled: number, digits: number) =>
    intl.formatNumber(scaled, { maximumFractionDigits: digits, useGrouping: false });
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${trimmed(value / 1e12, absolute >= 1e13 ? 1 : 2)}T`;
  if (absolute >= 1e9) return `${trimmed(value / 1e9, absolute >= 1e11 ? 0 : 1)}B`;
  if (absolute >= 1e6) return `${trimmed(value / 1e6, absolute >= 1e8 ? 0 : 1)}M`;
  if (absolute >= 1e3) return `${trimmed(value / 1e3, absolute >= 1e5 ? 0 : 1)}K`;
  return intl.formatNumber(Math.round(value), { useGrouping: false });
}

export const wholeNumber = (value: number, intl = getIntl()) =>
  intl.formatNumber(Math.round(value));

export function wholeDollars(value: number, intl = getIntl()): string {
  const dollars = intl.formatNumber(value > 0 && value < 1 ? 1 : Math.round(value), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return value > 0 && value < 1 ? `<${dollars}` : dollars;
}

/** A real share never reads as zero. */
export function shareLabel(share: number, intl = getIntl()): string {
  if (share > 0 && share < 0.01) {
    return `<${intl.formatNumber(0.01, { style: "percent" })}`;
  }
  return intl.formatNumber(Math.max(0, share), { style: "percent" });
}

export const monthName = (day: string, intl = getIntl()) =>
  intl.formatDate(new Date(`${day}T00:00:00Z`), { month: "short", timeZone: "UTC" });

export const shortDay = (day: string, intl = getIntl()) =>
  intl.formatDate(new Date(`${day}T00:00:00Z`), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });

export const insightHour = (hour: number, intl: IntlShape = getIntl()) =>
  intl.formatTime(hour * 3_600_000, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  });

export type ModelFamily = "claude" | "gpt" | "other";

export const modelFamily = (model: string): ModelFamily => {
  const base = model.replace(/^[a-z0-9-]+\//, "");
  if (base.startsWith("claude")) return "claude";
  return base.startsWith("gpt") || base.includes("codex") || /^o\d/.test(base) ? "gpt" : "other";
};

/** A calendar shade. Square-rooted so one enormous day does not flatten everything around it. */
export function heatStep(value: number, max: number, steps: number): number {
  if (value <= 0 || max <= 0) return -1;
  return Math.min(steps - 1, Math.floor(Math.sqrt(value / max) * steps));
}

/** The top of a chart: a round number at or above the largest value. */
export function axisMaximum(max: number): number {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const normalized = max / magnitude;
  const nice = [1, 2, 2.5, 5, 10].find((step) => normalized <= step) ?? 10;
  return nice * magnitude;
}
