import { readFileSync } from "node:fs";
import path from "node:path";

import type { AppUpdateChannel, MacAppUpdaterPlatform } from "./mac-app-updater";
import { loadSparkleNativeBinding, parseSparkleNativeEvent } from "./sparkle-native-binding";

type RuntimeArchitecture = "arm64" | "x64";

const SPARKLE_ARCHIVE_SHA256 = "ce89daf967db1e1893ed3ebd67575ed82d3902563e3191ca92aaec9164fbdef9";
const SPARKLE_PUBLIC_KEY = "YNySLZ74gjVAOpEdMo9OOEPvuTEMZf8fMnI+oQD7Ifs=";
const SPARKLE_VERSION = "2.9.4";

interface SparkleRuntimeConfig {
  readonly architecture: RuntimeArchitecture;
  readonly buildChannel: "disabled" | AppUpdateChannel;
  readonly feedUrls: null | Readonly<Record<AppUpdateChannel, string>>;
  readonly publicKey: string;
  readonly sparkleVersion: string;
}

interface SparkleMacAppUpdaterOptions {
  readonly applicationBundlePath: string;
  readonly architecture: RuntimeArchitecture;
  readonly loadNativeBinding?: typeof loadSparkleNativeBinding;
  readonly resourcesPath: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const assertExactKeys = (value: Record<string, unknown>, expected: readonly string[]): void => {
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw new Error("Packaged Sparkle runtime manifest has an unsupported shape.");
  }
};

export function parseSparkleRuntimeConfig(value: unknown): SparkleRuntimeConfig {
  if (!isRecord(value)) throw new Error("Packaged Sparkle runtime manifest must be an object.");
  assertExactKeys(value, [
    "architecture",
    "artifacts",
    "buildChannel",
    "feedUrls",
    "minimumMacOS",
    "publicKey",
    "schemaVersion",
    "sparkleArchiveSha256",
    "sparkleVersion",
  ]);
  if (
    value.schemaVersion !== 3 ||
    (value.architecture !== "arm64" && value.architecture !== "x64")
  ) {
    throw new Error("Packaged Sparkle runtime manifest version or architecture is invalid.");
  }
  if (
    value.buildChannel !== "disabled" &&
    value.buildChannel !== "stable" &&
    value.buildChannel !== "nightly"
  ) {
    throw new Error("Packaged Sparkle update channel is invalid.");
  }
  const expectedFeeds = {
    stable: `https://nodex.jyu.app/updates/stable/${value.architecture}/appcast.xml`,
    nightly: `https://nodex.jyu.app/updates/nightly/${value.architecture}/appcast.xml`,
  };
  if (
    (value.buildChannel === "disabled" && value.feedUrls !== null) ||
    (value.buildChannel !== "disabled" &&
      (!isRecord(value.feedUrls) ||
        value.feedUrls.stable !== expectedFeeds.stable ||
        value.feedUrls.nightly !== expectedFeeds.nightly))
  ) {
    throw new Error("Packaged Sparkle feed does not match its architecture and channel.");
  }
  if (
    value.minimumMacOS !== "15.0" ||
    value.sparkleVersion !== SPARKLE_VERSION ||
    value.sparkleArchiveSha256 !== SPARKLE_ARCHIVE_SHA256 ||
    value.publicKey !== SPARKLE_PUBLIC_KEY ||
    !isRecord(value.artifacts)
  ) {
    throw new Error("Packaged Sparkle runtime identity is invalid.");
  }
  return {
    architecture: value.architecture,
    buildChannel: value.buildChannel,
    feedUrls: value.feedUrls as SparkleRuntimeConfig["feedUrls"],
    publicKey: value.publicKey,
    sparkleVersion: value.sparkleVersion,
  };
}

export function readSparkleRuntimeConfig(resourcesPath: string): SparkleRuntimeConfig {
  const manifestPath = path.join(resourcesPath, "native", "sparkle-runtime.json");
  return parseSparkleRuntimeConfig(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown);
}

export function createPackagedMacAppUpdaterPlatform(
  options: SparkleMacAppUpdaterOptions,
): MacAppUpdaterPlatform | null {
  const config = readSparkleRuntimeConfig(options.resourcesPath);
  if (config.architecture !== options.architecture) {
    throw new Error("Packaged Sparkle architecture does not match Electron.");
  }
  if (config.buildChannel === "disabled") return null;
  return {
    buildDefaultChannel: config.buildChannel,
    acquire: (channel, onEvent) => {
      const feedUrl = config.feedUrls?.[channel];
      if (!feedUrl) throw new Error("Update channel is unavailable in this build.");
      const binding = (options.loadNativeBinding ?? loadSparkleNativeBinding)(
        options.resourcesPath,
      );
      let accepting = true;
      try {
        const runtime = binding.initialize(
          {
            applicationBundlePath: options.applicationBundlePath,
            feedUrl,
            hostBundlePath: options.applicationBundlePath,
          },
          (value) => {
            if (accepting) onEvent(parseSparkleNativeEvent(value));
          },
        );
        if (
          runtime.architecture !== options.architecture ||
          runtime.sparkleVersion !== config.sparkleVersion
        ) {
          throw new Error("Loaded Sparkle runtime does not match its packaged manifest.");
        }
      } catch (error) {
        accepting = false;
        binding.dispose();
        throw error;
      }

      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          accepting = false;
          binding.dispose();
        },
        session: {
          check: (kind) => binding.checkForUpdates(kind),
          installDownloadedUpdate: () => binding.installDownloadedUpdate(),
          setChannel: (nextChannel) => {
            const nextFeedUrl = config.feedUrls?.[nextChannel];
            if (!nextFeedUrl) {
              throw new Error("Update channel is unavailable in this build.");
            }
            binding.setFeedUrl(nextFeedUrl);
          },
        },
      };
    },
  };
}
