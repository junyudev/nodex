import { modelDisplayName, shareCardCalendar, type ShareCardView } from "@nodex/insights-cards";
import type { CcusageReport, CcusageTokens } from "./run";

// Display names from ccusage's supported-sources guide.
export const ccusageSourceNames = {
  amp: "Amp",
  antigravity: "Antigravity",
  claude: "Claude Code",
  cline: "Cline",
  codebuff: "Codebuff",
  codex: "Codex",
  copilot: "GitHub Copilot CLI",
  droid: "Droid",
  dsh: "DeepSeek Harness",
  gemini: "Gemini CLI",
  goose: "Goose",
  grok: "Grok Build CLI",
  hermes: "Hermes Agent",
  kilo: "Kilo",
  kimi: "Kimi",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  pi: "pi-agent",
  qwen: "Qwen",
  zcode: "ZCode",
} as const;

function sourceName(id: string): string {
  if (Object.hasOwn(ccusageSourceNames, id)) {
    return ccusageSourceNames[id as keyof typeof ccusageSourceNames];
  }
  return id.replace(/[-_]+/g, " ").replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

const dayMs = 24 * 60 * 60 * 1000;

function dayTime(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

function dayLabel(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function processedTokens({
  inputTokens,
  cacheReadTokens,
  cacheCreationTokens,
  outputTokens,
}: CcusageTokens): number {
  // Unified input already excludes both cache buckets. totalTokens can include other usage.
  return inputTokens + cacheReadTokens + cacheCreationTokens + outputTokens;
}

export function ccusageCardView(
  report: CcusageReport,
  span: { period: "year" | "range"; firstDay: string; lastDay: string },
): ShareCardView {
  const { firstDay, lastDay } = span;
  const tokensByDay = new Map<string, number>();
  const tokensBySource = new Map<string, number>();
  const modelsByLabel = new Map<string, { tokens: number; costUsd: number }>();
  let tokens = 0;
  let cacheReadTokens = 0;
  let costUsd = 0;

  for (const row of report.daily) {
    if (row.period < firstDay || row.period > lastDay) continue;
    const dayTokens = processedTokens(row);
    tokensByDay.set(row.period, (tokensByDay.get(row.period) ?? 0) + dayTokens);
    tokens += dayTokens;
    cacheReadTokens += row.cacheReadTokens;
    costUsd += row.totalCost ?? 0;

    for (const agent of row.agents) {
      const agentTokens = processedTokens(agent);
      if (agentTokens === 0) continue;
      tokensBySource.set(agent.agent, (tokensBySource.get(agent.agent) ?? 0) + agentTokens);
    }
    for (const model of row.modelBreakdowns) {
      const label = modelDisplayName(model.modelName.replace(/^\[[^\]]+\]\s+/, ""));
      const usage = modelsByLabel.get(label) ?? { tokens: 0, costUsd: 0 };
      usage.tokens += processedTokens(model);
      usage.costUsd += model.cost ?? 0;
      modelsByLabel.set(label, usage);
    }
  }

  const days: { day: string; tokens: number }[] = [];
  let activeDays = 0;
  let longestStreak = 0;
  let streak = 0;
  const lastTime = dayTime(lastDay);
  for (let time = dayTime(firstDay); time <= lastTime; time += dayMs) {
    const day = dayLabel(time);
    const dayTokens = tokensByDay.get(day) ?? 0;
    days.push({ day, tokens: dayTokens });
    if (dayTokens === 0) {
      streak = 0;
      continue;
    }
    activeDays += 1;
    streak += 1;
    longestStreak = Math.max(longestStreak, streak);
  }

  const hours = Array.from({ length: 24 }, () => 0);
  return {
    ...span,
    days,
    calendar: shareCardCalendar(days),
    recentHours: Array.from({ length: 7 }, (_, index) => ({
      day: dayLabel(lastTime - (6 - index) * dayMs),
      hours,
    })),
    hours,
    tokens,
    cachedShare: tokens > 0 ? cacheReadTokens / tokens : 0,
    costUsd,
    cacheSavingsUsd: null,
    activeDays,
    longestStreak,
    // Session rows can omit activity dates. Their count belongs to the original query window.
    conversations:
      report.sessionWindow.since === firstDay && report.sessionWindow.until === lastDay
        ? report.sessionCount
        : 0,
    messages: 0,
    peakAgents: 0,
    tasksDone: 0,
    pagesCreated: 0,
    models: Array.from(modelsByLabel, ([label, usage]) => ({
      label,
      ...usage,
      share: tokens > 0 ? usage.tokens / tokens : 0,
    }))
      .filter((model) => model.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens),
    sources: Array.from(tokensBySource)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => sourceName(id)),
  };
}
