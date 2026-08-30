import { describe, expect, it } from "vitest";

import { serializeSortableTranslation } from "./sortable-transform";

describe("sortable item transforms", () => {
  it("preserves the dragged item's dimensions when targets have different sizes", () => {
    expect(serializeSortableTranslation({ x: 18, y: -24, scaleX: 1.75, scaleY: 0.4 })).toBe(
      "translate3d(18px, -24px, 0)",
    );
    expect(serializeSortableTranslation(null)).toBeUndefined();
  });
});
