import { describe, expect, it } from "vitest";

import { ccusageCardView } from "./adapter";
import dailyByAgent from "./fixtures/daily-by-agent.json";
import noCost from "./fixtures/no-cost.json";
import { CcusageError, parseCcusageReport } from "./run";

const span = { period: "range", firstDay: "2025-12-27", lastDay: "2025-12-31" } as const;
const sessionWindow = { since: span.firstDay, until: span.lastDay };

describe("ccusage share cards", () => {
  it("counts the four processed token categories and fills gaps between active days", () => {
    const report = parseCcusageReport(JSON.stringify(dailyByAgent), sessionWindow);
    const card = ccusageCardView(report, span);

    // The selected Goose and Copilot rows include 50 additional tokens outside these categories.
    expect(card.tokens).toBe(47_232);
    expect(card.cachedShare).toBeCloseTo(7_913 / 47_232);
    expect(card.costUsd).toBeCloseTo(3.7921505);
    expect(card.activeDays).toBe(3);
    expect(card.longestStreak).toBe(2);
    expect(card.days).toEqual([
      { day: "2025-12-27", tokens: 7_831 },
      { day: "2025-12-28", tokens: 0 },
      { day: "2025-12-29", tokens: 0 },
      { day: "2025-12-30", tokens: 27_774 },
      { day: "2025-12-31", tokens: 11_627 },
    ]);
    expect(card.sources).toEqual(["Codex", "pi-agent", "GitHub Copilot CLI", "Goose"]);
    expect(card.models[0]).toMatchObject({
      label: "GPT-5",
      tokens: 22_441,
      share: expect.closeTo(22_441 / 47_232),
      costUsd: expect.closeTo(0.1480475, 7),
    });
    expect(card.models).toContainEqual(
      expect.objectContaining({ label: "Claude Sonnet 4", tokens: 3_850 }),
    );
    expect(card.models.every((model) => model.tokens > 0)).toBe(true);
    expect(card.models.reduce((total, model) => total + model.share, 0)).toBeCloseTo(1);
    expect(card.conversations).toBe(3);
  });

  it("uses a session count only for the window ccusage queried", () => {
    const report = parseCcusageReport(JSON.stringify(dailyByAgent), sessionWindow);
    const card = ccusageCardView(report, { ...span, firstDay: "2025-12-30" });

    expect(card.tokens).toBe(39_401);
    expect(card.sources).toEqual(["Codex", "GitHub Copilot CLI"]);
    expect(card.conversations).toBe(0);
  });

  it("accepts omitted cost fields and still counts tokens and sessions", () => {
    const day = "2026-04-21";
    const report = parseCcusageReport(JSON.stringify(noCost), { since: day, until: day });
    const card = ccusageCardView(report, { period: "range", firstDay: day, lastDay: day });

    expect(card).toMatchObject({
      tokens: 3_500,
      costUsd: 0,
      cacheSavingsUsd: null,
      conversations: 1,
      sources: ["Kimi"],
      models: [{ label: "Kimi For Coding", tokens: 3_500, share: 1, costUsd: 0 }],
    });
  });

  it("accepts empty ccusage sections", () => {
    const report = parseCcusageReport('{"daily":[],"session":[]}', sessionWindow);
    const card = ccusageCardView(report, span);

    expect(card.tokens).toBe(0);
    expect(card.cachedShare).toBe(0);
    expect(card.conversations).toBe(0);
    expect(card.models).toEqual([]);
    expect(card.sources).toEqual([]);
  });
});

describe("ccusage JSON boundary", () => {
  it.each([
    ["broken JSON", "{"],
    [
      "a daily row without its agent breakdown",
      JSON.stringify({
        ...dailyByAgent,
        daily: [{ ...dailyByAgent.daily[0], agents: undefined }],
      }),
    ],
    ["a session row without its identifier", '{"daily":[],"session":[{"agent":"codex"}]}'],
    [
      "a token count encoded as a string",
      JSON.stringify({
        ...dailyByAgent,
        daily: [{ ...dailyByAgent.daily[0], inputTokens: "11" }],
      }),
    ],
  ])("reports %s as a typed error with stderr", (_, stdout) => {
    const parse = () => parseCcusageReport(stdout, sessionWindow, "ccusage diagnostic\n");

    expect(parse).toThrow(CcusageError);
    expect(parse).toThrow(
      expect.objectContaining({ kind: "invalid-report", stderr: "ccusage diagnostic\n" }),
    );
  });
});
