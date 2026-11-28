import { request } from "node:http";
import { createIntl } from "@formatjs/intl";
import { shareCardCalendar, type ShareCardView } from "@nodex/insights-cards";
import zhCN from "@nodex/insights-cards/catalogs/zh-CN.json";
import { describe, expect, it } from "vitest";

import { ArgumentError, resolveArgs } from "./args";
import { detectLocale } from "./locale";
import { PREVIEW_CSP, servePreview } from "./server";
import { activityLine, columns, terminalSummary } from "./summary";

const today = "2026-12-05";
const parse = (...args: string[]) => resolveArgs(args, today, "en-US");

describe("preview arguments", () => {
  it("uses the current local year through today, or a complete past year", () => {
    expect(parse()).toMatchObject({ period: "year", firstDay: "2026-01-01", lastDay: today });
    expect(parse("--year", "2026")).toMatchObject({ period: "year", lastDay: today });
    expect(parse("--year", "2024")).toMatchObject({
      period: "year",
      firstDay: "2024-01-01",
      lastDay: "2024-12-31",
    });
  });

  it("resolves inclusive custom ranges and defaults their omitted endpoint", () => {
    expect(parse("--since", "2024-02-29", "--no-cost", "--no-open")).toMatchObject({
      period: "range",
      firstDay: "2024-02-29",
      lastDay: today,
      cost: false,
      open: false,
    });
    expect(parse("--until", "2024-02-29")).toMatchObject({
      period: "range",
      firstDay: "2024-01-01",
      lastDay: "2024-02-29",
    });
    expect(parse("--since", today, "--until", today)).toMatchObject({
      period: "range",
      firstDay: today,
      lastDay: today,
    });
  });

  it.each([
    ["--since", "2025-02-29"],
    ["--since", "2026-1-01"],
    ["--since", "2026-12-06"],
    ["--year", "26"],
    ["--year", "2027"],
    ["--year", "2025", "--until", today],
    ["--name", "a".repeat(33)],
    ["--unknown"],
  ])("rejects invalid arguments %j", (...args) => {
    expect(() => parse(...args)).toThrow(ArgumentError);
  });
});

describe("locale detection", () => {
  it("uses the first nonempty locale setting", () => {
    expect(detectLocale({ LC_ALL: "en_SG", LC_MESSAGES: "zh_CN", LANG: "zh_TW" })).toBe("en-US");
    expect(detectLocale({ LC_ALL: "", LC_MESSAGES: "zh_HK.UTF-8", LANG: "C" })).toBe("zh-CN");
    expect(detectLocale({ LANG: "zh_TW" })).toBe("zh-CN");
    expect(detectLocale({}, "en-US")).toBe("en-US");
    // C names no language, so an unconfigured shell falls through to the system's.
    expect(detectLocale({ LC_ALL: "C.UTF-8", LANG: "zh_CN.UTF-8" }, "en-US")).toBe("zh-CN");
    expect(detectLocale({ LC_ALL: "C", LANG: "POSIX" }, "zh-Hans-CN")).toBe("zh-CN");
  });
});

function get(url: URL, host: string) {
  return new Promise<{ status: number | undefined; body: string; csp: unknown; cache: unknown }>(
    (resolve, reject) => {
      request(url, { headers: { host } }, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (part: string) => {
          body += part;
        });
        response.once("error", reject);
        response.once("end", () =>
          resolve({
            status: response.statusCode,
            body,
            csp: response.headers["content-security-policy"],
            cache: response.headers["cache-control"],
          }),
        );
      })
        .once("error", reject)
        .end();
    },
  );
}

it("serves the preview only at the loopback origin and route", async () => {
  const controller = new AbortController();
  const html = "<!doctype html><title>Preview</title>";
  const url = new URL(await servePreview(html, controller.signal));
  try {
    expect(url.hostname).toBe("127.0.0.1");
    await expect(get(url, url.host)).resolves.toEqual({
      status: 200,
      body: html,
      csp: PREVIEW_CSP,
      cache: "no-store",
    });
    await expect(get(url, `localhost:${url.port}`)).resolves.toMatchObject({
      status: 200,
      body: html,
    });
    await expect(get(url, `example.com:${url.port}`)).resolves.toMatchObject({
      status: 403,
      body: "",
    });
    await expect(get(url, url.hostname)).resolves.toMatchObject({ status: 403, body: "" });
    await expect(get(new URL("/favicon.ico", url), url.host)).resolves.toMatchObject({
      status: 404,
      body: "",
    });
  } finally {
    controller.abort();
  }
});

describe("terminal summary", () => {
  const english = createIntl({ locale: "en-US", defaultLocale: "en-US" });
  const chinese = createIntl({ locale: "zh-CN", defaultLocale: "en-US", messages: zhCN });
  const days = Array.from({ length: 365 }, (_, index) => ({
    day: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    tokens: index % 3 === 0 ? 0 : (index + 1) * 1e7,
  }));
  const view: ShareCardView = {
    period: "year",
    firstDay: "2026-01-01",
    lastDay: "2026-12-31",
    days,
    calendar: shareCardCalendar(days),
    recentHours: [],
    hours: Array.from({ length: 24 }, () => 0),
    tokens: 211e9,
    cachedShare: 0.9,
    costUsd: 104_787,
    cacheSavingsUsd: null,
    activeDays: 243,
    longestStreak: 2,
    messages: 0,
    conversations: 12_188,
    peakAgents: 0,
    tasksDone: 0,
    pagesCreated: 0,
    models: Array.from({ length: 38 }, (_, index) => ({
      label:
        index === 0 ? "A model with a name far too long for any receipt column" : `模型 ${index}`,
      tokens: 1e9 * (40 - index),
      share: 0.02,
      costUsd: 900 * (40 - index),
    })),
    sources: [
      "Codex",
      "Claude Code",
      "Antigravity",
      "OpenClaw",
      "OpenCode",
      "Hermes Agent",
      "Amp",
      "pi-agent",
      "DeepSeek Harness",
    ],
  };
  const plain = { color: false, width: 80 };

  it.each([
    ["English", english],
    ["Chinese", chinese],
  ])("fits an 80-column terminal in %s", (_, intl) => {
    const text = terminalSummary(view, intl, { ...plain, showCost: true });
    expect(Math.max(...text.split("\n").map(columns))).toBeLessThanOrEqual(80);
    expect(text).not.toContain("\u001b[");
    // Every counted agent is named, wrapped rather than cut.
    for (const source of view.sources ?? []) expect(text).toContain(source);
  });

  it("leaves every price out when the cost is hidden", () => {
    expect(terminalSummary(view, english, { ...plain, showCost: true })).toContain("$104,787");
    expect(terminalSummary(view, english, { ...plain, showCost: false })).not.toContain("$");
  });

  it("draws a year as weekly bars and a short span as daily ones", () => {
    // The first active day starts the line, as the Skyline drops the empty weeks before it.
    expect(activityLine(view, 76).bars).toHaveLength(Math.ceil(364 / 7));
    const month = { ...view, days: days.slice(0, 30) };
    expect(activityLine(month, 76).bars).toHaveLength(29);
  });
});
