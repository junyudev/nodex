import { describe, expect, it } from "vite-plus/test";
import {
  resolveIntelligenceEffortPosition,
  resolveIntelligenceEffortStops,
} from "./intelligence-effort";

const label = (effort: string) => effort.toUpperCase();
const efforts = ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort }));

describe("resolveIntelligenceEffortStops", () => {
  it("puts thinking off below the lowest effort only when the model can turn thinking off", () => {
    expect(
      resolveIntelligenceEffortStops({ efforts, label, canDisableThinking: true }).map(
        (stop) => stop.value,
      ),
    ).toEqual(["off", "low", "medium", "high"]);
    expect(
      resolveIntelligenceEffortStops({ efforts, label, canDisableThinking: false }).map(
        (stop) => stop.value,
      ),
    ).toEqual(["low", "medium", "high"]);
    expect(
      resolveIntelligenceEffortStops({ efforts: [], label, canDisableThinking: true }),
    ).toEqual([]);
  });
});

describe("resolveIntelligenceEffortPosition", () => {
  const stops = resolveIntelligenceEffortStops({ efforts, label, canDisableThinking: true });

  it("shows an explicit effort as chosen", () => {
    expect(
      resolveIntelligenceEffortPosition({
        stops,
        selected: "high",
        modelDefault: "medium",
        thinkingOff: false,
      }),
    ).toEqual({ value: "high", isDefault: false });
  });

  it("rests an unchosen or retired effort on the model default", () => {
    for (const selected of ["default", "ultracode"])
      expect(
        resolveIntelligenceEffortPosition({
          stops,
          selected,
          modelDefault: "medium",
          thinkingOff: false,
        }),
      ).toEqual({ value: "medium", isDefault: true });
    expect(
      resolveIntelligenceEffortPosition({
        stops,
        selected: "default",
        modelDefault: undefined,
        thinkingOff: false,
      }),
    ).toEqual({ value: "low", isDefault: true });
  });

  it("shows thinking off ahead of any effort", () => {
    expect(
      resolveIntelligenceEffortPosition({
        stops,
        selected: "high",
        modelDefault: "medium",
        thinkingOff: true,
      }),
    ).toEqual({ value: "off", isDefault: false });
  });
});
