import { describe, expect, it } from "vitest";

import { createIntl } from "@formatjs/intl";
import { renderSkylineCity, skylineGrid, sourceLines } from "./cards";
import zhCN from "./catalogs/zh-CN.json";
import {
  agentArchetype,
  compactNumber,
  modelDisplayName,
  renderShareCard,
  shareCardCalendar,
  shareFileName,
  shareMessage,
  sharePeriodLabel,
  shareStats,
  tokenClub,
  type ShareCardOptions,
  type ShareCardView,
} from "./index";

const intl = createIntl({ locale: "en-US", defaultLocale: "en-US" });
const chinese = createIntl({ locale: "zh-CN", defaultLocale: "en-US", messages: zhCN });

const firstDays = { "7d": "2026-11-01", "30d": "2026-10-09", "12m": "2025-11-08" };
const lastDay = "2026-11-07";
const tokens = 100.1e9;
const costUsd = 77180;

const hoursWithTokens = (hour: number, value: number) =>
  Array.from({ length: 24 }, (_, index) => (index === hour ? value : 0));

function view(period: keyof typeof firstDays = "12m"): ShareCardView {
  const firstDay = firstDays[period];
  const days = [];
  for (let time = Date.parse(firstDay); time <= Date.parse(lastDay); time += 86_400_000) {
    const day = new Date(time).toISOString().slice(0, 10);
    days.push({ day, tokens: day === "2026-11-01" ? tokens : 0 });
  }
  const hours = hoursWithTokens(23, tokens);
  return {
    period,
    firstDay,
    lastDay,
    days,
    calendar: shareCardCalendar(days),
    recentHours: days.slice(-7).map(({ day, tokens }) => ({
      day,
      hours: hoursWithTokens(23, tokens),
    })),
    hours,
    tokens,
    cachedShare: 99e9 / tokens,
    costUsd,
    cacheSavingsUsd: 579811,
    activeDays: 1,
    longestStreak: 1,
    messages: 3416,
    conversations: 60,
    peakAgents: 19,
    tasksDone: 0,
    pagesCreated: 0,
    models: [{ label: "Claude Opus 5.5", tokens, share: 1, costUsd }],
  };
}

const options = (overrides: Partial<ShareCardOptions> = {}): ShareCardOptions => ({
  kind: "skyline",
  showCost: true,
  name: "",
  ...overrides,
});

describe("share cards", () => {
  it.each(["skyline", "receipt"] as const)("%s is a self-contained 4:5 picture", (kind) => {
    const svg = renderShareCard(view(), options({ kind }), intl);
    const root = /^<([a-z]+) [^>]*width="(\d+)" height="(\d+)"/u.exec(svg);
    expect(root?.slice(1)).toEqual(["svg", "1080", "1350"]);
    // A canvas refuses images that embed HTML or reach outside themselves.
    expect(svg).not.toContain("foreignObject");
    expect(svg).not.toMatch(/(?:href|src)="https?:/);
  });

  it.each(["skyline", "receipt"] as const)("%s shows the number and where to get one", (kind) => {
    const svg = renderShareCard(view(), options({ kind }), intl);
    expect(svg).toContain("100B");
    expect(svg).toContain("nodex.jyu.app");
    // A viewer can make their own without installing anything.
    expect(svg).toContain(">npx nodex-card</text>");
  });

  it.each(["skyline", "receipt"] as const)("%s can leave the money out", (kind) => {
    expect(renderShareCard(view(), options({ kind }), intl)).toContain("$77,180");
    const hidden = renderShareCard(view(), options({ kind, showCost: false }), intl);
    expect(hidden).not.toContain("$");
  });

  it.each(["skyline", "receipt"] as const)("%s names no one unless asked to", (kind) => {
    expect(renderShareCard(view(), options({ kind }), intl)).not.toContain("Ada");
    expect(renderShareCard(view(), options({ kind, name: "Ada" }), intl).toUpperCase()).toContain(
      "ADA",
    );
  });

  it("escapes what a person types into their name", () => {
    const svg = renderShareCard(view(), options({ name: `<script>"&` }), intl);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;");
  });

  it("embeds fonts only when it has them", () => {
    expect(renderShareCard(view(), options(), intl)).not.toContain("@font-face");
    const svg = renderShareCard(view(), options(), intl, {
      sans: "data:font/woff2;base64,AAAA",
      mono: "data:font/woff2;base64,BBBB",
    });
    expect(svg).toContain("base64,AAAA");
    expect(svg).toContain("base64,BBBB");
  });

  it("offers its strongest non-zero numbers", () => {
    expect(shareStats(view(), intl).map((stat) => stat.label)).toEqual([
      "agents at once",
      "messages sent",
      "day streak",
      "conversations",
    ]);
  });

  it("counts in the singular and keeps one agent at a time off the card", () => {
    const quiet = { ...view("30d"), messages: 1, conversations: 1, peakAgents: 1, pagesCreated: 1 };
    expect(shareStats(quiet, intl).map((stat) => `${stat.value} ${stat.label}`)).toEqual([
      "1 message sent",
      "1 day streak",
      "1 conversation",
      "1 page written",
    ]);
  });

  it("does not say the same thing twice", () => {
    const steady = {
      ...view("7d"),
      activeDays: 7,
      longestStreak: 7,
      peakAgents: 0,
      conversations: 0,
    };
    const labels = shareStats(steady, intl).map((stat) => stat.label);
    expect(labels).toContain("day streak");
    expect(labels).not.toContain("active days");
  });

  it("uses the calendar year in the Skyline question and on the Receipt", () => {
    const yearly = {
      ...view(),
      period: "year",
      firstDay: "2041-01-01",
      lastDay: "2041-12-31",
    } as const;
    expect(sharePeriodLabel(yearly, intl)).toBe("2041");
    expect(renderShareCard(yearly, options(), intl)).toMatch(/>[^<]* 2041 [^<]*\?<\/text>/u);
    expect(renderShareCard(yearly, options(), chinese)).toMatch(/>[^<]* 2041 年[^<]*？<\/text>/u);
    expect(renderShareCard(yearly, options({ kind: "receipt" }), intl)).toContain(">2041 · 1");
  });

  it("uses UTC calendar dates for a localized range and keeps the all-time Skyline question", () => {
    const range = {
      ...view(),
      period: "range",
      firstDay: "2025-12-31",
      lastDay: "2026-01-01",
    } as const;
    const all = { ...range, period: "all" } as const;
    const westCoast = createIntl({
      locale: "en-US",
      defaultLocale: "en-US",
      timeZone: "America/Los_Angeles",
    });
    const rangeLabel = sharePeriodLabel(range, westCoast);
    expect(rangeLabel).toMatch(/^Dec 31, 2025.*Jan 1, 2026$/u);
    expect(sharePeriodLabel(range, chinese)).toMatch(/^2025[/年]12[/月]31.*2026[/年]1[/月]1日?$/u);
    expect(renderShareCard(range, options(), westCoast)).toBe(
      renderShareCard(all, options(), westCoast).replace(
        `>${sharePeriodLabel(all, westCoast)}<`,
        `>${rangeLabel}<`,
      ),
    );
  });

  it("keeps model cost and the total when cache savings are unknown", () => {
    const receipt = options({ kind: "receipt" });
    const amounts = (svg: string) =>
      Array.from(svg.matchAll(/>(-?\$[0-9,]+)<\/text>/gu), (match) => match[1]);
    expect(amounts(renderShareCard(view(), receipt, intl))).toEqual([
      "$77,180",
      "$656,991",
      "-$579,811",
      "$77,180",
    ]);
    expect(amounts(renderShareCard({ ...view(), cacheSavingsUsd: null }, receipt, intl))).toEqual([
      "$77,180",
      "$77,180",
    ]);
  });

  it("words a post from the numbers and names the file after the day", () => {
    expect(shareMessage(view(), intl)).toBe(
      "100B tokens with my agents. 19 agents at once. 3,416 messages sent. What's yours? npx nodex-card · nodex.jyu.app",
    );
    expect(shareFileName(view(), "receipt")).toBe("nodex-receipt-2026-11-07.png");
  });

  it("puts the cost in a post only when the card shows it", () => {
    expect(shareMessage(view(), intl, { showCost: true })).toBe(
      "100B tokens with my agents, ≈ $77,180 at API list price. 19 agents at once. 3,416 messages sent. What's yours? npx nodex-card · nodex.jyu.app",
    );
    expect(shareMessage({ ...view(), costUsd: 0 }, intl, { showCost: true })).toBe(
      shareMessage(view(), intl),
    );
  });

  it.each(["skyline", "receipt"] as const)("%s draws dark unless asked for light", (kind) => {
    expect(renderShareCard(view(), options({ kind }), intl)).toBe(
      renderShareCard(view(), options({ kind, theme: "dark" }), intl),
    );
    expect(renderShareCard(view(), options({ kind, theme: "light" }), intl)).not.toBe(
      renderShareCard(view(), options({ kind }), intl),
    );
  });

  it.each(["skyline", "receipt"] as const)("%s names the agents it counted", (kind) => {
    const counted = { ...view(), sources: ["Claude Code", "Codex", "Gemini CLI"] };
    const svg = renderShareCard(counted, options({ kind }), intl);
    const names =
      kind === "skyline" ? "Claude Code · Codex · Gemini CLI" : "CLAUDE CODE · CODEX · GEMINI CLI";
    expect(svg).toContain(names);
    expect(renderShareCard(view(), options({ kind }), intl)).not.toContain("Codex");
  });

  it("makes a Receipt's total at API list price its headline", () => {
    const headline = 'font-size="72" font-weight="700" fill="#17171a" text-anchor="end">$77,180<';
    const receipt = options({ kind: "receipt" });
    expect(renderShareCard(view(), receipt, intl)).toContain(headline);
    expect(renderShareCard(view(), { ...receipt, showCost: false }, intl)).not.toContain("$");
  });
});

describe("sourceLines", () => {
  const names = ["Claude Code", "Codex", "Gemini CLI", "OpenCode", "Antigravity"];

  it("keeps every name that fits", () => {
    expect(sourceLines(names, 80, 1)).toEqual([
      "Claude Code · Codex · Gemini CLI · OpenCode · Antigravity",
    ]);
  });

  it("wraps by name and counts what is left once its lines are full", () => {
    expect(sourceLines(names, 26, 2)).toEqual(["Claude Code · Codex", "Gemini CLI · OpenCode +1"]);
    expect(sourceLines(names, 26, 1)).toEqual(["Claude Code · Codex +3"]);
  });

  it("always names at least one agent", () => {
    expect(sourceLines(names, 4, 1)).toEqual(["Claude Code +4"]);
    expect(sourceLines(["Claude Code"], 4, 1)).toEqual(["Claude Code"]);
    expect(sourceLines([], 40, 1)).toEqual([]);
  });
});

describe("skyline city", () => {
  it("shows a week by the hour and longer periods by the day", () => {
    const week = skylineGrid(view("7d"), intl);
    expect([week.columns, week.rows, week.cells.length]).toEqual([24, 7, 168]);
    const year = skylineGrid(view("30d"), intl);
    expect(year.rows).toBe(7);
    expect(year.cells.every((cell) => cell.column < year.columns)).toBe(true);
  });

  it("drops empty weeks before the first activity so the city fills the card", () => {
    const grid = skylineGrid(view("12m"), intl);
    expect(grid.columns).toBeLessThanOrEqual(2);
    expect(grid.cells.some((cell) => cell.value > 0)).toBe(true);
  });

  it("stays inside its area however many towers it holds", () => {
    const area = { width: 1020, height: 600 };
    for (const columns of [1, 6, 53, 200]) {
      const cells = Array.from({ length: columns * 7 }, (_, index) => ({
        column: Math.floor(index / 7),
        row: index % 7,
        value: index + 1,
        label: `day ${index}`,
      }));
      const svg = renderSkylineCity({ columns, rows: 7, cells }, area, intl);
      const xs = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((match) =>
        match[1]!.split(" ").map((point) => Number(point.split(",")[0])),
      );
      const ys = [...svg.matchAll(/points="([^"]+)"/g)].flatMap((match) =>
        match[1]!.split(" ").map((point) => Number(point.split(",")[1])),
      );
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
      expect(Math.max(...xs)).toBeLessThanOrEqual(area.width + 1);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      expect(Math.max(...ys)).toBeLessThanOrEqual(area.height + 1);
    }
  });

  it("labels its tallest tower and draws an empty city without failing", () => {
    const svg = renderSkylineCity(
      {
        columns: 2,
        rows: 1,
        cells: [
          { column: 0, row: 0, value: 5e9, label: "Nov 1" },
          { column: 1, row: 0, value: 1, label: "Nov 2" },
        ],
      },
      { width: 1020, height: 600 },
      intl,
    );
    expect(svg).toContain("5B on Nov 1");
    const empty = renderSkylineCity(
      { columns: 1, rows: 1, cells: [{ column: 0, row: 0, value: 0, label: "Nov 1" }] },
      { width: 1020, height: 600 },
      intl,
    );
    expect(empty).not.toContain("NaN");
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
    expect(tokenClub(tokens, intl)).toBe(club);
  });
});

describe("agentArchetype", () => {
  const archetype = (overrides: Partial<ShareCardView> = {}) =>
    agentArchetype(
      {
        ...view(),
        tokens: 0,
        hours: hoursWithTokens(0, 0),
        peakAgents: 0,
        longestStreak: 0,
        models: [],
        ...overrides,
      },
      intl,
    );

  it("names the strongest signal first", () => {
    const hours = hoursWithTokens(23, 100);
    expect(archetype({ hours, peakAgents: 10 })).toBe("The Orchestrator");
    expect(archetype({ hours, messages: 1, tokens: 6e6 })).toBe("The Night Shift");
    expect(archetype({ messages: 1, tokens: 6e6 })).toBe("The Delegator");
  });

  it("recognizes loyalty to one model", () => {
    expect(archetype({ models: view().models })).toBe("Claude Opus 5.5 Loyalist");
  });

  it("falls back to something everyone can wear", () => {
    expect(archetype()).toBe("The Builder");
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
    expect(compactNumber(value, intl)).toBe(label);
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
});
