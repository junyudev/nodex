import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { availableParallelism, totalmem } from "node:os";
import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "./config/renderer-vite-shared";
import { filesForSuite } from "./config/test-suites";
import { rendererWorkerCount } from "./config/renderer-worker-count";

const testFiles = filesForSuite("renderer", resolveVitestTestTier());

export default defineConfig({
  plugins: createRendererVitePlugins(),
  resolve: rendererViteResolve,
  css: rendererViteCss,
  test: {
    ...testObservation("renderer"),
    env: { TZ: "UTC" },
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "http://renderer.test/" },
    },
    exclude: testFiles.exclude,
    include: testFiles.include,
    pool: "forks",
    maxWorkers: rendererWorkerCount({
      ci: process.env.CI === "true",
      stress: testFiles.isStress,
      parallelism: availableParallelism(),
      memoryBytes: totalmem(),
    }),
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    setupFiles: ["./src/renderer/test/setup.ts"],
    hookTimeout: testFiles.isStress ? 60_000 : 30_000,
    testTimeout: testFiles.isStress ? 60_000 : 30_000,
  },
});
