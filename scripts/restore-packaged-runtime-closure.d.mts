import type { AfterPackContext } from "electron-builder";

export interface RestorePackagedBrowserRuntimeClosureOptions {
  readonly packagedBrowserRoot: string;
  readonly sourceBrowserRoot: string;
}

export function restorePackagedBrowserRuntimeClosure(
  options: RestorePackagedBrowserRuntimeClosureOptions,
): number;

export default function restorePackagedRuntimeClosure(context: AfterPackContext): Promise<void>;
