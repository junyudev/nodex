import { invokeRendererControl } from "./renderer-command";

export function notifyAppCloseFlushComplete(webContentsId: number): Promise<void> {
  return invokeRendererControl("app:flush-before-close:done", webContentsId);
}

export function readAppCloseBridge(): Window["api"] | null {
  if (typeof window === "undefined") return null;
  return window.api ?? null;
}
