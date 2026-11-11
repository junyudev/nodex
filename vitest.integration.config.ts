import { vitestTimeouts } from "./config/test-timeouts";
import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { TEST_ENVIRONMENT } from "./config/test-environment";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { filesForSuite } from "./config/test-suites";

assertElectronTestRuntime("integration");

const testFiles = filesForSuite("integration", resolveVitestTestTier());

export default defineConfig({
  test: {
    setupFiles: ["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"],
    ...testObservation("integration"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    // Each file starts Electron-as-Node plus a Core process; four keeps a full run inside its
    // share of the computer instead of one worker per core.
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    ...vitestTimeouts(testFiles.isStress),
  },
});
