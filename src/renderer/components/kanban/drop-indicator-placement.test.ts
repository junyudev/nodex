import { describe, expect, test } from "bun:test";
import { resolveDropIndicatorPlacement } from "./drop-indicator-placement";

describe("resolveDropIndicatorPlacement", () => {
  const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];

  test("renders before the first remaining card instead of the dragged source ghost", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set(["a"]), 0);

    expect(placement.beforeCardId).toBe("b");
    expect(placement.atEnd).toBeFalse();
  });

  test("renders before the matching remaining card in an unfiltered list", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set<string>(), 1);

    expect(placement.beforeCardId).toBe("b");
    expect(placement.atEnd).toBeFalse();
  });

  test("renders at the end when the indicator targets the final slot", () => {
    const placement = resolveDropIndicatorPlacement(cards, new Set(["a"]), 2);

    expect(placement.beforeCardId).toBe(null);
    expect(placement.atEnd).toBeTrue();
  });
});
