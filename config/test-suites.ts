import path from "node:path";
import type { VitestTestTier } from "./vitest-test-tier.ts";

export const APP_TEST_SUITES = [
  "unit",
  "effect-codex",
  "core-client",
  "main",
  "renderer",
  "integration",
  "browser",
] as const;
export type SuiteId = (typeof APP_TEST_SUITES)[number];
export type TestRuntime = "host-node" | "electron-node" | "jsdom" | "chromium";
export type NativeArtifactId = "core-server" | "yjs-yrs-bridge" | "cli";
export const NODEX_CLI_BOOTSTRAP_TEST = "src/main/platform/node/NodexCliBootstrap.node.test.ts";
export const YJS_YRS_TEST = "src/shared/block-documents/yjs-yrs-conformance.test.ts";

const blocknoteTests = [
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
] as const;

interface TestSuite {
  readonly config: string;
  readonly runtime: TestRuntime;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly stress: readonly string[];
  readonly native: readonly NativeArtifactId[];
}

/** Runtime, discovery and prerequisites change together; consumers never copy globs. */
const suites: Readonly<Record<SuiteId, TestSuite>> = {
  unit: {
    config: "vitest.node.config.ts",
    runtime: "host-node",
    include: [
      "config/**/*.test.ts",
      "scripts/**/*.test.ts",
      "src/shared/**/*.test.ts",
      "src/renderer/**/*.test.ts",
      "src/renderer/**/*.node.test.{ts,tsx}",
      "packages/landing/src/**/*.test.ts",
    ],
    exclude: [
      YJS_YRS_TEST,
      "packages/landing/src/**/*.jsdom.test.ts",
      "scripts/fixtures/**",
      "src/renderer/**/*.browser.test.{ts,tsx}",
      "src/renderer/**/*.jsdom.test.ts",
      "src/renderer/**/*.stress.test.{ts,tsx}",
      "third_party/**",
    ],
    stress: [
      "config/**/*.stress.test.ts",
      "scripts/**/*.stress.test.ts",
      "src/shared/**/*.stress.test.ts",
      "src/renderer/**/*.stress.node.test.{ts,tsx}",
      "packages/landing/src/**/*.stress.test.ts",
    ],
    native: [],
  },
  "effect-codex": {
    config: "vitest.effect-codex.config.ts",
    runtime: "host-node",
    include: ["packages/effect-codex-app-server/src/**/*.test.ts"],
    exclude: [],
    stress: [],
    native: [],
  },
  "core-client": {
    config: "vitest.core-client.config.ts",
    runtime: "host-node",
    include: ["src/main/**/*.node.test.ts", YJS_YRS_TEST],
    exclude: [],
    stress: ["src/main/**/*.stress.node.test.ts"],
    native: ["core-server", "yjs-yrs-bridge", "cli"],
  },
  main: {
    config: "vitest.main.config.ts",
    runtime: "electron-node",
    include: ["src/main/**/*.test.ts"],
    exclude: ["src/main/**/*.integration.ts", "src/main/**/*.node.test.ts"],
    stress: ["src/main/**/*.stress*.test.ts"],
    native: ["core-server"],
  },
  renderer: {
    config: "vitest.renderer.config.ts",
    runtime: "jsdom",
    include: [
      "src/renderer/**/*.test.tsx",
      "src/renderer/**/*.jsdom.test.ts",
      "packages/landing/src/**/*.jsdom.test.ts",
      ...blocknoteTests,
    ],
    exclude: [
      "src/renderer/**/*.browser.test.{ts,tsx}",
      "src/renderer/**/*.node.test.{ts,tsx}",
      "src/renderer/**/*.integration.ts",
    ],
    stress: ["src/renderer/**/*.stress.test.{ts,tsx}"],
    native: [],
  },
  integration: {
    config: "vitest.integration.config.ts",
    runtime: "electron-node",
    include: ["src/main/**/*.integration.ts", "src/renderer/**/*.integration.ts"],
    exclude: [],
    stress: ["src/main/**/*.stress.integration.ts", "src/renderer/**/*.stress.integration.ts"],
    native: ["core-server"],
  },
  browser: {
    config: "vitest.browser.config.ts",
    runtime: "chromium",
    include: ["src/renderer/**/*.browser.test.{ts,tsx}"],
    exclude: [],
    stress: ["src/renderer/**/*.stress.browser.test.{ts,tsx}"],
    native: [],
  },
};

export const STANDARD_TEST_SUITES = APP_TEST_SUITES.filter((suite) => suite !== "browser");
export const STRESS_TEST_SUITES = APP_TEST_SUITES.filter(
  (suite) => suites[suite].stress.length > 0,
);
export const suiteConfig = (suite: SuiteId): string => suites[suite].config;
export const runtimeForSuite = (suite: SuiteId): TestRuntime => suites[suite].runtime;

export function parseTestSuite(value: string): SuiteId {
  if ((APP_TEST_SUITES as readonly string[]).includes(value)) return value as SuiteId;
  throw new Error("Unknown application test suite: " + JSON.stringify(value) + ".");
}

export function filesForSuite(suite: SuiteId, tier: VitestTestTier = "default") {
  const definition = suites[suite];
  return {
    include: [...(tier === "stress" ? definition.stress : definition.include)],
    exclude: [...definition.exclude, ...(tier === "default" ? ["**/*.stress.*"] : [])],
    isStress: tier === "stress",
  };
}

export function ownersOfTest(file: string): readonly { suite: SuiteId; tier: VitestTestTier }[] {
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//u, "");
  const tier: VitestTestTier = normalized.includes(".stress.") ? "stress" : "default";
  return APP_TEST_SUITES.flatMap((suite) => {
    const { include, exclude } = filesForSuite(suite, tier);
    const matches = (glob: string) => path.posix.matchesGlob(normalized, glob);
    return include.some(matches) && !exclude.some(matches) ? [{ suite, tier }] : [];
  });
}

export function ownerOfTest(file: string) {
  const owners = ownersOfTest(file);
  if (owners.length > 1) throw new Error("Test has multiple owners: " + file);
  return owners[0];
}

/** Omitted files means the full suite. An empty selection needs no build. */
export function nativeRequirements(
  suite: SuiteId,
  files?: readonly string[],
): readonly NativeArtifactId[] {
  if (!files) return suites[suite].native;
  if (files.length === 0) return [];
  if (suite !== "core-client") return suites[suite].native;
  return [
    ...(files.some((file) => file !== YJS_YRS_TEST) ? ["core-server" as const] : []),
    ...(files.includes(YJS_YRS_TEST) ? ["yjs-yrs-bridge" as const] : []),
    ...(files.includes(NODEX_CLI_BOOTSTRAP_TEST) ? ["cli" as const] : []),
  ];
}

export const maintainedThirdPartyTests: readonly string[] = blocknoteTests;
