import { describe, expect, test } from "vitest";
import { resolveCssColorSrgba } from "./css-color-srgba";

describe("resolveCssColorSrgba", () => {
  test("reads computed colors written in any space as sRGB channels", () => {
    const light = resolveCssColorSrgba("oklab(0.991063 0.0000452 0.0000198 / 0.85)");
    expect(light?.slice(0, 3).every((channel) => channel > 0.95)).toBe(true);
    expect(light?.[3]).toBeCloseTo(0.85, 2);

    const dark = resolveCssColorSrgba("oklab(0.159065 0.0000072 0.0000032)");
    expect(dark?.slice(0, 3).every((channel) => channel > 0.02 && channel < 0.1)).toBe(true);

    expect(resolveCssColorSrgba("rgb(255 0 0)")).toEqual([1, 0, 0, 1]);
  });

  test("never answers an unreadable color with the previous one", () => {
    resolveCssColorSrgba("rgb(255 0 0)");
    expect(resolveCssColorSrgba("not-a-color")).toBeNull();
  });
});
