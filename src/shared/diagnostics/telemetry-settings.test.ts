import { describe, expect, test } from "vite-plus/test";
import { isTelemetrySettings } from "./telemetry-settings";

const VALID_SETTINGS = {
  enabled: true,
  active: false,
  blockedBy: "development-build",
  managed: false,
};

describe("telemetry settings guard", () => {
  test("accepts a complete payload, with or without a block", () => {
    expect(isTelemetrySettings(VALID_SETTINGS)).toBe(true);
    expect(isTelemetrySettings({ ...VALID_SETTINGS, active: true, blockedBy: null })).toBe(true);
  });

  test("rejects invalid or missing fields", () => {
    expect(isTelemetrySettings({ enabled: true })).toBe(false);
    expect(isTelemetrySettings({ ...VALID_SETTINGS, active: "yes" })).toBe(false);
    expect(isTelemetrySettings({ ...VALID_SETTINGS, blockedBy: "unknown-reason" })).toBe(false);
    expect(isTelemetrySettings(null)).toBe(false);
  });
});
