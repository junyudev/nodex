import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { filesForSuite } from "./config/test-suites";

assertElectronTestRuntime("integration");

const testFiles = filesForSuite("integration", resolveVitestTestTier());

export default defineConfig({
  test: {
    ...testObservation("integration"),
    env: { TZ: "UTC" },
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    ...(testFiles.isStress ? { maxWorkers: 1 } : {}),
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    testTimeout: testFiles.isStress ? 60_000 : 20_000,
  },
});
