/**
 * Where Nodex publishes a release's installers, update archives and manifests, and how a client
 * recognizes an immutable release download.
 *
 * - GitHub Releases keeps every release permanently and is the archive of record.
 * - `dl.nodex.jyu.app` serves the same bytes from the release bucket at Cloudflare's edge: stable
 *   releases under `releases/<tag>/`, Nightlies under `nightly/<tag>/`. Objects there never change
 *   after upload, so a client verifies them with the same size, digest and signature.
 * - `nodex.jyu.app` serves the mutable pointers: the update feeds at `updates/<channel>/<arch>/`
 *   and `/dl/<target>`, which redirects to the current stable installer named by `latest/stable.json`.
 */

export const RELEASE_DOWNLOAD_ORIGIN = "https://dl.nodex.jyu.app";
const RELEASE_DOWNLOAD_HOST = new URL(RELEASE_DOWNLOAD_ORIGIN).host;
const GITHUB_RELEASE_PATH = "/junyudev/nodex/releases/download/";

export type ReleaseChannel = "stable" | "nightly";

export const STABLE_RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
export const NIGHTLY_RELEASE_TAG =
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-nightly\.\d{8}\.[1-9]\d*$/u;
/** One path segment that needs no URL encoding and cannot climb out of its directory. */
const RELEASE_ASSET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

export function releaseTagChannel(tag: string): ReleaseChannel | null {
  if (STABLE_RELEASE_TAG.test(tag)) return "stable";
  if (NIGHTLY_RELEASE_TAG.test(tag)) return "nightly";
  return null;
}

const CHANNEL_PREFIX = { stable: "releases", nightly: "nightly" } as const;

/** The release bucket key of one asset of a stable or Nightly release. */
export function releaseObjectKey(tag: string, assetName: string): string {
  const channel = releaseTagChannel(tag);
  if (!channel) throw new Error(`${tag} is not a stable or Nightly release tag.`);
  if (!RELEASE_ASSET_NAME.test(assetName)) {
    throw new Error(`${assetName} is not a publishable release asset name.`);
  }
  return `${CHANNEL_PREFIX[channel]}/${tag}/${assetName}`;
}

/** The `dl.nodex.jyu.app` URL of one asset of a stable or Nightly release. */
export const releaseDownloadUrl = (tag: string, assetName: string): string =>
  `${RELEASE_DOWNLOAD_ORIGIN}/${releaseObjectKey(tag, assetName)}`;

/** The GitHub Releases URL of one asset; the archive of record for every release. */
export function githubReleaseDownloadUrl(tag: string, assetName: string): string {
  releaseObjectKey(tag, assetName);
  return `https://github.com${GITHUB_RELEASE_PATH}${tag}/${assetName}`;
}

export interface ImmutableReleaseDownload {
  readonly host: "github" | "release-bucket";
  readonly channel: ReleaseChannel;
  readonly tag: string;
  readonly assetName: string;
}

/**
 * Reads an immutable release download URL on either host, or returns `null`. Only the exact
 * canonical spelling is accepted: anything a URL parser would normalize (an explicit port, empty
 * userinfo, query or fragment markers, dot or encoded segments) fails the final comparison.
 */
export function parseImmutableReleaseDownloadUrl(value: string): ImmutableReleaseDownload | null {
  const url = URL.parse(value);
  if (!url) return null;
  let download: ImmutableReleaseDownload | null = null;
  if (url.host === "github.com" && url.pathname.startsWith(GITHUB_RELEASE_PATH)) {
    const [tag = "", assetName = ""] = url.pathname.slice(GITHUB_RELEASE_PATH.length).split("/");
    const channel = releaseTagChannel(tag);
    if (channel) download = { host: "github", channel, tag, assetName };
  } else if (url.host === RELEASE_DOWNLOAD_HOST) {
    const [prefix, tag = "", assetName = ""] = url.pathname.slice(1).split("/");
    const channel = releaseTagChannel(tag);
    if (channel && prefix === CHANNEL_PREFIX[channel]) {
      download = { host: "release-bucket", channel, tag, assetName };
    }
  }
  if (!download || !RELEASE_ASSET_NAME.test(download.assetName)) return null;
  const canonical =
    download.host === "github"
      ? githubReleaseDownloadUrl(download.tag, download.assetName)
      : releaseDownloadUrl(download.tag, download.assetName);
  return value === canonical ? download : null;
}

/** The release bucket key of the pointer `/dl/<target>` follows. */
export const STABLE_RELEASE_POINTER_KEY = "latest/stable.json";

/** The installers `/dl/<target>` serves, one per platform with a direct download. */
export const STABLE_DOWNLOAD_TARGETS = ["macos", "windows-x64", "android"] as const;
export type StableDownloadTarget = (typeof STABLE_DOWNLOAD_TARGETS)[number];

/**
 * `latest/stable.json`: the newest stable release whose assets are all on `dl.nodex.jyu.app`.
 * Publishing writes it last, so its presence means every installer it names is downloadable.
 */
export interface StableReleasePointer {
  readonly version: 1;
  readonly tag: string;
  readonly installers: Readonly<Record<StableDownloadTarget, string>>;
}

export function parseStableReleasePointer(value: unknown): StableReleasePointer {
  const record = (value ?? {}) as Record<string, unknown>;
  const installers = (record.installers ?? {}) as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.tag !== "string" ||
    releaseTagChannel(record.tag) !== "stable" ||
    Object.keys(record).length !== 3 ||
    Object.keys(installers).length !== STABLE_DOWNLOAD_TARGETS.length
  ) {
    throw new Error("Stable release pointer is invalid.");
  }
  const tag = record.tag;
  const entries = STABLE_DOWNLOAD_TARGETS.map((target) => {
    const name = installers[target];
    if (typeof name !== "string") throw new Error(`Stable release pointer lacks ${target}.`);
    releaseObjectKey(tag, name);
    return [target, name] as const;
  });
  return {
    version: 1,
    tag,
    installers: Object.fromEntries(entries) as Record<StableDownloadTarget, string>,
  };
}
