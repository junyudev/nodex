import { lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { nextPatchVersion, parseReleaseIdentity, sha256File, type ReleaseIdentity } from "./model";
import { NODEX_MACOS_TEAM_IDENTIFIER } from "./sparkle-manifest";

export type MobilePlatform = "android" | "ios";
export const MOBILE_PLATFORMS = ["android", "ios"] as const;

/** Nodex Mobile's production identifier on both stores. */
export const MOBILE_APP_ID = "app.jyu.nodex.mobile";
/** The App Store Connect record that owns Nodex Mobile's TestFlight builds. */
export const APP_STORE_CONNECT_APP_ID = "6831854845";
/** The external TestFlight group behind the public link on the download page. */
export const TESTFLIGHT_PUBLIC_GROUP = "Public beta";
/**
 * The certificate every Android build is signed with. An installed APK only accepts updates
 * signed by the same key, so a later Google Play listing must enroll this key in Play App Signing.
 */
export const ANDROID_SIGNING_CERTIFICATE_SHA256 =
  "d08f7ec6d09e8a957e7b0ba33ca3d647789a49231e970c8808088e23ad5215a9";
/** Both apps are signed by the same Apple team as the desktop app. */
export const APPLE_TEAM_IDENTIFIER = NODEX_MACOS_TEAM_IDENTIFIER;

export const MOBILE_BUILD_MANIFEST = "mobile-build.json";

export const mobileArtifactName = (platform: MobilePlatform, version: string): string =>
  platform === "android" ? `Nodex-${version}-android.apk` : `Nodex-${version}-ios.ipa`;

/** The stable download alias the website links to; it always names the newest stable APK. */
export const ANDROID_LATEST_APK = mobileArtifactName("android", "latest");

export interface MobileApp {
  readonly id: string;
  /** What a person sees: `x.y.z` on both platforms. */
  readonly version: string;
  /** The monotonic build: Apple's build version on iOS, the version code on Android. */
  readonly build: string;
}

/**
 * The phone app ships in lockstep with the desktop release it was built from. Stores accept only
 * numeric versions, so a Nightly takes the version it leads up to, and builds follow the same
 * first-parent ordinal as the desktop app, which keeps every channel's builds rising.
 */
export function mobileAppFor(platform: MobilePlatform, identity: ReleaseIdentity): MobileApp {
  return {
    id: MOBILE_APP_ID,
    version:
      identity.channel === "stable" ? identity.version : nextPatchVersion(identity.sourceVersion),
    build: platform === "ios" ? identity.buildVersion : String(identity.mainlineOrdinal),
  };
}

/** What `packages/mobile/app.config.ts` reads to stamp a production build with its release. */
export function mobileBuildEnvironment(
  identity: ReleaseIdentity,
): Readonly<Record<string, string>> {
  const ios = mobileAppFor("ios", identity);
  return {
    APP_VARIANT: "production",
    EXPO_NO_GIT_STATUS: "1",
    NODEX_MOBILE_VERSION: ios.version,
    NODEX_MOBILE_IOS_BUILD: ios.build,
    NODEX_MOBILE_ANDROID_VERSION_CODE: mobileAppFor("android", identity).build,
  };
}

export const expectedMobileSigner = (platform: MobilePlatform): string =>
  platform === "android" ? ANDROID_SIGNING_CERTIFICATE_SHA256 : APPLE_TEAM_IDENTIFIER;

export interface MobileArtifact {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface MobileBuildManifest {
  readonly schemaVersion: 1;
  readonly platform: MobilePlatform;
  readonly releaseIdentity: ReleaseIdentity;
  readonly app: MobileApp;
  readonly artifact: MobileArtifact;
  /** The Android signing certificate's SHA-256, or the Apple team that signed the iOS app. */
  readonly signer: string;
  readonly runner: Readonly<Record<string, string>>;
}

const MANIFEST_KEYS = [
  "app",
  "artifact",
  "platform",
  "releaseIdentity",
  "runner",
  "schemaVersion",
  "signer",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const sameKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

export function parseMobileBuildManifest(value: unknown): MobileBuildManifest {
  if (!isRecord(value) || !sameKeys(value, MANIFEST_KEYS) || value.schemaVersion !== 1)
    throw new Error("Mobile build manifest is invalid.");
  const { app, artifact, platform, runner, signer } = value;
  if (
    (platform !== "android" && platform !== "ios") ||
    !isRecord(app) ||
    !sameKeys(app, ["build", "id", "version"]) ||
    !isRecord(artifact) ||
    !sameKeys(artifact, ["bytes", "name", "sha256"]) ||
    typeof artifact.name !== "string" ||
    basename(artifact.name) !== artifact.name ||
    !Number.isSafeInteger(artifact.bytes) ||
    (artifact.bytes as number) <= 0 ||
    typeof artifact.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
    typeof signer !== "string" ||
    !isRecord(runner) ||
    Object.values(runner).some((entry) => typeof entry !== "string")
  )
    throw new Error("Mobile build manifest is invalid.");
  return {
    schemaVersion: 1,
    platform,
    releaseIdentity: parseReleaseIdentity(value.releaseIdentity),
    app: { id: String(app.id), version: String(app.version), build: String(app.build) },
    artifact: {
      name: artifact.name,
      bytes: artifact.bytes as number,
      sha256: artifact.sha256,
    },
    signer,
    runner: runner as Record<string, string>,
  };
}

export interface MobileBuildDirectory {
  readonly manifest: MobileBuildManifest;
  readonly manifestPath: string;
  readonly artifactPath: string;
}

/**
 * Reads one platform's build and proves it is the app this release must ship: the exact Release
 * Identity, its derived versions, the pinned signer, and the bytes the manifest names.
 */
export function readMobileBuildDirectory(
  directory: string,
  platform: MobilePlatform,
  identity: ReleaseIdentity,
): MobileBuildDirectory {
  const root = resolve(directory);
  const manifestPath = join(root, MOBILE_BUILD_MANIFEST);
  const manifest = parseMobileBuildManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (
    manifest.platform !== platform ||
    !isDeepStrictEqual(manifest.releaseIdentity, identity) ||
    !isDeepStrictEqual(manifest.app, mobileAppFor(platform, identity)) ||
    manifest.signer !== expectedMobileSigner(platform) ||
    manifest.artifact.name !== mobileArtifactName(platform, identity.version)
  )
    throw new Error(`${platform} build does not match its Release Identity, versions or signer.`);
  const artifactPath = join(root, manifest.artifact.name);
  const stats = lstatSync(artifactPath);
  if (
    !stats.isFile() ||
    stats.size !== manifest.artifact.bytes ||
    sha256File(artifactPath) !== manifest.artifact.sha256
  )
    throw new Error(`${platform} build artifact does not match its manifest.`);
  return { manifest, manifestPath, artifactPath };
}
