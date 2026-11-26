import { observeTestFiles } from "./test-file-observation";
import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./renderer-vite-shared";
import { filesForSuite } from "./test-suites";

const tier = resolveVitestTestTier(process.env.NODEX_TEST_TIER);
const testFiles = filesForSuite("core-client", tier);

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    ...observeTestFiles(["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"]),
    ...testObservation("core-client"),
    env: TEST_ENVIRONMENT,
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: tier !== "default",
    ...vitestTimeouts(testFiles.isStress),
  },
});
