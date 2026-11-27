import type { AppServerRuntimeIdentity } from "../src/shared/browser-app-server-compatibility";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  parseWindowsBrowserRuntimePackageIdentity,
  type BrowserRuntimeTargetKey,
  type WindowsBrowserRuntimePackageIdentity,
} from "../src/shared/browser-runtime-metadata";

export type { BrowserRuntimeTargetKey };
export type BrowserRuntimeTargetPlatform = "darwin" | "win32";
export type BrowserRuntimeTargetArch = "arm64" | "x64";

type BrowserRuntimeReleaseAssetCommon = {
  archiveSha256: string;
  archiveSize: number;
  assetName: string;
  manifestSha256: string;
  url: string | null;
};
type RuntimeVersions = { codexCli: string; cuaRuntime: string; node: string };

type MacBrowserRuntimeReleaseAsset = BrowserRuntimeReleaseAssetCommon & {
  runtimeVersions: RuntimeVersions & { peerAuthorization: string };
  archiveManifestSha256?: string;
  sourcePackage?: never;
};
export type WindowsBrowserRuntimeReleaseAsset = BrowserRuntimeReleaseAssetCommon & {
  appServer: AppServerRuntimeIdentity;
  runtimeVersions: RuntimeVersions;
  sourcePackage: WindowsBrowserRuntimePackageIdentity;
  archiveManifestSha256?: never;
};
export type BrowserRuntimeReleaseAsset =
  | MacBrowserRuntimeReleaseAsset
  | WindowsBrowserRuntimeReleaseAsset;

export type BrowserRuntimeReleaseIdentity = {
  browserPluginVersion: string;
  codexCompatibilityVersion: string;
  repository: string;
  source: {
    buildNumber: string;
    desktopBuild: string;
    product: "chatgpt-desktop";
  };
  tag: string;
};

export type BrowserRuntimeReleaseLock = BrowserRuntimeReleaseIdentity & {
  assets: {
    "darwin-arm64": MacBrowserRuntimeReleaseAsset;
    "win32-arm64": WindowsBrowserRuntimeReleaseAsset | null;
    "win32-x64": WindowsBrowserRuntimeReleaseAsset | null;
  };
  runtimeFamily: "browser";
  schemaVersion: 2;
  windowsRelease?: BrowserRuntimeReleaseIdentity;
};

export function browserRuntimeReleaseForTarget(
  lock: BrowserRuntimeReleaseLock,
  target: BrowserRuntimeTargetKey,
): BrowserRuntimeReleaseIdentity {
  return target === "darwin-arm64" ? lock : (lock.windowsRelease ?? lock);
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
export const BROWSER_RUNTIME_RELEASE_TARGETS = [
  "darwin-arm64",
  "win32-arm64",
  "win32-x64",
] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value === "string" && value.trim().length > 0 && !value.includes("\0")) {
    return value;
  }
  throw new Error(`Invalid Browser runtime release lock ${label}`);
}

function requireSha256(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (SHA256_PATTERN.test(parsed)) return parsed;
  throw new Error(`Invalid Browser runtime release lock ${label}`);
}

function requireAssetName(value: unknown, label: string): string {
  const parsed = requireString(value, label);
  if (parsed.includes("/") || parsed.includes("\\") || parsed === "." || parsed === "..") {
    throw new Error(`Invalid Browser runtime release lock ${label}`);
  }
  return parsed;
}

function parseRuntimeVersions(value: unknown, label: string): RuntimeVersions {
  if (!isObject(value)) {
    throw new Error(`Invalid Browser runtime release lock ${label}`);
  }
  return {
    codexCli: requireString(value.codexCli, `${label}.codexCli`),
    cuaRuntime: requireString(value.cuaRuntime, `${label}.cuaRuntime`),
    node: requireString(value.node, `${label}.node`),
  };
}

function parseAsset(value: unknown, target: "darwin-arm64"): MacBrowserRuntimeReleaseAsset;
function parseAsset(
  value: unknown,
  target: "win32-x64" | "win32-arm64",
): WindowsBrowserRuntimeReleaseAsset | null;
function parseAsset(
  value: unknown,
  target: BrowserRuntimeTargetKey,
): BrowserRuntimeReleaseAsset | null {
  if (value === null && target !== "darwin-arm64") return null;
  const label = `assets.${target}`;
  if (!isObject(value)) {
    throw new Error(`Invalid Browser runtime release lock ${label}`);
  }
  if (!Number.isSafeInteger(value.archiveSize) || (value.archiveSize as number) <= 0) {
    throw new Error(`Invalid Browser runtime release lock ${label}.archiveSize`);
  }
  const url = value.url === null ? null : requireString(value.url, `${label}.url`);
  if (url !== null && !url.startsWith("https://")) {
    throw new Error(`Invalid Browser runtime release lock ${label}.url`);
  }
  const common = {
    archiveSha256: requireSha256(value.archiveSha256, `${label}.archiveSha256`),
    archiveSize: value.archiveSize as number,
    assetName: requireAssetName(value.assetName, `${label}.assetName`),
    manifestSha256: requireSha256(value.manifestSha256, `${label}.manifestSha256`),
    url,
  };
  const runtimeVersions = parseRuntimeVersions(value.runtimeVersions, `${label}.runtimeVersions`);
  if (!isObject(value.runtimeVersions))
    throw new Error(`Invalid Browser runtime versions: ${label}`);
  if (target === "darwin-arm64") {
    if ("sourcePackage" in value) throw new Error(`Invalid macOS package metadata: ${label}`);
    return {
      ...common,
      runtimeVersions: {
        ...runtimeVersions,
        peerAuthorization: requireString(
          value.runtimeVersions.peerAuthorization,
          `${label}.runtimeVersions.peerAuthorization`,
        ),
      },
      ...(value.archiveManifestSha256 === undefined
        ? {}
        : {
            archiveManifestSha256: requireSha256(
              value.archiveManifestSha256,
              `${label}.archiveManifestSha256`,
            ),
          }),
    };
  }
  const sourcePackage = parseWindowsBrowserRuntimePackageIdentity(value.sourcePackage);
  if (
    !sourcePackage ||
    "archiveManifestSha256" in value ||
    "peerAuthorization" in value.runtimeVersions
  ) {
    throw new Error(`Invalid Windows package metadata: ${label}`);
  }
  if (!isObject(value.appServer)) throw new Error(`Missing app-server identity: ${label}`);
  const targetArch = target === "win32-arm64" ? "arm64" : "x64";
  const sourceCommit = requireString(
    value.appServer.sourceCommit,
    `${label}.appServer.sourceCommit`,
  );
  if (
    !/^[a-f0-9]{40}$/u.test(sourceCommit) ||
    value.appServer.targetPlatform !== "win32" ||
    value.appServer.targetArch !== targetArch
  ) {
    throw new Error(`Invalid app-server identity: ${label}`);
  }
  const appServer = {
    entrypointSha256: requireSha256(
      value.appServer.entrypointSha256,
      `${label}.appServer.entrypointSha256`,
    ),
    protocolSchemaFingerprint: requireSha256(
      value.appServer.protocolSchemaFingerprint,
      `${label}.appServer.protocolSchemaFingerprint`,
    ),
    runtimeVersion: requireString(
      value.appServer.runtimeVersion,
      `${label}.appServer.runtimeVersion`,
    ),
    sourceCommit,
    targetArch,
    targetPlatform: "win32",
  };
  return { ...common, runtimeVersions, sourcePackage, appServer };
}

function parseReleaseIdentity(value: unknown, label: string): BrowserRuntimeReleaseIdentity {
  if (!isObject(value) || !isObject(value.source) || value.source.product !== "chatgpt-desktop") {
    throw new Error(`Invalid Browser runtime release lock ${label}.source`);
  }
  const repository = requireString(value.repository, `${label}.repository`);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error(`Invalid Browser runtime release lock ${label}.repository`);
  }
  const tag = requireString(value.tag, `${label}.tag`);
  if (!/^[A-Za-z0-9._-]+$/u.test(tag)) {
    throw new Error(`Invalid Browser runtime release lock ${label}.tag`);
  }
  return {
    browserPluginVersion: requireString(
      value.browserPluginVersion,
      `${label}.browserPluginVersion`,
    ),
    codexCompatibilityVersion: requireString(
      value.codexCompatibilityVersion,
      `${label}.codexCompatibilityVersion`,
    ),
    repository,
    source: {
      buildNumber: requireString(value.source.buildNumber, `${label}.source.buildNumber`),
      desktopBuild: requireString(value.source.desktopBuild, `${label}.source.desktopBuild`),
      product: value.source.product,
    },
    tag,
  };
}

export function parseBrowserRuntimeReleaseLock(value: unknown): BrowserRuntimeReleaseLock {
  if (!isObject(value) || value.schemaVersion !== 2 || value.runtimeFamily !== "browser") {
    throw new Error("Invalid Browser runtime release lock header");
  }
  if (!isObject(value.assets)) {
    throw new Error("Invalid Browser runtime release lock assets");
  }
  const actualTargetKeys = Object.keys(value.assets).sort();
  if (JSON.stringify(actualTargetKeys) !== JSON.stringify(BROWSER_RUNTIME_RELEASE_TARGETS)) {
    throw new Error(
      "Browser runtime release lock must contain exactly darwin-arm64, win32-arm64 and win32-x64 entries",
    );
  }
  const lock: BrowserRuntimeReleaseLock = {
    ...parseReleaseIdentity(value, "release"),
    assets: {
      "darwin-arm64": parseAsset(value.assets["darwin-arm64"], "darwin-arm64"),
      "win32-arm64": parseAsset(value.assets["win32-arm64"], "win32-arm64"),
      "win32-x64": parseAsset(value.assets["win32-x64"], "win32-x64"),
    },
    runtimeFamily: value.runtimeFamily,
    schemaVersion: value.schemaVersion,
    ...(value.windowsRelease === undefined
      ? {}
      : { windowsRelease: parseReleaseIdentity(value.windowsRelease, "windowsRelease") }),
  };
  for (const target of BROWSER_RUNTIME_RELEASE_TARGETS) {
    const asset = lock.assets[target];
    if (!asset) continue;
    const { source, repository, tag } = browserRuntimeReleaseForTarget(lock, target);
    const expectedName = `nodex-browser-runtime-${source.desktopBuild}-${target}.tar.gz`;
    if (asset.assetName !== expectedName) {
      throw new Error(`Browser runtime release lock ${target} asset name must be ${expectedName}`);
    }
    const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${expectedName}`;
    if (asset.url !== null && asset.url !== expectedUrl) {
      throw new Error(
        `Browser runtime release lock ${target} URL does not match its repository and tag`,
      );
    }
  }
  return lock;
}

export function readBrowserRuntimeReleaseLock(lockPath: string): BrowserRuntimeReleaseLock {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    throw new Error(`Invalid Browser runtime release lock at ${lockPath}`);
  }
  return parseBrowserRuntimeReleaseLock(value);
}

export function resolveBrowserRuntimeReleaseLockPath(projectRoot: string): string {
  return path.join(projectRoot, "resources", "browser-runtime", "browser-runtime.lock.json");
}
