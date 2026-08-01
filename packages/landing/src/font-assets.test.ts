import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { create } from "fontkitten";
import { expect, test } from "vite-plus/test";

const basicLatinCodePoints = Array.from({ length: 0x7f - 0x20 }, (_, index) => 0x20 + index);

const junicodeFaces = [
  { file: "JunicodeVF-Roman-subset.woff2", style: "Regular" },
  { file: "JunicodeVF-Italic-subset.woff2", style: "Italic" },
] as const;

test.each(junicodeFaces)("$file covers Basic Latin without glyph fallback", ({ file, style }) => {
  const fontPath = resolve(import.meta.dirname, "../public/fonts", file);
  const font = create(readFileSync(fontPath));

  expect(font.isCollection).toBe(false);
  if (font.isCollection) return;

  const missingCodePoints = basicLatinCodePoints.filter(
    (codePoint) => !font.hasGlyphForCodePoint(codePoint),
  );

  expect(missingCodePoints).toEqual([]);
  expect(font.version).toBe("Version 2.211");
  expect(font.subfamilyName).toBe(style);
});
