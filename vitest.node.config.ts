import { vitestTimeouts } from "./config/test-timeouts";
import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { TEST_ENVIRONMENT } from "./config/test-environment";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./config/renderer-vite-shared";
import { filesForSuite } from "./config/test-suites";

const testFiles = filesForSuite("unit", resolveVitestTestTier());

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    setupFiles: ["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"],
    ...testObservation("unit"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    ...vitestTimeouts(testFiles.isStress),
  },
});
