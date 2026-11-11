import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { TEST_ENVIRONMENT } from "../../config/test-environment.ts";
import { vitestTimeouts } from "../../config/test-timeouts.ts";
import { filesForSuite } from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";

const testFiles = filesForSuite("agent-runtime", resolveVitestTestTier());
const localGlob = (glob: string) => glob.replace(/^packages\/agent-runtime\//u, "");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    // Workspace peer variants must register against the active test runner's suite.
    dedupe: ["@effect/vitest", "vite-plus"],
  },
  test: {
    env: TEST_ENVIRONMENT,
    environment: "node",
    include: testFiles.include.map(localGlob),
    exclude: testFiles.exclude.map(localGlob),
    passWithNoTests: testFiles.isStress,
    fileParallelism: false,
    reporters: [
      "default",
      [
        fileURLToPath(
          new URL("../../scripts/tooling/vitest-machine-budget-reporter.ts", import.meta.url),
        ),
        { suite: "agent-runtime" },
      ],
    ],
    ...vitestTimeouts(testFiles.isStress),
    setupFiles: [
      fileURLToPath(new URL("../../config/setup-test-timeouts.ts", import.meta.url)),
      fileURLToPath(new URL("./vendor/shared/src/testing/longTempDir.ts", import.meta.url)),
      fileURLToPath(new URL("./src/testUtils/gitConfig.setup.ts", import.meta.url)),
    ],
  },
});
