import type { InlineConfig } from "vite-plus/test/node";

/**
 * React interaction correctness is always enforced; detailed timings remain opt-in. Every run
 * also claims its share of the computer, so parallel checkouts queue instead of overloading it.
 */
export function testObservation(suite: string): Pick<InlineConfig, "attachmentsDir" | "reporters"> {
  const attachmentsDir = ".vitest-attachments";
  const directory = process.env.NODEX_TEST_TIMINGS;
  return {
    attachmentsDir,
    reporters: [
      "default",
      ["./scripts/tooling/vitest-machine-budget-reporter.ts", { suite }],
      ["./scripts/tooling/vitest-timing-reporter.ts", { directory, suite }],
    ],
  };
}
