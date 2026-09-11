import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vite-plus/test";

import { executeSemanticThemeCommand } from "./module";
import { MIGRATED_SURFACE_POLICIES, SEMANTIC_THEME_ARTIFACT_PATHS } from "./profile";

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
    --color-background-composer-primary: var(--color-background-primary-solid);
    --color-background-user-message: color-mix(in oklab, var(--color-text) 5%, transparent);
    --color-background-tip-badge: var(--vscode-editor-selectionBackground);
    --color-background-button-secondary: var(--vscode-editor-selectionBackground);
    --color-text-primary-solid: var(--vscode-button-foreground);
    --color-text-composer-primary: var(--color-text-primary-solid);
    --color-text-user-message: var(--color-text);
    --color-text-on-accent: var(--vscode-button-foreground);
    --color-text-tip-badge: var(--vscode-charts-blue);
  }
  .text-info { color: var(--color-text-info); }
  .text-danger { color: var(--color-text-danger); }
  .text-tertiary { color: var(--color-text-tertiary); }
  .text-secondary { color: var(--color-text-secondary); }
  .border-default { border-color: var(--color-border); }
  .bg-text-info { background-color: var(--color-text-info); }
  .bg-text\\/10 { background-color: color-mix(in oklab, var(--color-text) 10%, transparent); }
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
    await writeFile(source, referenceFixture.replace("#2878d0", "#1677cc"), "utf8");

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
