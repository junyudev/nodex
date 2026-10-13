import {
  isCodexCompactWindowUrl,
  resolveCodexRendererOs,
  resolveCodexRendererWindowChrome,
} from "../lib/codex-window-runtime";
import { applyCodexThemeVariant } from "../lib/codex-theme-variant";
import { readAccentColorPreferences, resolveAccentColorPreference } from "../lib/theme-preferences";

let unsubscribeElectronOpaqueSurfaceChange: (() => void) | null = null;

function applyElectronOpaqueSurface(root: HTMLElement, enabled: boolean): void {
  if (root.classList.contains("compact-window")) {
    root.classList.remove("electron-opaque");
    return;
  }

  root.classList.toggle("electron-opaque", enabled);
}

function subscribeElectronOpaqueSurfaceChanges(root: HTMLElement): void {
  unsubscribeElectronOpaqueSurfaceChange?.();
  unsubscribeElectronOpaqueSurfaceChange = null;
  if (!window.api) return;

  unsubscribeElectronOpaqueSurfaceChange = window.api.on(
    "electron-window-opaque-surface-changed",
    (payload) => {
      const opaqueWindowSurfaceEnabled =
        typeof payload === "object" &&
        payload !== null &&
        "opaqueWindowSurfaceEnabled" in payload &&
        payload.opaqueWindowSurfaceEnabled === true;
      applyElectronOpaqueSurface(root, opaqueWindowSurfaceEnabled);
    },
  );
}

function clearElectronRuntimeDocumentState(root: HTMLElement): void {
  unsubscribeElectronOpaqueSurfaceChange?.();
  unsubscribeElectronOpaqueSurfaceChange = null;
  root.classList.remove("compact-window", "electron-dark", "electron-light", "electron-opaque");
  delete root.dataset.windowType;
  delete root.dataset.codexOs;
  delete root.dataset.codexWindowChrome;
}

/** Reconciles parser-time appearance with the live Electron bridge before React loads. */
export function initializeRendererDocument(): void {
  const root = document.documentElement;
  const variant = root.classList.contains("dark") ? "dark" : "light";
  applyCodexThemeVariant(
    root,
    variant,
    document.body,
    resolveAccentColorPreference(readAccentColorPreferences(), variant),
  );
  const isElectronWindow = Boolean(window.api);
  const opaqueElectronWindow = root.classList.contains("electron-opaque");

  root.dataset.codexWindowType = isElectronWindow ? "electron" : "browser";

  if (!isElectronWindow) {
    clearElectronRuntimeDocumentState(root);
    return;
  }

  const os = resolveCodexRendererOs();
  const isCompactWindow = isCodexCompactWindowUrl(window.location.href);
  root.dataset.windowType = "electron";
  root.dataset.codexOs = os;
  root.dataset.codexWindowChrome = resolveCodexRendererWindowChrome("electron", os);
  root.classList.toggle("compact-window", isCompactWindow);
  root.classList.toggle("hide-startup-shell", isCompactWindow);
  applyElectronOpaqueSurface(root, opaqueElectronWindow);
  subscribeElectronOpaqueSurfaceChanges(root);

  const isDark = root.classList.contains("dark");
  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}
