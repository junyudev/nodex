import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type LightningCss = {
  transform(options: {
    filename: string;
    code: Uint8Array;
    minify: boolean;
    targets?: Record<string, number>;
  }): { code: Uint8Array };
};

/** Each Lightning CSS a production build runs the renderer's CSS through, as that tool resolves it. */
function productionMinifiers(): ReadonlyArray<readonly [string, LightningCss]> {
  const fromVite = createRequire(fileURLToPath(import.meta.resolve("vite")));
  const fromTailwind = createRequire(
    createRequire(fileURLToPath(import.meta.resolve("@tailwindcss/postcss"))).resolve(
      "@tailwindcss/node",
    ),
  );
  return [
    ["Vite", fromVite("lightningcss") as LightningCss],
    ["Tailwind", fromTailwind("lightningcss") as LightningCss],
  ];
}

const globalsCss = readFileSync(fileURLToPath(new URL("./globals.css", import.meta.url)), "utf8");

/** The declarations of the first rule in globals.css that starts with `prelude`. */
function ruleBody(prelude: string): string {
  const start = globalsCss.indexOf(`${prelude} {`);
  if (start < 0) throw new Error(`globals.css no longer defines ${prelude}`);
  const open = globalsCss.indexOf("{", start + prelude.length);
  return globalsCss.slice(open + 1, globalsCss.indexOf("}", open));
}

/** Rules that fade an edge from their own inline scroll timeline. */
const scrollTimelineFades = [
  ["truncate-fade", ".truncate-fade", ruleBody("@utility truncate-fade")],
  [
    "table scroller",
    ".nfm-table-scroll",
    ruleBody(
      ':is(.nfm-editor .bn-block-content[data-content-type="table"] .tableWrapper, .nfm-table-scroll)',
    ),
  ],
] as const;

describe("scroll-timeline fades", () => {
  it.each(
    scrollTimelineFades.flatMap(([name, selector, body]) =>
      productionMinifiers().map(([tool, css]) => [name, tool, selector, body, css] as const),
    ),
  )("%s keeps its scroll timeline through %s's minifier", (_, __, selector, body, css) => {
    const built = new TextDecoder().decode(
      css.transform({
        filename: "scroll-timeline-fade.css",
        code: new TextEncoder().encode(`${selector}{${body}}`),
        minify: true,
        targets: { chrome: 130 << 16 },
      }).code,
    );
    // Chromium rejects an `animation` shorthand that carries a timeline, dropping the fade.
    expect(built).toContain("animation-timeline:scroll(self inline)");
    expect(built).not.toMatch(/animation:[^;}]*scroll\(/u);
  });
});
