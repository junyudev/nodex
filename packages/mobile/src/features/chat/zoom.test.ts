import { describe, expect, it } from "vitest";

import {
  MAX_ZOOM,
  clampPan,
  clampZoom,
  containedSize,
  isZoomed,
  panLimit,
  pinchOffset,
} from "./zoom";

const frame = { width: 400, height: 800 };

describe("zooming a full-screen picture", () => {
  it("fits a picture whole, and fills the frame until its size is known", () => {
    expect(containedSize(frame, { width: 1600, height: 900 })).toEqual({ width: 400, height: 225 });
    expect(containedSize(frame, { width: 300, height: 1200 })).toEqual({ width: 200, height: 800 });
    expect(containedSize(frame, null)).toEqual(frame);
    expect(containedSize(frame, { width: 0, height: 10 })).toEqual(frame);
  });

  it("keeps a pinch between whole and the largest zoom", () => {
    expect(clampZoom(0.4)).toBe(1);
    expect(clampZoom(2)).toBe(2);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(isZoomed(1.005)).toBe(false);
    expect(isZoomed(1.2)).toBe(true);
  });

  it("pans only until the picture's edge meets the frame's", () => {
    // A wide picture drawn 400 × 225: zoomed 2×, it is 800 wide but still shorter than the frame.
    expect(panLimit(400, 400, 1)).toBe(0);
    expect(panLimit(400, 400, 2)).toBe(200);
    expect(panLimit(800, 225, 2)).toBe(0);
    expect(clampPan(350, 400, 400, 2)).toBe(200);
    expect(clampPan(-350, 400, 400, 2)).toBe(-200);
    expect(clampPan(120, 800, 225, 3)).toBe(0);
  });

  it("zooms about the point under the fingers and follows them as they move", () => {
    const start = { focal: 100, offset: 30, scale: 1.5 };
    // The picture point first under the fingers, in the picture's own unscaled space.
    const held = (start.focal - start.offset) / start.scale;
    for (const [focal, scale] of [
      [100, 3],
      [160, 2],
      [-40, 4],
    ] as const) {
      expect(pinchOffset(start, focal, scale) + held * scale).toBeCloseTo(focal);
    }
    // Spreading the fingers in place about the centre keeps the picture centred.
    expect(pinchOffset({ focal: 0, offset: 0, scale: 1 }, 0, 2.5)).toBe(0);
  });
});
