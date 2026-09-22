import { expect, test } from "vitest";
import {
  advanceInlineDictationWaveform,
  createInlineDictationWaveformState,
  drawInlineDictationWaveform,
} from "./composer-inline-dictation-waveform";

test("starts with a staggered pulse and respects reduced motion", () => {
  const input = {
    deltaSeconds: 1 / 15,
    nowSeconds: 1,
    inputTimeSeconds: -Infinity,
    inputLevel: 0,
    reducedMotion: false,
  };
  const pulse = advanceInlineDictationWaveform(createInlineDictationWaveformState(), input);
  expect(pulse.levels[0]).toBeGreaterThan(pulse.levels[1]!);
  expect(pulse.levels[5]).toBe(0);
  expect(
    advanceInlineDictationWaveform(createInlineDictationWaveformState(), {
      ...input,
      reducedMotion: true,
    }).levels,
  ).toEqual([0, 0, 0, 0, 0, 0]);
});

test("caps stalled frames and releases stale microphone samples after 300ms", () => {
  const input = {
    deltaSeconds: 1,
    nowSeconds: 1,
    inputTimeSeconds: 1,
    inputLevel: 1,
    reducedMotion: true,
  };
  const active = advanceInlineDictationWaveform(createInlineDictationWaveformState(), input);
  expect(active.elapsedSeconds).toBe(1 / 15);
  const stale = advanceInlineDictationWaveform(active, { ...input, nowSeconds: 1.301 });
  expect(stale.levels[2]).toBeLessThan(active.levels[2]!);
  const fresh = advanceInlineDictationWaveform(active, { ...input, nowSeconds: 1.299 });
  expect(fresh.levels[2]).toBeGreaterThan(active.levels[2]!);
});

test("draws six centered two-pixel bars with a three-pixel floor", () => {
  const rects: number[][] = [];
  const canvas = document.createElement("canvas");
  Object.defineProperties(canvas, { clientWidth: { value: 32 }, clientHeight: { value: 20 } });
  canvas.getContext = (() => ({
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    beginPath() {},
    fill() {},
    roundRect: (...args: number[]) => rects.push(args),
  })) as unknown as typeof canvas.getContext;
  drawInlineDictationWaveform(canvas, [0, 0, 1, 1, 0, 0]);
  expect(rects).toHaveLength(6);
  expect(rects[0]).toEqual([2.5, 8.5, 2, 3, 1]);
  expect(rects[2]).toEqual([12.5, 0, 2, 20, 1]);
});
