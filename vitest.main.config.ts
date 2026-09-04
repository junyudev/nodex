import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { assertElectronTestRuntime } from "./config/electron-test-runtime";
import { selectTieredTestFiles } from "./config/vitest-test-tier";

assertElectronTestRuntime("main");

const testFiles = selectTieredTestFiles({
  defaultExclude: ["src/main/**/*.integration.ts", "src/main/core-client/**/*.node.test.ts"],
  defaultInclude: ["src/main/**/*.test.ts"],
  stressExclude: ["src/main/core-client/**/*.node.test.ts"],
  stressInclude: ["src/main/**/*.stress*.test.ts"],
});

export default defineConfig({
  test: {
    ...testObservation("main"),
    env: { TZ: "UTC" },
    environment: "node",
    exclude: testFiles.exclude,
    include: testFiles.include,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    pool: "forks",
    testTimeout: testFiles.isStress ? 60_000 : 20_000,
  },
});
