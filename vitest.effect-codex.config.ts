import { vitestTimeouts } from "./config/test-timeouts";
import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { TEST_ENVIRONMENT } from "./config/test-environment";
import { filesForSuite } from "./config/test-suites";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";

const testFiles = filesForSuite("effect-codex", resolveVitestTestTier());

export default defineConfig({
  test: {
    setupFiles: ["./config/setup-markdown.ts", "./config/setup-test-timeouts.ts"],
    ...testObservation("effect-codex"),
    ...vitestTimeouts(testFiles.isStress),
    env: TEST_ENVIRONMENT,
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: 2,
  },
});
