export type ChromeControlRuntimeStatus =
  | "extension-disconnected"
  | "faulted"
  | "ready"
  | "runtime-unavailable";

/** Transport-neutral projection of the five Chrome provider readiness gates. */
export interface ChromeControlRuntimeSnapshot {
  readonly bundleSupported: boolean;
  readonly extensionConnected: boolean;
  readonly nativeHostInstalled: boolean;
  readonly providerReady: boolean;
  readonly reason: string | null;
  readonly requested: boolean;
  readonly revision: number;
  readonly status: ChromeControlRuntimeStatus;
}

const CHROME_CONTROL_RUNTIME_STATUSES: readonly ChromeControlRuntimeStatus[] = [
  "extension-disconnected",
  "faulted",
  "ready",
  "runtime-unavailable",
];

export function isChromeControlRuntimeSnapshot(
  value: unknown,
): value is ChromeControlRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.requested === "boolean" &&
    typeof candidate.bundleSupported === "boolean" &&
    typeof candidate.nativeHostInstalled === "boolean" &&
    typeof candidate.extensionConnected === "boolean" &&
    typeof candidate.providerReady === "boolean" &&
    (candidate.reason === null ||
      (typeof candidate.reason === "string" && candidate.reason.length <= 512)) &&
    Number.isSafeInteger(candidate.revision) &&
    Number(candidate.revision) >= 0 &&
    typeof candidate.status === "string" &&
    CHROME_CONTROL_RUNTIME_STATUSES.includes(candidate.status as ChromeControlRuntimeStatus)
  );
}
