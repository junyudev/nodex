import { describe, expect, test } from "vite-plus/test";

import { collectSemanticThemeCssFacts, extractDeclarations } from "./parser";
import { SEMANTIC_THEME_ARTIFACT_PATHS } from "./profile";
import { renderSemanticThemeArtifacts } from "./renderer";

describe("semantic theme artifact rendering", () => {
  test("keeps reachable providers in their window scope without importing product foundations", () => {
    const source = `
      :root, :host {
        --font-sans: sans-serif;
        --radius-xs: calc(var(--radius-xs-base) * var(--corner-radius-scale));
        --radius-xs-base: 4px;
        --corner-radius-scale: 1;
      }
      :where(:root), :where([data-theme]) {
        --gray-900: #121212;
        --blue-400: #0285ff;
        --pink-400: #f077af;
        --gray-fixed-1000: #0d0d0d;
        --unused-palette: orange;
        --color-text: var(--gray-900);
      }
      :where(:root:not([data-codex-window-type="extension"])) {
        --app-color-text-foreground: var(--gray-900);
        --app-color-text-accent: var(--blue-400);
      }
      :where(:root, [data-theme]) {
        --color-text: var(--app-color-text-foreground);
        --color-text-info: var(--app-color-text-accent);
      }
      :root[data-codex-window-type="extension"] {
        --color-text: var(--vscode-foreground);
      }
    `;
    const artifacts = renderSemanticThemeArtifacts(source, "fixture");
    const contract = artifacts.find(({ path }) => path === SEMANTIC_THEME_ARTIFACT_PATHS.contract);
    expect(contract).toBeDefined();
    const facts = collectSemanticThemeCssFacts(contract!.content, "contract.css");
    const providers = facts.definitions.filter(
      ({ name }) => name === "--app-color-text-foreground",
    );

    expect(providers).toHaveLength(1);
    expect(providers[0]?.targets).toEqual([
      "browser-dark",
      "browser-light",
      "electron-dark",
      "electron-light",
    ]);
    expect(providers[0]?.references.map(({ name }) => name)).toEqual(["--gray-900"]);
    expect(
      extractDeclarations(
        contract!.content,
        [":where(:root), :where([data-theme])"],
        ["--gray-900", "--blue-400"],
      ),
    ).toEqual(
      new Map([
        ["--blue-400", "#0285ff"],
        ["--gray-900", "#121212"],
      ]),
    );
    expect(facts.definitions.some(({ name }) => name === "--unused-palette")).toBe(false);
    expect(
      extractDeclarations(
        contract!.content,
        [":where(:root), :where([data-theme])"],
        ["--pink-400", "--gray-fixed-1000"],
      ),
    ).toEqual(
      new Map([
        ["--pink-400", "#f077af"],
        ["--gray-fixed-1000", "#0d0d0d"],
      ]),
    );
    expect(facts.definitions.some(({ name }) => name === "--radius-xs-base")).toBe(false);
    expect(
      facts.definitions.find(({ name, targets }) => name === "--color-text" && targets.length === 2)
        ?.targets,
    ).toEqual(["extension-dark", "extension-light"]);
  });
});
