import { hostCapabilities } from "../../shared/host-capabilities";
import { resolveCodexRendererOs } from "./codex-window-runtime";

/** Settings presents host-supported features; temporary readiness stays with each feature owner. */
export function resolveSettingsHostPresentation(platform: string) {
  const capabilities = hostCapabilities(platform);
  return {
    computerUse: capabilities.computerControl,
    browserProfileImport: capabilities.browserProfileImport,
    browserControl: capabilities.browserControl,
    appUpdates: capabilities.autoUpdate,
  };
}

export function readSettingsHostPresentation() {
  const platform =
    typeof document === "undefined"
      ? "unknown"
      : (document.documentElement.dataset.codexOs ?? resolveCodexRendererOs());
  return resolveSettingsHostPresentation(platform);
}
