import { observeTestFiles } from "./test-file-observation";
import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./electron-test-runtime";
import { filesForSuite } from "./test-suites";

assertElectronTestRuntime("integration");

const tier = resolveVitestTestTier();
const testFiles = filesForSuite("integration", tier);

export default defineConfig({
  test: {
    ...observeTestFiles(["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"]),
    ...testObservation("integration"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    // Each file starts Electron-as-Node plus a Core process; four keeps a full run inside its
    // share of the computer instead of one worker per core.
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: tier !== "default",
    pool: "forks",
    ...vitestTimeouts(testFiles.isStress),
  },
});
