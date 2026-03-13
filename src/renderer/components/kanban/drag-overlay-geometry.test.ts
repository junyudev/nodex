import { describe, expect, test } from "bun:test";
import { resolveDragOverlayGeometry } from "./drag-overlay-geometry";

describe("drag overlay geometry", () => {
  test("returns null for missing geometry", () => {
    expect(resolveDragOverlayGeometry(null)).toBe(null);
  });

  test("returns null for non-positive dimensions", () => {
    expect(resolveDragOverlayGeometry({ width: 0, height: 120 })).toBe(null);
    expect(resolveDragOverlayGeometry({ width: 240, height: 0 })).toBe(null);
  });

  test("keeps valid source rect dimensions", () => {
    const geometry = resolveDragOverlayGeometry({ width: 272, height: 148 });
    expect(geometry?.width).toBe(272);
    expect(geometry?.height).toBe(148);
  });
});
