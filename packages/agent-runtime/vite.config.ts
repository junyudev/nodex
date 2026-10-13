import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    fileParallelism: false,
    hookTimeout: 120_000,
    testTimeout: 120_000,
    setupFiles: [
      fileURLToPath(new URL("./vendor/shared/src/testing/longTempDir.ts", import.meta.url)),
      fileURLToPath(new URL("./src/testUtils/gitConfig.setup.ts", import.meta.url)),
    ],
  },
});
