import { vitestTimeouts } from "./config/test-timeouts";
import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { TEST_ENVIRONMENT } from "./config/test-environment";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { filesForSuite } from "./config/test-suites";

assertElectronTestRuntime("main");

const testFiles = filesForSuite("main", resolveVitestTestTier());

export default defineConfig({
  test: {
    setupFiles: ["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"],
    ...testObservation("main"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    ...vitestTimeouts(testFiles.isStress),
  },
});
