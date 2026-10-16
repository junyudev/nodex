import { readFileSync } from "node:fs";
import path from "node:path";

export type BrowserRuntimeTargetPlatform = "darwin";
export type BrowserRuntimeTargetArch = "arm64";
export type BrowserRuntimeTargetKey = `${BrowserRuntimeTargetPlatform}-${BrowserRuntimeTargetArch}`;

export type BrowserRuntimeReleaseAsset = {
  archiveSha256: string;
  archiveSize: number;
  assetName: string;
  manifestSha256: string;
  runtimeVersions: {
    codexCli: string;
    cuaRuntime: string;
    node: string;
    peerAuthorization: string;
  };
  url: string;
};

export type BrowserRuntimeReleaseLock = {
  assets: Record<BrowserRuntimeTargetKey, BrowserRuntimeReleaseAsset>;
  browserPluginVersion: string;
  codexCompatibilityVersion: string;
  repository: string;
  runtimeFamily: "browser";
  schemaVersion: 1;
  source: {
    buildNumber: string;
    desktopBuild: string;
    product: "chatgpt-desktop";
  };
  tag: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const EXPECTED_TARGET_KEYS = ["darwin-arm64"] as const;

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

function parseRuntimeVersions(
  value: unknown,
  label: string,
): BrowserRuntimeReleaseAsset["runtimeVersions"] {
  if (!isObject(value)) {
    throw new Error(`Invalid Browser runtime release lock ${label}`);
  }
  return {
    codexCli: requireString(value.codexCli, `${label}.codexCli`),
    cuaRuntime: requireString(value.cuaRuntime, `${label}.cuaRuntime`),
    node: requireString(value.node, `${label}.node`),
    peerAuthorization: requireString(value.peerAuthorization, `${label}.peerAuthorization`),
  };
}

function parseAsset(value: unknown, label: string): BrowserRuntimeReleaseAsset {
  if (!isObject(value)) {
    throw new Error(`Invalid Browser runtime release lock ${label}`);
  }
  if (!Number.isSafeInteger(value.archiveSize) || (value.archiveSize as number) <= 0) {
    throw new Error(`Invalid Browser runtime release lock ${label}.archiveSize`);
  }
  const url = requireString(value.url, `${label}.url`);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== "https:") {
    throw new Error(`Invalid Browser runtime release lock ${label}.url`);
  }
  return {
    archiveSha256: requireSha256(value.archiveSha256, `${label}.archiveSha256`),
    archiveSize: value.archiveSize as number,
    assetName: requireAssetName(value.assetName, `${label}.assetName`),
    manifestSha256: requireSha256(value.manifestSha256, `${label}.manifestSha256`),
    runtimeVersions: parseRuntimeVersions(value.runtimeVersions, `${label}.runtimeVersions`),
    url,
  };
}

export function parseBrowserRuntimeReleaseLock(value: unknown): BrowserRuntimeReleaseLock {
  if (!isObject(value) || value.schemaVersion !== 1 || value.runtimeFamily !== "browser") {
    throw new Error("Invalid Browser runtime release lock header");
  }
  if (!isObject(value.source) || value.source.product !== "chatgpt-desktop") {
    throw new Error("Invalid Browser runtime release lock source");
  }
  if (!isObject(value.assets)) {
    throw new Error("Invalid Browser runtime release lock assets");
  }
  const actualTargetKeys = Object.keys(value.assets).sort();
  if (JSON.stringify(actualTargetKeys) !== JSON.stringify(EXPECTED_TARGET_KEYS)) {
    throw new Error("Browser runtime release lock must contain exactly darwin-arm64 asset");
  }

  const repository = requireString(value.repository, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("Invalid Browser runtime release lock repository");
  }
  const tag = requireString(value.tag, "tag");
  if (!/^[A-Za-z0-9._-]+$/u.test(tag)) {
    throw new Error("Invalid Browser runtime release lock tag");
  }
  const assets = {
    "darwin-arm64": parseAsset(value.assets["darwin-arm64"], "assets.darwin-arm64"),
  };
  for (const targetKey of EXPECTED_TARGET_KEYS) {
    const asset = assets[targetKey];
    const expectedUrl = `https://github.com/${repository}/releases/download/${tag}/${asset.assetName}`;
    if (asset.url !== expectedUrl) {
      throw new Error(
        `Browser runtime release lock ${targetKey} URL does not match its repository and tag`,
      );
    }
  }

  return {
    assets,
    browserPluginVersion: requireString(value.browserPluginVersion, "browserPluginVersion"),
    codexCompatibilityVersion: requireString(
      value.codexCompatibilityVersion,
      "codexCompatibilityVersion",
    ),
    repository,
    runtimeFamily: value.runtimeFamily,
    schemaVersion: value.schemaVersion,
    source: {
      buildNumber: requireString(value.source.buildNumber, "source.buildNumber"),
      desktopBuild: requireString(value.source.desktopBuild, "source.desktopBuild"),
      product: value.source.product,
    },
    tag,
  };
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
