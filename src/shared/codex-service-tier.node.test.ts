import { describe, expect, test } from "vitest";
import { normalizeCodexServiceTier, offeredCodexServiceTier } from "./codex-service-tier";

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
