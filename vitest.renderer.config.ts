import { defineConfig } from "vite-plus";
import {
  createRendererVitePlugins,
  rendererViteCss,
  rendererViteResolve,
} from "./config/renderer-vite-shared";
import { selectTieredTestFiles } from "./config/vitest-test-tier";
import { rendererWorkerCount } from "./config/renderer-worker-count";

const testFiles = selectTieredTestFiles({
  defaultExclude: [
    "src/renderer/**/*.browser.test.{ts,tsx}",
    "src/renderer/**/*.node.test.{ts,tsx}",
    "src/renderer/**/*.integration.ts",
  ],
  defaultInclude: [
    "src/renderer/**/*.test.tsx",
    "src/renderer/**/*.jsdom.test.ts",
    "third_party/blocknote/packages/core/src/api/getBlockInfoFromPos.test.ts",
    "third_party/blocknote/packages/core/src/api/blockManipulation/tables/table-resource-limits.test.ts",
    "third_party/blocknote/packages/core/src/api/exporters/markdown/htmlToMarkdown.test.ts",
    "third_party/blocknote/packages/core/src/api/nodeConversions/blockToNode.test.ts",
    "third_party/blocknote/packages/core/src/api/parsers/markdown/markdownToHtml.security.test.ts",
    "third_party/blocknote/packages/core/src/blocks/Code/block.test.ts",
    "third_party/blocknote/packages/core/src/blocks/Code/indentation.test.ts",
    "third_party/blocknote/packages/core/src/schema/inlineContent/createSpec.test.ts",
    "third_party/blocknote/packages/core/src/extensions/Versioning/Versioning.test.ts",
    "third_party/blocknote/packages/core/src/extensions/Versioning/inMemoryVersioning.test.ts",
    "third_party/blocknote/packages/core/src/extensions/tiptap-extensions/KeyboardShortcuts/KeyboardShortcutsExtension.test.ts",
    "third_party/blocknote/packages/core/src/extensions/tiptap-extensions/Link/link.test.ts",
    "third_party/blocknote/packages/core/src/extensions/SuggestionMenu/SuggestionMenu.test.ts",
    "third_party/blocknote/packages/core/src/extensions/SideMenu/dragging.test.ts",
    "third_party/blocknote/packages/core/src/extensions/SourceBlockWithPreview/SourceBlockWithPreview.test.ts",
    "third_party/blocknote/packages/core/src/yjs/extensions/Versioning.test.ts",
    "third_party/blocknote/packages/react/src/components/SuggestionMenu/SuggestionMenuFreshness.test.tsx",
    "third_party/blocknote/packages/react/src/components/SuggestionMenu/hooks/useCloseSuggestionMenuNoItems.test.tsx",
    "third_party/blocknote/packages/react/src/util/sanitizeUrl.test.ts",
  ],
  stressInclude: ["src/renderer/**/*.stress.test.{ts,tsx}"],
});

export default defineConfig({
  plugins: createRendererVitePlugins(),
  resolve: rendererViteResolve,
  css: rendererViteCss,
  test: {
    env: { TZ: "UTC" },
    environment: "jsdom",
    environmentOptions: {
      jsdom: { url: "http://renderer.test/" },
    },
    exclude: testFiles.exclude,
    include: testFiles.include,
    pool: "forks",
    maxWorkers: rendererWorkerCount({ ci: process.env.CI === "true", stress: testFiles.isStress }),
    fileParallelism: !testFiles.isStress,
    passWithNoTests: testFiles.isStress,
    setupFiles: ["./src/renderer/test/setup.ts"],
    hookTimeout: testFiles.isStress ? 60_000 : 30_000,
    testTimeout: testFiles.isStress ? 60_000 : 30_000,
  },
});
