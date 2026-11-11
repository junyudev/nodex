import type { AfterPackContext } from "electron-builder";

export interface RestorePackagedBrowserRuntimeClosureOptions {
  readonly packagedBrowserRoot: string;
  readonly sourceBrowserRoot: string;
  readonly windowsArch?: "x64" | "arm64";
  readonly restore?: boolean;
}

export function restorePackagedBrowserRuntimeClosure(
  options: RestorePackagedBrowserRuntimeClosureOptions,
): number;

export default function restorePackagedRuntimeClosure(context: AfterPackContext): Promise<void>;
