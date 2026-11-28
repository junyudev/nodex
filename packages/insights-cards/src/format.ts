import type { IntlShape } from "@formatjs/intl";

export function compactNumber<RichText>(value: number, intl: IntlShape<RichText>): string {
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

export const wholeNumber = <RichText>(value: number, intl: IntlShape<RichText>) =>
  intl.formatNumber(Math.round(value));

export function wholeDollars<RichText>(value: number, intl: IntlShape<RichText>): string {
  const dollars = intl.formatNumber(value > 0 && value < 1 ? 1 : Math.round(value), {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return value > 0 && value < 1 ? `<${dollars}` : dollars;
}

export const shortDay = <RichText>(day: string, intl: IntlShape<RichText>) =>
  intl.formatDate(new Date(`${day}T00:00:00Z`), {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
