import { describe, expect, test } from "vite-plus/test";
import { isDiagnosticsSettings } from "./diagnostics-settings";

const VALID_SETTINGS = {
  enabled: true,
  active: true,
  blockedBy: null,
  dsn: "https://example.com/1",
  environment: "test",
  release: null,
  tracesSampleRate: 0,
  replayEnabled: true,
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1,
  envOverrides: {
    enabled: false,
    dsn: false,
    environment: false,
    release: false,
    tracesSampleRate: false,
    replayEnabled: false,
    replaysSessionSampleRate: false,
    replaysOnErrorSampleRate: false,
  },
};

describe("diagnostics settings guard", () => {
  test("accepts a complete diagnostics settings payload", () => {
    expect(isDiagnosticsSettings(VALID_SETTINGS)).toBe(true);
  });

  test("rejects incomplete environment override state", () => {
    expect(
      isDiagnosticsSettings({
        ...VALID_SETTINGS,
        envOverrides: {
          enabled: false,
        },
      }),
    ).toBe(false);
  });

  test("rejects invalid trace sample rates", () => {
    expect(
      isDiagnosticsSettings({
        ...VALID_SETTINGS,
        tracesSampleRate: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);

    expect(
      isDiagnosticsSettings({
        ...VALID_SETTINGS,
        tracesSampleRate: 1.1,
      }),
    ).toBe(false);
  });

  test("rejects invalid replay sample rates", () => {
    expect(
      isDiagnosticsSettings({
        ...VALID_SETTINGS,
        replaysSessionSampleRate: Number.POSITIVE_INFINITY,
      }),
    ).toBe(false);

    expect(
      isDiagnosticsSettings({
        ...VALID_SETTINGS,
        replaysOnErrorSampleRate: -0.1,
      }),
    ).toBe(false);
  });
});
