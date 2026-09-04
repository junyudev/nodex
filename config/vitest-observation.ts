import type { InlineConfig } from "vite-plus/test/node";

/** Detailed diagnostics are opt-in and never replay test results. */
export function testObservation(suite: string): Pick<InlineConfig, "reporters"> {
  const directory = process.env.NODEX_TEST_TIMINGS;
  if (!directory) return {};
  return {
    reporters: ["default", ["./scripts/tooling/vitest-timing-reporter.ts", { directory, suite }]],
  };
}
