import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  type BrowserRuntimeManifest,
} from "../src/shared/browser-runtime-metadata";
import {
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
  type BrowserRuntimeReleaseAsset,
  type BrowserRuntimeReleaseLock,
  type BrowserRuntimeTargetArch,
  type BrowserRuntimeTargetKey,
  type BrowserRuntimeTargetPlatform,
} from "./browser-runtime-release-lock";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";
import {
  assertBrowserRuntimeSourceClosure,
  readBrowserRuntimeFileSha256,
  readBrowserRuntimeSourceManifest,
} from "./stage-browser-runtime";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

export type MaterializeBrowserRuntimeOptions = {
  archivePath?: string;
  cachePath?: string;
  lockPath?: string;
  outputPath: string;
  projectRootPath?: string;
  targetArch: BrowserRuntimeTargetArch;
  targetPlatform: BrowserRuntimeTargetPlatform;
};

function targetKeyFor(
  targetPlatform: BrowserRuntimeTargetPlatform,
  targetArch: BrowserRuntimeTargetArch,
): BrowserRuntimeTargetKey {
  return `${targetPlatform}-${targetArch}`;
}

function assertNoLinksOrSpecialFiles(rootPath: string, currentPath = rootPath): void {
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    const stats = lstatSync(entryPath);
    const relativePath = path.relative(rootPath, entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Browser runtime archive contains a symlink: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      assertNoLinksOrSpecialFiles(rootPath, entryPath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Browser runtime archive contains an unsupported entry: ${relativePath}`);
    }
  }
}

function assertManifestMatchesLock(input: {
  asset: BrowserRuntimeReleaseAsset;
  lock: BrowserRuntimeReleaseLock;
  manifest: BrowserRuntimeManifest;
  manifestPath: string;
  targetArch: BrowserRuntimeTargetArch;
  targetPlatform: BrowserRuntimeTargetPlatform;
}): void {
  const { asset, lock, manifest, manifestPath, targetArch, targetPlatform } = input;
  const manifestSha256 = readBrowserRuntimeFileSha256(manifestPath);
  if (manifestSha256 !== asset.manifestSha256) {
    throw new Error(
      `Browser runtime manifest checksum mismatch: expected ${asset.manifestSha256}, ` +
        `found ${manifestSha256}`,
    );
  }
  if (
    manifest.browserPlugin.version !== lock.browserPluginVersion ||
    manifest.codexCompatibilityVersion !== lock.codexCompatibilityVersion ||
    manifest.desktopBuild !== lock.source.desktopBuild ||
    manifest.desktopBuildNumber !== lock.source.buildNumber ||
    manifest.targetArch !== targetArch ||
    manifest.targetPlatform !== targetPlatform ||
    JSON.stringify(manifest.runtimeVersions) !== JSON.stringify(asset.runtimeVersions)
  ) {
    throw new Error("Browser runtime manifest does not match the release lock");
  }
}

function readVerifiedSource(input: {
  asset: BrowserRuntimeReleaseAsset;
  lock: BrowserRuntimeReleaseLock;
  sourceRoot: string;
  targetArch: BrowserRuntimeTargetArch;
  targetPlatform: BrowserRuntimeTargetPlatform;
}): BrowserRuntimeManifest {
  const sourceRoot = path.resolve(input.sourceRoot);
  const stats = lstatSync(sourceRoot);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Browser runtime source must be a real directory: ${sourceRoot}`);
  }
  assertNoLinksOrSpecialFiles(sourceRoot);
  const manifest = readBrowserRuntimeSourceManifest(sourceRoot);
  assertManifestMatchesLock({
    ...input,
    manifest,
    manifestPath: path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
  });
  assertBrowserRuntimeSourceClosure(sourceRoot, manifest);
  return manifest;
}

function readReusableSource(input: {
  asset: BrowserRuntimeReleaseAsset;
  lock: BrowserRuntimeReleaseLock;
  outputPath: string;
  targetArch: BrowserRuntimeTargetArch;
  targetPlatform: BrowserRuntimeTargetPlatform;
}): BrowserRuntimeManifest | null {
  try {
    return readVerifiedSource({
      ...input,
      sourceRoot: input.outputPath,
    });
  } catch {
    return null;
  }
}

function assertArchivePathsAreSafe(archivePath: string): void {
  const entries = execFileSync("tar", ["-tzf", archivePath], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C" },
  })
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    throw new Error("Browser runtime archive is empty");
  }
  for (const entry of entries) {
    const withoutPrefix = entry.replace(/^(?:\.\/)+/u, "");
    const normalized = withoutPrefix.endsWith("/") ? withoutPrefix.slice(0, -1) : withoutPrefix;
    if (normalized.length === 0) continue;
    if (normalized.startsWith("/") || normalized.includes("\\")) {
      throw new Error(`Browser runtime archive contains an unsafe path: ${entry}`);
    }
    const segments = normalized.split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error(`Browser runtime archive contains an unsafe path: ${entry}`);
    }
  }

  const verboseEntries = execFileSync("tar", ["-tvzf", archivePath], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C" },
  })
    .split("\n")
    .filter((entry) => entry.length > 0);
  for (const entry of verboseEntries) {
    const entryKind = entry[0];
    if (entryKind !== "-" && entryKind !== "d") {
      throw new Error("Browser runtime archive may contain only regular files and directories");
    }
  }
}

function assertArchiveMatches(archivePath: string, asset: BrowserRuntimeReleaseAsset): void {
  const stats = lstatSync(archivePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Browser runtime archive must be a regular file: ${archivePath}`);
  }
  if (stats.size !== asset.archiveSize) {
    throw new Error(
      `Browser runtime archive size mismatch: expected ${asset.archiveSize}, ` +
        `found ${stats.size}`,
    );
  }
  const sha256 = readBrowserRuntimeFileSha256(archivePath);
  if (sha256 !== asset.archiveSha256) {
    throw new Error(
      `Browser runtime archive checksum mismatch: expected ${asset.archiveSha256}, ` +
        `found ${sha256}`,
    );
  }
  assertArchivePathsAreSafe(archivePath);
}

export async function materializeBrowserRuntime(
  options: MaterializeBrowserRuntimeOptions,
): Promise<BrowserRuntimeManifest> {
  const projectRoot = path.resolve(options.projectRootPath ?? repositoryRoot);
  const lockPath = path.resolve(
    options.lockPath ?? resolveBrowserRuntimeReleaseLockPath(projectRoot),
  );
  const lock = readBrowserRuntimeReleaseLock(lockPath);
  const targetKey = targetKeyFor(options.targetPlatform, options.targetArch);
  const asset = lock.assets[targetKey];
  const outputPath = path.resolve(options.outputPath);
  const reusable = readReusableSource({
    asset,
    lock,
    outputPath,
    targetArch: options.targetArch,
    targetPlatform: options.targetPlatform,
  });
  if (reusable) {
    process.stderr.write("Reused verified Browser runtime source.\n");
    return reusable;
  }

  const archivePath = path.resolve(
    options.archivePath ??
      resolveImmutableArtifactPath({
        archiveSha256: asset.archiveSha256,
        assetName: asset.assetName,
        cachePath: options.cachePath,
        family: "browser-runtime",
        projectRoot,
      }),
  );
  await ensureImmutableArtifact({
    destinationPath: archivePath,
    expectedSize: asset.archiveSize,
    label: "Browser runtime",
    replaceInvalid: options.archivePath === undefined,
    url: asset.url,
    validate: (candidatePath) => assertArchiveMatches(candidatePath, asset),
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  const extractionParent = mkdtempSync(
    path.join(path.dirname(outputPath), ".browser-runtime-materialize-"),
  );
  const extractedRoot = path.join(extractionParent, "source");
  mkdirSync(extractedRoot);
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", extractedRoot]);
    const manifest = readVerifiedSource({
      asset,
      lock,
      sourceRoot: extractedRoot,
      targetArch: options.targetArch,
      targetPlatform: options.targetPlatform,
    });
    replaceOwnedDirectory(extractedRoot, outputPath);
    return manifest;
  } finally {
    rmSync(extractionParent, { force: true, recursive: true });
  }
}

function parseCliOptions(argv: string[]): MaterializeBrowserRuntimeOptions {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Browser runtime materialization arguments must be --key value pairs");
    }
    values.set(key, value);
  }

  const outputPath = values.get("--out");
  const targetArch = values.get("--target-arch");
  const targetPlatform = values.get("--target-platform");
  if (!outputPath || targetArch !== "arm64" || targetPlatform !== "darwin") {
    throw new Error(
      "Usage: materialize-browser-runtime.ts --target-platform darwin " +
        "--target-arch <arm64> --out <directory> [--lock <lock.json>] " +
        "[--cache <directory>] [--archive <tar.gz>]",
    );
  }
  return {
    archivePath: values.get("--archive"),
    cachePath: values.get("--cache"),
    lockPath: values.get("--lock"),
    outputPath,
    targetArch,
    targetPlatform,
  };
}

async function main(): Promise<void> {
  const manifest = await materializeBrowserRuntime(parseCliOptions(process.argv.slice(2)));
  process.stdout.write(
    `${JSON.stringify({
      artifacts: manifest.artifacts.length,
      desktopBuild: manifest.desktopBuild,
      pluginVersion: manifest.browserPlugin.version,
      targetArch: manifest.targetArch,
    })}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
