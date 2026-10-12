import { exportImageToDataURL } from "@blocknote/core";
import { describe, expect, test } from "vite-plus/test";

import { renderDiagramToImage } from "./renderDiagramToImage.js";

/** Measures visible ink rather than accepting a correctly sized blank PNG. */
async function decodeAndSample(dataURL: string) {
  const image = new Image();
  image.src = dataURL;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image sampling requires a 2D canvas");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  let inkedPixels = 0;
  let minX = canvas.width;
  let minY = canvas.height;
  let maxX = -1;
  let maxY = -1;
  for (let offset = 0; offset < data.length; offset += 4) {
    if (data[offset + 3]! < 32 || Math.min(data[offset]!, data[offset + 1]!, data[offset + 2]!) >= 240)
      continue;
    const pixel = offset / 4;
    const x = pixel % canvas.width;
    const y = Math.floor(pixel / canvas.width);
    inkedPixels += 1;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return {
    inkedPixels,
    inkedFractionX: inkedPixels ? (maxX - minX + 1) / canvas.width : 0,
    inkedFractionY: inkedPixels ? (maxY - minY + 1) / canvas.height : 0,
  };
}
describe("renderDiagramToImage", () => {
  test(
    "renders Mermaid source to a non-blank PNG",
    { timeout: 15000 },
    async () => {
      const result = await renderDiagramToImage(
        "graph TD\n  A[Start] --> B[End]",
      );
      if (result.error !== undefined) {
        throw new Error(`Expected a successful render: ${result.error}`);
      }

      expect(result.image.mimeType).toBe("image/png");
      expect(result.image.width).toBeGreaterThan(0);
      const { inkedPixels, inkedFractionX, inkedFractionY } =
        await decodeAndSample(exportImageToDataURL(result.image));
      expect(inkedPixels).toBeGreaterThan(0);
      // The diagram must fill the image, not sit letterboxed in a fraction
      // of it - Mermaid crops the view box to the content bar ~8px padding,
      // so a healthy render inks ~0.85+ of the canvas. (WebKit regression
      // check: it lets Mermaid's inline max-width style shrink the
      // rasterization to ~half if the renderer doesn't strip it.)
      expect(inkedFractionX).toBeGreaterThan(0.75);
      expect(inkedFractionY).toBeGreaterThan(0.75);
    },
  );

  test(
    "returns invalid Mermaid source as a typed error",
    { timeout: 15000 },
    async () => {
      // The real Mermaid parse boundary: invalid source is expected (it's
      // user input), so it comes back as a typed error rather than a throw.
      const result = await renderDiagramToImage("not a valid diagram !!");

      expect(result.error).toBeDefined();
    },
  );
});
