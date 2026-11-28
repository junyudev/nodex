import type { IntlShape, MessageDescriptor } from "@formatjs/intl";
import { encode } from "uqr";

import { compactNumber, shortDay, wholeDollars, wholeNumber } from "./format";
import { agentArchetype, tokenClub } from "./card-profile";
import { defineMessage } from "./messages";
import type { ShareCardPeriod, ShareCardView } from "./view";

/** A share card is a pure function of its numbers, so preview and export are the same picture. */

export type ShareCardKind = "skyline" | "receipt";

export const SHARE_CARD_WIDTH = 1080;
export const SHARE_CARD_HEIGHT = 1350;
export const SHARE_URL = "nodex.jyu.app";
/** What someone who sees a card types to make their own, without installing anything. */
export const SHARE_COMMAND = "npx nodex-card";

const WIDE_CHARACTER =
  /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u;

/** East Asian characters take a full em in a CJK font and two columns in a terminal. */
export const isWideCharacter = (character: string) =>
  WIDE_CHARACTER.test(character) || (character.codePointAt(0) ?? 0) >= 0x20000;

/**
 * Geist Sans advances for printable ASCII in thousandths of an em, measured from
 * `fonts/geist-sans.woff2`; kerning makes a real run about one percent narrower. Geist Mono and
 * its fallbacks advance every character by six tenths of an em.
 */
const SANS_ADVANCES = [
  250, 213, 346, 478, 629, 802, 620, 178, 274, 274, 430, 558, 201, 419, 201, 480, 663, 384, 619,
  613, 615, 626, 593, 524, 604, 593, 297, 297, 544, 540, 544, 559, 906, 668, 680, 703, 694, 603,
  590, 700, 713, 270, 597, 640, 580, 877, 743, 739, 650, 733, 672, 640, 552, 689, 667, 945, 606,
  576, 544, 347, 455, 347, 426, 557, 248, 551, 595, 546, 595, 561, 395, 594, 581, 244, 260, 590,
  267, 877, 581, 573, 595, 595, 379, 520, 392, 575, 536, 819, 585, 537, 537, 389, 264, 389, 523,
] as const;
const MONO_ADVANCE = 600;

/** How wide card text draws, so a chip can sit inside a sentence. */
function textWidth(text: string, size: number, family: "sans" | "mono"): number {
  let units = 0;
  for (const character of text) {
    if (isWideCharacter(character)) units += 1000;
    else if (family === "mono") units += MONO_ADVANCE;
    else units += SANS_ADVANCES[(character.codePointAt(0) ?? 0) - 32] ?? MONO_ADVANCE;
  }
  return (units * size) / 1000;
}

/** The command set as code: a quiet chip a viewer reads as something to type. */
function commandChip(
  x: number,
  baseline: number,
  size: number,
  colors: { readonly chip: string; readonly ink: string },
) {
  const padding = size * 0.5;
  const width = (SHARE_COMMAND.length * size * MONO_ADVANCE) / 1000 + padding * 2;
  return {
    markup: `<rect x="${x.toFixed(1)}" y="${(baseline - size * 1.08).toFixed(1)}" width="${width.toFixed(1)}" height="${(size * 1.55).toFixed(1)}" rx="${(size * 0.36).toFixed(1)}" fill="${colors.chip}"/><text x="${(x + padding).toFixed(1)}" y="${baseline}" font-family="${MONO}" font-size="${size}" font-weight="500" fill="${colors.ink}">${SHARE_COMMAND}</text>`,
    end: x + width,
  };
}

const COMMAND_SLOT = "\u0001";
const URL_SLOT = "\u0002";

/**
 * A line telling a viewer how to make their own card: the command set as code and the address in
 * ink, inside a sentence formatted with COMMAND_SLOT and URL_SLOT. Words before the command are
 * measured so its chip lands in place; everything after flows from the chip's end.
 */
function invitation(
  sentence: string,
  at: {
    readonly x: number;
    readonly baseline: number;
    readonly size: number;
    readonly family: "sans" | "mono";
  },
  colors: { readonly chip: string; readonly words: string; readonly ink: string },
): string {
  const parts = sentence.split(/(\u0001|\u0002)/u).filter((part) => part !== "");
  const line = (x: number, runs: readonly string[]) =>
    runs.length === 0
      ? ""
      : `<text x="${x.toFixed(1)}" y="${at.baseline}" font-family="${at.family === "sans" ? SANS : MONO}" font-size="${at.size}" fill="${colors.words}" xml:space="preserve">${runs
          .map((run) =>
            run === URL_SLOT
              ? `<tspan font-family="${MONO}" fill="${colors.ink}">${SHARE_URL}</tspan>`
              : escapeXml(run),
          )
          .join("")}</text>`;
  const commandAt = parts.indexOf(COMMAND_SLOT);
  if (commandAt < 0) return line(at.x, parts);
  const before = parts.slice(0, commandAt);
  const chipX =
    at.x +
    before.reduce(
      (width, run) =>
        width +
        (run === URL_SLOT
          ? textWidth(SHARE_URL, at.size, "mono")
          : textWidth(run, at.size, at.family)),
      0,
    );
  const chip = commandChip(chipX, at.baseline, at.size, colors);
  return line(at.x, before) + chip.markup + line(chip.end, parts.slice(commandAt + 1));
}

const INVITATION: MessageDescriptor = defineMessage({
  id: "insights.insightsCards.invitation",
  defaultMessage: "Run {command} in a terminal, or visit {url}",
});

export type ShareCardTheme = "dark" | "light";

export interface ShareCardOptions {
  readonly kind: ShareCardKind;
  readonly showCost: boolean;
  /** How the person wants to be named; nothing identifies them unless they type it. */
  readonly name: string;
  /** Dark unless asked. */
  readonly theme?: ShareCardTheme;
}

export interface ShareCardFonts {
  readonly sans: string;
  readonly mono: string;
}

const SANS = "NodexCardSans, -apple-system, 'Helvetica Neue', Arial, sans-serif";
const MONO = "NodexCardMono, ui-monospace, Menlo, Consolas, monospace";

const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const fontStyle = (fonts: ShareCardFonts | null) =>
  fonts === null
    ? ""
    : `<style>
@font-face{font-family:NodexCardSans;font-weight:100 900;src:url(${fonts.sans}) format("woff2")}
@font-face{font-family:NodexCardMono;font-weight:100 900;src:url(${fonts.mono}) format("woff2")}
</style>`;

const PERIOD_LABELS: Readonly<
  Record<Exclude<ShareCardPeriod, "year" | "range">, MessageDescriptor>
> = {
  "7d": defineMessage({ id: "insights.insightsCards.periodWeek", defaultMessage: "Past 7 days" }),
  "30d": defineMessage({
    id: "insights.insightsCards.periodMonth",
    defaultMessage: "Past 30 days",
  }),
  "90d": defineMessage({
    id: "insights.insightsCards.periodQuarter",
    defaultMessage: "Past 90 days",
  }),
  "12m": defineMessage({
    id: "insights.insightsCards.periodYear",
    defaultMessage: "Past 12 months",
  }),
  all: defineMessage({ id: "insights.insightsCards.periodAll", defaultMessage: "All time" }),
};

export function sharePeriodLabel<RichText>(view: ShareCardView, intl: IntlShape<RichText>): string {
  if (view.period === "year") return view.lastDay.slice(0, 4);
  if (view.period === "range") {
    return intl.formatDateTimeRange(
      Date.parse(`${view.firstDay}T00:00:00Z`),
      Date.parse(`${view.lastDay}T00:00:00Z`),
      { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" },
    );
  }
  return intl.formatMessage(PERIOD_LABELS[view.period]);
}

const PERIOD_QUESTIONS: Readonly<Record<Exclude<ShareCardPeriod, "range">, MessageDescriptor>> = {
  "7d": defineMessage({
    id: "insights.insightsCards.weekQuestion",
    defaultMessage: "What does your week look like?",
  }),
  "30d": defineMessage({
    id: "insights.insightsCards.monthQuestion",
    defaultMessage: "What does your month look like?",
  }),
  "90d": defineMessage({
    id: "insights.insightsCards.quarterQuestion",
    defaultMessage: "What does your quarter look like?",
  }),
  "12m": defineMessage({
    id: "insights.insightsCards.yearQuestion",
    defaultMessage: "What does your year look like?",
  }),
  year: defineMessage({
    id: "insights.insightsCards.calendarYearQuestion",
    defaultMessage: "What does your {year} look like?",
  }),
  all: defineMessage({
    id: "insights.insightsCards.allTimeQuestion",
    defaultMessage: "What does yours look like?",
  }),
};

/** The Nodex mark, drawn from the same geometry as the application icon. */
export function nodexMark(x: number, y: number, size: number, ink: string, paper: string) {
  const scale = size / 800;
  return `<g transform="translate(${x} ${y}) scale(${scale})">
<path fill-rule="evenodd" clip-rule="evenodd" d="M142.9 730.445L56.916 623.328C36.2282 597.558 25 565.865 25 533.248V145.375C25 96.5161 64.0898 55.9743 114.518 52.5313L513.303 25.3046C542.275 23.3266 571.07 31.0273 594.87 47.1176L734.98 141.848C760.063 158.805 775 186.525 775 216.107V657.08C775 704.895 736.565 744.483 687.19 747.523L244.583 774.768C205.183 777.193 167.1 760.593 142.9 730.445Z" fill="${ink}"/>
<path d="M305 352L411 438.203L305 535" stroke="${paper}" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
<path d="M458.035 565.638L579.966 558.361" stroke="${paper}" stroke-width="50" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</g>`;
}

function qrCode(x: number, y: number, size: number, ink: string): string {
  const { data, size: modules } = encode(`https://${SHARE_URL}`, { border: 0 });
  const unit = size / modules;
  let path = "";
  data.forEach((row, rowIndex) =>
    row.forEach((filled, columnIndex) => {
      if (filled) {
        path += `M${(x + columnIndex * unit).toFixed(2)} ${(y + rowIndex * unit).toFixed(2)}h${unit.toFixed(2)}v${unit.toFixed(2)}h-${unit.toFixed(2)}z`;
      }
    }),
  );
  return `<path d="${path}" fill="${ink}"/>`;
}

export interface SkylineGrid {
  readonly columns: number;
  readonly rows: number;
  /** Cells in draw-independent order; `value` is tokens. */
  readonly cells: readonly {
    readonly column: number;
    readonly row: number;
    readonly value: number;
    readonly label: string;
  }[];
}

/** A week reads best by the hour; longer periods read as a calendar of days. */
export function skylineGrid<RichText>(view: ShareCardView, intl: IntlShape<RichText>): SkylineGrid {
  if (view.period === "7d") {
    return {
      columns: 24,
      rows: 7,
      cells: view.recentHours.flatMap(({ day, hours }, row) =>
        hours.map((value, column) => ({
          column,
          row,
          value,
          label: `${shortDay(day, intl)} ${String(column).padStart(2, "0")}:00`,
        })),
      ),
    };
  }
  // A long run of empty weeks before the first activity would only flatten the city.
  const firstActive = view.calendar.weeks.findIndex((week) =>
    week.some((cell) => cell !== null && cell.tokens > 0),
  );
  const weeks = firstActive <= 0 ? view.calendar.weeks : view.calendar.weeks.slice(firstActive);
  return {
    columns: weeks.length,
    rows: 7,
    cells: weeks.flatMap((week, column) =>
      week.flatMap((cell, row) =>
        cell === null ? [] : [{ column, row, value: cell.tokens, label: shortDay(cell.day, intl) }],
      ),
    ),
  };
}

type Ramp = readonly [string, string, string, string, string];

interface SkylinePalette {
  readonly paper: string;
  readonly glow: { readonly color: string; readonly opacity: string };
  readonly ember: { readonly color: string; readonly opacity: string };
  readonly ink: string;
  readonly muted: string;
  readonly faint: string;
  readonly accent: string;
  readonly mark: { readonly ink: string; readonly paper: string };
  /** Tower faces from the quietest day to the busiest: lit tops, fronts and shaded sides. */
  readonly tops: Ramp;
  readonly fronts: Ramp;
  readonly sides: Ramp;
  readonly empty: string;
  readonly qr: { readonly plate: string; readonly edge: string | null; readonly ink: string };
  readonly chip: string;
}

const SKYLINE_PALETTES: Readonly<Record<ShareCardTheme, SkylinePalette>> = {
  // Busier days glow brighter against the night.
  dark: {
    paper: "#08080a",
    glow: { color: "#3b4cb0", opacity: ".34" },
    ember: { color: "#d95926", opacity: ".14" },
    ink: "#f5f5f4",
    muted: "#a8a8ae",
    faint: "#6f6f78",
    accent: "#b6c6ff",
    mark: { ink: "#ffffff", paper: "#262626" },
    tops: ["#27366f", "#34479c", "#4663cf", "#6f8bf2", "#b6c6ff"],
    fronts: ["#1c274f", "#26336f", "#3247a0", "#4a63c9", "#7e94ea"],
    sides: ["#161e3e", "#1c2654", "#253478", "#364a98", "#5c6fb4"],
    empty: "#191920",
    qr: { plate: "#ffffff", edge: null, ink: "#08080a" },
    chip: "#ffffff1a",
  },
  // On paper, busier days are inked deeper.
  light: {
    paper: "#f4f3ee",
    glow: { color: "#6b84f0", opacity: ".2" },
    ember: { color: "#f08a4b", opacity: ".14" },
    ink: "#131316",
    muted: "#5b5b63",
    faint: "#7a7a83",
    accent: "#3a52c4",
    mark: { ink: "#131316", paper: "#f4f3ee" },
    tops: ["#dfe5fb", "#b9c6f6", "#8ea2ef", "#6f88e8", "#5770dc"],
    fronts: ["#ccd5f5", "#a3b3ef", "#7489e3", "#4d68d6", "#3550bd"],
    sides: ["#bcc6ec", "#8f9fe0", "#5f74d1", "#3c55c0", "#2a40a0"],
    empty: "#e7e6e0",
    qr: { plate: "#ffffff", edge: "#e2e0d8", ink: "#131316" },
    chip: "#13131612",
  },
};

const skylineStep = (value: number, max: number) =>
  value <= 0 || max <= 0 ? -1 : Math.min(4, Math.floor(Math.sqrt(value / max) * 5));

/** Axonometric towers scaled to fit any period, from a week of hours to years of days. */
export function renderSkylineCity<RichText>(
  grid: SkylineGrid,
  area: { width: number; height: number },
  intl: IntlShape<RichText>,
  palette: SkylinePalette = SKYLINE_PALETTES.dark,
) {
  const unitLimit = 62;
  const unit = Math.min(unitLimit, area.width / (grid.columns + 0.62 * grid.rows));
  const across = { x: unit, y: unit * 0.2 };
  const down = { x: -unit * 0.62, y: unit * 0.36 };
  const footprintWidth = grid.columns * across.x + grid.rows * -down.x;
  const footprintHeight = grid.columns * across.y + grid.rows * down.y;
  const towerHeight = Math.max(area.height - footprintHeight - 40, 80);
  const originX = (area.width - footprintWidth) / 2 + grid.rows * -down.x;
  const originY = towerHeight + 34;
  const max = grid.cells.reduce((largest, cell) => Math.max(largest, cell.value), 0);

  const point = (column: number, row: number, height: number) =>
    [
      originX + column * across.x + row * down.x,
      originY + column * across.y + row * down.y - height,
    ] as const;
  const polygon = (points: readonly (readonly [number, number])[], fill: string) =>
    `<polygon points="${points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}" fill="${fill}"/>`;

  const inset = 0.08;
  const ordered = [...grid.cells].sort(
    (a, b) => a.column * across.y + a.row * down.y - (b.column * across.y + b.row * down.y),
  );
  let city = "";
  let peak: { x: number; y: number; label: string; value: number } | null = null;
  for (const cell of ordered) {
    const height = cell.value <= 0 ? 0 : Math.max(4, Math.sqrt(cell.value / max) * towerHeight);
    const step = skylineStep(cell.value, max);
    const top = step < 0 ? palette.empty : palette.tops[step]!;
    const left = cell.column + inset;
    const right = cell.column + 1 - inset;
    const back = cell.row + inset;
    const front = cell.row + 1 - inset;
    if (height > 0) {
      city += polygon(
        [
          point(left, front, height),
          point(right, front, height),
          point(right, front, 0),
          point(left, front, 0),
        ],
        palette.fronts[step]!,
      );
      city += polygon(
        [
          point(right, back, height),
          point(right, front, height),
          point(right, front, 0),
          point(right, back, 0),
        ],
        palette.sides[step]!,
      );
    }
    city += polygon(
      [
        point(left, back, height),
        point(right, back, height),
        point(right, front, height),
        point(left, front, height),
      ],
      top,
    );
    if (cell.value === max && max > 0 && peak === null) {
      const [x, y] = point(cell.column + 0.5, cell.row + 0.5, height);
      peak = { x, y, label: cell.label, value: cell.value };
    }
  }
  let annotation = "";
  if (peak !== null) {
    const end = peak.x > area.width * 0.72;
    annotation = `<line x1="${peak.x.toFixed(1)}" y1="${(peak.y - 3).toFixed(1)}" x2="${peak.x.toFixed(1)}" y2="${(peak.y - 26).toFixed(1)}" stroke="${palette.muted}"/>
<text x="${peak.x.toFixed(1)}" y="${(peak.y - 34).toFixed(1)}" fill="${palette.ink}" font-family="${SANS}" font-size="19" font-weight="600" paint-order="stroke" stroke="${palette.paper}" stroke-width="6" stroke-linejoin="round" text-anchor="${end ? "end" : "middle"}">${escapeXml(intl.formatMessage({ id: "insights.insightsCards.peakAnnotation", defaultMessage: "{tokens} on {day}" }, { tokens: compactNumber(peak.value, intl), day: peak.label }))}</text>`;
  }
  return `${city}${annotation}`;
}

export interface ShareStat {
  readonly value: string;
  readonly label: string;
}

/** The four strongest things a card can say; a zero is never worth showing off. */
export function shareStats<RichText>(
  view: ShareCardView,
  intl: IntlShape<RichText>,
): readonly ShareStat[] {
  const stat = (value: number, label: string) => [value, wholeNumber(value, intl), label] as const;
  const candidates = [
    // One agent at a time is what everyone does; it only says something from two up.
    view.peakAgents >= 2
      ? stat(
          view.peakAgents,
          intl.formatMessage(
            {
              id: "insights.insightsCards.concurrentAgents",
              defaultMessage: "{count, plural, one {agent at once} other {agents at once}}",
            },
            { count: view.peakAgents },
          ),
        )
      : null,
    stat(
      view.tasksDone,
      intl.formatMessage(
        {
          id: "insights.insightsCards.tasksDone",
          defaultMessage: "{count, plural, one {task done} other {tasks done}}",
        },
        { count: view.tasksDone },
      ),
    ),
    stat(
      view.messages,
      intl.formatMessage(
        {
          id: "insights.insightsCards.messagesSent",
          defaultMessage: "{count, plural, one {message sent} other {messages sent}}",
        },
        { count: view.messages },
      ),
    ),
    stat(
      view.longestStreak,
      intl.formatMessage({ id: "insights.insightsCards.streak", defaultMessage: "day streak" }),
    ),
    stat(
      view.conversations,
      intl.formatMessage(
        {
          id: "insights.insightsCards.conversations",
          defaultMessage: "{count, plural, one {conversation} other {conversations}}",
        },
        { count: view.conversations },
      ),
    ),
    stat(
      view.pagesCreated,
      intl.formatMessage(
        {
          id: "insights.insightsCards.pagesWritten",
          defaultMessage: "{count, plural, one {page written} other {pages written}}",
        },
        { count: view.pagesCreated },
      ),
    ),
    view.activeDays === view.longestStreak
      ? null
      : stat(
          view.activeDays,
          intl.formatMessage(
            {
              id: "insights.insightsCards.activeDays",
              defaultMessage: "{count, plural, one {active day} other {active days}}",
            },
            { count: view.activeDays },
          ),
        ),
    stat(
      view.models.length,
      intl.formatMessage(
        {
          id: "insights.insightsCards.modelCount",
          defaultMessage: "{count, plural, one {model used} other {models used}}",
        },
        { count: view.models.length },
      ),
    ),
  ].filter((candidate) => candidate !== null);
  return candidates
    .filter(([value]) => value > 0)
    .slice(0, 4)
    .map(([, value, label]) => ({ value, label }));
}

const wrapNames = (names: readonly string[], limit: number) =>
  names.reduce<string[]>((lines, name) => {
    const last = lines.at(-1);
    if (last !== undefined && `${last} · ${name}`.length <= limit) {
      lines[lines.length - 1] = `${last} · ${name}`;
    } else {
      lines.push(name);
    }
    return lines;
  }, []);

/** The agents a card counted, in as many lines as it has room for; any left over are counted. */
export function sourceLines(
  names: readonly string[],
  limit: number,
  maxLines: number,
): readonly string[] {
  for (let shown = names.length; shown > 1; shown -= 1) {
    const lines = wrapNames(names.slice(0, shown), limit);
    const rest = names.length - shown;
    if (rest > 0) lines[lines.length - 1] += ` +${rest}`;
    if (lines.length <= maxLines && lines.every((line) => line.length <= limit)) return lines;
  }
  return names.length === 0
    ? []
    : [names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]!];
}

function renderSkyline<RichText>(
  view: ShareCardView,
  options: ShareCardOptions,
  intl: IntlShape<RichText>,
  fonts: ShareCardFonts | null,
) {
  const cost =
    options.showCost && view.costUsd > 0
      ? intl.formatMessage(
          {
            id: "insights.insightsCards.apiPriceSuffix",
            defaultMessage: " · ≈ {cost} at API list price",
          },
          { cost: wholeDollars(view.costUsd, intl) },
        )
      : "";
  const club = tokenClub(view.tokens, intl);
  const name = options.name.trim();
  const stats = shareStats(view, intl);
  const palette = SKYLINE_PALETTES[options.theme ?? "dark"];
  const city = renderSkylineCity(
    skylineGrid(view, intl),
    { width: 1020, height: 640 },
    intl,
    palette,
  );
  const sources = sourceLines(view.sources ?? [], 64, 1).map((names) =>
    intl.formatMessage(
      { id: "insights.insightsCards.skylineAgents", defaultMessage: "Across {names}" },
      { names },
    ),
  );
  const periodLabel = sharePeriodLabel(view, intl);
  const question = intl.formatMessage(
    PERIOD_QUESTIONS[view.period === "range" ? "all" : view.period],
    view.period === "year" ? { year: periodLabel } : undefined,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">
<defs>${fontStyle(fonts)}
<radialGradient id="glow" cx="12%" cy="0%" r="75%"><stop offset="0%" stop-color="${palette.glow.color}" stop-opacity="${palette.glow.opacity}"/><stop offset="100%" stop-color="${palette.glow.color}" stop-opacity="0"/></radialGradient>
<radialGradient id="ember" cx="95%" cy="100%" r="55%"><stop offset="0%" stop-color="${palette.ember.color}" stop-opacity="${palette.ember.opacity}"/><stop offset="100%" stop-color="${palette.ember.color}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="100%" height="100%" fill="${palette.paper}"/><rect width="100%" height="100%" fill="url(#glow)"/><rect width="100%" height="100%" fill="url(#ember)"/>
${nodexMark(64, 56, 40, palette.mark.ink, palette.mark.paper)}
<text x="114" y="85" font-family="${SANS}" font-size="27" font-weight="600" fill="${palette.ink}">Nodex${name ? `<tspan fill="${palette.faint}" font-weight="400"> · ${escapeXml(name)}</tspan>` : ""}</text>
<text x="1016" y="85" text-anchor="end" font-family="${SANS}" font-size="24" fill="${palette.muted}">${escapeXml(periodLabel)}</text>
<text x="60" y="262" font-family="${SANS}" font-size="168" font-weight="600" letter-spacing="-8" fill="${palette.ink}">${compactNumber(view.tokens, intl)}</text>
<text x="64" y="316" font-family="${SANS}" font-size="27" fill="${palette.muted}">${escapeXml(intl.formatMessage({ id: "insights.insightsCards.processedTokens", defaultMessage: "tokens processed" }) + cost)}</text>
${club === null ? "" : `<text x="1016" y="316" text-anchor="end" font-family="${MONO}" font-size="21" font-weight="600" letter-spacing="1.5" fill="${palette.accent}">${escapeXml(club.toUpperCase())}</text>`}
<text x="1016" y="262" text-anchor="end" font-family="${SANS}" font-size="30" font-weight="600" fill="${palette.ink}">${escapeXml(agentArchetype(view, intl))}</text>
<g transform="translate(30 340)">${city}</g>
${stats
  .map((stat, index) => {
    const x = 64 + index * 244;
    return `<text x="${x}" y="1072" font-family="${SANS}" font-size="56" font-weight="600" letter-spacing="-1.5" fill="${palette.ink}">${stat.value}</text>
<text x="${x}" y="1110" font-family="${SANS}" font-size="21" fill="${palette.faint}">${escapeXml(stat.label)}</text>`;
  })
  .join("\n")}
${sources
  .map(
    (
      line,
    ) => `<text x="64" y="1160" font-family="${SANS}" font-size="21" fill="${palette.faint}">${escapeXml(line)}</text>
`,
  )
  .join(
    "",
  )}<text x="64" y="1234" font-family="${SANS}" font-size="33" font-weight="600" letter-spacing="-.5" fill="${palette.ink}">${escapeXml(question)}</text>
${invitation(
  intl.formatMessage(INVITATION, { command: COMMAND_SLOT, url: URL_SLOT }),
  { x: 64, baseline: 1280, size: 21, family: "sans" },
  { chip: palette.chip, words: palette.muted, ink: palette.ink },
)}
${palette.qr.edge === null ? `<rect x="896" y="1180" width="120" height="120" rx="12" fill="${palette.qr.plate}"/>` : `<rect x="896.5" y="1180.5" width="119" height="119" rx="12" fill="${palette.qr.plate}" stroke="${palette.qr.edge}"/>`}${qrCode(906, 1190, 100, palette.qr.ink)}
</svg>`;
}

interface ReceiptStage {
  readonly top: string;
  readonly bottom: string;
  readonly shadow: { readonly color: string; readonly opacity: string; readonly blur: number };
  readonly paper: string;
}

/** The till roll is the same paper in either light; only the table it lies on changes. */
const RECEIPT_STAGES: Readonly<Record<ShareCardTheme, ReceiptStage>> = {
  dark: {
    top: "#232a52",
    bottom: "#08080a",
    shadow: { color: "#000000", opacity: ".62", blur: 38 },
    paper: "#f4f2ea",
  },
  light: {
    top: "#e3e7f6",
    bottom: "#cfd3df",
    shadow: { color: "#1c2240", opacity: ".22", blur: 34 },
    paper: "#fdfcf7",
  },
};

const RECEIPT_WIDTH = 660;
const RECEIPT_MODEL_ROWS = 5;

export interface ShareModelRow {
  readonly label: string;
  readonly tokens: number;
  readonly costUsd: number;
}

/** The models a Receipt itemizes: the busiest few by name, then the rest as one line. */
export function shareModelRows<RichText>(
  view: ShareCardView,
  intl: IntlShape<RichText>,
): readonly ShareModelRow[] {
  const shown = view.models.slice(0, RECEIPT_MODEL_ROWS);
  const rest = view.models.slice(RECEIPT_MODEL_ROWS);
  return [
    ...shown.map((model) => ({ label: model.label, tokens: model.tokens, costUsd: model.costUsd })),
    ...(rest.length === 0
      ? []
      : [
          {
            label: intl.formatMessage(
              {
                id: "insights.insightsCards.otherModels",
                defaultMessage: "{count, plural, one {# other model} other {# other models}}",
              },
              { count: rest.length },
            ),
            tokens: rest.reduce((sum, model) => sum + model.tokens, 0),
            costUsd: rest.reduce((sum, model) => sum + model.costUsd, 0),
          },
        ]),
  ];
}
const RECEIPT_MIN_COST = 1;

/** A Receipt line's cost; under a dollar it would only round to a misleading figure. */
export const receiptCost = <RichText>(costUsd: number, intl: IntlShape<RichText>) =>
  costUsd >= RECEIPT_MIN_COST ? wholeDollars(costUsd, intl) : "—";

const truncate = (value: string, limit: number) =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

function renderReceipt<RichText>(
  view: ShareCardView,
  options: ShareCardOptions,
  intl: IntlShape<RichText>,
  fonts: ShareCardFonts | null,
) {
  const left = 44;
  const right = RECEIPT_WIDTH - 44;
  const ink = "#17171a";
  const dim = "#6a6962";
  const stage = RECEIPT_STAGES[options.theme ?? "dark"];
  const showCost = options.showCost && view.costUsd > 0;
  const rows: string[] = [];
  let y = 66;
  const advance = (delta: number) => {
    y += delta;
    return y;
  };
  const text = (
    value: string,
    x: number,
    attributes: {
      readonly anchor?: "start" | "middle" | "end";
      readonly size?: number;
      readonly weight?: number;
      readonly fill?: string;
    } = {},
  ) =>
    `<text x="${x}" y="${y}" font-family="${MONO}" font-size="${attributes.size ?? 20}" font-weight="${attributes.weight ?? 400}" fill="${attributes.fill ?? ink}" text-anchor="${attributes.anchor ?? "start"}">${escapeXml(value)}</text>`;
  const center = RECEIPT_WIDTH / 2;
  const line = (label: string, value: string, attributes = {}) => {
    rows.push(text(label, left, attributes), text(value, right, { ...attributes, anchor: "end" }));
  };
  const rule = () => {
    advance(24);
    rows.push(
      `<line x1="${left}" x2="${right}" y1="${y}" y2="${y}" stroke="#b7b4a8" stroke-width="2" stroke-dasharray="8 7"/>`,
    );
    advance(14);
  };

  rows.push(nodexMark(center - 25, y - 34, 50, ink, stage.paper));
  advance(52);
  rows.push(text("NODEX", center, { anchor: "middle", size: 34, weight: 700 }));
  advance(30);
  rows.push(
    text(
      intl.formatMessage({
        id: "insights.insightsCards.agentReceipt",
        defaultMessage: "AGENT RECEIPT",
      }),
      center,
      { anchor: "middle", fill: dim },
    ),
  );
  advance(26);
  rows.push(
    text(
      intl.formatMessage(
        {
          id: "insights.insightsCards.receiptActiveDays",
          defaultMessage: "{period} · {days} ACTIVE DAYS",
        },
        {
          period: sharePeriodLabel(view, intl).toUpperCase(),
          days: wholeNumber(view.activeDays, intl),
        },
      ),
      center,
      {
        anchor: "middle",
        fill: dim,
        size: 18,
      },
    ),
  );
  const sources = view.sources ?? [];
  sourceLines(
    sources.map((source) => source.toUpperCase()),
    48,
    3,
  ).forEach((names, index) => {
    advance(26);
    rows.push(
      text(
        index === 0
          ? intl.formatMessage(
              { id: "insights.insightsCards.receiptAgents", defaultMessage: "AGENTS: {names}" },
              { names },
            )
          : names,
        center,
        { anchor: "middle", fill: dim, size: 18 },
      ),
    );
  });
  const name = options.name.trim();
  if (name) {
    advance(26);
    rows.push(
      text(
        intl.formatMessage(
          { id: "insights.insightsCards.customer", defaultMessage: "CUSTOMER: {name}" },
          { name: truncate(name.toUpperCase(), 28) },
        ),
        center,
        {
          anchor: "middle",
          fill: dim,
          size: 18,
        },
      ),
    );
  }
  rule();

  for (const model of shareModelRows(view, intl)) {
    advance(30);
    rows.push(
      text(truncate(model.label, 24), left),
      `<text x="${showCost ? right - 150 : right}" y="${y}" font-family="${MONO}" font-size="17" fill="${dim}" text-anchor="end">${compactNumber(model.tokens, intl)}</text>`,
    );
    if (showCost) {
      rows.push(
        text(receiptCost(model.costUsd, intl), right, {
          anchor: "end",
        }),
      );
    }
  }
  rule();

  if (showCost && view.cacheSavingsUsd !== null) {
    advance(30);
    line(
      intl.formatMessage({
        id: "insights.insightsCards.withoutCache",
        defaultMessage: "WITHOUT PROMPT CACHE",
      }),
      wholeDollars(view.costUsd + view.cacheSavingsUsd, intl),
    );
    advance(30);
    line(
      intl.formatMessage({
        id: "insights.insightsCards.cacheSavings",
        defaultMessage: "CACHE SAVINGS",
      }),
      `-${wholeDollars(view.cacheSavingsUsd, intl)}`,
    );
  }
  const total = intl.formatMessage({
    id: "insights.insightsCards.total",
    defaultMessage: "TOTAL",
  });
  // A bill leads with what it comes to; without a cost the Receipt totals tokens instead.
  if (showCost) {
    advance(78);
    rows.push(
      text(total, left, { size: 30, weight: 700 }),
      text(wholeDollars(view.costUsd, intl), right, { anchor: "end", size: 72, weight: 700 }),
    );
    advance(34);
    rows.push(
      text(
        intl.formatMessage(
          {
            id: "insights.insightsCards.atApiPrice",
            defaultMessage: "AT API LIST PRICE · {tokens} TOKENS",
          },
          { tokens: compactNumber(view.tokens, intl) },
        ),
        right,
        { anchor: "end", size: 16, fill: dim },
      ),
    );
  } else {
    advance(50);
    line(total, compactNumber(view.tokens, intl), { size: 36, weight: 700 });
    advance(28);
    rows.push(
      text(
        intl.formatMessage(
          {
            id: "insights.insightsCards.receiptCacheReads",
            defaultMessage: "TOKENS · {share} CACHE READS",
          },
          { share: intl.formatNumber(view.cachedShare, { style: "percent" }) },
        ),
        left,
        {
          size: 16,
          fill: dim,
        },
      ),
    );
  }
  rule();

  for (const stat of shareStats(view, intl)) {
    advance(30);
    line(stat.label.toUpperCase(), stat.value);
  }
  const club = tokenClub(view.tokens, intl);
  if (club !== null) {
    advance(30);
    line(
      intl.formatMessage({
        id: "insights.insightsCards.memberStatus",
        defaultMessage: "MEMBER STATUS",
      }),
      club.toUpperCase(),
    );
  }
  advance(30);
  line(
    intl.formatMessage({
      id: "insights.insightsCards.agentType",
      defaultMessage: "AGENT TYPE",
    }),
    agentArchetype(view, intl).toUpperCase().replace(/^THE /, ""),
  );
  rule();

  advance(2);
  const barsTop = y;
  const barsHeight = 74;
  const max = view.days.reduce((largest, day) => Math.max(largest, day.tokens), 0);
  const slot = (right - left) / Math.max(view.days.length, 1);
  view.days.forEach((day, index) => {
    if (day.tokens <= 0) return;
    const weight = 0.25 + 0.75 * Math.sqrt(day.tokens / max);
    const barWidth = Math.max(slot * weight, 1);
    const x = left + index * slot + (slot - barWidth) / 2;
    rows.push(
      `<rect x="${x.toFixed(2)}" y="${barsTop}" width="${barWidth.toFixed(2)}" height="${barsHeight}" fill="${ink}"/>`,
    );
  });
  advance(barsHeight + 24);
  rows.push(
    text(
      intl.formatMessage({
        id: "insights.insightsCards.barLegend",
        defaultMessage: "EVERY BAR IS A DAY · WIDER = MORE TOKENS",
      }),
      center,
      {
        anchor: "middle",
        fill: dim,
        size: 14,
      },
    ),
  );
  rule();
  advance(24);
  rows.push(
    text(
      intl.formatMessage({
        id: "insights.insightsCards.thanks",
        defaultMessage: "THANK YOU FOR SHIPPING",
      }),
      left,
      { weight: 700 },
    ),
  );
  const qrTop = y - 21;
  advance(28);
  rows.push(
    text(
      intl.formatMessage({
        id: "insights.insightsCards.receiptQuestion",
        defaultMessage: "WHAT'S ON YOUR RECEIPT?",
      }),
      left,
      { fill: dim, size: 17 },
    ),
  );
  // The receipt is narrow, so its invitation takes two lines.
  const receiptInvitation = (message: MessageDescriptor) =>
    invitation(
      intl.formatMessage(message, { command: COMMAND_SLOT, url: URL_SLOT }),
      { x: left, baseline: y, size: 17, family: "mono" },
      { chip: "#17171a12", words: dim, ink },
    );
  advance(30);
  rows.push(
    receiptInvitation(
      defineMessage({
        id: "insights.insightsCards.receiptRun",
        defaultMessage: "RUN {command} IN A TERMINAL",
      }),
    ),
  );
  advance(26);
  rows.push(
    receiptInvitation(
      defineMessage({
        id: "insights.insightsCards.receiptVisit",
        defaultMessage: "OR VISIT {url}",
      }),
    ),
  );
  rows.push(qrCode(right - 86, qrTop, 86, ink));
  advance(36);

  const height = y;
  const tooth = 18;
  let edge = `M0 0H${RECEIPT_WIDTH}V${height}`;
  for (let x = RECEIPT_WIDTH; x > 0; x -= tooth) {
    edge += `L${x - tooth / 2} ${height + 10}L${Math.max(x - tooth, 0)} ${height}`;
  }
  edge += "Z";

  const scale = Math.min(1, (SHARE_CARD_HEIGHT - 110) / (height + 20));
  const offsetX = (SHARE_CARD_WIDTH - RECEIPT_WIDTH * scale) / 2;
  const offsetY = (SHARE_CARD_HEIGHT - (height + 10) * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">
<defs>${fontStyle(fonts)}
<radialGradient id="stage" cx="50%" cy="0%" r="85%"><stop offset="0%" stop-color="${stage.top}"/><stop offset="100%" stop-color="${stage.bottom}"/></radialGradient>
<filter id="lift" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="34" stdDeviation="${stage.shadow.blur}" flood-color="${stage.shadow.color}" flood-opacity="${stage.shadow.opacity}"/></filter>
</defs>
<rect width="100%" height="100%" fill="url(#stage)"/>
<g transform="translate(${offsetX.toFixed(1)} ${offsetY.toFixed(1)}) rotate(-1.4 ${RECEIPT_WIDTH / 2} ${height / 2}) scale(${scale.toFixed(4)})">
<path d="${edge}" fill="${stage.paper}" filter="url(#lift)"/>
${rows.join("\n")}
</g>
</svg>`;
}

export function renderShareCard<RichText>(
  view: ShareCardView,
  options: ShareCardOptions,
  intl: IntlShape<RichText>,
  fonts: ShareCardFonts | null = null,
): string {
  return options.kind === "skyline"
    ? renderSkyline(view, options, intl, fonts)
    : renderReceipt(view, options, intl, fonts);
}

/** The words that go with a posted card; the cost joins them only when the card shows it. */
export function shareMessage<RichText>(
  view: ShareCardView,
  intl: IntlShape<RichText>,
  options: { readonly showCost?: boolean } = {},
): string {
  const stats = shareStats(view, intl)
    .slice(0, 2)
    .map((stat) => `${stat.value} ${stat.label}`);
  const tokens = compactNumber(view.tokens, intl);
  const lead =
    options.showCost && view.costUsd > 0
      ? intl.formatMessage(
          {
            id: "insights.insightsCards.postLeadCost",
            defaultMessage: "{tokens} tokens with my agents, ≈ {cost} at API list price",
          },
          { tokens, cost: wholeDollars(view.costUsd, intl) },
        )
      : intl.formatMessage(
          {
            id: "insights.insightsCards.postLead",
            defaultMessage: "{tokens} tokens with my agents",
          },
          { tokens },
        );
  return intl.formatMessage(
    {
      id: "insights.insightsCards.post",
      defaultMessage: "{summary}. What's yours? {command} · {url}",
    },
    {
      summary: [lead, ...stats].join(intl.locale === "zh-CN" ? "。" : ". "),
      command: SHARE_COMMAND,
      url: SHARE_URL,
    },
  );
}

export const shareFileName = (view: ShareCardView, kind: ShareCardKind) =>
  `nodex-${kind}-${view.lastDay}.png`;
