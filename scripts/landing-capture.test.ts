import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fitScale, frameSequence, parseOptions } from "../packages/landing/scripts/capture-demos";
import { CAPTURE_DEMOS } from "../packages/landing/src/demos/capture-demos";

describe("landing capture timing", () => {
  it("drops surplus frames and holds missing frames on the real presentation clock", () => {
    const frames = [0, 10, 25, 110, 180].map((offset) => ({
      file: String(offset),
      timestampMs: 1000 + offset,
    }));
    expect(frameSequence(frames, 1000, 250, 20).map((frame) => frame.file)).toEqual([
      "0",
      "25",
      "25",
      "110",
      "180",
    ]);
  });

  it("fills the first tick from the first painted demo frame and preserves the static tail", () => {
    const frames = [
      { file: "first", timestampMs: 1008 },
      { file: "last", timestampMs: 1040 },
    ];
    expect(frameSequence(frames, 1000, 225, 20).map((frame) => frame.file)).toEqual([
      "first",
      "last",
      "last",
      "last",
      "last",
    ]);
  });

  it("rounds up a partial final frame without compressing the real duration", () => {
    expect(frameSequence([{ file: "frame", timestampMs: 0 }], 0, 1001, 30)).toHaveLength(31);
    expect(() => frameSequence([], 0, 1000, 30)).toThrow("no capture frames");
  });
});

describe("landing capture scale", () => {
  it("renders every demo within a tenth of the published width, at a whole pixel size", () => {
    for (const { width, height } of Object.values(CAPTURE_DEMOS)) {
      const scale = fitScale({ width });
      const pixels = (width + 80) * scale;
      expect(Number.isInteger(pixels) && Number.isInteger((height + 80) * scale)).toBe(true);
      expect(Math.abs(pixels - 1800)).toBeLessThanOrEqual(180);
    }
  });
});

describe("landing capture arguments", () => {
  it("defaults to every registered demo and both themes, recorded into ignored local notes", () => {
    expect(parseOptions([])?.demos).toEqual(Object.keys(CAPTURE_DEMOS));
    expect(parseOptions([])).toMatchObject({
      themes: ["dark", "light"],
      fps: 30,
      scale: undefined,
    });
    expect(parseOptions([])?.out).toBe(
      resolve(import.meta.dirname, "../notes.local/artifacts/landing-captures"),
    );
  });

  it("rejects unsupported demos, themes, and unusable capture rates", () => {
    for (const args of [
      ["--demo", "missing"],
      ["--theme", "blue"],
      ["--fps", "0"],
      ["--fps", "29.5"],
      ["--scale", "NaN"],
      ["--base-url", "file:///tmp"],
    ]) {
      expect(() => parseOptions(args)).toThrow();
    }
    expect(parseOptions(["--og", "--theme", "light"])?.og).toBe(true);
    expect(parseOptions(["--help"])).toBeUndefined();
  });
});
