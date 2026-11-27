import { describe, expect, test } from "vite-plus/test";
import { faviconInk } from "./link-favicons";

type Rgba = readonly [number, number, number, number];
const clear: Rgba = [0, 0, 0, 0];

/** A 10-pixel icon: `drawn` pixels of `ink`, the rest see-through. */
function icon(ink: Rgba, drawn: number, rest: Rgba = clear) {
  return Array.from({ length: 10 }, (_, index) => (index < drawn ? ink : rest)).flat();
}

describe("favicon ink", () => {
  test("names the tone of a see-through icon's drawing only when a background could swallow it", () => {
    expect(faviconInk(icon([20, 20, 20, 255], 5))).toBe("dark");
    expect(faviconInk(icon([245, 245, 245, 255], 5))).toBe("light");
    // Colorful ink reads on either background.
    expect(faviconInk(icon([55, 118, 171, 255], 5))).toBeNull();
    // An opaque icon carries its own background.
    expect(faviconInk(icon([20, 20, 20, 255], 9, [255, 255, 255, 255]))).toBeNull();
    // Faint pixels are not ink.
    expect(faviconInk(icon([20, 20, 20, 100], 10))).toBeNull();
  });
});
