import {
  isCodexCompactWindowUrl,
  resolveCodexRendererOs,
  resolveCodexRendererWindowChrome,
} from "../lib/codex-window-runtime";
import { applyCodexThemeVariant } from "../lib/codex-theme-variant";

export interface RendererDocumentOptions {
  readonly storybook?: boolean;
}

declare global {
  interface Window {
    __NODEX_STORYBOOK__?: boolean;
  }
}

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
export function initializeRendererDocument(options?: RendererDocumentOptions): void {
  const root = document.documentElement;
  applyCodexThemeVariant(root, root.classList.contains("dark") ? "dark" : "light", document.body);
  const isElectronWindow = Boolean(window.api);
  const shouldEmulateElectronWindow = isElectronWindow || options?.storybook === true;
  const shouldEmulateOpaqueElectronWindow =
    options?.storybook === true || root.classList.contains("electron-opaque");

  root.dataset.codexWindowType = shouldEmulateElectronWindow ? "electron" : "browser";
  window.__NODEX_STORYBOOK__ = options?.storybook === true;

  if (!shouldEmulateElectronWindow) {
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
  applyElectronOpaqueSurface(root, shouldEmulateOpaqueElectronWindow);
  subscribeElectronOpaqueSurfaceChanges(root);

  const isDark = root.classList.contains("dark");
  root.classList.toggle("electron-dark", isDark);
  root.classList.toggle("electron-light", !isDark);
}
