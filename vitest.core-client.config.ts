import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";
import { rendererViteResolve } from "./config/renderer-vite-shared";
import { selectTieredTestFiles } from "./config/vitest-test-tier";

const testFiles = selectTieredTestFiles({
  defaultInclude: [
    "src/main/core-client/**/*.node.test.ts",
    "src/main/core-runtime/**/*.node.test.ts",
    "src/main/library-application/**/*.node.test.ts",
    "src/main/database-application/**/*.node.test.ts",
    "src/main/nodex-agent-application/**/*.node.test.ts",
    "src/main/codex-runtime/**/*.node.test.ts",
    "src/main/codex-application/**/*.node.test.ts",
    "src/main/ipc/handlers/**/*.node.test.ts",
    "src/main/host-runtime/**/*.node.test.ts",
    "src/main/terminal-runtime/**/*.node.test.ts",
    "src/main/effect-control-plane/**/*.node.test.ts",
  ],
  stressInclude: ["src/main/core-client/**/*.stress.node.test.ts"],
});

export default defineConfig({
  resolve: rendererViteResolve,
  test: {
    ...testObservation("core-client"),
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
