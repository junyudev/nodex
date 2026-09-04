import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { filesForSuite } from "./config/test-suites";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";

const testFiles = filesForSuite("effect-codex", resolveVitestTestTier());

export default defineConfig({
  test: {
    ...testObservation("effect-codex"),
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: 2,
  },
});
