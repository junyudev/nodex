export const VITEST_TEST_TIERS = ["default", "nightly", "stress", "live"] as const;
export type VitestTestTier = (typeof VITEST_TEST_TIERS)[number];

// Related selection can collect two tiers without changing test ownership.
export type VitestTestScope = VitestTestTier | "related";

export function resolveVitestTestTier(value = process.env.NODEX_TEST_TIER): VitestTestScope {
  if (value === undefined) return "default";
  if (value === "related") return value;
  const tier = VITEST_TEST_TIERS.find((tier) => tier === value);
  if (tier) return tier;
  throw new Error(
    `NODEX_TEST_TIER must be "default", "nightly", "stress", "live", or "related", received ${JSON.stringify(value)}`,
  );
}
