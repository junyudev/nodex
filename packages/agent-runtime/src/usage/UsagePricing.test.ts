import { assert, describe, it } from "@effect/vitest";

import { lookupRate, parseRateTable, priceUsage } from "./UsagePricing.ts";
import { EMPTY_USAGE_TOTALS } from "./UsageRecord.ts";

const entry = (input: number, output: number, extra: Record<string, unknown> = {}) => ({
  input_cost_per_token: input,
  output_cost_per_token: output,
  ...extra,
});

describe("usage pricing", () => {
  const table = parseRateTable({
    "claude-opus-5-5": entry(4e-6, 2e-5, {
      cache_read_input_token_cost: 2e-7,
      cache_creation_input_token_cost: 5e-6,
      provider_specific_entry: { fast: 6 },
    }),
    "openai/gpt-6.1-sol": entry(2e-6, 1e-5, {
      cache_read_input_token_cost: 1e-7,
      input_cost_per_token_priority: 4e-6,
      output_cost_per_token_priority: 2e-5,
    }),
    "reseller/gpt-6.1-sol": entry(9e-6, 9e-5),
    "incomplete-model": { input_cost_per_token: 1e-6 },
    opus: entry(1, 1),
    sample_spec: "not a rate",
  });

  it("prices every token category and reports what the cache saved", () => {
    const priced = priceUsage(table, "claude-opus-5-5", "standard", {
      uncachedInputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
      outputTokens: 1_000_000,
      reasoningTokens: 500_000,
    });
    assert.closeTo(priced.costUsd, 4 + 0.2 + 5 + 20, 1e-9);
    assert.closeTo(priced.cacheSavingsUsd, 3.8, 1e-9);
    assert.equal(priced.priced, true);
  });

  it("scales a fast tier from its multiplier or its own priority rates", () => {
    const totals = { ...EMPTY_USAGE_TOTALS, uncachedInputTokens: 1_000_000 };
    assert.closeTo(priceUsage(table, "claude-opus-5-5", "fast", totals).costUsd, 24, 1e-9);
    assert.closeTo(priceUsage(table, "gpt-6.1-sol", "fast", totals).costUsd, 4, 1e-9);
  });

  it("gives a bare model name its first-party price, not a reseller's", () => {
    assert.equal(lookupRate(table, "gpt-6.1-sol")?.inputCostPerToken, 2e-6);
  });

  it("prices a bracketed context variant at its base model", () => {
    assert.equal(lookupRate(table, "claude-opus-5-5[1m]")?.inputCostPerToken, 4e-6);
  });

  it("leaves unknown, incomplete and generation-ambiguous models unpriced", () => {
    const totals = { ...EMPTY_USAGE_TOTALS, outputTokens: 1_000 };
    for (const model of ["unknown-model", "incomplete-model", "opus", "<synthetic>"]) {
      assert.deepEqual(priceUsage(table, model, "standard", totals), {
        costUsd: 0,
        cacheSavingsUsd: 0,
        priced: false,
      });
    }
  });

  it("treats a malformed document as an empty table", () => {
    assert.equal(parseRateTable(null).size, 0);
    assert.equal(parseRateTable("rates").size, 0);
  });
});
