import { testObservation } from "./config/vitest-observation";
import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    ...testObservation("effect-codex"),
    environment: "node",
    include: ["packages/effect-codex-app-server/src/**/*.test.ts"],
    maxWorkers: 2,
  },
});
