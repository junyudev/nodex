import { describe, expect, test } from "vite-plus/test";
import { describeUsageMeter, describeUsageMeterLabel } from "@/lib/usage-meter";
import type { ProviderKeyConnection } from "../../../shared/provider-keys";
import type { ProviderKeyUsage } from "../../../shared/provider-key-usage";
import { providerKeyBalanceLabel, providerKeyUsageReading } from "./provider-key-usage-model";

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
