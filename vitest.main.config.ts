import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { filesForSuite } from "./config/test-suites";

assertElectronTestRuntime("main");

const testFiles = filesForSuite("main", resolveVitestTestTier());

export default defineConfig({
  test: {
    ...testObservation("main"),
    env: { TZ: "UTC" },
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    testTimeout: testFiles.isStress ? 60_000 : 20_000,
  },
});
