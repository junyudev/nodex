import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import sharp from "sharp";
import { expect, test } from "vite-plus/test";
import { ICON_GLYPHS } from "../../packages/mobile/src/ui/icon-glyphs.generated";
import { MOBILE_ICON_COMPONENTS } from "./mapping";
import { generateMobileIcons, REGENERATE_COMMAND } from "./generate";
import { parseLegacyMobileIcons } from "./legacy";

test(`committed mobile glyphs match desktop components; regenerate with ${REGENERATE_COMMAND}`, () => {
  expect(ICON_GLYPHS, `Run ${REGENERATE_COMMAND}`).toEqual(generateMobileIcons().glyphs);
});

// The phone paints each path in an opaque ink, where overlapping shapes cannot show.
test("generated geometry paints what the desktop components paint", async () => {
  const { glyphs } = generateMobileIcons();
  const ink = "rgb(40,80,120)";
  const pixels = async (svg: string) => sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
  for (const [name, entry] of Object.entries(MOBILE_ICON_COMPONENTS)) {
    const [Component] = Object.values(entry);
    const document = new DOMParser().parseFromString(
      renderToStaticMarkup(createElement(Component)),
      "image/svg+xml",
    );
    const svg = document.documentElement!;
    svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    svg.setAttribute("width", "80");
    svg.setAttribute("height", "80");
    svg.setAttribute("style", `color:${ink}`);
    const original = new XMLSerializer().serializeToString(svg);
    const shapes = glyphs[name]!.paths.map(
      ({ d, fillRule, opacity, fill, stroke, strokeWidth, strokeLinecap, strokeLinejoin }) =>
        createElement("path", {
          d,
          fill: fill ?? ink,
          fillRule,
          opacity,
          stroke: stroke ? ink : undefined,
          strokeWidth,
          strokeLinecap: strokeLinecap ?? "butt",
          strokeLinejoin,
        }),
    );
    const generated = renderToStaticMarkup(
      createElement(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: 80,
          height: 80,
          viewBox: glyphs[name]!.viewBox,
        },
        ...shapes,
      ),
    );
    // Shapes that overlap blend their antialiased edges twice here and once on the desktop,
    // which can differ by at most a quarter of full coverage and never moves an edge.
    const [painted, expected] = [await pixels(generated), await pixels(original)];
    let furthest = 0;
    for (let index = 0; index < expected.length; index += 1)
      furthest = Math.max(furthest, Math.abs(painted[index]! - expected[index]!));
    expect(painted.length, name).toBe(expected.length);
    expect(furthest, name).toBeLessThanOrEqual(64);
  }
});

test("legacy exports retain old names, line styling and solid fills", () => {
  expect(
    parseLegacyMobileIcons(
      'const LINE_GLYPHS = { sliders: ["M1 2h3", "M4 5v6"] } as const; const SOLID_GLYPHS = { more: "M1 1h2v2Z" } as const;',
    ),
  ).toEqual({
    sliders: {
      viewBox: "0 0 20 20",
      paths: ["M1 2h3", "M4 5v6"].map((d) => ({
        d,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.33,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      })),
    },
    more: { viewBox: "0 0 20 20", paths: [{ d: "M1 1h2v2Z" }] },
  });
});
