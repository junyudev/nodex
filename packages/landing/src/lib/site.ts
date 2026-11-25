import changelog from "../../../../CHANGELOG.md?raw";
import { releasesToShow } from "../changelog";

const changeSources = import.meta.glob<string>("../../../../changes/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const changeFiles = Object.entries(changeSources).map(([path, content]) => ({
  path: path.slice("../../../../".length),
  content,
}));

export const CHANGELOG_RELEASES = releasesToShow(changelog, changeFiles);
const version = CHANGELOG_RELEASES.find((release) => release.version !== null)?.version;
if (!version) throw new Error("The landing page requires a dated release in CHANGELOG.md.");

export const VERSION_LABEL: `v${string}` = `v${version}`;
export const GITHUB_URL = "https://github.com/junyudev/nodex";
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const CHANGELOG_URL = "/changelog/";
export const BREW_COMMAND = "brew install --cask junyudev/tap/nodex";

export type DownloadTarget = "macos" | "windows-x64" | "ios" | "android";

const LATEST = `${RELEASES_URL}/latest/download`;

/**
 * Stable alias assets that every release carries for its newest build, and the public TestFlight
 * beta that receives each release's iPhone build.
 */
export const DOWNLOADS: Readonly<Record<DownloadTarget, string>> = {
  macos: `${LATEST}/Nodex-latest-arm64.dmg`,
  "windows-x64": `${LATEST}/Nodex-latest-windows-x64.exe`,
  ios: "https://testflight.apple.com/join/Yz8Kpcty",
  android: `${LATEST}/Nodex-latest-android.apk`,
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
