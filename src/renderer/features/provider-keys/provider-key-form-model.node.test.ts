import { describe, expect, it, test } from "vite-plus/test";
import {
  initialProviderKeyDraft,
  parseTypedModels,
  providerKeyConnectInput,
  providerKeyDraftProblem,
  providerKeyEndpoint,
  providerKeyFailureField,
} from "./provider-key-form-model";
import { providerKeyDetail, providerKeysSummary } from "./provider-keys-model";
import { describeUsageMeter, describeUsageMeterLabel } from "@/lib/usage-meter";
import type { ProviderKeyConnection } from "../../../shared/provider-keys";
import type { ProviderKeyUsage } from "../../../shared/provider-key-usage";
import { providerKeyBalanceLabel, providerKeyUsageReading } from "./provider-key-usage-model";

describe("API key form", () => {
  it("starts a two-region provider on the region matching the app's language", () => {
    const kimi = initialProviderKeyDraft("moonshot");
    expect(providerKeyEndpoint(kimi, "zh-CN")?.id).toBe("china");
    expect(providerKeyEndpoint(kimi, "en-US")?.id).toBe("international");
    expect(providerKeyEndpoint({ ...kimi, endpoints: { moonshot: "china" } }, "en-US")?.id).toBe(
      "china",
    );
    expect(providerKeyEndpoint(initialProviderKeyDraft("deepseek"), "zh-CN")?.id).toBe(
      "international",
    );
    expect(providerKeyEndpoint(initialProviderKeyDraft("custom"), "en")).toBeNull();
  });

  it("names the field that keeps a draft from being sent", () => {
    expect(providerKeyDraftProblem(initialProviderKeyDraft())?.field).toBe("apiKey");
    expect(
      providerKeyDraftProblem({ ...initialProviderKeyDraft(), apiKey: "sk 1" })?.message
        .defaultMessage,
    ).toContain("no spaces");
    const custom = { ...initialProviderKeyDraft("custom"), apiKey: "sk-1" };
    expect(providerKeyDraftProblem(custom)?.field).toBe("baseUrl");
    expect(providerKeyDraftProblem({ ...custom, baseUrl: "http://example.com" })?.field).toBe(
      "baseUrl",
    );
    expect(providerKeyDraftProblem({ ...custom, baseUrl: "https://gw.example.com" })).toBeNull();
  });

  it("sends a preset's endpoint, or a custom URL with any typed models", () => {
    expect(
      providerKeyConnectInput({ ...initialProviderKeyDraft("zhipu"), apiKey: " k1 " }, "zh"),
    ).toEqual({ target: { preset: "zhipu", endpoint: "china", agent: "codex" }, apiKey: "k1" });
    expect(
      providerKeyConnectInput(
        {
          ...initialProviderKeyDraft("custom"),
          baseUrl: "https://gw.example.com/anthropic",
          apiKey: "k2",
          modelsText: "qwen3-coder-plus\n\nqwen3-coder-plus, glm-5.3",
        },
        "en",
      ),
    ).toEqual({
      target: { preset: "custom", baseUrl: "https://gw.example.com/anthropic", agent: "codex" },
      apiKey: "k2",
      models: [
        { id: "qwen3-coder-plus", name: "Qwen3 Coder Plus" },
        { id: "glm-5.3", name: "GLM 5.3" },
      ],
    });
    expect(parseTypedModels("custom", " \n")).toEqual([]);
  });

  it("points a failure at the field that fixes it", () => {
    expect(providerKeyFailureField("rejected", "deepseek")).toBe("apiKey");
    expect(providerKeyFailureField("no-models", "custom")).toBe("models");
    expect(providerKeyFailureField("unreachable", "custom")).toBe("baseUrl");
    expect(providerKeyFailureField("unreachable", "deepseek")).toBeNull();
  });
});

describe("API key connections", () => {
  const connection = {
    id: "c1",
    preset: "moonshot",
    agent: "codex",
    endpoint: "china",
    baseUrl: null,
    displayName: "Kimi",
    enabled: true,
    models: [
      { id: "kimi-k3", name: "Kimi K3" },
      { id: "kimi-k3.1-pro", name: "Kimi K3.1 Pro" },
    ],
    keyHint: "9x1z",
  } as const;

  it("describes what a connection offers and where it sends requests", () => {
    expect(providerKeyDetail(connection)).toBe("2 models · ••••9x1z · China");
    expect(
      providerKeyDetail({
        ...connection,
        preset: "custom",
        agent: "codex",
        endpoint: null,
        baseUrl: "https://gw.example.com:8443/anthropic",
        keyHint: "",
        models: [{ id: "m", name: "M" }],
      }),
    ).toBe("1 model · gw.example.com:8443");
  });

  it("summarizes the card by provider until there are many", () => {
    expect(providerKeysSummary(null)).toBeNull();
    expect(providerKeysSummary([])).toBe("Not set up");
    expect(providerKeysSummary([connection])).toBe("Kimi");
    expect(providerKeysSummary([connection, { ...connection, id: "c2", displayName: "GLM" }])).toBe(
      "Kimi, GLM",
    );
    expect(
      providerKeysSummary([connection, { ...connection, id: "c2" }, { ...connection, id: "c3" }]),
    ).toBe("3 keys");
    expect(providerKeysSummary([{ ...connection, enabled: false }])).toBe("Off");
  });
});

describe("provider key usage model", () => {
  const NOW = Date.parse("2026-11-24T08:00:00.000Z");
  const connection: ProviderKeyConnection = {
    id: "c1",
    preset: "deepseek",
    agent: "codex",
    endpoint: "international",
    baseUrl: null,
    displayName: "DeepSeek",
    enabled: true,
    models: [{ id: "deepseek-flash", name: "DeepSeek V4.1 Flash" }],
    keyHint: "3f2a",
  };
  const usage = (overrides: Partial<ProviderKeyUsage> = {}): ProviderKeyUsage => ({
    connectionId: "c1",
    observedAt: NOW - 60_000,
    readFailed: false,
    balance: { amount: 2.9, currency: "CNY" },
    windows: [],
    ...overrides,
  });

  describe("an API key connection's usage meter", () => {
    test("is the connection's own account, measured against its last top-up", () => {
      const reading = providerKeyUsageReading(connection, usage(), { baseline: 10, balance: 2.9 });
      expect(reading).toMatchObject({
        provider: "codex",
        instanceId: "key_deepseek_c1",
        title: "DeepSeek",
        account: "API key ••••3f2a",
        balance: { amount: 2.9, currency: "CNY", remainingPercent: 29 },
      });
      const view = describeUsageMeter(reading, NOW);
      expect(view).toMatchObject({ status: "measured", level: { remainingPercent: 29 } });
      expect(view.balance?.severity).toBe("normal");
      expect(describeUsageMeterLabel(view, NOW)).toBe("DeepSeek: ¥2.90 left");
    });

    test("shows a balance whose top-up it never saw at full", () => {
      const view = describeUsageMeter(providerKeyUsageReading(connection, usage(), null), NOW);
      expect(view.level).toEqual({ remainingPercent: 100, severity: "normal" });
    });

    test("reads a plan's windows like a subscription's", () => {
      const reading = providerKeyUsageReading(
        connection,
        usage({
          balance: null,
          windows: [
            { id: "five_hour", usedPercent: 30, durationMins: 300, resetsAt: NOW + 3_600_000 },
            { id: "weekly", usedPercent: 80, durationMins: 10_080, resetsAt: NOW + 86_400_000 },
          ],
        }),
        null,
      );
      expect(reading.windows.map(({ label }) => label)).toEqual(["5-hour", "Weekly"]);
      expect(describeUsageMeter(reading, NOW).level).toEqual({
        remainingPercent: 20,
        severity: "low",
      });
    });

    test("names the balance in Settings, and when it is used up", () => {
      expect(providerKeyBalanceLabel(usage())).toBe("¥2.90 left");
      expect(providerKeyBalanceLabel(usage({ balance: { amount: -0.4, currency: "USD" } }))).toBe(
        "Balance used up",
      );
      expect(providerKeyBalanceLabel(usage({ balance: null }))).toBeNull();
      expect(providerKeyBalanceLabel(undefined)).toBeNull();
    });
  });
});
