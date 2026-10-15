import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";
import { filesForSuite } from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";

const testFiles = filesForSuite("agent-runtime", resolveVitestTestTier());
const localGlob = (glob: string) => glob.replace(/^packages\/agent-runtime\//u, "");

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: testFiles.include.map(localGlob),
    exclude: testFiles.exclude.map(localGlob),
    passWithNoTests: testFiles.isStress,
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: [
      fileURLToPath(new URL("./vendor/shared/src/testing/longTempDir.ts", import.meta.url)),
      fileURLToPath(new URL("./src/testUtils/gitConfig.setup.ts", import.meta.url)),
    ],
  },
});
