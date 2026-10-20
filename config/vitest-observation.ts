import type { InlineConfig } from "vite-plus/test/node";

/** React interaction correctness is always enforced; detailed timings remain opt-in. */
export function testObservation(suite: string): Pick<InlineConfig, "attachmentsDir" | "reporters"> {
  const attachmentsDir = ".vitest-attachments";
  const directory = process.env.NODEX_TEST_TIMINGS;
  return {
    attachmentsDir,
    reporters: ["default", ["./scripts/tooling/vitest-timing-reporter.ts", { directory, suite }]],
  };
}
