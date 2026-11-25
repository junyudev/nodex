import { describe, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "@effect/vitest";
import { providerKeyModelDiscovery } from "./ProviderKeyModelDiscovery";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { ProviderKeyConnection } from "../../../shared/provider-keys";
import { providerKeyUsageReader } from "./ProviderKeyUsageReader";

describe("ProviderKeyModelDiscovery", () => {
  const custom = {
    preset: "custom",
    baseUrl: "https://gateway.example/anthropic",
    agent: "claudeAgent",
  } as const;
  const deepseek = { preset: "deepseek", endpoint: "international", agent: "claudeAgent" } as const;
  const keyText = "test-secret-value";
  const key = Redacted.make(keyText);

  it.effect(
    "reads Anthropic model pages using the same origin and omits reflected credentials",
    () =>
      Effect.gen(function* () {
        const request = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            Response.json({
              data: [
                { id: "claude-v1", display_name: "Claude V1" },
                { id: keyText, display_name: keyText },
              ],
              has_more: true,
              last_id: "claude-v1",
            }),
          )
          .mockResolvedValueOnce(
            Response.json({
              data: [{ id: "claude-v2", display_name: keyText }, { id: "embed-only" }],
              has_more: false,
            }),
          );
        expect(yield* providerKeyModelDiscovery(request)(custom, key)).toEqual({
          ok: true,
          models: [
            { id: "claude-v1", name: "Claude V1" },
            { id: "claude-v2", name: "Claude V2" },
          ],
        });
        expect(request.mock.calls[1]?.[0].toString()).toBe(
          "https://gateway.example/anthropic/v1/models?after_id=claude-v1",
        );
        expect(request.mock.calls[0]?.[1]).toMatchObject({
          redirect: "error",
          headers: {
            Authorization: `Bearer ${keyText}`,
            "x-api-key": keyText,
            "anthropic-version": "2023-06-01",
          },
        });
      }),
  );

  it.effect.each([
    new Response(null, { status: 404 }),
    new Response(null, { status: 405 }),
    Response.json({ unrelated: true }),
  ])("falls back from an unavailable Anthropic listing to the OpenAI model endpoint", (first) =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(
          Response.json({
            data: [{ id: "deepseek-v4-pro", name: "Pro label" }, { id: "other-provider-model" }],
          }),
        );
      expect(yield* providerKeyModelDiscovery(request)(deepseek, key)).toEqual({
        ok: true,
        models: [{ id: "deepseek-v4-pro", name: "Pro label" }],
      });
      expect(request.mock.calls[1]?.[0].toString()).toBe("https://api.deepseek.com/models");
      expect(request.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: `Bearer ${keyText}` });
    }),
  );

  it.effect.each([
    () => new Response(null, { status: 401 }),
    () => new Response(null, { status: 403 }),
    () => Response.json({ code: 401, message: "refused" }),
    () => Response.json({ error: { type: "authentication_error", message: "refused" } }),
  ])("rejects HTTP and in-body authentication failures before any fallback", (response) =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockImplementation(async () => response());
      const discover = providerKeyModelDiscovery(request);
      expect(
        yield* discover({ preset: "zhipu", endpoint: "china", agent: "claudeAgent" }, key),
      ).toMatchObject({
        ok: false,
        reason: "rejected",
      });
      expect(request).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("uses preset defaults when the list contains no supported models", () =>
    Effect.gen(function* () {
      const discover = providerKeyModelDiscovery(async () =>
        Response.json({ data: [{ id: "unrelated-model" }] }),
      );
      expect(yield* discover(deepseek, key)).toMatchObject({
        ok: true,
        models: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }],
      });
    }),
  );

  it.effect("uses typed models only when the custom endpoint cannot list models", () =>
    Effect.gen(function* () {
      const discover = providerKeyModelDiscovery(async () => new Response(null, { status: 404 }));
      const models = [{ id: "manual-model", name: "My model" }];
      expect(yield* discover(custom, key)).toMatchObject({
        ok: false,
        reason: "no-models",
      });
      expect(yield* discover(custom, key, models)).toEqual({
        ok: true,
        models,
      });
    }),
  );

  it.effect("classifies network and server failures as unreachable even with typed models", () =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockRejectedValueOnce(new Error("connection refused"))
        .mockResolvedValueOnce(new Response(null, { status: 500 }));
      const discover = providerKeyModelDiscovery(request);
      for (const _ of [1, 2]) {
        expect(yield* discover(custom, key, [{ id: "manual", name: "Manual" }])).toMatchObject({
          ok: false,
          reason: "unreachable",
        });
      }
    }),
  );

  it.effect("discovers Codex models and merges listed Responses traits over preset traits", () =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          data: [
            {
              id: "deepseek-flash",
              display_name: "DeepSeek Flash",
              context_window: 900_000,
              input_modalities: ["text"],
              effort: { supported_levels: ["low", "max"], default_level: "low" },
            },
            {
              id: "deepseek-v4-pro",
              context_window: -1,
              input_modalities: "not an array",
              effort: { default_level: "a".repeat(40) },
            },
          ],
          has_more: true,
          last_id: "deepseek-v4-pro",
        }),
      );
      const result = yield* providerKeyModelDiscovery(request)(
        { ...deepseek, agent: "codex" },
        key,
      );
      expect(result).toEqual({
        ok: true,
        models: [
          {
            id: "deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            contextWindow: 1_048_576,
            reasoningEfforts: ["low", "high", "max"],
            defaultReasoningEffort: "high",
          },
          {
            id: "deepseek-flash",
            name: "DeepSeek Flash",
            contextWindow: 900_000,
            images: false,
            reasoningEfforts: ["low", "max"],
            defaultReasoningEffort: "low",
          },
        ],
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0]?.[0].toString()).toBe("https://api.deepseek.com/models");
      expect(request.mock.calls[0]?.[1]).toMatchObject({
        redirect: "error",
        headers: { Authorization: `Bearer ${keyText}` },
      });
    }),
  );

  it.effect.each([404, 405])(
    "tries the preset's alternate Responses listing after HTTP %i",
    (status) =>
      Effect.gen(function* () {
        const request = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(new Response(null, { status }))
          .mockResolvedValueOnce(
            Response.json({
              data: [{ id: "glm-5.3", input_modalities: ["text", "image"] }],
            }),
          );
        const result = yield* providerKeyModelDiscovery(request)(
          { preset: "zhipu", endpoint: "china", agent: "codex" },
          key,
        );
        expect(result).toMatchObject({ ok: true, models: [{ id: "glm-5.3", images: true }] });
        expect(request.mock.calls.map(([url]) => url.toString())).toEqual([
          "https://open.bigmodel.cn/api/v1/models",
          "https://open.bigmodel.cn/api/paas/v4/models",
        ]);
        expect(request.mock.calls[1]?.[1]?.headers).toEqual({ Authorization: `Bearer ${keyText}` });
      }),
  );

  it.effect("ignores reflected credentials in Responses model traits and labels", () =>
    Effect.gen(function* () {
      const discover = providerKeyModelDiscovery(async () =>
        Response.json({
          data: [
            {
              id: "custom-model",
              display_name: "a".repeat(124) + keyText,
              effort: { supported_levels: ["low", keyText], default_level: keyText },
            },
          ],
        }),
      );
      const result = yield* discover({ ...custom, agent: "codex" }, key);
      expect(result).toEqual({
        ok: true,
        models: [{ id: "custom-model", name: "Custom Model", reasoningEfforts: ["low"] }],
      });
    }),
  );
});

describe("ProviderKeyUsageReader", () => {
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
      expect(yield* read(key)).toEqual({
        balance: { amount: -0.25, currency: "CNY" },
        windows: [],
      });
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
        expect(request.mock.calls[0]?.[0]).toBe(
          `https://api.moonshot.${domain}/v1/users/me/balance`,
        );
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
      const fiber = yield* Effect.flip(read(key)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
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
});
