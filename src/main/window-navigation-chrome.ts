import {
  resolveWorkbenchMacWindowControlPosition,
  resolveWorkbenchWindowControlsOverlayHeight,
  type WorkbenchWindowControlPosition,
} from "../shared/workbench-window-chrome";
import type { BrowserWindow } from "electron";

const shellZoomByWindow = new WeakMap<BrowserWindow, number>();

export function setWindowShellZoom(window: BrowserWindow, zoom: number): void {
  shellZoomByWindow.set(window, zoom);
}

export type WindowZoomCommand = "reset" | "in" | "out";

export function syncWindowNavigationChrome(
  window: BrowserWindow,
  platform: NodeJS.Platform,
  isDark = false,
): void {
  if (platform !== "darwin" && platform !== "win32") return;
  if (window.isDestroyed() || window.webContents.isDestroyed()) return;
  const zoom = window.webContents.getZoomFactor() * (shellZoomByWindow.get(window) ?? 1);
  if (platform === "darwin") {
    window.setWindowButtonPosition(resolveCodexTrafficLightPosition(zoom));
    return;
  }
  if (platform === "win32") window.setTitleBarOverlay(resolveCodexTitleBarOverlay(zoom, isDark));
}

export const CODEX_TITLEBAR_OVERLAY_COLOR = "#00000000";
export const CODEX_TITLEBAR_OVERLAY_DARK_SYMBOL_COLOR = "#ffffff";
export const CODEX_TITLEBAR_OVERLAY_LIGHT_SYMBOL_COLOR = "#1f1f1f";

export type CodexTrafficLightPosition = WorkbenchWindowControlPosition;

export interface CodexTitleBarOverlayOptions {
  color: string;
  symbolColor: string;
  height: number;
}

export type CodexTitleBarOptions =
  | {
      titleBarStyle: "hiddenInset";
      trafficLightPosition: CodexTrafficLightPosition;
    }
  | {
      titleBarStyle: "hidden";
      titleBarOverlay: CodexTitleBarOverlayOptions;
    }
  | {
      titleBarStyle: "default";
    };

export function resolveCodexTrafficLightPosition(windowZoom = 1): CodexTrafficLightPosition {
  return resolveWorkbenchMacWindowControlPosition(windowZoom);
}

export function resolveCodexTitleBarOverlay(
  windowZoom = 1,
  isDark = false,
): CodexTitleBarOverlayOptions {
  return {
    color: CODEX_TITLEBAR_OVERLAY_COLOR,
    symbolColor: isDark
      ? CODEX_TITLEBAR_OVERLAY_DARK_SYMBOL_COLOR
      : CODEX_TITLEBAR_OVERLAY_LIGHT_SYMBOL_COLOR,
    height: resolveWorkbenchWindowControlsOverlayHeight(windowZoom),
  };
}

export function resolveCodexTitleBarOptions({
  platform,
  windowZoom = 1,
  isDark = false,
}: {
  platform: NodeJS.Platform;
  windowZoom?: number;
  isDark?: boolean;
}): CodexTitleBarOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: "hiddenInset",
      trafficLightPosition: resolveCodexTrafficLightPosition(windowZoom),
    };
  }

  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: resolveCodexTitleBarOverlay(windowZoom, isDark),
    };
  }

  return {
    titleBarStyle: "default",
  };
}
