import { describe, expect, test } from "vitest";
import { normalizeCodexServiceTier } from "./codex-service-tier";

describe("Codex service-tier domain projection", () => {
  test.each([null, undefined, "", " standard ", "default", "DEFAULT"])(
    "projects %p to Standard",
    (value) => {
      expect(normalizeCodexServiceTier(value)).toBeNull();
    },
  );

  test.each([
    ["priority", "priority"],
    [" fast ", "fast"],
    ["flex", "flex"],
  ])("preserves named tier %p", (value, expected) => {
    expect(normalizeCodexServiceTier(value)).toBe(expected);
  });
});
