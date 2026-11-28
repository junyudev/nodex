import type { IntlShape } from "@formatjs/intl";
import {
  agentArchetype,
  compactNumber,
  receiptCost,
  shareModelRows,
  sharePeriodLabel,
  shareStats,
  shortDay,
  sourceLines,
  tokenClub,
  wholeDollars,
  type ShareCardView,
} from "@nodex/insights-cards";

/**
 * What the terminal shows before the preview opens: the cards' own numbers and words, laid out
 * to read at a glance and to screenshot, in at most `width` columns.
 */

export interface SummaryStyle {
  readonly showCost: boolean;
  /** ANSI styling, for a terminal that wants it. */
  readonly color: boolean;
  readonly width: number;
}

const INDENT = "  ";
const BARS = "▁▂▃▄▅▆▇█";

const paint = (enabled: boolean) => (code: string, text: string) =>
  enabled && text !== "" ? `\u001b[${code}m${text}\u001b[0m` : text;

const WIDE =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** Columns a string takes in a terminal: wide East Asian characters take two. */
export function columns(text: string): number {
  let width = 0;
  for (const character of text.replace(/\u001b\[[0-9;]*m/g, "")) {
    width += WIDE.test(character) || (character.codePointAt(0) ?? 0) >= 0x20000 ? 2 : 1;
  }
  return width;
}

const padEnd = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - columns(text)));
const padStart = (text: string, width: number) =>
  " ".repeat(Math.max(0, width - columns(text))) + text;

function truncate(text: string, width: number): string {
  if (columns(text) <= width) return text;
  let kept = "";
  for (const character of text) {
    if (columns(kept + character) > width - 1) break;
    kept += character;
  }
  return `${kept}…`;
}

/** Activity over the span as one line of bars, a day or a week each, as many as fit. */
export function activityLine(
  view: ShareCardView,
  maxBars: number,
): { readonly bars: string; readonly firstDay: string } {
  const firstActive = view.days.findIndex((day) => day.tokens > 0);
  const days = firstActive < 0 ? view.days : view.days.slice(firstActive);
  const step = days.length <= maxBars ? 1 : 7 * Math.ceil(days.length / 7 / maxBars);
  const buckets: number[] = [];
  for (let index = 0; index < days.length; index += step) {
    buckets.push(days.slice(index, index + step).reduce((sum, day) => sum + day.tokens, 0));
  }
  const max = Math.max(0, ...buckets);
  // Square-rooted like the cards, so one enormous day does not flatten the rest.
  const bars = buckets
    .map((value) =>
      value <= 0 || max <= 0
        ? " "
        : BARS[Math.min(BARS.length - 1, Math.floor(Math.sqrt(value / max) * BARS.length))]!,
    )
    .join("");
  return { bars, firstDay: days[0]?.day ?? view.firstDay };
}

export function terminalSummary<RichText>(
  view: ShareCardView,
  intl: IntlShape<RichText>,
  style: SummaryStyle,
): string {
  const ansi = paint(style.color);
  const bold = (text: string) => ansi("1", text);
  const dim = (text: string) => ansi("2", text);
  const accent = (text: string) => ansi("38;5;111", text);
  const inner = Math.max(40, style.width - INDENT.length * 2);
  const lines: string[] = [];
  const blank = () => lines.push("");

  blank();
  lines.push(`${bold("Nodex Insights")} ${dim("·")} ${sharePeriodLabel(view, intl)}`);
  blank();

  const cost =
    style.showCost && view.costUsd > 0
      ? intl.formatMessage(
          {
            id: "insights.insightsCards.apiPriceSuffix",
            defaultMessage: " · ≈ {cost} at API list price",
          },
          { cost: wholeDollars(view.costUsd, intl) },
        )
      : "";
  lines.push(bold(compactNumber(view.tokens, intl)));
  lines.push(
    dim(
      intl.formatMessage({
        id: "insights.insightsCards.processedTokens",
        defaultMessage: "tokens processed",
      }) + cost,
    ),
  );
  blank();

  const activity = activityLine(view, inner);
  lines.push(accent(activity.bars));
  const from = shortDay(activity.firstDay, intl);
  const to = shortDay(view.lastDay, intl);
  lines.push(
    dim(from + padStart(to, Math.max(columns(activity.bars) - columns(from), columns(to) + 1))),
  );
  blank();

  const stats = shareStats(view, intl).map((stat) => `${bold(stat.value)} ${dim(stat.label)}`);
  if (stats.length > 0) lines.push(stats.join(dim(" · ")));
  const club = tokenClub(view.tokens, intl);
  lines.push(
    [club === null ? null : accent(club), agentArchetype(view, intl)]
      .filter((part) => part !== null)
      .join(dim(" · ")),
  );
  blank();

  // Columns fit what they hold, so no figure ever runs into the next.
  const showCost = style.showCost && view.costUsd > 0;
  const rows = shareModelRows(view, intl).map((row) => ({
    label: row.label,
    tokens: compactNumber(row.tokens, intl),
    cost: showCost ? receiptCost(row.costUsd, intl) : "",
  }));
  const tokenWidth = Math.max(0, ...rows.map((row) => columns(row.tokens))) + 3;
  const costWidth = showCost ? Math.max(0, ...rows.map((row) => columns(row.cost))) + 3 : 0;
  const labelWidth = Math.min(32, inner - tokenWidth - costWidth);
  for (const row of rows) {
    lines.push(
      padEnd(truncate(row.label, labelWidth), labelWidth) +
        dim(padStart(row.tokens, tokenWidth)) +
        padStart(row.cost, costWidth),
    );
  }

  const sources = view.sources ?? [];
  if (sources.length > 0) {
    blank();
    const lead = intl.formatMessage(
      { id: "insights.insightsCards.skylineAgents", defaultMessage: "Across {names}" },
      { names: "" },
    );
    const hang = " ".repeat(columns(lead));
    sourceLines(sources, inner - columns(lead), 3).forEach((names, index) =>
      lines.push(dim(index === 0 ? lead : hang) + names),
    );
  }
  blank();
  return lines.map((line) => (line === "" ? "" : INDENT + line)).join("\n");
}
