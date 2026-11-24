import { defineConfig } from "vite-plus";
import { observeTestFiles } from "../../../config/test-file-observation.ts";

export default defineConfig({
  test: {
    ...observeTestFiles([]),
    include: ["scripts/fixtures/test-observation/*.test.ts"],
    maxWorkers: 1,
    vmMemoryLimit: "512MiB",
  },
});
