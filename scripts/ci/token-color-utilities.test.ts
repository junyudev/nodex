import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";

import {
  createTokenColorValidator,
  explicitCssClasses,
  extractClassCandidates,
} from "./token-color-utilities";

const base = resolve(import.meta.dirname, "../..");
const usages = (classes: string) =>
  extractClassCandidates("fixture.tsx", `const node = <div className="${classes}" />;`);

describe("token color utility compilation", () => {
  test("reports the warning regression and accepts its theme bridge repair", async () => {
    const input = usages(
      "text-token-warning-foreground border-token-warning-foreground/30 dark:bg-token-warning-background",
    );
    const validate = await createTokenColorValidator(
      "@theme { --color-unrelated: red; }",
      base,
      new Set(),
    );
    expect(validate(input)).toEqual(input);

    const repaired = await createTokenColorValidator(
      `@theme {
      --color-token-warning-foreground: var(--color-text-warning);
      --color-token-warning-background: var(--color-background-warning-surface);
    }`,
      base,
      new Set(),
    );
    expect(repaired(input)).toEqual([]);
  });

  test("covers Tailwind color families, variants, important markers and opacity", async () => {
    const roots = [
      "text",
      "bg",
      "border",
      "border-x",
      "border-bs",
      "ring",
      "ring-offset",
      "inset-ring",
      "fill",
      "stroke",
      "outline",
      "divide",
      "from",
      "via",
      "to",
      "decoration",
      "caret",
      "accent",
      "shadow",
      "inset-shadow",
      "drop-shadow",
      "text-shadow",
      "mask-linear-from",
      "mask-radial-to",
      "scrollbar-thumb",
      "scrollbar-track",
    ];
    const classes = [
      ...roots.map((root) => `${root}-token-missing`),
      "hover:text-token-missing/30",
      "dark:bg-token-missing!",
      "group-hover/row:border-token-missing/[0.3]",
      "[&>svg]:fill-token-missing",
      "text-token-missing!",
    ];
    const input = usages(classes.join(" "));
    const validate = await createTokenColorValidator("", base, new Set());
    expect(validate(input).map(({ candidate }) => candidate)).toEqual(classes);

    const repaired = await createTokenColorValidator(
      "@theme { --color-token-missing: #123456; }",
      base,
      new Set(),
    );
    expect(repaired(input)).toEqual([]);
  });

  test("accepts real explicit selectors and @utility definitions, but no invented variants", async () => {
    const css = `
      /* .text-token-comment { color: red; } */
      @layer components {
        .text-token-explicit { color: red; }
        .hover\\:bg-token-explicit:hover { background-color: blue; }
      }
      @utility bg-token-custom { background-color: green; }
    `;
    const validate = await createTokenColorValidator(
      css,
      base,
      explicitCssClasses([{ path: "fixture.css", css }]),
    );
    expect(
      validate(
        usages(
          "text-token-explicit hover:bg-token-explicit hover:bg-token-custom text-token-comment hover:text-token-explicit text-token-explicit/30",
        ),
      ).map(({ candidate }) => candidate),
    ).toEqual(["text-token-comment", "hover:text-token-explicit", "text-token-explicit/30"]);
  });

  test("loads imported @theme files and distinguishes ordinary CSS variables from theme colors", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "nodex-token-colors-"));
    try {
      writeFileSync(resolve(directory, "bridge.css"), "@theme { --color-token-imported: red; }");
      const validate = await createTokenColorValidator(
        '@import "./bridge.css"; :root { --color-token-root-only: blue; }',
        directory,
        new Set(),
      );
      expect(
        validate(
          usages("text-token-imported text-token-root-only w-token-unrelated text-[var(--x)]"),
        ).map(({ candidate }) => candidate),
      ).toEqual(["text-token-root-only"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("class source extraction", () => {
  test("follows class constants, maps and functions into JSX and DOM class sinks", () => {
    const source = `
      const shades = { warning: "bg-token-map", label: "text-token-label" };
      function tone() { if (active) return "text-token-function"; return shades.warning; }
      const chipClassName = "border-token-constant";
      const view = <Chip className={cn(tone(), chipClassName, { "ring-token-key": active })} unreadRingClassName="ring-token-prop" />;
      element.className = "fill-token-dom";
      element.classList.add("stroke-token-list");
      element.setAttribute("class", "caret-token-attribute");
    `;
    expect(extractClassCandidates("fixture.tsx", source).map(({ candidate }) => candidate)).toEqual(
      [
        "bg-token-map",
        "text-token-function",
        "border-token-constant",
        "ring-token-key",
        "ring-token-prop",
        "fill-token-dom",
        "stroke-token-list",
        "caret-token-attribute",
      ],
    );
    const location = extractClassCandidates(
      "fixture.tsx",
      'const el = <div className="text-token-location" />;',
    )[0];
    expect(location).toEqual({
      path: "fixture.tsx",
      candidate: "text-token-location",
      line: 1,
      column: 28,
    });
  });

  test("ignores non-class strings and partial dynamic names while retaining complete template classes", async () => {
    const source = [
      '// className="text-token-comment"',
      'const message = "text-token-prose";',
      'const el = <div title="bg-token-title" aria-label="text-token-label" className={`bg-token-${tone} text-token-complete ${active ? "fill-token-active" : "fill-token-idle"} border-token-${kind}/30`} />;',
      'document.querySelector(".bg-token-selector");',
      'const className = "text-token-" + tone;',
      'const otherClassName = cn("text-[var(--x)]", "bg-[var(--color-token-x)]", "w-token-spacing", "text-token-" + tone);',
    ].join("\n");
    const validate = await createTokenColorValidator("", base, new Set());
    expect(
      validate(extractClassCandidates("fixture.tsx", source)).map(({ candidate }) => candidate),
    ).toEqual(["text-token-complete", "fill-token-active", "fill-token-idle"]);
  });

  test("terminates recursive class tables and checks selected metadata fields as classes", () => {
    const source = `
      const palette = { ...palette, label: "text-token-selected" };
      const view = <div className={palette.label} />;
    `;
    expect(extractClassCandidates("fixture.tsx", source).map(({ candidate }) => candidate)).toEqual(
      ["text-token-selected"],
    );
  });
});
