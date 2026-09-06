import { describe, expect, test } from "vitest";
import { encodeDictationPcm16 } from "./dictation-pcm";
const samples = (buffer: ArrayBuffer) => Array.from(new Int16Array(buffer));

describe("dictation PCM gain envelope", () => {
  test("reduces gain immediately to the peak cap and truncates signed PCM16", () => {
    const frame = encodeDictationPcm16(new Float32Array([0.5, -0.5, 1, -1]));
    expect(frame.gain).toBe(0.708);
    expect(samples(frame.pcm16)).toEqual([11599, -11599, 23199, -23199]);
  });
  test("resets silence gain and does not round PCM samples", () => {
    const frame = encodeDictationPcm16(new Float32Array([0, 0.001]), 3);
    expect(frame.gain).toBe(1);
    expect(samples(frame.pcm16)).toEqual([0, 32]);
    expect(encodeDictationPcm16(new Float32Array(), 2)).toMatchObject({ gain: 1, rms: 0 });
  });
  test("raises gain gradually for quiet speech without attenuating ordinary speech", () => {
    expect(encodeDictationPcm16(new Float32Array([0.01, -0.01])).gain).toBeCloseTo(2.05);
    expect(encodeDictationPcm16(new Float32Array([0.1, -0.1])).gain).toBe(1);
    expect(encodeDictationPcm16(new Float32Array([0.5, -0.5]), 3).gain).toBe(1);
  });
});
