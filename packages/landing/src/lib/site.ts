import changelog from "../../../../CHANGELOG.md?raw";
import { parseChangelog } from "../../../../src/shared/changelog";
import type { StableDownloadTarget } from "../../../../src/shared/release-download";

const version = parseChangelog(changelog)[0]?.version;
if (!version) throw new Error("The landing page requires a dated release in CHANGELOG.md.");

export const VERSION_LABEL: `v${string}` = `v${version}`;
export const GITHUB_URL = "https://github.com/junyudev/nodex";
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const CHANGELOG_URL = "/changelog/";
export const BREW_COMMAND = "brew install --cask junyudev/tap/nodex";

export type DownloadTarget = StableDownloadTarget | "ios";

const STABLE_DOWNLOADS = "https://nodex.jyu.app/dl";

/**
 * The current stable installers and the public TestFlight beta for iPhone.
 */
export const DOWNLOADS: Readonly<Record<DownloadTarget, string>> = {
  macos: `${STABLE_DOWNLOADS}/macos`,
  "windows-x64": `${STABLE_DOWNLOADS}/windows-x64`,
  ios: "https://testflight.apple.com/join/Yz8Kpcty",
  android: `${STABLE_DOWNLOADS}/android`,
};

/** Nodex Mobile's Google Play listing, offered beside the APK once it exists. */
export const GOOGLE_PLAY_URL: string | null = null;

// 0.5.0 is the last stable release published without Windows installers.
const LAST_RELEASE_WITHOUT_WINDOWS = [0, 5, 0] as const;

/** Whether the release a site build describes carries the Windows installers. */
export function windowsDownloadsAvailable(releaseVersion: string): boolean {
  const current = releaseVersion.split(".").slice(0, 3).map(Number);
  for (const [index, part] of LAST_RELEASE_WITHOUT_WINDOWS.entries()) {
    if (current[index] !== part) return current[index] > part;
  }
  return false;
}

export const WINDOWS_AVAILABLE = windowsDownloadsAvailable(version);
