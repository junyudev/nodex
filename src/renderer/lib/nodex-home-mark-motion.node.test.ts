import { describe, expect, test } from "vite-plus/test";
import {
  canMergeNodexMarkAxes,
  composeNodexMarkRotorPose,
  isNodexMarkIdentity,
  NODEX_HOME_MARK_FALLBACK_AXIS,
  nodexMarkPoseDistanceDegrees,
  resolveNodexHomeMarkClickAxis,
  resolveNodexHomeMarkFieldMorph,
  resolveNodexHomeMarkFramebuffer,
} from "./nodex-home-mark-motion";

describe("Nodex home mark motion", () => {
  test("maps opposite click positions to opposite rotation axes", () => {
    const left = resolveNodexHomeMarkClickAxis({
      clientX: 0,
      clientY: 50,
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });
    const right = resolveNodexHomeMarkClickAxis({
      clientX: 100,
      clientY: 50,
      left: 0,
      top: 0,
      width: 100,
      height: 100,
    });

    expect(left[0] + right[0]).toBeCloseTo(0, 10);
    expect(left[1] + right[1]).toBeCloseTo(0, 10);
    expect(left[2] + right[2]).toBeCloseTo(0, 10);
  });

  test("uses the tuned axis for center clicks and invalid bounds", () => {
    expect(
      resolveNodexHomeMarkClickAxis({
        clientX: 50,
        clientY: 50,
        left: 0,
        top: 0,
        width: 100,
        height: 100,
      }),
    ).toEqual(NODEX_HOME_MARK_FALLBACK_AXIS);
    expect(
      resolveNodexHomeMarkClickAxis({
        clientX: 0,
        clientY: 0,
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      }),
    ).toEqual(NODEX_HOME_MARK_FALLBACK_AXIS);
  });

  test("closes every integer-turn rotor composition at identity", () => {
    const pose = composeNodexMarkRotorPose([
      { axis: [1, 0, 0], turns: 3 },
      { axis: [0.2, -0.7, 0.4], turns: 2 },
      { axis: [-0.9, -0.9, -0.59], turns: 1 },
    ]);

    expect(isNodexMarkIdentity(pose, 1e-8)).toBe(true);
    expect(nodexMarkPoseDistanceDegrees(pose)).toBeCloseTo(0, 6);
  });

  test("only merges sufficiently aligned click axes", () => {
    expect(canMergeNodexMarkAxes([1, 0, 0], [0.99, 0.01, 0])).toBe(true);
    expect(canMergeNodexMarkAxes([1, 0, 0], [-1, 0, 0])).toBe(false);
    expect(canMergeNodexMarkAxes([1, 0, 0], [0, 1, 0])).toBe(false);
  });

  test("moves smoothly from fitted to regular geometry by 48 degrees", () => {
    expect(resolveNodexHomeMarkFieldMorph(0)).toBe(0);
    expect(resolveNodexHomeMarkFieldMorph(24)).toBe(0.5);
    expect(resolveNodexHomeMarkFieldMorph(48)).toBe(1);
    expect(resolveNodexHomeMarkFieldMorph(90)).toBe(1);
  });

  test("keeps the DPR-aware framebuffer bounded and scaled to the mark", () => {
    const heroFrame = 78.4;
    expect(
      resolveNodexHomeMarkFramebuffer({
        devicePixelRatio: 1,
        chargedScale: 1,
        frameCssSize: heroFrame,
      }).size,
    ).toBe(100);
    expect(
      resolveNodexHomeMarkFramebuffer({
        devicePixelRatio: 2,
        chargedScale: 1,
        frameCssSize: heroFrame,
      }).size,
    ).toBe(200);
    expect(
      resolveNodexHomeMarkFramebuffer({
        devicePixelRatio: 4,
        chargedScale: 1.17,
        frameCssSize: heroFrame,
      }).size,
    ).toBe(298);
    // The 18px title mark allocates a backing store for its own size, not the hero's.
    expect(
      resolveNodexHomeMarkFramebuffer({
        devicePixelRatio: 2,
        chargedScale: 1,
        frameCssSize: 25.2,
      }).size,
    ).toBe(64);
  });
});
