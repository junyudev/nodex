import { describe, expect, test } from "bun:test";
import {
  computeNativeDropIndex,
  computeNativeDropIndexFromSurface,
} from "./native-drop-index";

describe("native drop index", () => {
  test("returns 0 for empty columns", () => {
    expect(computeNativeDropIndex([], 100)).toBe(0);
  });

  test("returns top insertion index when pointer is above first midpoint", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      110,
    );
    expect(index).toBe(0);
  });

  test("returns middle insertion index when pointer is between midpoints", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      160,
    );
    expect(index).toBe(1);
  });

  test("returns end insertion index when pointer is below all cards", () => {
    const index = computeNativeDropIndex(
      [
        { top: 100, bottom: 140 },
        { top: 150, bottom: 190 },
      ],
      220,
    );
    expect(index).toBe(2);
  });

  test("reads card rects from DOM surface", () => {
    const cardA = {
      getBoundingClientRect: () => ({ top: 100, bottom: 140 }),
    } as unknown as HTMLElement;
    const cardB = {
      getBoundingClientRect: () => ({ top: 150, bottom: 190 }),
    } as unknown as HTMLElement;
    const surface = {
      querySelectorAll: () => [cardA, cardB],
    } as unknown as HTMLElement;

    expect(computeNativeDropIndexFromSurface(surface, 169)).toBe(1);
  });
});
