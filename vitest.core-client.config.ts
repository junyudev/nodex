import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./config/renderer-vite-shared";
import { filesForSuite } from "./config/test-suites";

const testFiles = filesForSuite("core-client", resolveVitestTestTier());

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    ...testObservation("core-client"),
    env: { TZ: "UTC" },
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    testTimeout: testFiles.isStress ? 60_000 : 30_000,
  },
});
