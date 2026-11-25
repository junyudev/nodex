import { observeTestFiles } from "./test-file-observation";
import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { filesForSuite } from "./test-suites";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";

const tier = resolveVitestTestTier();
const testFiles = filesForSuite("effect-codex", tier);

export default defineConfig({
  test: {
    ...observeTestFiles(["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"]),
    ...testObservation("effect-codex"),
    ...vitestTimeouts(testFiles.isStress),
    env: TEST_ENVIRONMENT,
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    passWithNoTests: tier !== "default",
    maxWorkers: 2,
  },
});
