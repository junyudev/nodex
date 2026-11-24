import { fileURLToPath } from "node:url";
import type { InlineConfig } from "vite-plus/test/node";

export function observeTestFiles(setupFiles: string[]) {
  if (!process.env.NODEX_TEST_OBSERVATIONS) return { setupFiles };
  return {
    setupFiles: [
      fileURLToPath(new URL("../scripts/testing/setup-test-observation.ts", import.meta.url)),
      ...setupFiles,
    ],
    execArgv: [
      "--import",
      new URL("../scripts/testing/test-observation.mts", import.meta.url).href,
    ],
    sequence: { setupFiles: "list" },
    runner: fileURLToPath(
      new URL("../scripts/testing/test-observation-runner.ts", import.meta.url),
    ),
  } satisfies Pick<InlineConfig, "setupFiles" | "sequence" | "runner" | "execArgv">;
}
