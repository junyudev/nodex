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
import { filesForSuite, rendererNativePortTests } from "./test-suites";
import { rendererWorkerCount } from "./renderer-worker-count";

const testFiles = filesForSuite("renderer", resolveVitestTestTier());
const memoryBytes = totalmem();
// A full VM run needs room for the transform server and retiring worker processes.
const useVmPool = !testFiles.isStress && memoryBytes >= 24 * 1024 ** 3;
const maxWorkers = rendererWorkerCount({
  ci: process.env.CI === "true",
  stress: testFiles.isStress,
  parallelism: availableParallelism(),
  memoryBytes,
});

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
    // Vitest resolves the recycle threshold from the root config even with projects.
    vmMemoryLimit: "384MiB",
    ...(useVmPool
      ? {
          projects: [
            {
              extends: true as const,
              test: {
                name: "renderer",
                include: testFiles.include,
                exclude: [...rendererNativePortTests],
                pool: "vmForks" as const,
              },
            },
            {
              extends: true as const,
              test: {
                name: "renderer-native-ports",
                include: [...rendererNativePortTests],
                pool: "forks" as const,
              },
            },
          ],
        }
      : { include: testFiles.include, pool: "forks" as const }),
    maxWorkers: useVmPool ? Math.min(maxWorkers, 2) : maxWorkers,
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
