import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vite-plus/test/node";

/**
 * React interaction correctness is always enforced; detailed timings remain opt-in. Every run
 * also claims its share of the computer, so parallel checkouts queue instead of overloading it.
 */
export function testObservation(suite: string) {
  const attachmentsDir = ".vitest-attachments";
  const directory = process.env.NODEX_TEST_TIMINGS;
  return {
    attachmentsDir,
    reporters: [
      "default",
      ...(process.env.NODEX_TEST_OBSERVATIONS
        ? [
            fileURLToPath(
              new URL("../scripts/testing/test-observation-transform-cache.ts", import.meta.url),
            ),
          ]
        : []),
      [
        fileURLToPath(
          new URL("../scripts/tooling/vitest-machine-budget-reporter.ts", import.meta.url),
        ),
        { suite },
      ],
      [
        fileURLToPath(new URL("../scripts/tooling/vitest-timing-reporter.ts", import.meta.url)),
        { directory, suite },
      ],
    ],
  } satisfies Pick<InlineConfig, "attachmentsDir" | "reporters">;
}
