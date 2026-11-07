import { describe, expect, it } from "vitest";

import type {
  InsightsContentSnapshot,
  InsightsModelDay,
  InsightsUsageSnapshot,
} from "../../../shared/insights";
import {
  axisMaximum,
  compactNumber,
  heatStep,
  modelDisplayName,
  modelFamily,
  shareLabel,
} from "./insights-format";
import {
  agentArchetype,
  projectInsights,
  tokenClub,
  tokenSeries,
  type InsightsPeriod,
} from "./insights-model";

const modelDay = (
  day: string,
  model: string,
  overrides: Partial<InsightsModelDay> = {},
): InsightsModelDay => ({
  day,
  provider: model.startsWith("claude") ? "claude" : "codex",
  model,
  uncachedInputTokens: 100,
  cachedInputTokens: 900,
  cacheCreationTokens: 0,
  outputTokens: 0,
  requests: 1,
  costUsd: 2,
  cacheSavingsUsd: 5,
  priced: true,
  ...overrides,
});

const usage = (overrides: Partial<InsightsUsageSnapshot> = {}): InsightsUsageSnapshot => ({
  access: "granted",
  revision: 1,
  scan: { state: "idle", filesDone: 0, filesTotal: 0, failedFiles: 0, finishedAtMs: 1 },
  pricing: "fresh",
  models: [],
  messages: [],
  conversations: [],
  hours: [],
  agents: [],
  ...overrides,
});

const content: InsightsContentSnapshot = {
  pageTotal: 40,
  blockTotal: 900,
  taskTotal: 30,
  tasksDoneTotal: 12,
  pagesCreated: [["2026-11-01", 3]],
  tasksDone: [
    ["2026-01-01", 9],
    ["2026-11-01", 2],
  ],
};

const project = (
  snapshot: InsightsUsageSnapshot,
  period: InsightsPeriod = "30d",
  today = "2026-11-07",
) => projectInsights({ usage: snapshot, content, period, today });

describe("projectInsights", () => {
  it("counts only what falls inside the period", () => {
    const view = project(
      usage({
        models: [modelDay("2026-11-01", "claude-opus-5-5"), modelDay("2026-01-01", "gpt-6.1-sol")],
        messages: [
          ["2026-11-01", 4],
          ["2026-01-01", 50],
        ],
      }),
    );
    expect(view.tokens).toBe(1000);
    expect(view.costUsd).toBe(2);
    expect(view.messages).toBe(4);
    expect(view.tasksDone).toBe(2);
    expect(view.pagesCreated).toBe(3);
    expect(view.models.map((model) => model.model)).toEqual(["claude-opus-5-5"]);
    // Library totals describe the Library as it is now, whatever the period.
    expect(view.tasksDoneTotal).toBe(12);
    expect(view.blockTotal).toBe(900);
  });

  it("includes the first and last day of a period and has one entry per day", () => {
    const view = project(
      usage({
        models: [modelDay("2026-11-01", "gpt-6.1-sol"), modelDay("2026-11-07", "gpt-6.1-sol")],
      }),
      "7d",
    );
    expect(view.days).toHaveLength(7);
    expect(view.firstDay).toBe("2026-11-01");
    expect(view.tokens).toBe(2000);
  });

  it("starts all time at the earliest thing it knows about", () => {
    const view = project(usage({ models: [modelDay("2026-03-02", "gpt-6.1-sol")] }), "all");
    expect(view.firstDay).toBe("2026-01-01");
  });

  it("ranks models and gives each a share of the total", () => {
    const view = project(
      usage({
        models: [
          modelDay("2026-11-01", "gpt-6.1-sol", { uncachedInputTokens: 750, cachedInputTokens: 0 }),
          modelDay("2026-11-02", "claude-opus-5-5", {
            uncachedInputTokens: 250,
            cachedInputTokens: 0,
          }),
        ],
      }),
    );
    expect(view.models.map((model) => [model.model, model.share])).toEqual([
      ["gpt-6.1-sol", 0.75],
      ["claude-opus-5-5", 0.25],
    ]);
    expect(view.days.find((day) => day.day === "2026-11-01")?.gpt).toBe(750);
  });

  it("reports the cache share and models without a price", () => {
    const view = project(
      usage({
        models: [
          modelDay("2026-11-01", "gpt-6.1-sol"),
          modelDay("2026-11-01", "mystery", { priced: false, costUsd: 0 }),
        ],
      }),
    );
    expect(view.cachedShare).toBe(0.9);
    expect(view.unpricedModels).toBe(1);
  });

  it("measures the longest unbroken run of active days and finds the biggest day", () => {
    const view = project(
      usage({
        models: [
          modelDay("2026-11-01", "gpt-6.1-sol"),
          modelDay("2026-11-02", "gpt-6.1-sol", { uncachedInputTokens: 5000 }),
          modelDay("2026-11-03", "gpt-6.1-sol"),
          modelDay("2026-11-05", "gpt-6.1-sol"),
        ],
      }),
    );
    expect(view.longestStreak).toBe(3);
    expect(view.activeDays).toBe(4);
    expect(view.biggestDay?.day).toBe("2026-11-02");
  });

  it("takes the period's busiest moment and adds up agent time", () => {
    const view = project(
      usage({
        agents: [
          { day: "2026-11-01", turns: 3, activeSeconds: 3600, peakAgents: 4 },
          { day: "2026-11-02", turns: 5, activeSeconds: 7200, peakAgents: 19 },
          { day: "2026-01-02", turns: 5, activeSeconds: 7200, peakAgents: 40 },
        ],
      }),
    );
    expect(view.peakAgents).toBe(19);
    expect(view.peakAgentsDay).toBe("2026-11-02");
    expect(view.agentTurns).toBe(8);
    expect(view.agentHours).toBe(3);
  });

  it("keeps the last seven days by the hour for a week's card", () => {
    const view = project(
      usage({
        hours: [
          ["2026-11-07", 23, 80],
          ["2026-11-01", 0, 20],
          ["2026-10-31", 5, 999],
        ],
      }),
    );
    expect(view.recentHours.map((row) => row.day)[0]).toBe("2026-11-01");
    expect(view.recentHours[0]?.hours[0]).toBe(20);
    expect(view.recentHours[6]?.hours[23]).toBe(80);
    expect(view.hours[5]).toBe(999);
  });

  it("lays days out in Sunday-first weeks", () => {
    const view = project(usage(), "7d");
    // 2026-11-01 is a Sunday, so the period is exactly one week.
    expect(view.calendar.weeks).toHaveLength(1);
    expect(view.calendar.weeks[0]?.[0]?.day).toBe("2026-11-01");
    expect(view.calendar.weeks[0]?.[6]?.day).toBe("2026-11-07");
  });

  it("works with no Core content available", () => {
    const view = projectInsights({
      usage: usage({ models: [modelDay("2026-11-01", "gpt-6.1-sol")] }),
      content: null,
      period: "30d",
      today: "2026-11-07",
    });
    expect(view.pageTotal).toBeNull();
    expect(view.tasksDone).toBe(0);
    expect(view.tokens).toBe(1000);
  });

  it("says nothing clever about an empty period", () => {
    expect(project(usage()).highlights).toEqual([]);
  });

  it("describes the biggest day, the night share and what a message sets off", () => {
    const view = project(
      usage({
        models: [
          modelDay("2026-11-01", "gpt-6.1-sol"),
          modelDay("2026-11-02", "gpt-6.1-sol", { uncachedInputTokens: 9100 }),
        ],
        messages: [["2026-11-01", 10]],
        hours: [
          ["2026-11-01", 23, 300],
          ["2026-11-01", 12, 700],
        ],
      }),
    );
    expect(view.highlights.map((highlight) => highlight.lead)).toEqual([
      "Nov 2 was your biggest day.",
      "30% of your tokens burn after 10pm.",
      "Every message you send sets off 1.1K tokens.",
    ]);
  });
});

describe("tokenSeries", () => {
  it("draws days while bars stay readable and weeks beyond that", () => {
    const models = [modelDay("2026-11-01", "gpt-6.1-sol")];
    expect(tokenSeries(project(usage({ models }), "90d"))).toHaveLength(90);
    const weekly = tokenSeries(project(usage({ models }), "12m"));
    expect(weekly).toHaveLength(53);
    expect(weekly.reduce((sum, point) => sum + point.tokens, 0)).toBe(1000);
  });
});

describe("tokenClub", () => {
  it.each([
    [999_999_999, null],
    [1e9, "1B Club"],
    [9.9e9, "1B Club"],
    [10e9, "10B Club"],
    [177e9, "100B Club"],
    [1e12, "1T Club"],
  ])("%d tokens is %s", (tokens, club) => {
    expect(tokenClub(tokens)).toBe(club);
  });
});

describe("agentArchetype", () => {
  const archetype = (snapshot: InsightsUsageSnapshot) => agentArchetype(project(snapshot));

  it("names the strongest signal first", () => {
    expect(
      archetype(
        usage({ agents: [{ day: "2026-11-01", turns: 1, activeSeconds: 1, peakAgents: 10 }] }),
      ),
    ).toBe("The Orchestrator");
    expect(archetype(usage({ hours: [["2026-11-01", 23, 100]] }))).toBe("The Night Shift");
    expect(
      archetype(
        usage({
          models: [modelDay("2026-11-01", "gpt-6.1-sol", { uncachedInputTokens: 6e6 })],
          messages: [["2026-11-01", 1]],
        }),
      ),
    ).toBe("The Delegator");
  });

  it("recognizes loyalty to one model", () => {
    expect(archetype(usage({ models: [modelDay("2026-11-01", "claude-opus-5-5")] }))).toBe(
      "Claude Opus 5.5 Loyalist",
    );
  });

  it("falls back to something everyone can wear", () => {
    expect(archetype(usage())).toBe("The Builder");
  });
});

describe("insights formatting", () => {
  it.each([
    [0, "0"],
    [999, "999"],
    [1500, "1.5K"],
    [250_000, "250K"],
    [54_663_250_104, "54.7B"],
    [176_628_875_040, "177B"],
    [1_200_000_000_000, "1.2T"],
  ])("compacts %d to %s", (value, label) => {
    expect(compactNumber(value)).toBe(label);
  });

  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-opus-5-5-20261001", "Claude Opus 5.5"],
    ["claude-opus-5-5[1m]", "Claude Opus 5.5"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-5.3-codex", "GPT-5.3 Codex"],
    ["opencode/deepseek-v4.1-flash-free", "Deepseek V4.1 Flash Free"],
  ])("names %s as %s", (model, name) => {
    expect(modelDisplayName(model)).toBe(name);
  });

  it("groups a model into its maker's color", () => {
    expect(modelFamily("claude-opus-5-5")).toBe("claude");
    expect(modelFamily("gpt-6.1-sol")).toBe("gpt");
    expect(modelFamily("o3-mini")).toBe("gpt");
    expect(modelFamily("deepseek-v4")).toBe("other");
  });

  it("keeps empty days apart from quiet ones and the largest in the top shade", () => {
    expect(heatStep(0, 100, 5)).toBe(-1);
    expect(heatStep(5, 0, 5)).toBe(-1);
    expect(heatStep(1, 100, 5)).toBe(0);
    expect(heatStep(100, 100, 5)).toBe(4);
  });

  it.each([
    [0, 1],
    [3, 5],
    [4.9e9, 5e9],
    [5.1e9, 1e10],
    [1.2e9, 2e9],
    [2.2e6, 2.5e6],
  ])("rounds an axis holding %d up to %d", (value, top) => {
    expect(axisMaximum(value)).toBeCloseTo(top, 3);
  });

  it("never rounds a real share down to nothing", () => {
    expect(shareLabel(0)).toBe("0%");
    expect(shareLabel(0.004)).toBe("<1%");
    expect(shareLabel(0.746)).toBe("75%");
  });
});
