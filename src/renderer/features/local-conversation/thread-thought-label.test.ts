import { describe, expect, it } from "vite-plus/test";
import { formatThoughtLabel, sumThoughtDurations } from "./thread-thought-label";

describe("formatThoughtLabel", () => {
  it("names how long a Thought took once it reached a second", () => {
    expect(formatThoughtLabel(1_000)).toBe("Thought for 1s");
    expect(formatThoughtLabel(83_400)).toBe("Thought for 1m 23s");
  });

  it("omits an unknown or sub-second time", () => {
    expect(formatThoughtLabel(null)).toBe("Thought");
    expect(formatThoughtLabel(undefined)).toBe("Thought");
    expect(formatThoughtLabel(999)).toBe("Thought");
    expect(formatThoughtLabel(Number.NaN)).toBe("Thought");
  });
});

describe("sumThoughtDurations", () => {
  it("sums the reported times of consecutive Thoughts", () => {
    expect(sumThoughtDurations([4_000, 2_500])).toBe(6_500);
  });

  it("is unknown when any Thought has no reported time, or there are none", () => {
    expect(sumThoughtDurations([4_000, null])).toBeNull();
    expect(sumThoughtDurations([undefined])).toBeNull();
    expect(sumThoughtDurations([])).toBeNull();
  });
});
