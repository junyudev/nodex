import { describe, expect, test } from "vite-plus/test";

import {
  collectSelectorFingerprints,
  collectSemanticThemeCssFacts,
  extractCustomPropertyMap,
  filterCss,
} from "./parser";

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
