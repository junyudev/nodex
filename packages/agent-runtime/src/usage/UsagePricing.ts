import type { UsageSpeed, UsageTotals } from "./UsageRecord.ts";

export interface TokenRates {
  readonly inputCostPerToken: number;
  readonly outputCostPerToken: number;
  readonly cacheReadCostPerToken: number;
  readonly cacheCreationCostPerToken: number;
}

export interface ModelRate extends TokenRates {
  readonly fast: TokenRates | null;
  readonly ultrafast: TokenRates | null;
}

export type RateTable = ReadonlyMap<string, ModelRate>;

type RateEntry = Readonly<Record<string, unknown>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// Missing cache rates fall back to input pricing; providers normally discount reads and charge extra for writes.
function readTokenRates(
  entry: RateEntry,
  suffix: string,
  standard?: TokenRates,
): TokenRates | null {
  const input = finiteNumber(entry[`input_cost_per_token${suffix}`]);
  const output = finiteNumber(entry[`output_cost_per_token${suffix}`]);
  if (input === null || output === null) return null;
  const cacheRate = (name: string, field: "cacheReadCostPerToken" | "cacheCreationCostPerToken") =>
    finiteNumber(entry[`${name}${suffix}`]) ??
    (standard !== undefined && standard.inputCostPerToken > 0
      ? (standard[field] / standard.inputCostPerToken) * input
      : input);
  return {
    inputCostPerToken: input,
    outputCostPerToken: output,
    cacheReadCostPerToken: cacheRate("cache_read_input_token_cost", "cacheReadCostPerToken"),
    cacheCreationCostPerToken: cacheRate(
      "cache_creation_input_token_cost",
      "cacheCreationCostPerToken",
    ),
  };
}

function scaleTokenRates(rates: TokenRates, multiple: number): TokenRates {
  return {
    inputCostPerToken: rates.inputCostPerToken * multiple,
    outputCostPerToken: rates.outputCostPerToken * multiple,
    cacheReadCostPerToken: rates.cacheReadCostPerToken * multiple,
    cacheCreationCostPerToken: rates.cacheCreationCostPerToken * multiple,
  };
}

function fastMultiplier(entry: RateEntry): number | null {
  const specific = entry["provider_specific_entry"];
  if (typeof specific !== "object" || specific === null) return null;
  const fast = finiteNumber((specific as Record<string, unknown>)["fast"]);
  return fast !== null && fast > 0 ? fast : null;
}

// Prefixes for the model makers' own APIs; their price beats a cloud's or reseller's for a bare name.
const FIRST_PARTY_PROVIDERS = new Set([
  "anthropic",
  "deepseek",
  "gemini",
  "meta",
  "mistral",
  "openai",
  "xai",
]);

const normalizeRateKey = (model: string) => model.trim().toLowerCase();

function bareModelName(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? key : key.slice(slash + 1);
}

function sameTokenRates(a: TokenRates | null, b: TokenRates | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.inputCostPerToken === b.inputCostPerToken &&
    a.outputCostPerToken === b.outputCostPerToken &&
    a.cacheReadCostPerToken === b.cacheReadCostPerToken &&
    a.cacheCreationCostPerToken === b.cacheCreationCostPerToken
  );
}

// Resellers often omit speed tiers, so a missing tier fills from the other entry instead of conflicting.
function mergeAliasRate(a: ModelRate, b: ModelRate): ModelRate | null {
  const fast = a.fast ?? b.fast;
  const ultrafast = a.ultrafast ?? b.ultrafast;
  if (
    !sameTokenRates(a, b) ||
    !sameTokenRates(fast, b.fast ?? fast) ||
    !sameTokenRates(ultrafast, b.ultrafast ?? ultrafast)
  ) {
    return null;
  }
  return { ...a, fast, ultrafast };
}

/** Drops models missing input or output rates so an incomplete price never understates cost. */
export function parseRateTable(document: unknown): RateTable {
  const table = new Map<string, ModelRate>();
  if (typeof document !== "object" || document === null) return table;

  for (const [name, raw] of Object.entries(document as Record<string, unknown>)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as RateEntry;
    const standard = readTokenRates(entry, "");
    if (standard === null) continue;
    const key = normalizeRateKey(name);
    if (key.length === 0) continue;
    const multiple = fastMultiplier(entry);
    table.set(key, {
      ...standard,
      fast:
        multiple === null
          ? readTokenRates(entry, "_priority", standard)
          : scaleTokenRates(standard, multiple),
      ultrafast: readTokenRates(entry, "_ultrafast", standard),
    });
  }

  const aliasCandidates = new Map<string, { rate: ModelRate | null; firstParty: boolean }>();
  for (const [key, rate] of table) {
    const alias = bareModelName(key);
    if (alias.length === 0 || alias === key || table.has(alias)) continue;
    const firstParty = FIRST_PARTY_PROVIDERS.has(key.slice(0, key.indexOf("/")));
    const held = aliasCandidates.get(alias);
    if (held === undefined || (firstParty && !held.firstParty)) {
      aliasCandidates.set(alias, { rate, firstParty });
    } else if (held.rate !== null && firstParty === held.firstParty) {
      aliasCandidates.set(alias, { rate: mergeAliasRate(held.rate, rate), firstParty });
    }
  }
  for (const [alias, { rate }] of aliasCandidates) {
    if (rate !== null) table.set(alias, rate);
  }
  return table;
}

// Synthetic messages are unbilled; bare family names are generation-ambiguous and remain unpriced.
const UNPRICEABLE_MODELS = new Set([
  "<synthetic>",
  "synthetic",
  "opus",
  "sonnet",
  "haiku",
  "fable",
]);

export function lookupRate(table: RateTable, model: string): ModelRate | null {
  const normalized = normalizeRateKey(model);
  const bracket = normalized.indexOf("[");
  // Claude's bracketed context variants price at the base tier, the only name the table knows.
  const key = bracket === -1 ? normalized : normalized.slice(0, bracket);
  const bare = bareModelName(key);
  if (bare.length === 0 || UNPRICEABLE_MODELS.has(bare)) return null;
  return table.get(key) ?? null;
}

export interface PricedUsage {
  readonly costUsd: number;
  readonly cacheSavingsUsd: number;
  readonly priced: boolean;
}

/** Reasoning tokens are already inside output tokens and are not charged twice. */
export function priceUsage(
  table: RateTable,
  model: string,
  speed: UsageSpeed,
  totals: UsageTotals,
): PricedUsage {
  const rate = lookupRate(table, model);
  if (rate === null) return { costUsd: 0, cacheSavingsUsd: 0, priced: false };
  const rates = (speed === "standard" ? null : rate[speed]) ?? rate;
  return {
    costUsd:
      totals.uncachedInputTokens * rates.inputCostPerToken +
      totals.cachedInputTokens * rates.cacheReadCostPerToken +
      totals.cacheCreationTokens * rates.cacheCreationCostPerToken +
      totals.outputTokens * rates.outputCostPerToken,
    cacheSavingsUsd:
      totals.cachedInputTokens * (rates.inputCostPerToken - rates.cacheReadCostPerToken),
    priced: true,
  };
}
