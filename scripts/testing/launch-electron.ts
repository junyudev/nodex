import path from "node:path";
import { _electron, type ElectronApplication } from "playwright";
import { isolatedElectronArguments } from "../isolated-run/electron-arguments";

export type ElectronTestWindowPresentation = "background" | "foreground";
type LaunchOptions = NonNullable<Parameters<typeof _electron.launch>[0]> & {
  readonly windows?: ElectronTestWindowPresentation;
};

/** All disposable Electron tests share the same non-interrupting window policy. */
export function launchTestElectron({
  windows = "background",
  ...options
}: LaunchOptions = {}): Promise<ElectronApplication> {
  const foreground = process.env.NODEX_E2E_WINDOWS === "foreground" || windows === "foreground";
  return _electron.launch({
    ...options,
    args: [
      ...(foreground
        ? []
        : ["-r", path.resolve("scripts/testing/electron-background-windows.cjs")]),
      ...(options.args ?? []),
      ...isolatedElectronArguments(),
    ],
  });
}
