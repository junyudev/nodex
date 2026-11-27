import { resolve } from "node:path";

export type BundledElectronPreload =
  | "browser-guest.js"
  | "global-dictation.js"
  | "index.js"
  | "mcp-app-sandbox-guest.js";

/** Chromium rejects parent-referencing file paths, so Electron must receive a canonical path. */
export function resolveBundledElectronPreload(
  mainOutputDirectory: string,
  preload: BundledElectronPreload,
): string {
  return resolve(mainOutputDirectory, "..", "preload", preload);
}
