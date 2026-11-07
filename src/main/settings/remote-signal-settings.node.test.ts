import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  getDiagnosticsSettings,
  getTelemetrySettings,
  updateTelemetrySettings,
} from "./application-settings-persistence";

let directory: string;
let settingsPath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "nodex-remote-signals-"));
  settingsPath = join(directory, "config.toml");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const released = (environment: NodeJS.ProcessEnv = {}) => ({
  environment,
  isPackaged: true,
  settingsPath,
});

describe("remote signal settings", () => {
  test("a released build with no saved preference shares usage and crash data", () => {
    expect(getTelemetrySettings(released())).toEqual({
      enabled: true,
      active: true,
      blockedBy: null,
      managed: false,
    });
    const diagnostics = getDiagnosticsSettings(released());
    expect(diagnostics.active).toBe(true);
    expect(diagnostics.dsn).not.toBe("");
    expect(diagnostics.replayEnabled).toBe(false);
  });

  test("a development build stays silent while the preference still reads on", () => {
    const source = { environment: {}, settingsPath };
    expect(getTelemetrySettings(source)).toEqual({
      enabled: true,
      active: false,
      blockedBy: "development-build",
      managed: false,
    });
    expect(getDiagnosticsSettings(source).active).toBe(false);
  });

  test("an earlier explicit choice to stay off is kept", () => {
    writeFileSync(
      settingsPath,
      "[server]\ntelemetry_enabled = false\ndiagnostics_enabled = false\n",
    );
    expect(getTelemetrySettings(released()).active).toBe(false);
    expect(getDiagnosticsSettings(released()).active).toBe(false);
  });

  test("DO_NOT_TRACK and CI stop both signals; their own variable still wins", () => {
    expect(getTelemetrySettings(released({ DO_NOT_TRACK: "1" })).blockedBy).toBe("do-not-track");
    expect(getDiagnosticsSettings(released({ CI: "true" })).blockedBy).toBe("ci");
    expect(
      getTelemetrySettings(released({ DO_NOT_TRACK: "1", NODEX_TELEMETRY_ENABLED: "true" })).active,
    ).toBe(true);
    expect(getTelemetrySettings(released({ NODEX_TELEMETRY_ENABLED: "false" }))).toEqual({
      enabled: false,
      active: false,
      blockedBy: "environment",
      managed: true,
    });
    expect(getTelemetrySettings(released({ NODEX_TELEMETRY_ENABLED: "true" })).managed).toBe(true);
  });

  test("a local test receiver lets a development build follow the preference", () => {
    const source = {
      environment: { NODEX_TELEMETRY_ENDPOINT: "http://127.0.0.1:1/" },
      settingsPath,
    };
    expect(getTelemetrySettings(source).active).toBe(true);
    updateTelemetrySettings({ enabled: false }, source);
    expect(getTelemetrySettings(source)).toEqual({
      enabled: false,
      active: false,
      blockedBy: null,
      managed: false,
    });
    expect(getDiagnosticsSettings(source).active).toBe(false);
  });

  test("saving writes only the preference and takes effect", () => {
    expect(updateTelemetrySettings({ enabled: false }, released()).active).toBe(false);
    const saved = parseToml(readFileSync(settingsPath, "utf8")) as {
      server: Record<string, unknown>;
    };
    expect(saved.server).toEqual({ telemetry_enabled: false });
    expect(getTelemetrySettings(released()).enabled).toBe(false);
  });
});
