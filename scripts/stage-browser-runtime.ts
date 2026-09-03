import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROWSER_PLUGIN_NODE_MODULE_DIR,
  BROWSER_RUNTIME_BUNDLE_DIRECTORY,
  BROWSER_RUNTIME_MANIFEST_FILENAME,
  parseBrowserRuntimeManifest,
  type BrowserRuntimeManifest,
} from "../src/shared/browser-runtime-metadata";
import type {
  AppServerRuntimeIdentity,
  TestedBrowserAppServerPair,
} from "../src/shared/browser-app-server-compatibility";
import { resolveBrowserRuntimeBundle } from "../src/main/codex/browser-runtime-bundle";
import type { BrowserRuntimePlatformArtifactVerifier } from "../src/main/codex/browser-runtime-bundle";
import { replaceOwnedDirectory } from "./replace-owned-directory";

const EXECUTABLE_RUNTIME_MODE = 0o755;
const REGULAR_RUNTIME_MODE = 0o644;
const LEGACY_BROWSER_PLUGIN_NODE_MODULE_DIR = "marketplace/plugins/browser/scripts/node_modules";

type StageBrowserRuntimeOptions = {
  appServerIdentity: AppServerRuntimeIdentity;
  platformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  runtimeRoot: string;
  sourceRoot: string;
  targetArch: "arm64" | "x64";
  targetPlatform: "darwin" | "linux" | "win32";
  testedPairs?: readonly TestedBrowserAppServerPair[];
};

export function readBrowserRuntimeFileSha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function listFiles(rootPath: string, currentPath = rootPath): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    const stats = fs.lstatSync(entryPath);
    const relativePath = path.relative(rootPath, entryPath).split(path.sep).join("/");
    if (stats.isSymbolicLink()) {
      throw new Error(`Browser runtime source contains a symlink: ${relativePath}`);
    }
    if (stats.isDirectory()) {
      files.push(...listFiles(rootPath, entryPath));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Browser runtime source contains an unsupported entry: ${relativePath}`);
    }
    files.push(relativePath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

export function readBrowserRuntimeSourceManifest(sourceRoot: string): BrowserRuntimeManifest {
  const manifestPath = path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Browser runtime source manifest is unreadable: ${manifestPath}`);
  }
  const manifest = parseBrowserRuntimeManifest(rawManifest);
  if (!manifest) {
    throw new Error(`Browser runtime source manifest is invalid: ${manifestPath}`);
  }
  return manifest;
}

export function assertBrowserRuntimeSourceClosure(
  sourceRoot: string,
  manifest: BrowserRuntimeManifest,
): void {
  const expectedFiles = [
    BROWSER_RUNTIME_MANIFEST_FILENAME,
    ...manifest.artifacts.map((artifact) => artifact.path),
  ].sort((left, right) => left.localeCompare(right));
  const actualFiles = listFiles(sourceRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("Browser runtime source must contain exactly the manifest-declared artifacts");
  }

  for (const artifact of manifest.artifacts) {
    const artifactPath = path.join(sourceRoot, ...artifact.path.split("/"));
    const stats = fs.lstatSync(artifactPath);
    if (
      stats.size !== artifact.size ||
      readBrowserRuntimeFileSha256(artifactPath) !== artifact.sha256
    ) {
      throw new Error(
        `Browser runtime source artifact does not match its manifest: ${artifact.path}`,
      );
    }
    if (artifact.executable && (stats.mode & 0o111) === 0) {
      throw new Error(`Browser runtime source artifact is not executable: ${artifact.path}`);
    }
  }
}

function normalizeBrowserRuntimeManifest(
  sourceRoot: string,
  manifest: BrowserRuntimeManifest,
): BrowserRuntimeManifest {
  if (!manifest.browserPlugin.nodeModuleDirs.includes(LEGACY_BROWSER_PLUGIN_NODE_MODULE_DIR)) {
    return manifest;
  }

  const canonicalDirectory = path.join(sourceRoot, ...BROWSER_PLUGIN_NODE_MODULE_DIR.split("/"));
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(canonicalDirectory);
  } catch {
    throw new Error(`Legacy Browser runtime manifest requires ${BROWSER_PLUGIN_NODE_MODULE_DIR}`);
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(
      `Legacy Browser runtime module directory is unavailable: ${BROWSER_PLUGIN_NODE_MODULE_DIR}`,
    );
  }

  const nodeModuleDirs = [
    ...new Set(
      manifest.browserPlugin.nodeModuleDirs.map((directory) =>
        directory === LEGACY_BROWSER_PLUGIN_NODE_MODULE_DIR
          ? BROWSER_PLUGIN_NODE_MODULE_DIR
          : directory,
      ),
    ),
  ];
  return {
    ...manifest,
    browserPlugin: {
      ...manifest.browserPlugin,
      nodeModuleDirs,
    },
  };
}

function serializedActiveManifest(sourceRoot: string, manifest: BrowserRuntimeManifest): Buffer {
  const sourcePath = path.join(sourceRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
  const sourceBytes = fs.readFileSync(sourcePath);
  try {
    const sourceValue = JSON.parse(sourceBytes.toString("utf8")) as {
      browserPlugin?: { nodeModuleDirs?: unknown };
      schemaVersion?: unknown;
    };
    const nodeModuleDirs = sourceValue.browserPlugin?.nodeModuleDirs;
    if (
      sourceValue.schemaVersion === 5 &&
      Array.isArray(nodeModuleDirs) &&
      !nodeModuleDirs.includes(LEGACY_BROWSER_PLUGIN_NODE_MODULE_DIR)
    ) {
      // Published v5 archives retain their signed exact-pair identity while the
      // compatibility decoder projects the in-memory schema-v6 contract.
      return sourceBytes;
    }
  } catch {
    // readBrowserRuntimeSourceManifest already owns the validation error.
  }
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function stageBrowserRuntime(options: StageBrowserRuntimeOptions): BrowserRuntimeManifest {
  const sourceRoot = path.resolve(options.sourceRoot);
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const sourceStats = fs.lstatSync(sourceRoot);
  if (!sourceStats.isDirectory() || sourceStats.isSymbolicLink()) {
    throw new Error(`Browser runtime source must be a real directory: ${sourceRoot}`);
  }

  const sourceManifest = readBrowserRuntimeSourceManifest(sourceRoot);
  if (
    sourceManifest.targetArch !== options.targetArch ||
    sourceManifest.targetPlatform !== options.targetPlatform
  ) {
    throw new Error("Browser runtime source manifest does not match the active Agent runtime");
  }
  assertBrowserRuntimeSourceClosure(sourceRoot, sourceManifest);
  const manifest = normalizeBrowserRuntimeManifest(sourceRoot, sourceManifest);
  const activeManifestBytes = serializedActiveManifest(sourceRoot, manifest);

  fs.mkdirSync(runtimeRoot, { recursive: true });
  const runtimeRootStats = fs.lstatSync(runtimeRoot);
  if (!runtimeRootStats.isDirectory() || runtimeRootStats.isSymbolicLink()) {
    throw new Error(`Agent runtime root must be a real directory: ${runtimeRoot}`);
  }
  const activeRoot = path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  try {
    const activeManifest = fs.readFileSync(
      path.join(activeRoot, BROWSER_RUNTIME_MANIFEST_FILENAME),
    );
    if (activeManifestBytes.equals(activeManifest)) {
      assertBrowserRuntimeSourceClosure(activeRoot, manifest);
      const verification = resolveBrowserRuntimeBundle({
        appServerIdentity: options.appServerIdentity,
        platformArtifactVerifier: options.platformArtifactVerifier,
        runtimeRoot,
        targetArch: options.targetArch,
        targetPlatform: options.targetPlatform,
        testedPairs: options.testedPairs,
      });
      if (verification.status === "available") return manifest;
    }
  } catch {
    // A missing or damaged active closure is replaced below.
  }

  const temporaryParent = fs.mkdtempSync(path.join(runtimeRoot, ".browser-runtime-stage-"));
  const stagedRoot = path.join(temporaryParent, BROWSER_RUNTIME_BUNDLE_DIRECTORY);
  fs.mkdirSync(stagedRoot);
  try {
    for (const artifact of manifest.artifacts) {
      const sourcePath = path.join(sourceRoot, ...artifact.path.split("/"));
      const destinationPath = path.join(stagedRoot, ...artifact.path.split("/"));
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      fs.copyFileSync(sourcePath, destinationPath);
      fs.chmodSync(
        destinationPath,
        artifact.executable ? EXECUTABLE_RUNTIME_MODE : REGULAR_RUNTIME_MODE,
      );
    }
    const nodeModuleDirs = new Set([
      ...manifest.browserPlugin.nodeModuleDirs,
      ...(manifest.capabilities.computerUse.status === "available"
        ? manifest.capabilities.computerUse.plugin.nodeModuleDirs
        : []),
    ]);
    for (const nodeModuleDir of nodeModuleDirs) {
      fs.mkdirSync(path.join(stagedRoot, ...nodeModuleDir.split("/")), { recursive: true });
    }
    const manifestPath = path.join(stagedRoot, BROWSER_RUNTIME_MANIFEST_FILENAME);
    fs.writeFileSync(manifestPath, activeManifestBytes, { mode: REGULAR_RUNTIME_MODE });
    fs.chmodSync(manifestPath, REGULAR_RUNTIME_MODE);

    const verification = resolveBrowserRuntimeBundle({
      appServerIdentity: options.appServerIdentity,
      platformArtifactVerifier: options.platformArtifactVerifier,
      runtimeRoot: temporaryParent,
      targetArch: options.targetArch,
      targetPlatform: options.targetPlatform,
      testedPairs: options.testedPairs,
    });
    if (verification.status === "unavailable") {
      throw new Error(`Staged Browser runtime failed verification: ${verification.message}`);
    }

    replaceOwnedDirectory(stagedRoot, path.join(runtimeRoot, BROWSER_RUNTIME_BUNDLE_DIRECTORY));
    return manifest;
  } finally {
    fs.rmSync(temporaryParent, { force: true, recursive: true });
  }
}

function parseCliOptions(argv: string[]): StageBrowserRuntimeOptions {
  const args = argv.filter((value) => value !== "--");
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Browser runtime staging arguments must be --key value pairs");
    }
    values.set(key, value);
  }

  const sourceRoot = values.get("--source");
  const runtimeRoot = values.get("--runtime-root");
  const appServerEntrypointSha256 = values.get("--app-server-entrypoint-sha256");
  const appServerProtocolSchemaFingerprint = values.get("--app-server-protocol-schema-fingerprint");
  const appServerRuntimeVersion = values.get("--app-server-runtime-version");
  const appServerSourceCommit = values.get("--app-server-source-commit");
  const targetArch = values.get("--target-arch");
  const targetPlatform = values.get("--target-platform");
  if (
    !sourceRoot ||
    !runtimeRoot ||
    !appServerEntrypointSha256 ||
    !appServerProtocolSchemaFingerprint ||
    !appServerRuntimeVersion ||
    !appServerSourceCommit ||
    (targetArch !== "arm64" && targetArch !== "x64") ||
    (targetPlatform !== "darwin" && targetPlatform !== "linux" && targetPlatform !== "win32")
  ) {
    throw new Error(
      "Usage: stage-browser-runtime.ts --source <dir> --runtime-root <dir> " +
        "--app-server-runtime-version <version> --app-server-source-commit <commit> " +
        "--app-server-protocol-schema-fingerprint <sha256> " +
        "--app-server-entrypoint-sha256 <sha256> --target-platform <platform> " +
        "--target-arch <arm64|x64>",
    );
  }
  return {
    appServerIdentity: {
      entrypointSha256: appServerEntrypointSha256,
      protocolSchemaFingerprint: appServerProtocolSchemaFingerprint,
      runtimeVersion: appServerRuntimeVersion,
      sourceCommit: appServerSourceCommit,
      targetArch,
      targetPlatform,
    },
    runtimeRoot,
    sourceRoot,
    targetArch,
    targetPlatform,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = stageBrowserRuntime(parseCliOptions(process.argv.slice(2)));
    process.stdout.write(
      `${JSON.stringify({
        artifacts: manifest.artifacts.length,
        desktopBuild: manifest.desktopBuild,
        pluginVersion: manifest.browserPlugin.version,
        targetArch: manifest.targetArch,
        targetPlatform: manifest.targetPlatform,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
