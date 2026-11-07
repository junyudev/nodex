import { describe, expect, it } from "vitest";

import type { InsightsUsageSnapshot } from "../../../shared/insights";
import {
  renderShareCard,
  renderSkylineCity,
  shareFileName,
  shareMessage,
  shareStats,
  skylineGrid,
  type ShareCardOptions,
} from "./insights-cards";
import { projectInsights, type InsightsPeriod } from "./insights-model";

const usage: InsightsUsageSnapshot = {
  access: "granted",
  revision: 1,
  scan: { state: "idle", filesDone: 0, filesTotal: 0, failedFiles: 0, finishedAtMs: 1 },
  pricing: "fresh",
  models: [
    {
      day: "2026-11-01",
      provider: "claude",
      model: "claude-opus-5-5",
      uncachedInputTokens: 1e9,
      cachedInputTokens: 99e9,
      cacheCreationTokens: 0,
      outputTokens: 1e8,
      requests: 900,
      costUsd: 77180,
      cacheSavingsUsd: 579811,
      priced: true,
    },
  ],
  messages: [["2026-11-01", 3416]],
  conversations: [["2026-11-01", 60]],
  hours: [["2026-11-01", 23, 100.1e9]],
  agents: [{ day: "2026-11-01", turns: 40, activeSeconds: 7200, peakAgents: 19 }],
};

const emptyContent = {
  pageTotal: 0,
  blockTotal: 0,
  taskTotal: 0,
  tasksDoneTotal: 0,
  pagesCreated: [],
  tasksDone: [],
};

const view = (period: InsightsPeriod = "12m") =>
  projectInsights({ usage, content: null, period, today: "2026-11-07" });

const options = (overrides: Partial<ShareCardOptions> = {}): ShareCardOptions => ({
  kind: "skyline",
  showCost: true,
  name: "",
  ...overrides,
});

describe("share cards", () => {
  it.each(["skyline", "receipt"] as const)("%s is a self-contained 4:5 picture", (kind) => {
    const svg = renderShareCard(view(), options({ kind }));
    expect(svg).toMatch(/^<svg [^>]*width="1080" height="1350"/);
    // A canvas refuses images that embed HTML or reach outside themselves.
    expect(svg).not.toContain("foreignObject");
    expect(svg).not.toMatch(/(?:href|src)="https?:/);
  });

  it.each(["skyline", "receipt"] as const)("%s shows the number and where to get one", (kind) => {
    const svg = renderShareCard(view(), options({ kind }));
    expect(svg).toContain("100B");
    expect(svg).toContain("nodex.jyu.app");
  });

  it.each(["skyline", "receipt"] as const)("%s can leave the money out", (kind) => {
    expect(renderShareCard(view(), options({ kind }))).toContain("$77,180");
    const hidden = renderShareCard(view(), options({ kind, showCost: false }));
    expect(hidden).not.toContain("$");
  });

  it.each(["skyline", "receipt"] as const)("%s names no one unless asked to", (kind) => {
    expect(renderShareCard(view(), options({ kind }))).not.toContain("Ada");
    expect(renderShareCard(view(), options({ kind, name: "Ada" })).toUpperCase()).toContain("ADA");
  });

  it("escapes what a person types into their name", () => {
    const svg = renderShareCard(view(), options({ name: `<script>"&` }));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&quot;&amp;");
  });

  it("embeds fonts only when it has them", () => {
    expect(renderShareCard(view(), options())).not.toContain("@font-face");
    const svg = renderShareCard(view(), options(), {
      sans: "data:font/woff2;base64,AAAA",
      mono: "data:font/woff2;base64,BBBB",
    });
    expect(svg).toContain("base64,AAAA");
    expect(svg).toContain("base64,BBBB");
  });

  it("offers its strongest non-zero numbers", () => {
    expect(shareStats(view()).map((stat) => stat.label)).toEqual([
      "agents at once",
      "messages sent",
      "day streak",
      "conversations",
    ]);
  });

  it("counts in the singular and keeps one agent at a time off the card", () => {
    const quiet = projectInsights({
      usage: {
        ...usage,
        messages: [["2026-11-01", 1]],
        conversations: [["2026-11-01", 1]],
        agents: [{ day: "2026-11-01", turns: 1, activeSeconds: 60, peakAgents: 1 }],
      },
      content: { ...emptyContent, pagesCreated: [["2026-11-01", 1]] },
      period: "30d",
      today: "2026-11-07",
    });
    expect(shareStats(quiet).map((stat) => `${stat.value} ${stat.label}`)).toEqual([
      "1 message sent",
      "1 day streak",
      "1 conversation",
      "1 page written",
    ]);
  });

  it("does not say the same thing twice", () => {
    const steady = projectInsights({
      usage: {
        ...usage,
        agents: [],
        conversations: [],
        models: Array.from({ length: 7 }, (_, index) => ({
          ...usage.models[0]!,
          day: `2026-11-0${index + 1}`,
        })),
      },
      content: null,
      period: "7d",
      today: "2026-11-07",
    });
    const labels = shareStats(steady).map((stat) => stat.label);
    expect(labels).toContain("day streak");
    expect(labels).not.toContain("active days");
  });

  it("words a post from the numbers and names the file after the day", () => {
    expect(shareMessage(view())).toBe(
      "100B tokens with my agents. 19 agents at once. 3,416 messages sent. What's yours? nodex.jyu.app",
    );
    expect(shareFileName(view(), "receipt")).toBe("nodex-receipt-2026-11-07.png");
  });
});

describe("skyline city", () => {
  it("shows a week by the hour and longer periods by the day", () => {
    const week = skylineGrid(view("7d"));
    expect([week.columns, week.rows, week.cells.length]).toEqual([24, 7, 168]);
    const year = skylineGrid(view("30d"));
    expect(year.rows).toBe(7);
    expect(year.cells.every((cell) => cell.column < year.columns)).toBe(true);
  });

  it("drops empty weeks before the first activity so the city fills the card", () => {
    const grid = skylineGrid(view("12m"));
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
      const svg = renderSkylineCity({ columns, rows: 7, cells }, area);
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
    );
    expect(svg).toContain("5B on Nov 1");
    const empty = renderSkylineCity(
      { columns: 1, rows: 1, cells: [{ column: 0, row: 0, value: 0, label: "Nov 1" }] },
      { width: 1020, height: 600 },
    );
    expect(empty).not.toContain("NaN");
  });
});
