import { useState, type ReactNode } from "react";

import {
  axisMaximum,
  compactNumber,
  heatStep,
  monthName,
  shortDay,
  wholeNumber,
} from "./insights-format";
import type {
  InsightsCalendar,
  InsightsDay,
  InsightsMetric,
  InsightsSeriesPoint,
} from "./insights-model";

/** Validated as one set on both light and dark surfaces. */
export const FAMILY_COLORS = {
  claude: "#d95926",
  gpt: "#199e70",
  other: "#3987e5",
} as const;

const HEAT_ACCENT = "#5b78ea";
const HEAT_STEPS = [28, 46, 64, 82, 100];
const QUIET_FILL = "color-mix(in srgb, var(--color-text) 6%, transparent)";
const GRID_STROKE = "color-mix(in srgb, var(--color-text) 9%, transparent)";
const AXIS_FILL = "color-mix(in srgb, var(--color-text) 45%, transparent)";

const METRIC_UNITS: Readonly<Record<InsightsMetric, string>> = {
  tokens: "tokens",
  messages: "messages",
  tasks: "tasks done",
  pages: "pages",
};

const metricValue = (day: InsightsDay, metric: InsightsMetric) => day[metric];

interface Hover {
  readonly xPercent: number;
  readonly yPercent: number;
  readonly content: ReactNode;
}

function ChartTooltip({ hover }: { readonly hover: Hover | null }) {
  if (hover === null) return null;
  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-md bg-(--color-background-elevated-primary) px-2 py-1 text-xs whitespace-nowrap text-(--color-text) shadow-md ring-[0.5px] ring-(--color-border-default)"
      style={{ left: `${hover.xPercent}%`, top: `calc(${hover.yPercent}% - 6px)` }}
    >
      {hover.content}
    </div>
  );
}

export function ActivityHeatmap({
  calendar,
  metric,
}: {
  readonly calendar: InsightsCalendar;
  readonly metric: InsightsMetric;
}) {
  const [hover, setHover] = useState<Hover | null>(null);
  const pitch = 16;
  const size = 13.5;
  const top = 18;
  const width = Math.max(calendar.weeks.length, 1) * pitch;
  const height = top + 7 * pitch;
  let max = 0;
  for (const week of calendar.weeks) {
    for (const cell of week) if (cell) max = Math.max(max, metricValue(cell, metric));
  }
  const monthLabels = new Map<number, string>();
  let lastMonth = "";
  calendar.weeks.forEach((week, column) => {
    const first = week.find((cell) => cell !== null);
    if (!first) return;
    const month = monthName(first.day);
    // The last weeks have no room for a label inside the chart.
    if (month !== lastMonth && column * pitch + 24 <= width) monthLabels.set(column, month);
    lastMonth = month;
  });
  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block max-h-[220px] w-full"
        role="img"
        aria-label={`Daily ${METRIC_UNITS[metric]}`}
      >
        {calendar.weeks.map((week, column) => (
          <g key={week.find((cell) => cell !== null)?.day ?? column}>
            {monthLabels.has(column) ? (
              <text x={column * pitch} y={10} fontSize={10} fill={AXIS_FILL}>
                {monthLabels.get(column)}
              </text>
            ) : null}
            {week.map((cell, row) => {
              if (cell === null) return null;
              const value = metricValue(cell, metric);
              const step = heatStep(value, max, HEAT_STEPS.length);
              return (
                <rect
                  key={cell.day}
                  data-day={cell.day}
                  x={column * pitch}
                  y={top + row * pitch}
                  width={size}
                  height={size}
                  rx={3}
                  fill={
                    step < 0
                      ? QUIET_FILL
                      : `color-mix(in srgb, ${HEAT_ACCENT} ${HEAT_STEPS[step]}%, transparent)`
                  }
                  onPointerEnter={() =>
                    setHover({
                      xPercent: ((column * pitch + size / 2) / width) * 100,
                      yPercent: ((top + row * pitch) / height) * 100,
                      content: `${shortDay(cell.day)} · ${
                        metric === "tokens" ? compactNumber(value) : wholeNumber(value)
                      } ${METRIC_UNITS[metric]}`,
                    })
                  }
                />
              );
            })}
          </g>
        ))}
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  );
}

export function TokenTimeline({ series }: { readonly series: readonly InsightsSeriesPoint[] }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const width = 440;
  const height = 176;
  const left = 30;
  const top = 8;
  const bottom = 18;
  const plotHeight = height - top - bottom;
  const axisTop = axisMaximum(
    series.reduce((largest, point) => Math.max(largest, point.tokens), 0),
  );
  const pitch = (width - left) / Math.max(series.length, 1);
  const barWidth = Math.max(Math.min(pitch - 1.5, 24), 1);
  const monthLabels = new Set<string>();
  let lastMonth = "";
  series.forEach((point, index) => {
    const month = monthName(point.day);
    const fits = left + index * pitch + 24 <= width;
    // A long period labels every other month so the names never touch.
    const room = series.length <= 60 || new Date(`${point.day}T00:00:00Z`).getUTCMonth() % 2 === 0;
    if (month !== lastMonth && fits && room) monthLabels.add(point.day);
    lastMonth = month;
  });
  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        role="img"
        aria-label="Tokens over time by model family"
      >
        {[0, axisTop / 2, axisTop].map((tick) => {
          const y = top + plotHeight - (tick / axisTop) * plotHeight;
          return (
            <g key={tick}>
              <line x1={left} x2={width} y1={y} y2={y} stroke={GRID_STROKE} />
              <text x={0} y={y + 3.5} fontSize={10} fill={AXIS_FILL}>
                {tick === 0 ? "0" : compactNumber(tick)}
              </text>
            </g>
          );
        })}
        {series.map((point, index) => {
          const x = left + index * pitch;
          let y = top + plotHeight;
          return (
            <g
              key={point.day}
              onPointerEnter={() =>
                setHover({
                  xPercent: ((x + barWidth / 2) / width) * 100,
                  yPercent:
                    ((top + plotHeight - (point.tokens / axisTop) * plotHeight) / height) * 100,
                  content: `${point.label} · ${compactNumber(point.tokens)} tokens`,
                })
              }
            >
              <rect x={x} y={top} width={pitch} height={plotHeight} fill="transparent" />
              {(["claude", "gpt", "other"] as const).map((family) => {
                const value = point[family];
                if (value <= 0) return null;
                const segment = (value / axisTop) * plotHeight;
                y -= segment;
                return (
                  <rect
                    key={family}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(segment - 0.75, 0.5)}
                    rx={1}
                    fill={FAMILY_COLORS[family]}
                  />
                );
              })}
              {monthLabels.has(point.day) ? (
                <text x={x} y={height - 4} fontSize={10} fill={AXIS_FILL}>
                  {monthName(point.day)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  );
}

export function HourRhythm({ hours }: { readonly hours: readonly number[] }) {
  const [hover, setHover] = useState<Hover | null>(null);
  const width = 360;
  const height = 104;
  const bottom = 16;
  const plotHeight = height - bottom;
  const max = Math.max(...hours, 1);
  const pitch = width / 24;
  return (
    <div className="relative" onPointerLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="block w-full"
        role="img"
        aria-label="Tokens by hour of day"
      >
        {hours.map((value, hour) => {
          const barHeight = (value / max) * plotHeight;
          return (
            <g
              key={hour}
              onPointerEnter={() =>
                setHover({
                  xPercent: ((hour + 0.5) / 24) * 100,
                  yPercent: ((plotHeight - barHeight) / height) * 100,
                  content: `${String(hour).padStart(2, "0")}:00 · ${compactNumber(value)} tokens`,
                })
              }
            >
              <rect x={hour * pitch} y={0} width={pitch} height={plotHeight} fill="transparent" />
              <rect
                x={hour * pitch + 1}
                y={plotHeight - barHeight}
                width={pitch - 2}
                height={Math.max(barHeight, value > 0 ? 1.5 : 0)}
                rx={2}
                fill={HEAT_ACCENT}
              />
              {hour % 6 === 0 ? (
                <text x={hour * pitch + 1} y={height - 3} fontSize={10} fill={AXIS_FILL}>
                  {hour}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <ChartTooltip hover={hover} />
    </div>
  );
}
