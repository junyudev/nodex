export type VitestTestTier = "default" | "stress";

export function resolveVitestTestTier(value = process.env.NODEX_TEST_TIER): VitestTestTier {
  if (value === undefined || value === "default") return "default";
  if (value === "stress") return "stress";
  throw new Error(
    `NODEX_TEST_TIER must be "default" or "stress", received ${JSON.stringify(value)}`,
  );
}
