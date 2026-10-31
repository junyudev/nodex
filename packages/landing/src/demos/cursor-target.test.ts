import { expect, test } from "vite-plus/test";
import { cursorTargetPoint } from "./cursor-target";

test("projects to the lane's bottom while a button is still moving toward it", () => {
  const positions = [250, 430, 570].map((top) =>
    cursorTargetPoint({ x: 0, y: 0 }, { left: 720, top, width: 120, height: 24 }, 1, 594),
  );
  for (const position of positions) {
    expect(position.x).toBeCloseTo(770.4);
    expect(position.y).toBeCloseTo(583.2);
  }
});

test("keeps projected targets in window coordinates when the demo is scaled", () => {
  const point = cursorTargetPoint(
    { x: 100, y: 50 },
    { left: 460, top: 175, width: 60, height: 12 },
    0.5,
    347,
  );
  expect(point.x).toBeCloseTo(770.4);
  expect(point.y).toBeCloseTo(583.2);
});

test("ordinary targets follow their current position", () => {
  const point = cursorTargetPoint(
    { x: 40, y: 80 },
    { left: 120, top: 200, width: 100, height: 20 },
    1,
  );
  expect(point).toEqual({ x: 122, y: 131 });
});
