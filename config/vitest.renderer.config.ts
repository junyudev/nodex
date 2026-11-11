import { vitestTimeouts } from "./test-timeouts";
import { resolveVitestTestTier } from "./vitest-test-tier";
import { TEST_ENVIRONMENT } from "./test-environment";
import { availableParallelism, totalmem } from "node:os";
import { testObservation } from "./vitest-observation";
import { defineConfig } from "vite-plus";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
  rendererViteWorker,
} from "./renderer-vite-shared";
import { filesForSuite } from "./test-suites";
import { rendererWorkerCount } from "./renderer-worker-count";

const testFiles = filesForSuite("renderer", resolveVitestTestTier());

export default defineConfig(async () => ({
  // Generated JavaScript still belongs to this renderer, even in nested worktrees.
  tsconfig: "./config/tsconfig.web.json",
  plugins: await createRendererVitePlugins(),
  resolve: rendererViteResolve,
  css: rendererViteCss,
  worker: rendererViteWorker,
  test: {
    ...testObservation("renderer"),
    env: TEST_ENVIRONMENT,
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
    setupFiles: [
      "./config/setup-markdown.ts",
      "./config/setup-test-timeouts.ts",
      "./src/renderer/test/setup.ts",
    ],
    ...vitestTimeouts(testFiles.isStress),
  },
}));
