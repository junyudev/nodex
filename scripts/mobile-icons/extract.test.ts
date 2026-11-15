import { describe, expect, test } from "vite-plus/test";
import { extractIcon } from "./extract";

const extract = (body: string, attributes = 'fill="currentColor"') =>
  extractIcon("fixture", `<svg viewBox="0 0 20 20" ${attributes}>${body}</svg>`);

describe("mobile SVG geometry extraction", () => {
  test("unwraps only the silhouette mask and preserves path order, fill rules and opacity", () => {
    const result = extract(
      '<mask id="m"><g style="color:white"><path d="M0 0h2v2Z" fill-rule="evenodd"/><path d="M1 1h3v3Z" opacity=".4"/></g></mask><rect width="100%" height="100%" fill="currentColor" mask="url(#m)"/>',
    );
    expect(result).toEqual({
      silhouette: true,
      glyph: {
        viewBox: "0 0 20 20",
        paths: [
          { d: "M0 0h2v2Z", fillRule: "evenodd" },
          { d: "M1 1h3v3Z", opacity: 0.4 },
        ],
      },
    });
  });

  test("converts primitives, including rounded rectangles, without curve approximation", () => {
    const result = extract(
      '<circle cx="3" cy="4" r="2"/><ellipse cx="8" cy="9" rx="3" ry="2"/><rect x="1" y="2" width="6" height="4"/><rect width="6" height="4" rx="1"/><line x1="1" y1="2" x2="3" y2="4"/><polyline points="1,2 3,4 5,6"/>',
    );
    expect(result.glyph.paths.map((path) => path.d)).toEqual([
      "M1 4A2 2 0 1 0 5 4A2 2 0 1 0 1 4Z",
      "M5 9A3 2 0 1 0 11 9A3 2 0 1 0 5 9Z",
      "M1 2H7V6H1Z",
      "M1 0H5A1 1 0 0 1 6 1V3A1 1 0 0 1 5 4H1A1 1 0 0 1 0 3V1A1 1 0 0 1 1 0Z",
      "M1 2L3 4",
      "M1 2L3 4 5 6",
    ]);
  });

  test("composes nested translate and scale in SVG order and scales strokes", () => {
    expect(
      extract(
        '<g transform="translate(2 3) scale(2)"><path transform="translate(1 2)" d="M0 0L1 1" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"/></g>',
        'fill="none"',
      ).glyph.paths,
    ).toEqual([
      {
        d: "M4 7L6 9",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 2.66,
        strokeLinecap: "round",
        strokeLinejoin: "round",
      },
    ]);
  });

  test("preserves inherited fill, stroke and default stroke width without redundant fields", () => {
    expect(
      extract('<g fill="none" stroke="currentColor"><path d="M0 0L1 1"/></g>').glyph.paths,
    ).toEqual([{ d: "M0 0L1 1", fill: "none", stroke: "currentColor" }]);
  });

  test.each([
    '<svg viewBox="0 0 10 10"><path d="M0 0h2v2Z"/></svg>',
    '<linearGradient id="paint"/>',
    '<path d="M0 0h2v2Z" fill="red"/>',
    '<path d="M0 0h2v2Z" fill="url(#paint)"/>',
    '<path d="M0 0h2v2Z" clip-path="url(#clip)"/>',
    '<g opacity=".5"><path d="M0 0h2v2Z"/></g>',
    '<g style="color:red"><path d="M0 0h2v2Z"/></g>',
    '<path d="M0 0h2v2Z" transform="rotate(30)"/>',
    '<path d="M0 0h2v2Z" transform="scale(2 3)" stroke="currentColor"/>',
    '<path d="M0 0h2v2Z" stroke-dasharray="2 1"/>',
    '<path d="broken"/>',
    '<rect width="100%" height="100%"/>',
    '<mask id="m"><mask id="nested"/></mask><rect width="100%" height="100%" fill="currentColor" mask="url(#m)"/>',
    '<mask id="m"><g style="color:white"><path d="M0 0h2v2Z" mask="url(#nested)"/></g></mask><rect width="100%" height="100%" fill="currentColor" mask="url(#m)"/>',
  ])("rejects unsupported geometry with the phone name: %s", (body) => {
    expect(() => extract(body)).toThrow(/^fixture: /u);
  });
});
