import { describe, expect, test } from "vitest";
import {
  codexSpeedTiers,
  fitCodexServiceTier,
  fitCodexServiceTierSelection,
  normalizeCodexServiceTier,
  offeredCodexServiceTier,
} from "./codex-service-tier";

describe("Codex service-tier domain projection", () => {
  test.each([null, undefined, "", " standard ", "default", "DEFAULT"])(
    "projects %p to Standard",
    (value) => {
      expect(normalizeCodexServiceTier(value)).toBeNull();
    },
  );

  test.each([
    ["priority", "fast"],
    [" PRIORITY ", "fast"],
    [" fast ", "fast"],
  ])("projects %p to Fast", (value, expected) => {
    expect(normalizeCodexServiceTier(value)).toBe(expected);
  });

  test("preserves any other named tier", () => {
    expect(normalizeCodexServiceTier(" flex ")).toBe("flex");
    expect(normalizeCodexServiceTier("ultrafast")).toBe("ultrafast");
  });
});

describe("offeredCodexServiceTier", () => {
  test("finds the id a model's catalog gives Fast", () => {
    expect(offeredCodexServiceTier(["default", "priority"], "fast")).toBe("priority");
    expect(offeredCodexServiceTier(["default", "fast"], "fast")).toBe("fast");
    expect(offeredCodexServiceTier(["default", "fast"], "priority")).toBe("fast");
  });

  test("prefers an exact id and reports a tier the model does not offer", () => {
    expect(offeredCodexServiceTier(["fast", "priority"], "priority")).toBe("priority");
    expect(offeredCodexServiceTier(["default", "flex"], "fast")).toBeNull();
    expect(offeredCodexServiceTier([], "fast")).toBeNull();
  });
});

describe("codexSpeedTiers", () => {
  test("lists the offered speeds slowest first by their Nodex names", () => {
    expect(codexSpeedTiers(["default", "ultrafast", "priority"])).toEqual(["fast", "ultrafast"]);
    expect(codexSpeedTiers(["default", "fast", "flex"])).toEqual(["fast"]);
    expect(codexSpeedTiers(["default"])).toEqual([]);
  });
});

describe("fitCodexServiceTier", () => {
  const sol = ["default", "priority", "ultrafast"];
  const astra = ["default", "priority"];

  test("keeps a tier the model offers, by the model's id", () => {
    expect(fitCodexServiceTier(sol, "ultrafast")).toBe("ultrafast");
    expect(fitCodexServiceTier(astra, "fast")).toBe("priority");
  });

  test("steps down to the fastest offered tier below the request", () => {
    expect(fitCodexServiceTier(astra, "ultrafast")).toBe("priority");
    expect(fitCodexServiceTier(["default"], "ultrafast")).toBeNull();
    expect(fitCodexServiceTier([], "fast")).toBeNull();
  });

  test("runs Standard and unknown tiers the model lacks at Standard", () => {
    expect(fitCodexServiceTier(sol, null)).toBeNull();
    expect(fitCodexServiceTier(sol, "flex")).toBeNull();
  });
});

describe("fitCodexServiceTierSelection", () => {
  test("fits by Nodex name and keeps a speed for a model the catalog does not describe", () => {
    expect(fitCodexServiceTierSelection(["default", "priority"], "ultrafast")).toBe("fast");
    expect(fitCodexServiceTierSelection(["default"], "fast")).toBeNull();
    expect(fitCodexServiceTierSelection(undefined, "ultrafast")).toBe("ultrafast");
    expect(fitCodexServiceTierSelection(undefined, "priority")).toBe("fast");
  });
});
