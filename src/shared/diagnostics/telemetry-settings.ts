import type { TelemetrySettings } from "../types";
import type { RemoteSignalBlock } from "../product-analytics/remote-signals";

const REMOTE_SIGNAL_BLOCKS: ReadonlySet<unknown> = new Set<RemoteSignalBlock>([
  "environment",
  "do-not-track",
  "ci",
  "development-build",
]);

export function isRemoteSignalBlock(value: unknown): value is RemoteSignalBlock | null {
  return value === null || REMOTE_SIGNAL_BLOCKS.has(value);
}

export function isTelemetrySettings(value: unknown): value is TelemetrySettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.enabled === "boolean" &&
    typeof candidate.active === "boolean" &&
    typeof candidate.managed === "boolean" &&
    isRemoteSignalBlock(candidate.blockedBy)
  );
}
