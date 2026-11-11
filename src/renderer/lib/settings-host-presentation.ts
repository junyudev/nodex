import { hostCapabilities } from "../../shared/host-capabilities";
import { resolveCodexRendererOs } from "./codex-window-runtime";

/** Settings presents host-supported features; temporary readiness stays with each feature owner. */
export function resolveSettingsHostPresentation(platform: string) {
  const capabilities = hostCapabilities(platform);
  return {
    terminalShell: platform === "win32",
    computerUse: platform === "win32" || capabilities.computerControl,
    browserProfileImport: capabilities.browserProfileImport,
    browserControl: platform === "win32" || capabilities.browserControl,
    appUpdates: capabilities.autoUpdate,
    launchAtLogin: platform === "win32" || platform === "windows",
  };
}

export function readSettingsHostPresentation() {
  const platform =
    typeof document === "undefined"
      ? "unknown"
      : (document.documentElement.dataset.codexOs ?? resolveCodexRendererOs());
  return resolveSettingsHostPresentation(platform);
}
