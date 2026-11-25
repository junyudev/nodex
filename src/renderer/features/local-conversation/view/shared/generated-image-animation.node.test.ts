import { describe, expect, test, vi } from "vite-plus/test";
import {
  createGeneratedImageDotFieldConfig,
  resolveGeneratedImageDotFieldGridSpacing,
  resolveGeneratedImageDotFieldFrame,
} from "../../../user-attachment-image-editor/model/generated-image-loading-presentation";
import { createGeneratedImageAnimationClock } from "../../../user-attachment-image-editor/view/generated-image-animation-clock";

describe("generated image dot field", () => {
  test("freezes all random channels into a once-per-mount configuration", () => {
    const config = createGeneratedImageDotFieldConfig(() => 0.5);

    expect(config.durations.offsetX1).toBe(6_345);
    expect(config.durations.fieldSize2).toBe(3_384);
    expect(config.phases).toEqual({
      offsetX1: 0.5,
      offsetY1: 0.5,
      offsetX2: 0.5,
      offsetY2: 0.5,
      fieldSize1: 0.5,
      fieldSize2: 0.5,
    });
    expect(config.bounds).toEqual({
      x1Start: 0.21000000000000002,
      x1End: 0.79,
      y1Start: 0.21000000000000002,
      y1End: 0.79,
      x2Start: 0.79,
      x2End: 0.21000000000000002,
      y2Start: 0.79,
      y2End: 0.21000000000000002,
    });
  });

  test("seeks to the same visible frame for the same elapsed time", () => {
    let value = 0;
    const config = createGeneratedImageDotFieldConfig(() => {
      value = (value + 0.137) % 1;
      return value;
    });

    const first = resolveGeneratedImageDotFieldFrame(8_250, config);
    const resumed = resolveGeneratedImageDotFieldFrame(8_250, config);

    expect(resumed).toEqual(first);
    expect(Object.values(first).every(Number.isFinite)).toBe(true);
    expect(first.firstSize).toBeGreaterThan(0);
    expect(first.secondSize).toBeGreaterThan(0);
  });

  test("uses device pixels only for the default field density", () => {
    expect(resolveGeneratedImageDotFieldGridSpacing("default", 2)).toBe(6);
    expect(resolveGeneratedImageDotFieldGridSpacing("single", 2)).toBe(6);
    expect(resolveGeneratedImageDotFieldGridSpacing("playground", 2)).toBe(14);
    expect(resolveGeneratedImageDotFieldGridSpacing("thumbnail", 2)).toBe(6);
  });
});

describe("pending image animation clock", () => {
  test("shares one frame across subscribers and stops it with the last unsubscribe", () => {
    let nextFrameId = 1;
    let nowMs = 0;
    const frames = new Map<number, (timestamp: number) => void>();
    const cancelFrame = vi.fn((frameId: number) => {
      frames.delete(frameId);
    });
    const clock = createGeneratedImageAnimationClock({
      cancelFrame,
      now: () => nowMs,
      requestFrame: (callback) => {
        const frameId = nextFrameId++;
        frames.set(frameId, callback);
        return frameId;
      },
    });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = clock.subscribe(first);
    const unsubscribeSecond = clock.subscribe(second);
    expect(frames.size).toBe(1);
    expect(clock.getSubscriberCount()).toBe(2);

    const firstFrame = frames.values().next().value;
    if (!firstFrame) throw new Error("Expected a scheduled frame");
    frames.clear();
    nowMs = 16;
    firstFrame(16);

    expect(first).toHaveBeenCalledWith(16);
    expect(second).toHaveBeenCalledWith(16);
    expect(frames.size).toBe(1);

    unsubscribeFirst();
    expect(cancelFrame).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(cancelFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
  });

  test("never reports time moving backwards", () => {
    let nowMs = 20;
    const clock = createGeneratedImageAnimationClock({
      cancelFrame: () => undefined,
      now: () => nowMs,
      requestFrame: () => 1,
    });

    expect(clock.now()).toBe(20);
    nowMs = 10;
    expect(clock.now()).toBe(20);
    nowMs = 30;
    expect(clock.now()).toBe(30);
  });
});
