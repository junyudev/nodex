export type ChromeControlRuntimeStatus =
  | "disabled"
  | "extension-disconnected"
  | "faulted"
  | "registration-disabled"
  | "registration-in-use"
  | "ready"
  | "runtime-unavailable";

export type ChromeControlSettingsAction =
  | { readonly kind: "enable" | "disable" | "repair" }
  | { readonly kind: "takeover"; readonly token: string };

export interface WindowsChromeControlSettings {
  readonly owner: "app" | "profile" | null;
  readonly manifestPaths: readonly string[];
  readonly takeoverToken: string | null;
  readonly canGiveBack: boolean;
}

/** Transport-neutral projection of Chrome provider readiness. */
export interface ChromeControlRuntimeSnapshot {
  readonly bundleSupported: boolean;
  readonly extensionConnected: boolean;
  readonly nativeHostInstalled: boolean;
  readonly providerReady: boolean;
  readonly reason: string | null;
  readonly requested: boolean;
  readonly revision: number;
  readonly status: ChromeControlRuntimeStatus;
  readonly windows?: WindowsChromeControlSettings;
}

const CHROME_CONTROL_RUNTIME_STATUSES: readonly ChromeControlRuntimeStatus[] = [
  "disabled",
  "extension-disconnected",
  "faulted",
  "registration-disabled",
  "registration-in-use",
  "ready",
  "runtime-unavailable",
];

export function isChromeControlRuntimeSnapshot(
  value: unknown,
): value is ChromeControlRuntimeSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.windows === undefined || isWindowsChromeControlSettings(candidate.windows)) &&
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

function isWindowsChromeControlSettings(value: unknown): value is WindowsChromeControlSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Record<string, unknown>;
  return (
    (settings.owner === null || settings.owner === "app" || settings.owner === "profile") &&
    Array.isArray(settings.manifestPaths) &&
    settings.manifestPaths.length <= 2 &&
    settings.manifestPaths.every((path) => typeof path === "string" && path.length <= 1024) &&
    (settings.takeoverToken === null ||
      (typeof settings.takeoverToken === "string" &&
        /^[0-9a-f-]{36}$/u.test(settings.takeoverToken))) &&
    typeof settings.canGiveBack === "boolean"
  );
}

export function parseChromeControlSettingsAction(value: unknown): ChromeControlSettingsAction {
  if (value && typeof value === "object") {
    const { kind, token } = value as Record<string, unknown>;
    if (kind === "enable" || kind === "disable" || kind === "repair") return { kind };
    if (kind === "takeover" && typeof token === "string" && /^[0-9a-f-]{36}$/u.test(token)) {
      return { kind, token };
    }
  }
  throw new Error("Invalid browser control action");
}
