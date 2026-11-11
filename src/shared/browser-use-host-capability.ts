import { hostCapabilities } from "./host-capabilities";
import type { BrowserRuntimeBackend } from "./browser-runtime-metadata";

export const BROWSER_USE_PEER_AUTHORIZATION_ENV = "CODEX_BROWSER_USE_PEER_AUTHORIZATION";

export type BrowserUseHostCapabilityUnavailableReason =
  | "platform-unsupported"
  | "runtime-unavailable";

export type BrowserUsePeerAuthorizationMode = "development" | "disabled" | "packaged";

export type BrowserUseHostCapability =
  | {
      readonly availableBackends: readonly BrowserRuntimeBackend[];
      readonly peerAuthorizationMode: BrowserUsePeerAuthorizationMode;
      readonly status: "available";
    }
  | {
      readonly availableBackends: readonly [];
      readonly message: string;
      readonly peerAuthorizationMode: "disabled";
      readonly reason: BrowserUseHostCapabilityUnavailableReason;
      readonly status: "unavailable";
    };

export function resolveBrowserUseHostCapability(input: {
  readonly windowsTransportReady?: boolean;
  readonly execution?: "local" | "remote" | "wsl";
  readonly browserRuntimeStatus: "available" | "unavailable";
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly isPackaged: boolean;
  readonly platform: NodeJS.Platform;
}): BrowserUseHostCapability {
  if (input.browserRuntimeStatus === "unavailable") {
    return {
      availableBackends: [],
      message: "The verified Browser runtime is unavailable",
      peerAuthorizationMode: "disabled",
      reason: "runtime-unavailable",
      status: "unavailable",
    };
  }
  if (
    (input.platform !== "darwin" && input.platform !== "win32") ||
    (input.execution !== undefined && input.execution !== "local")
  ) {
    return {
      availableBackends: [],
      message: `The in-app Browser host is unsupported on ${input.platform}`,
      peerAuthorizationMode: "disabled",
      reason: "platform-unsupported",
      status: "unavailable",
    };
  }
  if (
    !hostCapabilities(input.platform, undefined, {
      browserReady: input.windowsTransportReady === true,
    }).browserControl
  ) {
    return {
      availableBackends: [],
      message: "The Windows Browser transport is unavailable",
      peerAuthorizationMode: "disabled",
      reason: "runtime-unavailable",
      status: "unavailable",
    };
  }
  if (
    input.isPackaged ||
    (input.platform === "win32" && input.environment[BROWSER_USE_PEER_AUTHORIZATION_ENV] !== "1")
  ) {
    return {
      availableBackends: ["iab"],
      peerAuthorizationMode: "packaged",
      status: "available",
    };
  }
  return {
    availableBackends: ["iab"],
    peerAuthorizationMode:
      input.environment[BROWSER_USE_PEER_AUTHORIZATION_ENV] === "1" ? "development" : "disabled",
    status: "available",
  };
}
