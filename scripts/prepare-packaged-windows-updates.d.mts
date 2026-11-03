import type { AfterPackContext } from "electron-builder";
export default function preparePackagedWindowsUpdates(
  context: Pick<AfterPackContext, "arch" | "electronPlatformName" | "packager">,
): void;
