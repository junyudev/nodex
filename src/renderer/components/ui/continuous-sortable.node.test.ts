import { describe, expect, it } from "vitest";

import { constrainContinuousDragTransform } from "./continuous-sortable";

const active = { top: 20, right: 80, bottom: 50, left: 30 };
const container = { top: 10, right: 120, bottom: 100, left: 10 };

describe("continuous sortable constraints", () => {
  it("clamps horizontal motion by the dragged rectangle and removes vertical drift", () => {
    expect(
      constrainContinuousDragTransform(
        "horizontal",
        { x: -200, y: 9, scaleX: 1, scaleY: 1 },
        active,
        container,
      ),
    ).toEqual({ x: -20, y: 0, scaleX: 1, scaleY: 1 });
    expect(
      constrainContinuousDragTransform(
        "horizontal",
        { x: 200, y: -9, scaleX: 1, scaleY: 1 },
        active,
        container,
      ),
    ).toEqual({ x: 40, y: 0, scaleX: 1, scaleY: 1 });
  });

  it("clamps vertical motion by the dragged rectangle and removes horizontal drift", () => {
    expect(
      constrainContinuousDragTransform(
        "vertical",
        { x: 9, y: -200, scaleX: 1, scaleY: 1 },
        active,
        container,
      ),
    ).toEqual({ x: 0, y: -10, scaleX: 1, scaleY: 1 });
    expect(
      constrainContinuousDragTransform(
        "vertical",
        { x: -9, y: 200, scaleX: 1, scaleY: 1 },
        active,
        container,
      ),
    ).toEqual({ x: 0, y: 50, scaleX: 1, scaleY: 1 });
  });
});
