import type { InsightsContentSnapshot, InsightsUsageSnapshot } from "../../../shared/insights";
import {
  compactNumber,
  modelDisplayName,
  modelFamily,
  shortDay,
  type ModelFamily,
} from "./insights-format";

export type InsightsPeriod = "7d" | "30d" | "90d" | "12m" | "all";

export const INSIGHTS_PERIODS: readonly { readonly id: InsightsPeriod; readonly label: string }[] =
  [
    { id: "7d", label: "7 days" },
    { id: "30d", label: "30 days" },
    { id: "90d", label: "90 days" },
    { id: "12m", label: "12 months" },
    { id: "all", label: "All time" },
  ];

export type InsightsMetric = "tokens" | "messages" | "tasks" | "pages";

export interface InsightsDay {
  readonly day: string;
  readonly tokens: number;
  readonly messages: number;
  readonly tasks: number;
  readonly pages: number;
  readonly claude: number;
  readonly gpt: number;
  readonly other: number;
}

export interface InsightsModelRow {
  readonly model: string;
  readonly label: string;
  readonly family: ModelFamily;
  readonly tokens: number;
  readonly share: number;
  readonly costUsd: number;
  readonly priced: boolean;
}

export interface InsightsSeriesPoint {
  readonly day: string;
  readonly label: string;
  readonly tokens: number;
  readonly claude: number;
  readonly gpt: number;
  readonly other: number;
}

export interface InsightsCalendar {
  /** Sunday-first weeks; a null cell lies outside the period. */
  readonly weeks: readonly (readonly (InsightsDay | null)[])[];
}

export interface InsightsHighlight {
  readonly lead: string;
  readonly detail: string;
}

export interface InsightsView {
  readonly period: InsightsPeriod;
  readonly firstDay: string;
  readonly lastDay: string;
  readonly days: readonly InsightsDay[];
  readonly calendar: InsightsCalendar;
  readonly tokens: number;
  readonly cachedTokens: number;
  readonly cachedShare: number;
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly unpricedModels: number;
  readonly requests: number;
  readonly messages: number;
  readonly conversations: number;
  readonly activeDays: number;
  readonly longestStreak: number;
  readonly biggestDay: InsightsDay | null;
  readonly models: readonly InsightsModelRow[];
  readonly peakAgents: number;
  readonly peakAgentsDay: string | null;
  readonly agentTurns: number;
  readonly agentHours: number;
  readonly hours: readonly number[];
  /** Hour-by-day tokens for the last seven days, oldest first; each row has 24 values. */
  readonly recentHours: readonly { readonly day: string; readonly hours: readonly number[] }[];
  readonly pagesCreated: number;
  readonly tasksDone: number;
  readonly pageTotal: number | null;
  readonly blockTotal: number | null;
  readonly taskTotal: number | null;
  readonly tasksDoneTotal: number | null;
  readonly highlights: readonly InsightsHighlight[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

const dayToUtcMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
const utcMsToDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day: string, delta: number) => utcMsToDay(dayToUtcMs(day) + delta * DAY_MS);

export function localToday(timeZone: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs));
}

function earliestDay(usage: InsightsUsageSnapshot, content: InsightsContentSnapshot | null) {
  const candidates = [
    usage.models[0]?.day,
    usage.messages[0]?.[0],
    usage.agents[0]?.day,
    content?.pagesCreated[0]?.[0],
    content?.tasksDone[0]?.[0],
  ].filter((day): day is string => day !== undefined);
  return candidates.reduce<string | null>(
    (earliest, day) => (earliest === null || day < earliest ? day : earliest),
    null,
  );
}

function firstDayOf(period: InsightsPeriod, today: string, earliest: string | null): string {
  switch (period) {
    case "7d":
      return addDays(today, -6);
    case "30d":
      return addDays(today, -29);
    case "90d":
      return addDays(today, -89);
    case "12m":
      return addDays(today, -364);
    case "all":
      return earliest !== null && earliest < today ? earliest : today;
  }
}

function buildCalendar(days: readonly InsightsDay[]): InsightsCalendar {
  const weeks: (InsightsDay | null)[][] = [];
  let week: (InsightsDay | null)[] = Array.from({ length: 7 }, () => null);
  for (const entry of days) {
    const weekday = new Date(dayToUtcMs(entry.day)).getUTCDay();
    week[weekday] = entry;
    if (weekday === 6) {
      weeks.push(week);
      week = Array.from({ length: 7 }, () => null);
    }
  }
  if (week.some((cell) => cell !== null)) weeks.push(week);
  return { weeks };
}

function buildHighlights(input: {
  readonly biggestDay: InsightsDay | null;
  readonly activeDays: number;
  readonly tokens: number;
  readonly hours: readonly number[];
  readonly messages: number;
  readonly cachedShare: number;
  readonly peakAgents: number;
  readonly peakAgentsDay: string | null;
}): readonly InsightsHighlight[] {
  const highlights: InsightsHighlight[] = [];
  const { biggestDay, activeDays, tokens, hours, messages, cachedShare } = input;
  if (biggestDay !== null && activeDays > 1) {
    const multiple = Math.round(biggestDay.tokens / (tokens / activeDays));
    highlights.push({
      lead: `${shortDay(biggestDay.day)} was your biggest day.`,
      detail: `${compactNumber(biggestDay.tokens)} tokens${multiple >= 2 ? `, about ${multiple}× a usual day` : ""}.`,
    });
  }
  const total = hours.reduce((sum, value) => sum + value, 0);
  if (total > 0) {
    const night = hours.reduce((sum, value, hour) => sum + (hour >= 22 || hour < 5 ? value : 0), 0);
    const peakHour = hours.indexOf(Math.max(...hours));
    const nightShare = Math.round((night / total) * 100);
    const peakClock = `${String(peakHour).padStart(2, "0")}:00`;
    highlights.push(
      nightShare >= 10
        ? {
            lead: `${nightShare}% of your tokens burn after 10pm.`,
            detail: `Your agents are busiest around ${peakClock}.`,
          }
        : {
            lead: `Your agents are busiest around ${peakClock}.`,
            detail: "They mostly sleep when you do.",
          },
    );
  }
  if (messages > 0 && tokens > 0) {
    highlights.push({
      lead: `Every message you send sets off ${compactNumber(tokens / messages)} tokens.`,
      detail: `${Math.round(cachedShare * 100)}% of them are cache reads.`,
    });
  }
  return highlights;
}

/** One period's numbers. Everything on the page and on a card reads from this. */
export function projectInsights(input: {
  readonly usage: InsightsUsageSnapshot;
  readonly content: InsightsContentSnapshot | null;
  readonly period: InsightsPeriod;
  readonly today: string;
}): InsightsView {
  const { usage, content, period, today } = input;
  const firstDay = firstDayOf(period, today, earliestDay(usage, content));
  const inPeriod = (day: string) => day >= firstDay && day <= today;

  const blank = (day: string): Mutable<InsightsDay> => ({
    day,
    tokens: 0,
    messages: 0,
    tasks: 0,
    pages: 0,
    claude: 0,
    gpt: 0,
    other: 0,
  });
  const byDay = new Map<string, Mutable<InsightsDay>>();
  for (let day = firstDay; day <= today; day = addDays(day, 1)) byDay.set(day, blank(day));

  const models = new Map<string, Mutable<InsightsModelRow>>();
  let tokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let cacheSavingsUsd = 0;
  let requests = 0;
  for (const row of usage.models) {
    if (!inPeriod(row.day)) continue;
    const rowTokens =
      row.uncachedInputTokens + row.cachedInputTokens + row.cacheCreationTokens + row.outputTokens;
    tokens += rowTokens;
    cachedTokens += row.cachedInputTokens;
    costUsd += row.costUsd;
    cacheSavingsUsd += row.cacheSavingsUsd;
    requests += row.requests;
    const family = modelFamily(row.model);
    const entry = byDay.get(row.day);
    if (entry) {
      entry.tokens += rowTokens;
      entry[family] += rowTokens;
    }
    let model = models.get(row.model);
    if (model === undefined) {
      model = {
        model: row.model,
        label: modelDisplayName(row.model),
        family,
        tokens: 0,
        share: 0,
        costUsd: 0,
        priced: row.priced,
      };
      models.set(row.model, model);
    }
    model.tokens += rowTokens;
    model.costUsd += row.costUsd;
    model.priced = model.priced && row.priced;
  }
  const modelRows = [...models.values()]
    .filter((model) => model.tokens > 0)
    .map((model) => ({ ...model, share: model.tokens / tokens }))
    .sort((a, b) => b.tokens - a.tokens);

  let messages = 0;
  for (const [day, count] of usage.messages) {
    if (!inPeriod(day)) continue;
    messages += count;
    const entry = byDay.get(day);
    if (entry) entry.messages += count;
  }
  let conversations = 0;
  for (const [day, count] of usage.conversations) if (inPeriod(day)) conversations += count;

  let pagesCreated = 0;
  let tasksDone = 0;
  for (const [day, count] of content?.pagesCreated ?? []) {
    if (!inPeriod(day)) continue;
    pagesCreated += count;
    const entry = byDay.get(day);
    if (entry) entry.pages += count;
  }
  for (const [day, count] of content?.tasksDone ?? []) {
    if (!inPeriod(day)) continue;
    tasksDone += count;
    const entry = byDay.get(day);
    if (entry) entry.tasks += count;
  }

  let peakAgents = 0;
  let peakAgentsDay: string | null = null;
  let agentTurns = 0;
  let agentSeconds = 0;
  for (const agentDay of usage.agents) {
    if (!inPeriod(agentDay.day)) continue;
    agentTurns += agentDay.turns;
    agentSeconds += agentDay.activeSeconds;
    if (agentDay.peakAgents > peakAgents) {
      peakAgents = agentDay.peakAgents;
      peakAgentsDay = agentDay.day;
    }
  }

  const hours = Array.from({ length: 24 }, () => 0);
  const hourRows = new Map<string, number[]>();
  const recentFrom = addDays(today, -6);
  for (const [day, hour, count] of usage.hours) {
    if (inPeriod(day)) hours[hour] = (hours[hour] ?? 0) + count;
    if (day >= recentFrom && day <= today) {
      let row = hourRows.get(day);
      if (row === undefined) {
        row = Array.from({ length: 24 }, () => 0);
        hourRows.set(day, row);
      }
      row[hour] = (row[hour] ?? 0) + count;
    }
  }
  const recentHours = Array.from({ length: 7 }, (_, index) => {
    const day = addDays(recentFrom, index);
    return { day, hours: hourRows.get(day) ?? Array.from({ length: 24 }, () => 0) };
  });

  const days = [...byDay.values()];
  let longestStreak = 0;
  let streak = 0;
  let activeDays = 0;
  let biggestDay: InsightsDay | null = null;
  for (const entry of days) {
    const active = entry.tokens > 0 || entry.messages > 0;
    if (active) activeDays += 1;
    streak = active ? streak + 1 : 0;
    longestStreak = Math.max(longestStreak, streak);
    if (entry.tokens > 0 && (biggestDay === null || entry.tokens > biggestDay.tokens)) {
      biggestDay = entry;
    }
  }

  const cachedShare = tokens > 0 ? cachedTokens / tokens : 0;
  return {
    period,
    firstDay,
    lastDay: today,
    days,
    calendar: buildCalendar(days),
    tokens,
    cachedTokens,
    cachedShare,
    costUsd,
    cacheSavingsUsd,
    unpricedModels: modelRows.filter((model) => !model.priced).length,
    requests,
    messages,
    conversations,
    activeDays,
    longestStreak,
    biggestDay,
    models: modelRows,
    peakAgents,
    peakAgentsDay,
    agentTurns,
    agentHours: agentSeconds / 3600,
    hours,
    recentHours,
    pagesCreated,
    tasksDone,
    pageTotal: content?.pageTotal ?? null,
    blockTotal: content?.blockTotal ?? null,
    taskTotal: content?.taskTotal ?? null,
    tasksDoneTotal: content?.tasksDoneTotal ?? null,
    highlights: buildHighlights({
      biggestDay,
      activeDays,
      tokens,
      hours,
      messages,
      cachedShare,
      peakAgents,
      peakAgentsDay,
    }),
  };
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

const MAX_DAILY_BARS = 92;

/** Daily bars while they stay thin enough to read; a longer period groups them by week. */
export function tokenSeries(view: InsightsView): readonly InsightsSeriesPoint[] {
  if (view.days.length <= MAX_DAILY_BARS) {
    return view.days.map(({ day, tokens, claude, gpt, other }) => ({
      day,
      label: shortDay(day),
      tokens,
      claude,
      gpt,
      other,
    }));
  }
  const weeks: Mutable<InsightsSeriesPoint>[] = [];
  view.days.forEach((entry, index) => {
    if (index % 7 === 0) {
      weeks.push({
        day: entry.day,
        label: `Week of ${shortDay(entry.day)}`,
        tokens: 0,
        claude: 0,
        gpt: 0,
        other: 0,
      });
    }
    const week = weeks.at(-1)!;
    week.tokens += entry.tokens;
    week.claude += entry.claude;
    week.gpt += entry.gpt;
    week.other += entry.other;
  });
  return weeks;
}

const CLUB_TIERS = [
  { tokens: 1e12, label: "1T Club" },
  { tokens: 100e9, label: "100B Club" },
  { tokens: 10e9, label: "10B Club" },
  { tokens: 1e9, label: "1B Club" },
] as const;

/** A fixed mark anyone can verify from their own number; no one is ranked against anyone. */
export function tokenClub(tokens: number): string | null {
  return CLUB_TIERS.find((tier) => tokens >= tier.tokens)?.label ?? null;
}

/** What the numbers say about how someone works, strongest signal first. */
export function agentArchetype(view: InsightsView): string {
  const totalHours = view.hours.reduce((sum, value) => sum + value, 0);
  const night =
    totalHours === 0
      ? 0
      : view.hours.reduce((sum, value, hour) => sum + (hour >= 22 || hour < 5 ? value : 0), 0) /
        totalHours;
  if (view.peakAgents >= 10) return "The Orchestrator";
  if (night >= 0.45) return "The Night Shift";
  if (view.messages > 0 && view.tokens / view.messages >= 5e6) return "The Delegator";
  if (view.longestStreak >= 30) return "The Daily Shipper";
  if (view.models[0] !== undefined && view.models[0].share >= 0.85) {
    return `${view.models[0].label} Loyalist`;
  }
  return "The Builder";
}
