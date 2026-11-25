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
const utility = /@utility truncate-fade \{([^}]*)\}/u.exec(globalsCss)?.[1];

describe("truncate-fade", () => {
  it.each(productionMinifiers())("keeps its scroll timeline through %s's minifier", (_, css) => {
    if (!utility) throw new Error("globals.css no longer defines truncate-fade");
    const built = new TextDecoder().decode(
      css.transform({
        filename: "truncate-fade.css",
        code: new TextEncoder().encode(`.truncate-fade{${utility}}`),
        minify: true,
        targets: { chrome: 130 << 16 },
      }).code,
    );
    // Chromium rejects an `animation` shorthand that carries a timeline, dropping the fade.
    expect(built).toContain("animation-timeline:scroll(self inline)");
    expect(built).not.toMatch(/animation:[^;}]*scroll\(/u);
  });
});
