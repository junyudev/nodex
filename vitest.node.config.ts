import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./config/renderer-vite-shared";
import { selectTieredTestFiles } from "./config/vitest-test-tier";

const testFiles = selectTieredTestFiles({
  defaultExclude: [
    "packages/landing/src/download-cta.test.ts",
    "scripts/fixtures/**",
    "src/renderer/**/*.browser.test.ts",
    "src/renderer/**/*.jsdom.test.ts",
    "src/renderer/**/*.stress.test.{ts,tsx}",
    "third_party/**",
  ],
  defaultInclude: [
    "config/**/*.test.ts",
    "scripts/**/*.test.ts",
    "src/shared/**/*.test.ts",
    "src/renderer/**/*.test.ts",
    "src/renderer/**/*.node.test.{ts,tsx}",
    "packages/landing/src/**/*.test.ts",
  ],
  stressInclude: [
    "config/**/*.stress.test.ts",
    "scripts/**/*.stress.test.ts",
    "src/shared/**/*.stress.test.ts",
    "src/renderer/**/*.stress.node.test.{ts,tsx}",
    "packages/landing/src/**/*.stress.test.ts",
  ],
});

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    ...testObservation("unit"),
    env: { TZ: "UTC" },
    environment: "node",
    include: testFiles.include,
    exclude: testFiles.exclude,
    maxWorkers: testFiles.isStress ? 1 : 4,
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    testTimeout: testFiles.isStress ? 60_000 : 30_000,
  },
});
