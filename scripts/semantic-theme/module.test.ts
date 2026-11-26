import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { executeSemanticThemeCommand } from "./module";
import {
  MIGRATED_SURFACE_POLICIES,
  SEMANTIC_THEME_ARTIFACT_PATHS,
  SEMANTIC_THEME_RUNTIME_VARIABLES,
} from "./profile";
import { collectSemanticThemeIntegrityDiagnostics } from "./integrity";
import {
  collectSelectorFingerprints,
  collectSemanticThemeCssFacts,
  extractCustomPropertyMap,
  filterCss,
} from "./parser";

const workspaces: string[] = [];

const referenceFixture = `
  /* identity and /private/input.css must never be exported */
  .app-theme {
    --vscode-foreground: #202124;
    --vscode-errorForeground: #c43b2f;
    --vscode-charts-blue: #2878d0;
    --vscode-button-foreground: white;
    --vscode-editor-selectionBackground: #d8e8ff;
  }
  :root, :host {
    ${SEMANTIC_THEME_RUNTIME_VARIABLES.map((name) => `${name}: #0285ff;`).join("\n")}
    --font-sans: sans-serif;
    --spacing-panel: 1rem;
    --corner-radius-scale: 1.25;
    --height-toolbar: 46px;
    --radius-xs: 4px;
    --radius-sm: 6px;
    --radius-md: 8px;
    --radius-lg: 10px;
    --radius-xl: 12px;
    --radius-2xl: 16px;
    --radius-3xl: 20px;
    --radius-4xl: 24px;
    --thread-content-max-width: 48rem;
    --color-token-foreground: var(--vscode-foreground);
    --color-token-description-foreground: var(--vscode-foreground);
    --color-text: var(--vscode-foreground);
    --color-text-info: var(--vscode-charts-blue);
    --color-text-danger: var(--vscode-errorForeground);
    --color-text-tertiary: color-mix(in oklab, var(--vscode-foreground) 55%, transparent);
    --color-text-secondary: color-mix(in oklab, var(--vscode-foreground) 75%, transparent);
    --color-border: color-mix(in oklab, var(--vscode-foreground) 12%, transparent);
    --color-border-heavy: color-mix(in oklab, var(--vscode-foreground) 20%, transparent);
    --color-background-primary-solid: var(--vscode-foreground);
    --color-background-info-solid: var(--vscode-charts-blue);
    --color-background-composer-primary: var(--color-background-primary-solid);
    --color-background-user-message: color-mix(in oklab, var(--color-text) 5%, transparent);
    --color-background-tip-badge: var(--vscode-editor-selectionBackground);
    --color-background-button-secondary: var(--vscode-editor-selectionBackground);
    --color-text-primary-solid: var(--vscode-button-foreground);
    --color-text-inverse: var(--vscode-button-foreground);
    --color-text-composer-primary: var(--color-text-primary-solid);
    --color-text-user-message: var(--color-text);
    --color-text-on-accent: var(--vscode-button-foreground);
    --color-text-tip-badge: var(--vscode-charts-blue);
    --color-chart-blue: var(--vscode-charts-blue);
    --app-shell-page-window-fill: white;
    --color-accent: #0285ff;
    --menu-background-color: white;
    --switch-thumb-color: white;
    --switch-thumb-color-checked: var(--switch-thumb-color);
  }
  .text-info { color: var(--color-text-info); }
  .text-danger { color: var(--color-text-danger); }
  .text-tertiary { color: var(--color-text-tertiary); }
  .text-secondary { color: var(--color-text-secondary); }
  .border-default { border-color: var(--color-border); }
  .bg-text-info { background-color: var(--color-text-info); }
  .bg-info-solid { background-color: var(--color-background-info-solid); }
  .bg-text\\/10 { background-color: color-mix(in oklab, var(--color-text) 10%, transparent); }
  .bg-composer-primary { background-color: var(--color-background-composer-primary); }
  .text-composer-primary { color: var(--color-text-composer-primary); }
  .bg-user-message { background-color: var(--color-background-user-message); }
  .text-user-message { color: var(--color-text-user-message); }
  .bg-chart-blue { background-color: var(--color-chart-blue); }
  .text-inverse { color: var(--color-text-inverse); }
  .bg-primary-solid { background-color: var(--color-background-primary-solid); }
  .text-primary-solid { color: var(--color-text-primary-solid); }
  .loading-shimmer { color: transparent; }
`;

const createWorkspace = async (): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), "semantic-theme-test-"));
  workspaces.push(workspace);
  const providers = [
    "theme-source.css",
    "theme-token-bridge.css",
    "theme-utilities.css",
    "theme-surface.css",
  ];
  for (const [index, provider] of providers.entries()) {
    const path = join(workspace, "src/renderer/styles", provider);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      index === 0
        ? `
      @theme static { --spacing: 0.25rem; }
      :root {
        --background: white;
        --destructive: #c43b2f;
        --corner-radius-scale: 1.25;
        --radius-2xs-base: 0.125rem;
        --radius-xs-base: 0.25rem;
        --radius-sm-base: 0.375rem;
        --radius-md-base: 0.5rem;
        --radius-lg-base: 0.625rem;
        --radius-xl-base: 0.75rem;
        --radius-2xl-base: 1rem;
        --radius-3xl-base: 1.5rem;
        --radius-4xl-base: 2rem;
        --padding-panel-base: 0.75rem;
        --color-background-elevated-secondary: #f5f5f5;
        --color-border: #ddd;
        --color-token-editor-background: white;
        --vscode-foreground: #202124;
        --vscode-errorForeground: #c43b2f;
        --vscode-charts-blue: #2878d0;
        --vscode-charts-green: #16803a;
        --vscode-button-foreground: white;
        --vscode-editor-selectionBackground: #d8e8ff;
        --vscode-inputValidation-errorBackground: #fee;
        --vscode-inputValidation-warningBackground: #fff4dd;
        --vscode-descriptionForeground: #666;
        --vscode-editor-background: white;
      }
    `
        : "",
      "utf8",
    );
  }
  for (const policy of MIGRATED_SURFACE_POLICIES) {
    const path = join(workspace, policy.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "export const Fixture = () => null;\n", "utf8");
  }
  return workspace;
};

const writeReference = async (directory: string, name: string): Promise<string> => {
  const path = join(directory, name);
  await writeFile(path, referenceFixture, "utf8");
  return path;
};

afterEach(async () => {
  await Promise.all(
    workspaces.splice(0).map((workspace) =>
      rm(workspace, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("semantic theme module", () => {
  test("syncs deterministically from arbitrary temporary paths and verifies without the source", async () => {
    const left = await createWorkspace();
    const right = await createWorkspace();
    const leftSource = await writeReference(left, "one.css");
    const nested = join(right, "nested");
    await mkdir(nested);
    const rightSource = await writeReference(nested, "different-name.css");

    const leftResult = await executeSemanticThemeCommand(
      {
        kind: "sync",
        sourcePath: leftSource,
        refVersion: "ref-1",
      },
      { workspaceRoot: left },
    );
    const rightResult = await executeSemanticThemeCommand(
      {
        kind: "sync",
        sourcePath: rightSource,
        refVersion: "ref-1",
      },
      { workspaceRoot: right },
    );

    expect(leftResult.ok, JSON.stringify(leftResult.diagnostics)).toBe(true);
    expect(rightResult.ok, JSON.stringify(rightResult.diagnostics)).toBe(true);
    for (const path of Object.values(SEMANTIC_THEME_ARTIFACT_PATHS)) {
      expect(await readFile(join(left, path), "utf8")).toBe(
        await readFile(join(right, path), "utf8"),
      );
    }

    await rm(leftSource);
    const verified = await executeSemanticThemeCommand({ kind: "verify" }, { workspaceRoot: left });
    expect(verified, JSON.stringify(verified.diagnostics)).toMatchObject({
      ok: true,
      mode: "verify-source-free",
    });

    const contract = await readFile(join(left, SEMANTIC_THEME_ARTIFACT_PATHS.contract), "utf8");
    expect(contract).not.toContain("identity");
    expect(contract).not.toContain("/private/input.css");
    expect(contract).not.toContain("one.css");
  });

  test("source-aware verify reports drift without writing", async () => {
    const workspace = await createWorkspace();
    const source = await writeReference(workspace, "reference.css");
    await executeSemanticThemeCommand(
      {
        kind: "sync",
        sourcePath: source,
        refVersion: "ref-1",
      },
      { workspaceRoot: workspace },
    );
    await writeFile(
      source,
      referenceFixture.replace(
        "--color-text-info: var(--vscode-charts-blue)",
        "--color-text-info: #1677cc",
      ),
      "utf8",
    );

    const result = await executeSemanticThemeCommand(
      { kind: "verify", sourcePath: source },
      { workspaceRoot: workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("verify-source-aware");
    expect(result.diagnostics.map((item) => item.code)).toContain("THEME_CONTRACT_DIFF");
  });

  test("audit exposes a structured, source-neutral contract diff", async () => {
    const workspace = await createWorkspace();
    const source = await writeReference(workspace, "reference.css");
    const result = await executeSemanticThemeCommand(
      {
        kind: "audit",
        sourcePath: source,
        refVersion: "ref-1",
      },
      { workspaceRoot: workspace },
    );

    expect(result.ok).toBe(true);
    expect(result.auditReport).toMatchObject({
      schemaVersion: 1,
      refVersion: "ref-1",
    });
    expect(result.auditReport?.declarations.added.length).toBeGreaterThan(0);
    expect(result.auditReport?.exclusions).toEqual([
      expect.objectContaining({
        scope: "application-menu-window",
        consumerStatus: "unsupported",
      }),
    ]);
    expect(JSON.stringify(result.auditReport)).not.toContain("reference.css");
    expect(JSON.stringify(result.auditReport)).not.toContain(workspace);
  });

  test("rejects source URLs without leaking source identity into the public error", async () => {
    const workspace = await createWorkspace();
    const source = await writeReference(workspace, "sensitive-name.css");
    await writeFile(
      source,
      referenceFixture.replace(
        ".loading-shimmer { color: transparent; }",
        ".loading-shimmer { color: transparent; background: url(https://example.invalid/a); }",
      ),
      "utf8",
    );

    await expect(
      executeSemanticThemeCommand(
        {
          kind: "sync",
          sourcePath: source,
          refVersion: "ref-1",
        },
        { workspaceRoot: workspace },
      ),
    ).rejects.not.toThrow("sensitive-name.css");
  });

  test("discovers the hashed global renderer stylesheet for build verification", async () => {
    const workspace = await createWorkspace();
    const assetsDirectory = join(workspace, "out/renderer/assets");
    await mkdir(assetsDirectory, { recursive: true });
    await writeFile(join(assetsDirectory, "globals-fixture.css"), ":root {}\n", "utf8");

    const result = await executeSemanticThemeCommand(
      { kind: "verify-build" },
      { workspaceRoot: workspace },
    );

    expect(result.ok).toBe(false);
    expect(result.mode).toBe("verify-build");
    expect(result.diagnostics.map((item) => item.code)).toContain("THEME_BUILD_UTILITY_MISSING");
    expect(result.diagnostics.map((item) => item.code)).not.toContain(
      "THEME_BUILD_ARTIFACT_MISSING",
    );
  });
});

const options = {
  collisionResolutions: {},
  requiredVariables: [],
  runtimeProviders: [],
  checkedOwnerNames: new Set(["--radius-lg", "--a", "--b"]),
} as const;

const codesFor = (
  artifacts: readonly { readonly path: string; readonly content: string }[],
  providers: readonly { readonly path: string; readonly content: string }[] = [],
): readonly string[] =>
  collectSemanticThemeIntegrityDiagnostics(artifacts, providers, options).map((item) => item.code);

describe("semantic theme integrity", () => {
  test("rejects a dependency whose provider does not cover every consumer scope", () => {
    expect(
      codesFor([
        {
          path: "generated.css",
          content: `
        :root { --radius-lg: calc(10px * var(--radius-scale)); }
        .electron-light { --radius-scale: 1.25; }
      `,
        },
      ]),
    ).toContain("THEME_DEPENDENCY_SCOPE_UNRESOLVED");
  });

  test("rejects custom-property cycles in an effective target scope", () => {
    expect(
      codesFor([
        {
          path: "generated.css",
          content: ":root { --a: var(--b); --b: var(--a); }",
        },
      ]),
    ).toContain("THEME_DEPENDENCY_CYCLE");
  });

  test("rejects conflicting root owners unless the profile resolves ownership", () => {
    expect(
      codesFor(
        [{ path: "generated.css", content: ":root { --shared: red; }" }],
        [{ path: "product.css", content: ":root { --shared: blue; }" }],
      ),
    ).toContain("THEME_COLLISION_UNOWNED");
  });

  test("treats formatter-only declaration whitespace as the same root value", () => {
    expect(
      codesFor(
        [
          {
            path: "generated.css",
            content: ":root { --shared: color-mix(in oklab, var(--foreground) 60%, transparent); }",
          },
        ],
        [
          {
            path: "product.css",
            content: `
              :root {
                --shared: color-mix(
                  in oklab,
                  var(--foreground) 60%,
                  transparent
                );
              }
            `,
          },
        ],
      ),
    ).not.toContain("THEME_COLLISION_UNOWNED");
  });

  test("accepts a complete non-cyclic dependency graph", () => {
    expect(
      codesFor([
        {
          path: "generated.css",
          content: ":root { --radius-scale: 1.25; --radius-lg: calc(10px * var(--radius-scale)); }",
        },
      ]),
    ).toEqual([]);
  });

  test("walks required variables through transitive aliases", () => {
    const diagnostics = collectSemanticThemeIntegrityDiagnostics(
      [
        {
          path: "generated.css",
          content: ":root { --surface: var(--host-surface); --host-surface: var(--missing-leaf); }",
        },
      ],
      [],
      {
        ...options,
        requiredVariables: [
          {
            name: "--surface",
            targets: ["electron-light"],
          },
        ],
        checkedOwnerNames: undefined,
      },
    );

    expect(diagnostics.map((item) => item.code)).toContain("THEME_DEPENDENCY_SCOPE_UNRESOLVED");
    expect(diagnostics.some((item) => item.subject?.includes("--missing-leaf"))).toBe(true);
  });
});

describe("semantic theme CSS parser", () => {
  test("reference theme registration does not count as a runtime variable provider", () => {
    const facts = collectSemanticThemeCssFacts(
      `
        @theme reference { --color-text-secondary: var(--missing-runtime-color); }
        @theme static { --color-text-info: blue; }
        :where(:root) { --color-text-secondary: rgb(0 0 0 / 0.65); }
      `,
      "fixture.css",
    );
    expect(facts.definitions.filter(({ name }) => name === "--color-text-secondary")).toHaveLength(
      1,
    );
    expect(facts.definitions.find(({ name }) => name === "--color-text-info")?.selectorKey).toBe(
      "@theme",
    );
    expect(facts.uses).toEqual([]);
  });

  test("keeps configured declarations and their conditional scope", () => {
    const css = `
      :root, :host { --color-text-info: blue; --unowned: red; }
      .unrelated { --color-text-info: orange; }
      @supports (color: color-mix(in oklab, red, blue)) {
        :root, :host { --color-text-info: color-mix(in oklab, blue 80%, white); }
      }
    `;

    const output = filterCss(css, {
      selectorFingerprints: collectSelectorFingerprints([":root, :host"]),
      declarationPredicate: (declaration) =>
        declaration.property === "custom" && declaration.value.name === "--color-text-info",
    });

    expect(extractCustomPropertyMap(output).has("--color-text-info")).toBe(true);
    expect(output).toContain("@supports");
    expect(output).not.toContain("--unowned");
    expect(output).not.toContain(".unrelated");
  });

  test("normalizes equivalent selector formatting through AST fingerprints", () => {
    const output = filterCss(":root,:host{--color-text-info:blue}", {
      selectorFingerprints: collectSelectorFingerprints([":root, :host"]),
    });

    expect(output).toContain("--color-text-info: blue");
  });

  test("preserves window and color-scheme coverage instead of flattening declarations", () => {
    const facts = collectSemanticThemeCssFacts(
      `
      :root { --global: 1; }
      .electron-light { --electron-light-only: var(--global); }
      .electron-dark { --electron-dark-only: var(--global); }
      :is([data-codex-window-type="browser"], [data-codex-window-type="chrome-extension"]) {
        --web-windows: var(--global);
      }
    `,
      "fixture.css",
    );

    const definitions = new Map(
      facts.definitions.map((definition) => [definition.name, definition]),
    );
    expect(definitions.get("--global")?.targets).toEqual([
      "browser-dark",
      "browser-light",
      "electron-dark",
      "electron-light",
      "extension-dark",
      "extension-light",
    ]);
    expect(definitions.get("--electron-light-only")?.targets).toEqual(["electron-light"]);
    expect(definitions.get("--electron-dark-only")?.targets).toEqual(["electron-dark"]);
    expect(definitions.get("--web-windows")?.targets).toEqual([
      "browser-dark",
      "browser-light",
      "extension-dark",
      "extension-light",
    ]);
    expect(definitions.get("--web-windows")?.scopeKind).toBe("scoped");
  });

  test("resolves nested window negations and data-theme appearance scopes", () => {
    const facts = collectSemanticThemeCssFacts(
      `
        :where(:root:not([data-codex-window-type="extension"])) { --native-color: white; }
        :is(:where(:root), :where([data-theme])):where(:root[data-codex-window-type="browser"], :root[data-codex-window-type="browser"] *) { --browser-color: blue; }
        :where(:root:not([data-codex-window-type="extension"])[data-theme="dark"]) { --native-dark-color: black; }
        :where([data-theme="light"]) { --light-color: white; }
      `,
      "fixture.css",
    );
    const definitions = new Map(
      facts.definitions.map((definition) => [definition.name, definition]),
    );

    expect(definitions.get("--native-color")?.targets).toEqual([
      "browser-dark",
      "browser-light",
      "electron-dark",
      "electron-light",
    ]);
    expect(definitions.get("--browser-color")?.targets).toEqual(["browser-dark", "browser-light"]);
    expect(definitions.get("--native-dark-color")?.targets).toEqual([
      "browser-dark",
      "electron-dark",
    ]);
    expect(definitions.get("--light-color")?.targets).toEqual([
      "browser-light",
      "electron-light",
      "extension-light",
    ]);
  });
});
