/** Number and name formatting shared by the page and the cards. */

const trimmed = (value: number, digits: number) =>
  value
    .toFixed(digits)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");

export function compactNumber(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1e12) return `${trimmed(value / 1e12, absolute >= 1e13 ? 1 : 2)}T`;
  if (absolute >= 1e9) return `${trimmed(value / 1e9, absolute >= 1e11 ? 0 : 1)}B`;
  if (absolute >= 1e6) return `${trimmed(value / 1e6, absolute >= 1e8 ? 0 : 1)}M`;
  if (absolute >= 1e3) return `${trimmed(value / 1e3, absolute >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(value));
}

export const wholeNumber = (value: number) => Math.round(value).toLocaleString("en-US");

export const wholeDollars = (value: number) =>
  value > 0 && value < 1 ? "<$1" : `$${wholeNumber(value)}`;

/** A real share never reads as zero. */
export function shareLabel(share: number): string {
  if (share <= 0) return "0%";
  return share < 0.01 ? "<1%" : `${Math.round(share * 100)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const monthName = (day: string) => MONTHS[Number(day.slice(5, 7)) - 1] ?? "";

export const shortDay = (day: string) => `${monthName(day)} ${Number(day.slice(8, 10))}`;

/** `claude-opus-5-5` reads as `Claude Opus 5.5`; `gpt-6.1-sol` as `GPT-6.1 Sol`. */
export function modelDisplayName(model: string): string {
  const base = model
    .replace(/^[a-z0-9-]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  const words = base.split("-").map((word) => {
    if (word === "gpt") return "GPT";
    return /^[a-z]/.test(word) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
  });
  return words
    .join(" ")
    .replace(/^GPT /, "GPT-")
    .replace(/(\d) (\d)/g, "$1.$2");
}

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
