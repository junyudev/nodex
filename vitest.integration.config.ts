import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { selectTieredTestFiles } from "./config/vitest-test-tier";

assertElectronTestRuntime("integration");

const testFiles = selectTieredTestFiles({
  defaultInclude: ["src/main/**/*.integration.ts", "src/renderer/**/*.integration.ts"],
  stressInclude: ["src/main/**/*.stress.integration.ts", "src/renderer/**/*.stress.integration.ts"],
});

export default defineConfig({
  test: {
    ...testObservation("integration"),
    env: { TZ: "UTC" },
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    ...(testFiles.isStress ? { maxWorkers: 1 } : {}),
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    testTimeout: testFiles.isStress ? 60_000 : 20_000,
  },
});
