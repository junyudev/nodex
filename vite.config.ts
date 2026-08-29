import { defineConfig } from "vite-plus";
import { recommended as effectRecommended } from "@effect/tsgo/oxlint-presets";

const toolingFixtureMode = process.env.NODEX_TOOLING_FIXTURE_MODE === "1";
const generatedOrExternalPaths = [
  ".cache/**",
  ".generated/**",
  ".vite-plus/**",
  "build/**",
  "cache.local/**",
  "coverage/**",
  "dist/**",
  "node_modules/**",
  "out/**",
  "packages/*/dist/**",
  "packages/codex-app-server-protocol/runtime-schemas/**",
  "packages/codex-app-server-protocol/src/**",
  "packages/effect-codex-app-server/src/_generated/**",
  "packages/core-protocol/openapi.json",
  "packages/core-protocol/src/compatibility.generated.ts",
  "packages/core-protocol/src/generated.ts",
  "packages/storybook/storybook-static/**",
  "pnpm-lock.yaml",
  "playwright-report/**",
  "scripts/fixtures/tooling/**",
  "scripts/scenarios/artifacts/**",
  "src/renderer/generated/**",
  "src/renderer/**/*.generated.*",
  "**/fixtures/**",
  "**/test-fixtures/**",
  "test-results/**",
  "third_party/**",
];

// Whitespace and delimiters are protocol data in these syntax references.
// Formatting them can silently change the Nested Markdown examples they define.
const rawMarkdownReferencePaths = [
  "agent-skills/nodex/references/nested-markdown.md",
  "docs/references/nested-markdown-spec.md",
  "docs/references/notion-flavored-markdown-syntax-sample.md",
];

// These files remain runnable artifacts, but they were deliberately outside the
// previous `tsc -b` project graph. Keep the TS7 migration scoped to that graph.
const nonProjectSources = [
  "**/*.cjs",
  "**/*.js",
  "**/*.mjs",
  "config/**/*.test.ts",
  "scripts/**/*.test.ts",
];

const rendererRestrictedImportPaths = [
  {
    name: "lucide-react",
    message:
      "Use app-owned icons from @/components/shared/icons or normalized generic glyphs from @/components/shared/icons/generic-icons.",
  },
];

const tanstackQueryRules = {
  "@tanstack/query/exhaustive-deps": "error",
  "@tanstack/query/infinite-query-property-order": "error",
  "@tanstack/query/mutation-property-order": "error",
  "@tanstack/query/no-rest-destructuring": "error",
  "@tanstack/query/no-unstable-deps": "error",
  "@tanstack/query/no-void-query-fn": "error",
  "@tanstack/query/stable-query-client": "error",
} as const;

const betterTailwindEnabled = process.env.ESLINT_BETTER_TAILWIND === "1";
const betterTailwindOptions = {
  detectComponentClasses: true,
  entryPoint: "./src/renderer/globals.css",
};
const pluginRule = <Options>(
  severity: "error" | "warn",
  options: Options,
): ["error" | "warn", Options] => [severity, options];
const betterTailwindRules = betterTailwindEnabled
  ? {
      "better-tailwindcss/enforce-canonical-classes": pluginRule("warn", betterTailwindOptions),
      "better-tailwindcss/enforce-consistent-class-order": pluginRule(
        "warn",
        betterTailwindOptions,
      ),
      "better-tailwindcss/no-conflicting-classes": pluginRule("error", betterTailwindOptions),
      "better-tailwindcss/no-deprecated-classes": pluginRule("warn", betterTailwindOptions),
      "better-tailwindcss/no-duplicate-classes": pluginRule("warn", betterTailwindOptions),
      "better-tailwindcss/no-unknown-classes": pluginRule("error", {
        ...betterTailwindOptions,
        ignore: [
          "^excalidraw-button$",
          "^slide-in-from-top-0\\.5$",
          "^nfm-",
          "^bn-",
          "^nodex-",
          "^codex-",
        ],
      }),
      "better-tailwindcss/no-unnecessary-whitespace": pluginRule("warn", betterTailwindOptions),
    }
  : {};

const workbenchRefreshBoundaries = [
  "src/renderer/components/workbench/workbench-shell.tsx",
  "src/renderer/components/workbench/workbench-panel-controls.tsx",
  "src/renderer/components/workbench/workbench-panel-surface.tsx",
  "src/renderer/components/workbench/workbench-db-view-panel.tsx",
  "src/renderer/components/workbench/workbench-page-stage-panel.tsx",
  "src/renderer/components/workbench/workbench-review-route-adapter.tsx",
  "src/renderer/components/workbench/workbench-session-thread-route.tsx",
  "src/renderer/components/workbench/workbench-runtime-panel-surfaces.tsx",
  "src/renderer/components/workbench/workbench-auxiliary-conversation-panels.tsx",
  "src/renderer/components/workbench/workbench-side-chat-panels.tsx",
  "src/renderer/components/workbench/workbench-session-sidebar.tsx",
];

const singleOwnerEventHandlerFiles = [
  "src/renderer/components/block-documents/long-page-open.stress.browser.test.ts",
  "src/renderer/features/local-conversation/view/composer/image-attachments/use-composer-image-attachments.ts",
  "src/renderer/features/user-attachment-image-editor/view/user-attachment-image-editor-surface.tsx",
  "src/renderer/lib/assets.ts",
  "src/renderer/lib/canvas-scene-outbox.node.test.ts",
  "src/renderer/lib/canvas-scene-outbox.ts",
  "src/renderer/lib/document-local-checkpoint.ts",
  "src/renderer/lib/mcp-app/mcp-app-port-rpc.ts",
];

const toolingFixtureIgnorePatterns = new Set(["scripts/fixtures/tooling/**", "**/fixtures/**"]);
const effectControlPlaneFiles = [
  "packages/effect-codex-app-server/**/*.{ts,tsx}",
  "src/main/app/**/*.{ts,tsx}",
  "src/main/core-runtime/**/*.{ts,tsx}",
  "src/main/codex-runtime/**/*.{ts,tsx}",
  "src/main/platform/**/*.{ts,tsx}",
  "src/main/main-program*.ts",
  "scripts/codex-probe-session.ts",
];

export default defineConfig({
  lint: {
    ignorePatterns: [
      ...generatedOrExternalPaths.filter(
        (path) => !toolingFixtureMode || !toolingFixtureIgnorePatterns.has(path),
      ),
      ...nonProjectSources.filter((path) => !toolingFixtureMode || path !== "scripts/**/*.test.ts"),
    ],
    jsPlugins: [
      "./oxlint-plugin-nodex/index.ts",
      { name: "@tanstack/query", specifier: "@tanstack/eslint-plugin-query" },
      ...(betterTailwindEnabled
        ? [{ name: "better-tailwindcss", specifier: "eslint-plugin-better-tailwindcss" }]
        : []),
    ],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    options: {
      typeAware: !toolingFixtureMode,
      typeCheck: !toolingFixtureMode,
    },
    plugins: ["effecttsgo", "eslint", "oxc", "react", "typescript", "unicorn"],
    rules: {
      // These broad heuristics consume the diagnostic budget without expressing
      // a stable Nodex invariant. Keep correctness rules below strict instead.
      "eslint/no-await-in-loop": "off",
      "eslint/no-control-regex": "off",
      "eslint/no-empty-pattern": "off",
      "eslint/no-shadow": "off",
      "eslint/no-underscore-dangle": "off",
      "eslint/no-useless-escape": "off",
      "oxc/no-map-spread": "off",
      "oxc/no-accumulating-spread": "off",
      "react/no-array-index-key": "off",
      "react/no-children-prop": "off",
      "react/react-in-jsx-scope": "off",
      "typescript/await-thenable": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/no-array-fill-with-reference-type": "off",
      "unicorn/no-array-reverse": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-new-array": "off",
      "unicorn/no-useless-fallback-in-spread": "off",
      "unicorn/no-useless-spread": "off",
      "unicorn/prefer-array-find": "off",
      "unicorn/prefer-set-has": "off",

      // Only stable correctness contracts and app-owned invariants block the gate.
      // Broad category diagnostics remain advisory so agents can improve nearby code
      // without turning historical warning volume into unrelated cleanup work.
      "eslint/no-extra-boolean-cast": "error",
      "eslint/preserve-caught-error": "error",
      "eslint/no-unreachable": "error",
      "eslint/no-unsafe-finally": "error",
      "eslint/no-unsafe-optional-chaining": "error",
      "nodex/no-manual-effect-runtime-in-tests": "error",
      "nodex/no-ambient-profile-authority": "error",
      "nodex/no-native-title-tooltip": "error",
      "oxc/const-comparisons": "error",
      "react/iframe-missing-sandbox": "error",
      "react/jsx-no-constructed-context-values": "error",
      // Render-prop callbacks are lazy slots, not component identities. Their
      // call site owns invocation; component-valued props remain prohibited.
      "react/no-unstable-nested-components": ["error", { allowAsProps: true }],
      "typescript/no-floating-promises": "error",
      "typescript/no-misused-spread": "error",
      "typescript/no-unsafe-enum-comparison": "error",
      "typescript/require-array-sort-compare": "error",
      ...tanstackQueryRules,
      ...betterTailwindRules,
    },
    overrides: [
      {
        files: ["**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}"],
        rules: {
          // Test assertions deliberately probe nullable values and cleanup failures.
          "eslint/no-unsafe-finally": "off",
          "eslint/no-unsafe-optional-chaining": "off",
          // Constructor-only and nominal classes are legitimate platform fixtures.
          "typescript/no-extraneous-class": "off",
          // One-shot Provider fixtures do not cross a production render boundary.
          "react/jsx-no-constructed-context-values": "off",
        },
      },
      {
        files: ["src/main/core-client/isolated-run-ownership.ts", "src/main/local-store/assets.ts"],
        rules: {
          // Cleanup failure is intentionally fatal on these durability boundaries.
          "eslint/no-unsafe-finally": "off",
        },
      },
      {
        files: ["src/renderer/**/*.{ts,tsx}", "scripts/fixtures/tooling/renderer/**/*.{ts,tsx}"],
        rules: {
          "no-restricted-imports": ["error", { paths: rendererRestrictedImportPaths }],
          "react/exhaustive-deps": "error",
          "react/rules-of-hooks": "error",
        },
      },
      {
        files: singleOwnerEventHandlerFiles,
        rules: {
          // These adapters exclusively own fresh EventTarget handler slots and
          // intentionally replace or clear the one lifecycle callback.
          "unicorn/prefer-add-event-listener": "off",
        },
      },
      {
        files: ["src/renderer/env.d.ts"],
        rules: {
          // The empty export is the declaration file's explicit module marker.
          "unicorn/require-module-specifiers": "off",
        },
      },
      {
        files: [
          "src/renderer/**/*.test.tsx",
          "src/renderer/**/*.jsdom.test.ts",
          "src/renderer/**/*testkit*/**/*.{ts,tsx}",
          "scripts/fixtures/tooling/renderer-tests/**/*.{ts,tsx}",
        ],
        excludeFiles: ["src/renderer/**/*.browser.test.tsx", "src/renderer/**/*.node.test.tsx"],
        rules: {
          "no-restricted-imports": [
            "error",
            {
              paths: rendererRestrictedImportPaths,
              patterns: [
                {
                  regex: "(?:^|/)shared/block-documents$",
                  message:
                    "Import the owning block-documents module directly so renderer tests do not load the complete schema barrel.",
                },
              ],
            },
          ],
        },
      },
      {
        files: [...workbenchRefreshBoundaries, "scripts/fixtures/tooling/workbench/**/*.{ts,tsx}"],
        rules: {
          "react/only-export-components": "error",
        },
      },
      {
        files: [
          "src/renderer/components/ui/context-menu.tsx",
          "src/renderer/components/shared/icons/generic-icons.tsx",
        ],
        rules: {
          "no-restricted-imports": "off",
        },
      },
      {
        files: [
          "src/main/git-worker-host.ts",
          "src/main/worktree-worker/worktree-worker-host.ts",
          "src/renderer/lib/mcp-app/mcp-app-port-rpc.ts",
        ],
        rules: {
          // Worker and MessagePort postMessage use a transfer-list overload;
          // unlike Window.postMessage, they do not accept a target origin.
          "unicorn/require-post-message-target-origin": "off",
        },
      },
      {
        files: effectControlPlaneFiles,
        rules: effectRecommended.rules,
      },
      {
        files: [
          "packages/effect-codex-app-server/src/_internal/**/*.{ts,tsx}",
          "packages/effect-codex-app-server/scripts/**/*.ts",
          "src/main/platform/**/*.{ts,tsx}",
          "scripts/codex-probe-session.ts",
        ],
        rules: {
          ...effectRecommended.rules,
          // These app-owned adapters are the intentional Node/platform frontier.
          "effecttsgo/global-random": "off",
          "effecttsgo/node-builtin-import": "off",
        },
      },
    ],
  },
  fmt: {
    ignorePatterns: [...generatedOrExternalPaths, ...rawMarkdownReferencePaths],
    sortPackageJson: {},
  },
  // Static validation is deterministic and produces no restorable artifacts,
  // so Vite Task owns its cache policy and automatic input tracking. Keep
  // side-effectful development, generation, packaging, and release commands as
  // uncached package scripts unless they earn a narrower task definition. Keep
  // these entries literal so Vite+ can statically extract the run config.
  run: {
    cache: {
      scripts: false,
      tasks: true,
    },
    tasks: {
      check: {
        command: "vp check",
        env: ["ESLINT_BETTER_TAILWIND", "NODEX_TOOLING_FIXTURE_MODE"],
        input: [{ auto: true }, "!cache.local", "!cache.local/**"],
        output: [],
      },
      "fmt:check": {
        command: "vp fmt --check",
        input: [{ auto: true }, "!cache.local", "!cache.local/**"],
        output: [],
      },
      lint: {
        command: "vp lint --report-unused-disable-directives",
        env: ["ESLINT_BETTER_TAILWIND", "NODEX_TOOLING_FIXTURE_MODE"],
        input: [{ auto: true }, "!cache.local", "!cache.local/**"],
        output: [],
      },
      typecheck: {
        command: "vp check --no-fmt",
        env: ["ESLINT_BETTER_TAILWIND", "NODEX_TOOLING_FIXTURE_MODE"],
        input: [{ auto: true }, "!cache.local", "!cache.local/**"],
        output: [],
      },
    },
  },
  staged: {
    "*": "vp fmt",
  },
});
