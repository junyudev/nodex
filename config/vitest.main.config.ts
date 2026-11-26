import { observeTestFiles } from "./test-file-observation";
import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./electron-test-runtime";
import { filesForSuite } from "./test-suites";

assertElectronTestRuntime("main");

const tier = resolveVitestTestTier(process.env.NODEX_TEST_TIER);
const testFiles = filesForSuite("main", tier);

export default defineConfig({
  test: {
    ...observeTestFiles(["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"]),
    ...testObservation("main"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: tier !== "default",
    pool: "forks",
    ...vitestTimeouts(testFiles.isStress),
  },
});
