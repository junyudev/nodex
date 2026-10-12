import type { InlineConfig } from "vite-plus/test/node";

/** Runtime artifacts stay ephemeral; detailed timings are opt-in. */
export function testObservation(suite: string): Pick<InlineConfig, "attachmentsDir" | "reporters"> {
  const attachmentsDir = ".vitest-attachments";
  const directory = process.env.NODEX_TEST_TIMINGS;
  if (!directory) return { attachmentsDir };
  return {
    attachmentsDir,
    reporters: ["default", ["./scripts/tooling/vitest-timing-reporter.ts", { directory, suite }]],
  };
}
