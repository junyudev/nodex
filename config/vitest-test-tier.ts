export const VITEST_TEST_TIERS = ["default", "nightly", "stress", "live"] as const;
export type VitestTestTier = (typeof VITEST_TEST_TIERS)[number];

export function resolveVitestTestTier(value = process.env.NODEX_TEST_TIER): VitestTestTier {
  if (value === undefined) return "default";
  const tier = VITEST_TEST_TIERS.find((tier) => tier === value);
  if (tier) return tier;
  throw new Error(
    `NODEX_TEST_TIER must be "default", "nightly", "stress", or "live", received ${JSON.stringify(value)}`,
  );
}
