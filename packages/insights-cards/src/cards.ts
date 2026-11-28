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

export interface ShareCardOptions {
  readonly kind: ShareCardKind;
  readonly showCost: boolean;
  /** How the person wants to be named; nothing identifies them unless they type it. */
  readonly name: string;
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
function nodexMark(x: number, y: number, size: number, ink: string, paper: string) {
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

const SKYLINE_RAMP = ["#27366f", "#34479c", "#4663cf", "#6f8bf2", "#b6c6ff"] as const;
const SKYLINE_FRONT = ["#1c274f", "#26336f", "#3247a0", "#4a63c9", "#7e94ea"] as const;
const SKYLINE_SHADE = ["#161e3e", "#1c2654", "#253478", "#364a98", "#5c6fb4"] as const;
const SKYLINE_EMPTY = "#191920";

const skylineStep = (value: number, max: number) =>
  value <= 0 || max <= 0 ? -1 : Math.min(4, Math.floor(Math.sqrt(value / max) * 5));

/** Axonometric towers scaled to fit any period, from a week of hours to years of days. */
export function renderSkylineCity<RichText>(
  grid: SkylineGrid,
  area: { width: number; height: number },
  intl: IntlShape<RichText>,
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
    const top = step < 0 ? SKYLINE_EMPTY : SKYLINE_RAMP[step]!;
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
        SKYLINE_FRONT[step]!,
      );
      city += polygon(
        [
          point(right, back, height),
          point(right, front, height),
          point(right, front, 0),
          point(right, back, 0),
        ],
        SKYLINE_SHADE[step]!,
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
    annotation = `<line x1="${peak.x.toFixed(1)}" y1="${(peak.y - 3).toFixed(1)}" x2="${peak.x.toFixed(1)}" y2="${(peak.y - 26).toFixed(1)}" stroke="#a8a8ae"/>
<text x="${peak.x.toFixed(1)}" y="${(peak.y - 34).toFixed(1)}" fill="#f5f5f4" font-family="${SANS}" font-size="19" font-weight="600" paint-order="stroke" stroke="#08080a" stroke-width="6" stroke-linejoin="round" text-anchor="${end ? "end" : "middle"}">${escapeXml(intl.formatMessage({ id: "insights.insightsCards.peakAnnotation", defaultMessage: "{tokens} on {day}" }, { tokens: compactNumber(peak.value, intl), day: peak.label }))}</text>`;
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
  const city = renderSkylineCity(skylineGrid(view, intl), { width: 1020, height: 640 }, intl);
  const periodLabel = sharePeriodLabel(view, intl);
  const question = intl.formatMessage(
    PERIOD_QUESTIONS[view.period === "range" ? "all" : view.period],
    view.period === "year" ? { year: periodLabel } : undefined,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHARE_CARD_WIDTH}" height="${SHARE_CARD_HEIGHT}" viewBox="0 0 ${SHARE_CARD_WIDTH} ${SHARE_CARD_HEIGHT}">
<defs>${fontStyle(fonts)}
<radialGradient id="glow" cx="12%" cy="0%" r="75%"><stop offset="0%" stop-color="#3b4cb0" stop-opacity=".34"/><stop offset="100%" stop-color="#3b4cb0" stop-opacity="0"/></radialGradient>
<radialGradient id="ember" cx="95%" cy="100%" r="55%"><stop offset="0%" stop-color="#d95926" stop-opacity=".14"/><stop offset="100%" stop-color="#d95926" stop-opacity="0"/></radialGradient>
</defs>
<rect width="100%" height="100%" fill="#08080a"/><rect width="100%" height="100%" fill="url(#glow)"/><rect width="100%" height="100%" fill="url(#ember)"/>
${nodexMark(64, 56, 40, "#ffffff", "#262626")}
<text x="114" y="85" font-family="${SANS}" font-size="27" font-weight="600" fill="#f5f5f4">Nodex${name ? `<tspan fill="#6f6f78" font-weight="400"> · ${escapeXml(name)}</tspan>` : ""}</text>
<text x="1016" y="85" text-anchor="end" font-family="${SANS}" font-size="24" fill="#a8a8ae">${escapeXml(periodLabel)}</text>
<text x="60" y="262" font-family="${SANS}" font-size="168" font-weight="600" letter-spacing="-8" fill="#f5f5f4">${compactNumber(view.tokens, intl)}</text>
<text x="64" y="316" font-family="${SANS}" font-size="27" fill="#a8a8ae">${escapeXml(intl.formatMessage({ id: "insights.insightsCards.processedTokens", defaultMessage: "tokens processed" }) + cost)}</text>
${club === null ? "" : `<text x="1016" y="316" text-anchor="end" font-family="${MONO}" font-size="21" font-weight="600" letter-spacing="1.5" fill="#b6c6ff">${escapeXml(club.toUpperCase())}</text>`}
<text x="1016" y="262" text-anchor="end" font-family="${SANS}" font-size="30" font-weight="600" fill="#f5f5f4">${escapeXml(agentArchetype(view, intl))}</text>
<g transform="translate(30 340)">${city}</g>
${stats
  .map((stat, index) => {
    const x = 64 + index * 244;
    return `<text x="${x}" y="1072" font-family="${SANS}" font-size="56" font-weight="600" letter-spacing="-1.5" fill="#f5f5f4">${stat.value}</text>
<text x="${x}" y="1110" font-family="${SANS}" font-size="21" fill="#6f6f78">${escapeXml(stat.label)}</text>`;
  })
  .join("\n")}
<text x="64" y="1234" font-family="${SANS}" font-size="33" font-weight="600" letter-spacing="-.5" fill="#f5f5f4">${escapeXml(question)}</text>
<text x="64" y="1278" font-family="${MONO}" font-size="23" fill="#a8a8ae">${SHARE_URL}</text>
<rect x="896" y="1180" width="120" height="120" rx="12" fill="#ffffff"/>${qrCode(906, 1190, 100, "#08080a")}
</svg>`;
}

const RECEIPT_WIDTH = 660;
const RECEIPT_MODEL_ROWS = 5;
const RECEIPT_MIN_COST = 1;

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

  rows.push(nodexMark(center - 25, y - 34, 50, ink, "#f4f2ea"));
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

  const shown = view.models.slice(0, RECEIPT_MODEL_ROWS);
  const rest = view.models.slice(RECEIPT_MODEL_ROWS);
  const modelRows = [
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
  for (const model of modelRows) {
    advance(30);
    rows.push(
      text(truncate(model.label, 24), left),
      `<text x="${showCost ? right - 150 : right}" y="${y}" font-family="${MONO}" font-size="17" fill="${dim}" text-anchor="end">${compactNumber(model.tokens, intl)}</text>`,
    );
    if (showCost) {
      rows.push(
        text(model.costUsd >= RECEIPT_MIN_COST ? wholeDollars(model.costUsd, intl) : "—", right, {
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
  if (showCost) {
    advance(50);
    line(
      intl.formatMessage({ id: "insights.insightsCards.total", defaultMessage: "TOTAL" }),
      wholeDollars(view.costUsd, intl),
      { size: 36, weight: 700 },
    );
    advance(28);
    rows.push(
      text(
        intl.formatMessage(
          {
            id: "insights.insightsCards.atApiPrice",
            defaultMessage: "AT API LIST PRICE · {tokens} TOKENS",
          },
          { tokens: compactNumber(view.tokens, intl) },
        ),
        left,
        {
          size: 16,
          fill: dim,
        },
      ),
    );
  } else {
    advance(50);
    line(
      intl.formatMessage({ id: "insights.insightsCards.total", defaultMessage: "TOTAL" }),
      compactNumber(view.tokens, intl),
      { size: 36, weight: 700 },
    );
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
  advance(25);
  rows.push(text(SHARE_URL, left, { fill: dim, size: 17 }));
  rows.push(qrCode(right - 86, y - 74, 86, ink));
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
<radialGradient id="stage" cx="50%" cy="0%" r="85%"><stop offset="0%" stop-color="#232a52"/><stop offset="100%" stop-color="#08080a"/></radialGradient>
<filter id="lift" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="34" stdDeviation="38" flood-color="#000000" flood-opacity=".62"/></filter>
</defs>
<rect width="100%" height="100%" fill="url(#stage)"/>
<g transform="translate(${offsetX.toFixed(1)} ${offsetY.toFixed(1)}) rotate(-1.4 ${RECEIPT_WIDTH / 2} ${height / 2}) scale(${scale.toFixed(4)})">
<path d="${edge}" fill="#f4f2ea" filter="url(#lift)"/>
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

/** The words that go with a posted card. */
export function shareMessage<RichText>(view: ShareCardView, intl: IntlShape<RichText>): string {
  const stats = shareStats(view, intl)
    .slice(0, 2)
    .map((stat) => `${stat.value} ${stat.label}`);
  const lead = intl.formatMessage(
    { id: "insights.insightsCards.postLead", defaultMessage: "{tokens} tokens with my agents" },
    { tokens: compactNumber(view.tokens, intl) },
  );
  return intl.formatMessage(
    { id: "insights.insightsCards.post", defaultMessage: "{summary}. What's yours? {url}" },
    { summary: [lead, ...stats].join(intl.locale === "zh-CN" ? "。" : ". "), url: SHARE_URL },
  );
}

export const shareFileName = (view: ShareCardView, kind: ShareCardKind) =>
  `nodex-${kind}-${view.lastDay}.png`;
