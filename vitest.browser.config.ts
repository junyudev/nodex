import { resolveVitestTestTier } from "./config/vitest-test-tier";
import { testObservation } from "./config/vitest-observation";
import { playwright } from "vite-plus/test/browser-playwright";
import { defineConfig } from "vite-plus";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "./config/renderer-vite-shared";
import { filesForSuite } from "./config/test-suites";

const testFiles = filesForSuite("browser", resolveVitestTestTier());

export default defineConfig({
  plugins: createRendererVitePlugins(),
  resolve: rendererViteResolve,
  css: rendererViteCss,
  optimizeDeps: {
    include: [
      "@base-ui/react/button",
      "@base-ui/react/collapsible",
      "@base-ui/react/context-menu",
      "@base-ui/react/dialog",
      "@base-ui/react/menu",
      "@base-ui/react/popover",
      "@base-ui/react/scroll-area",
      "@base-ui/react/slider",
      "@base-ui/react/tabs",
      "@base-ui/react/tooltip",
      "@base-ui/react/use-render",
    ],
  },
  test: {
    ...testObservation("browser"),
    browser: {
      enabled: true,
      headless: true,
      instances: [{ browser: "chromium" }],
      provider: playwright(),
    },
    exclude: testFiles.exclude,
    include: testFiles.include,
    fileParallelism: false,
    passWithNoTests: testFiles.isStress,
    setupFiles: ["./src/renderer/test/setup-browser.ts"],
    ...(testFiles.isStress ? { testTimeout: 60_000 } : {}),
  },
});
