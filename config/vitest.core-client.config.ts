import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./renderer-vite-shared";
import { filesForSuite } from "./test-suites";

const testFiles = filesForSuite("core-client", resolveVitestTestTier());

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    setupFiles: ["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"],
    ...testObservation("core-client"),
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
