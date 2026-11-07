import { isRemoteSignalBlock } from "./telemetry-settings";
import type { DiagnosticsSettings, DiagnosticsSettingsEnvOverrides } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isDiagnosticsSettingsEnvOverrides(
  value: unknown,
): value is DiagnosticsSettingsEnvOverrides {
  if (!isRecord(value)) return false;

  return (
    typeof value.enabled === "boolean" &&
    typeof value.dsn === "boolean" &&
    typeof value.environment === "boolean" &&
    typeof value.release === "boolean" &&
    typeof value.tracesSampleRate === "boolean" &&
    typeof value.replayEnabled === "boolean" &&
    typeof value.replaysSessionSampleRate === "boolean" &&
    typeof value.replaysOnErrorSampleRate === "boolean"
  );
}

export function isDiagnosticsSettings(value: unknown): value is DiagnosticsSettings {
  if (!isRecord(value)) return false;

  return (
    typeof value.enabled === "boolean" &&
    typeof value.dsn === "string" &&
    typeof value.environment === "string" &&
    (typeof value.release === "string" || value.release === null) &&
    typeof value.tracesSampleRate === "number" &&
    Number.isFinite(value.tracesSampleRate) &&
    value.tracesSampleRate >= 0 &&
    value.tracesSampleRate <= 1 &&
    typeof value.replayEnabled === "boolean" &&
    typeof value.replaysSessionSampleRate === "number" &&
    Number.isFinite(value.replaysSessionSampleRate) &&
    value.replaysSessionSampleRate >= 0 &&
    value.replaysSessionSampleRate <= 1 &&
    typeof value.replaysOnErrorSampleRate === "number" &&
    Number.isFinite(value.replaysOnErrorSampleRate) &&
    value.replaysOnErrorSampleRate >= 0 &&
    value.replaysOnErrorSampleRate <= 1 &&
    isDiagnosticsSettingsEnvOverrides(value.envOverrides) &&
    typeof value.active === "boolean" &&
    isRemoteSignalBlock(value.blockedBy)
  );
}
