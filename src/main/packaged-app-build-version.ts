import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { APP_UPDATE_BUILD_VERSION_PATTERN } from "../shared/app-version";
import { readWindowsAppUpdateConfig } from "./windows-app-update-config";

/** Read the same installed build identity the platform updater uses. */
export function readPackagedAppBuildVersion(
  platform: NodeJS.Platform,
  resourcesPath: string,
): string | undefined {
  if (platform === "win32") return readWindowsAppUpdateConfig(resourcesPath).buildVersion;
  if (platform !== "darwin") return undefined;
  const buildVersion = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleVersion", "raw", "-o", "-", join(resourcesPath, "..", "Info.plist")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1_000 },
  ).trim();
  if (!APP_UPDATE_BUILD_VERSION_PATTERN.test(buildVersion)) {
    throw new Error("Packaged macOS build version is invalid.");
  }
  return buildVersion;
}
