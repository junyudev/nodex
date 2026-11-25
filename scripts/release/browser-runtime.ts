import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { materializeBrowserRuntime } from "../materialize-browser-runtime";
import { readBrowserRuntimeReleaseLock } from "../browser-runtime-release-lock";
import {
  publishRuntimeArchive,
  runtimeDraftArguments,
  type RuntimeAssetIdentity,
  type RuntimePublication,
} from "./runtime-publication";
export {
  awaitRuntimePublicationPlan as awaitBrowserRuntimePublicationPlan,
  planRuntimePublication as planBrowserRuntimePublication,
  type RuntimePublicationPlan as BrowserRuntimePublicationPlan,
} from "./runtime-publication";

const defaultReleaseNotes = "Immutable Browser runtime closure consumed by Nodex release locks.";

function browserRuntimePublication(options: {
  readonly arm64Path: string;
  readonly notes?: string;
  readonly repo: string;
  readonly tag: string;
}): RuntimePublication {
  if (!/^browser-runtime-v\d+(?:\.\d+)+$/.test(options.tag)) {
    throw new Error("Browser runtime tag must use browser-runtime-v<version>.");
  }
  const arm64Path = resolve(options.arm64Path);
  const stats = lstatSync(arm64Path);
  if (!stats.isFile() || stats.isSymbolicLink() || !basename(arm64Path).includes("arm64")) {
    throw new Error("Browser runtime arm64 archive is invalid.");
  }
  return {
    repo: options.repo,
    tag: options.tag,
    title: `Nodex Browser runtime ${options.tag.replace("browser-runtime-v", "")}`,
    notes: options.notes ?? defaultReleaseNotes,
  };
}

export const browserRuntimeReleaseArguments = (
  options: Parameters<typeof browserRuntimePublication>[0],
): readonly string[] => runtimeDraftArguments(browserRuntimePublication(options));

export type BrowserRuntimePublishOptions = {
  readonly arm64Path: string;
  readonly windowsX64Path?: string;
  readonly lockPath: string;
  readonly repo: string;
  readonly tag: string;
};

function localBrowserRuntimeArchives(options: BrowserRuntimePublishOptions) {
  return [
    { target: "darwin-arm64", platform: "darwin", arch: "arm64", path: options.arm64Path },
    { target: "win32-x64", platform: "win32", arch: "x64", path: options.windowsX64Path },
  ] as const;
}

/** Proves the published bytes are the exact complete closure named by the release lock. */
export async function verifyBrowserRuntimePublishInput(
  options: BrowserRuntimePublishOptions,
): Promise<void> {
  const lockPath = resolve(options.lockPath);
  const lock = readBrowserRuntimeReleaseLock(lockPath);
  if (lock.repository !== options.repo || lock.tag !== options.tag) {
    throw new Error("Browser runtime publish target does not match its release lock.");
  }

  const verificationRoot = mkdtempSync(join(tmpdir(), "nodex-browser-runtime-publish-"));
  try {
    for (const archive of localBrowserRuntimeArchives(options)) {
      const asset = lock.assets[archive.target];
      if (!archive.path) {
        if (asset?.url) throw new Error(`Missing local Browser runtime asset ${asset.assetName}.`);
        continue;
      }
      if (!asset) throw new Error(`Desktop Tool runtime is unavailable for ${archive.target}`);
      const archivePath = resolve(archive.path);
      if (basename(archivePath) !== asset.assetName) {
        throw new Error("Browser runtime archive names do not match their release lock.");
      }
      await materializeBrowserRuntime({
        archivePath,
        // Inspect these archive bytes even when a shared extraction is cached.
        cachePath: join(verificationRoot, "cache"),
        lockPath,
        outputPath: join(verificationRoot, archive.target),
        targetArch: archive.arch,
        targetPlatform: archive.platform,
      });
    }
  } finally {
    rmSync(verificationRoot, { force: true, recursive: true });
  }
}

export async function publishBrowserRuntime(options: BrowserRuntimePublishOptions): Promise<void> {
  await verifyBrowserRuntimePublishInput(options);
  const lock = readBrowserRuntimeReleaseLock(resolve(options.lockPath));
  const expected = new Map<string, RuntimeAssetIdentity>();
  const pathsByName = new Map<string, string>();
  for (const archive of localBrowserRuntimeArchives(options)) {
    const asset = lock.assets[archive.target];
    if (!archive.path) continue;
    if (!asset?.url) throw new Error(`Desktop Tool asset ${archive.target} is a local candidate.`);
    expected.set(asset.assetName, { sha256: asset.archiveSha256, size: asset.archiveSize });
    pathsByName.set(asset.assetName, resolve(archive.path));
  }
  const unavailableWindowsTargets = localBrowserRuntimeArchives(options)
    .filter(({ platform, target }) => platform === "win32" && lock.assets[target] === null)
    .map(({ arch }) => arch);
  const notes = unavailableWindowsTargets.length
    ? `${defaultReleaseNotes}\n\nBrowser and Computer Use are unavailable on Windows (${unavailableWindowsTargets.join(", ")}) pending native conformance.`
    : defaultReleaseNotes;
  await publishRuntimeArchive(
    browserRuntimePublication({ ...options, notes }),
    expected,
    pathsByName,
  );
}
