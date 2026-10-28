export type VitestTestTier = "default" | "stress" | "live";

export function resolveVitestTestTier(value = process.env.NODEX_TEST_TIER): VitestTestTier {
  if (value === undefined || value === "default") return "default";
  if (value === "stress") return "stress";
  if (value === "live") return "live";
  throw new Error(
    `NODEX_TEST_TIER must be "default", "stress", or "live", received ${JSON.stringify(value)}`,
  );
}
