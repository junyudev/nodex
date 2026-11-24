import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";
import type { ProviderKeyConnection } from "../../../shared/provider-keys";
import { providerKeyUsageReader } from "./ProviderKeyUsageReader";

const key = Redacted.make("test-secret-value");
const connection = (
  preset: ProviderKeyConnection["preset"],
  endpoint: ProviderKeyConnection["endpoint"] = "international",
): ProviderKeyConnection => ({
  preset,
  endpoint,
  id: preset,
  agent: "codex",
  displayName: preset,
  baseUrl: null,
  enabled: true,
  models: [],
  keyHint: "alue",
});

const balance = {
  currency: "CNY",
  total_balance: "2.90",
  granted_balance: "0.00",
  topped_up_balance: "2.90",
};
const kimi = {
  code: 0,
  status: true,
  scode: "0x0",
  data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 },
};
const miniMaxChat = {
  model_name: "MiniMax-M*",
  start_time: 1776355200000,
  end_time: 1776373200000,
  current_interval_total_count: 1500,
  current_interval_usage_count: 1125,
  current_interval_remaining_percent: 60,
  weekly_start_time: 1776009600000,
  weekly_end_time: 1776614400000,
  current_weekly_total_count: 10000,
  current_weekly_usage_count: 5000,
};
const plan = (model_remains: readonly unknown[]) => ({
  base_resp: { status_code: 0 },
  model_remains,
});

const windows = (fiveHour: number, weekly: number) => ({
  balance: null,
  windows: [
    { id: "five_hour", usedPercent: fiveHour, durationMins: 300, resetsAt: miniMaxChat.end_time },
    {
      id: "weekly",
      usedPercent: weekly,
      durationMins: 10080,
      resetsAt: miniMaxChat.weekly_end_time,
    },
  ],
});

it.effect("reads DeepSeek's largest currency balance and keeps an exhausted balance", () =>
  Effect.gen(function* () {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          is_available: true,
          balance_infos: [{ currency: "USD", total_balance: "1.00" }, balance],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          is_available: false,
          balance_infos: [{ ...balance, total_balance: "-0.25" }],
        }),
      );
    const read = providerKeyUsageReader(request)(connection("deepseek"))!;
    expect(yield* read(key)).toEqual({ balance: { amount: 2.9, currency: "CNY" }, windows: [] });
    expect(yield* read(key)).toEqual({ balance: { amount: -0.25, currency: "CNY" }, windows: [] });
    expect(request.mock.calls[0]?.[0]).toBe("https://api.deepseek.com/user/balance");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "error",
      headers: { Authorization: "Bearer test-secret-value" },
    });
  }),
);

it.effect.each([
  { region: "china", domain: "cn", currency: "CNY" },
  { region: "international", domain: "ai", currency: "USD" },
] as const)(
  "uses Kimi's $region endpoint and reports available balance in major units",
  ({ region, domain, currency }) =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(kimi));
      const read = providerKeyUsageReader(request)(connection("moonshot", region))!;
      expect(yield* read(key)).toEqual({ balance: { amount: 49.58894, currency }, windows: [] });
      expect(request.mock.calls[0]?.[0]).toBe(`https://api.moonshot.${domain}/v1/users/me/balance`);
    }),
);

it.effect.each([
  { region: "china", domain: "minimaxi.com" },
  { region: "international", domain: "minimax.io" },
] as const)(
  "uses MiniMax's $region endpoint and converts remaining chat quota into used percentages",
  ({ region, domain }) =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          Response.json(
            plan([
              { ...miniMaxChat, model_name: "image-01", current_interval_usage_count: 0 },
              miniMaxChat,
            ]),
          ),
        );
      const read = providerKeyUsageReader(request)(connection("minimax", region))!;
      expect(yield* read(key)).toEqual(windows(25, 50));
      expect(request.mock.calls[0]?.[0]).toBe(`https://api.${domain}/v1/token_plan/remains`);
    }),
);

it.effect("reads time-based MiniMax quotas whose count totals are zero", () =>
  Effect.gen(function* () {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        plan([
          {
            ...miniMaxChat,
            model_name: "general",
            current_interval_total_count: 0,
            current_interval_usage_count: 0,
            current_weekly_total_count: 0,
            current_weekly_usage_count: 0,
            current_interval_remaining_percent: 85,
            current_weekly_remaining_percent: 0,
          },
        ]),
      ),
    );
    expect(yield* providerKeyUsageReader(request)(connection("minimax"))!(key)).toEqual(
      windows(15, 100),
    );
  }),
);

it.effect.each([
  new Response(null, { status: 401 }),
  new Response(null, { status: 403 }),
  Response.json({ base_resp: { status_code: 1004 } }),
  Response.json(plan([])),
])("omits MiniMax keys that report no usage", (response) =>
  Effect.gen(function* () {
    const read = providerKeyUsageReader(vi.fn<typeof fetch>().mockResolvedValue(response));
    expect(yield* read(connection("minimax"))!(key)).toBeNull();
  }),
);

it.effect.each([
  { preset: "deepseek", response: () => new Response(null, { status: 401 }) },
  {
    preset: "deepseek",
    response: () =>
      Response.json({ is_available: true, balance_infos: [{ ...balance, total_balance: " " }] }),
  },
  { preset: "deepseek", response: () => new Response("not JSON") },
  { preset: "deepseek", response: () => new Response(" ".repeat(65_537)) },
  { preset: "moonshot", response: () => Response.json({ ...kimi, status: false }) },
  { preset: "moonshot", response: () => Response.json({ ...kimi, code: 1004 }) },
  { preset: "minimax", response: () => new Response(null, { status: 429 }) },
  {
    preset: "minimax",
    response: () =>
      Response.json({ base_resp: { status_code: 1001 }, model_remains: [miniMaxChat] }),
  },
  { preset: "minimax", response: () => Response.json(plan([{ model_name: "general" }])) },
] as const)(
  "treats an invalid or unavailable $preset response as a sanitized failure",
  ({ preset, response }) =>
    Effect.gen(function* () {
      const read = providerKeyUsageReader(vi.fn<typeof fetch>().mockResolvedValue(response()));
      expect(yield* Effect.flip(read(connection(preset))!(key))).toBe("read-failed");
    }),
);

it.effect("times out and aborts an unresponsive provider read", () =>
  Effect.gen(function* () {
    const request = vi.fn<typeof fetch>().mockReturnValue(new Promise(() => {}));
    const read = providerKeyUsageReader(request)(connection("deepseek"))!;
    const fiber = yield* Effect.flip(read(key)).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("10 seconds");
    expect(yield* Fiber.join(fiber)).toBe("read-failed");
    expect(request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  }).pipe(Effect.provide(TestClock.layer())),
);

it("has no reader for GLM or custom endpoints", () => {
  const read = providerKeyUsageReader();
  expect(read(connection("zhipu"))).toBeUndefined();
  expect(read(connection("custom", null))).toBeUndefined();
});
