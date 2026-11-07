import { version } from "../../../../package.json";

export const VERSION_LABEL: `v${string}` = `v${version}`;
export const GITHUB_URL = "https://github.com/junyudev/nodex";
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const CHANGELOG_URL = "/changelog/";
export const DOWNLOAD_PAGE_URL = "/download/";
export const MOBILE_DOWNLOAD_URL = `${DOWNLOAD_PAGE_URL}#mobile`;
export const BREW_COMMAND = "brew install --cask junyudev/tap/nodex";

export type DownloadTarget = "macos" | "windows-x64" | "windows-arm64" | "ios" | "android";

const LATEST = `${RELEASES_URL}/latest/download`;

/**
 * Stable alias assets that every release carries for its newest build, and the public TestFlight
 * beta that receives each release's iPhone build.
 */
export const DOWNLOADS: Readonly<Record<DownloadTarget, string>> = {
  macos: `${LATEST}/Nodex-latest-arm64.dmg`,
  "windows-x64": `${LATEST}/Nodex-latest-windows-x64.exe`,
  "windows-arm64": `${LATEST}/Nodex-latest-windows-arm64.exe`,
  ios: "https://testflight.apple.com/join/Yz8Kpcty",
  android: `${LATEST}/Nodex-latest-android.apk`,
};

/** Nodex Mobile's Google Play listing, offered beside the APK once it exists. */
export const GOOGLE_PLAY_URL: string | null = null;

// 0.5.0 is the last stable release published without Windows installers.
const LAST_RELEASE_WITHOUT_WINDOWS = [0, 5, 0] as const;

/** Whether the release a site build describes carries the Windows installers. */
export function windowsDownloadsAvailable(releaseVersion: string): boolean {
  const current = releaseVersion.split(/[.-]/u).slice(0, 3).map(Number);
  for (const [index, part] of LAST_RELEASE_WITHOUT_WINDOWS.entries()) {
    if (current[index] !== part) return current[index] > part;
  }
  return false;
}

export const WINDOWS_AVAILABLE = windowsDownloadsAvailable(version);
