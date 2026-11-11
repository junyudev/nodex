// Keep exported API changes paired with the adjacent .d.mts contract.
import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { stageWindowsVcRuntime } from "./windows-vc-runtime.mjs";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

import { assertDesktopRuntimePayload } from "./desktop-runtime-payload.mjs";
import { assertPackagedAppArchive } from "./packaged-app-archive.mjs";
import { BROWSER_RUNTIME_SCHEMA_VERSION } from "../src/shared/browser-runtime-schema.mjs";

const manifestFilename = "browser-runtime-manifest.json";
const stagedBrowserRuntimePath = [
  ".generated",
  "codex-runtime",
  "agent-runtime",
  "browser-runtime",
];
const packagedBrowserRuntimePath = ["Contents", "Resources", "browser-runtime"];
const electronBuilderSkippedBasenames = new Set([".gitkeep"]);

const sha256File = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");

const requireSafeArtifactPath = (value, manifestPath) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\")
  ) {
    throw new Error(`Invalid Browser runtime artifact path in ${manifestPath}`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Invalid Browser runtime artifact path in ${manifestPath}`);
  }
  return segments;
};

const requireRealDirectoryChain = (rootPath, segments) => {
  let currentPath = rootPath;
  const rootMetadata = lstatSync(currentPath);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Packaged Browser runtime root is not a real directory: ${rootPath}`);
  }
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const metadata = lstatSync(currentPath);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Packaged Browser runtime path is not a real directory: ${currentPath}`);
    }
  }
};

const requireExactArtifact = (artifactPath, entry, label, windows = false) => {
  const metadata = lstatSync(artifactPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (!windows && (metadata.mode & 0o111) !== 0) ||
    metadata.size !== entry.size ||
    sha256File(artifactPath) !== entry.sha256
  ) {
    throw new Error(`${label} Browser runtime artifact does not match its manifest: ${entry.path}`);
  }
};

export const restorePackagedBrowserRuntimeClosure = ({
  packagedBrowserRoot,
  sourceBrowserRoot,
  windowsArch,
  expectedManifestSha256,
  restore = true,
}) => {
  if (
    windowsArch &&
    !expectedManifestSha256 &&
    !existsSync(sourceBrowserRoot) &&
    !existsSync(packagedBrowserRoot)
  )
    return 0;
  requireRealDirectoryChain(sourceBrowserRoot, []);
  requireRealDirectoryChain(packagedBrowserRoot, []);
  const sourceManifestPath = path.join(sourceBrowserRoot, manifestFilename);
  const packagedManifestPath = path.join(packagedBrowserRoot, manifestFilename);
  if (
    windowsArch &&
    ![sourceManifestPath, packagedManifestPath].every((file) => lstatSync(file).isFile())
  ) {
    throw new Error("Windows Desktop Tool manifest must be a regular file");
  }
  if (expectedManifestSha256 && sha256File(packagedManifestPath) !== expectedManifestSha256)
    throw new Error("Packaged Desktop Tool manifest does not match the release lock");
  const sourceManifestBytes = readFileSync(sourceManifestPath);
  const packagedManifestBytes = readFileSync(packagedManifestPath);
  if (!sourceManifestBytes.equals(packagedManifestBytes)) {
    throw new Error("Packaged Browser runtime manifest differs from the verified staged source");
  }

  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== BROWSER_RUNTIME_SCHEMA_VERSION ||
    !Array.isArray(manifest.artifacts) ||
    (windowsArch && (manifest.targetPlatform !== "win32" || manifest.targetArch !== windowsArch))
  ) {
    throw new Error(`Unsupported Browser runtime manifest: ${sourceManifestPath}`);
  }

  const remaining = new Set([
    manifestFilename,
    ...manifest.artifacts.map((artifact) => artifact.path),
  ]);
  const directories = new Set();
  if (windowsArch) {
    for (const file of remaining) {
      let directory = path.posix.dirname(file);
      while (directory !== ".") {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
  }
  let restored = 0;
  for (const entry of manifest.artifacts) {
    const segments = requireSafeArtifactPath(entry.path, sourceManifestPath);
    const placeholder = electronBuilderSkippedBasenames.has(segments.at(-1));
    if (!windowsArch && !placeholder) continue;
    if (windowsArch && segments.some((segment) => /[<>:"|?*\x00-\x1f]/u.test(segment))) {
      throw new Error(`Invalid Windows Desktop Tool artifact path: ${entry.path}`);
    }
    if (
      (placeholder && (entry.kind !== "data" || entry.executable !== false)) ||
      typeof entry.size !== "number" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error(`Invalid restorable Browser runtime artifact: ${entry.path}`);
    }

    const sourcePath = path.join(sourceBrowserRoot, ...segments);
    const packagedPath = path.join(packagedBrowserRoot, ...segments);
    if (placeholder) requireExactArtifact(sourcePath, entry, "Staged", Boolean(windowsArch));
    requireRealDirectoryChain(packagedBrowserRoot, segments.slice(0, -1));

    try {
      requireExactArtifact(packagedPath, entry, "Packaged", Boolean(windowsArch));
      continue;
    } catch (error) {
      if (
        !restore ||
        !placeholder ||
        !error ||
        typeof error !== "object" ||
        error.code !== "ENOENT"
      )
        throw error;
    }

    copyFileSync(sourcePath, packagedPath, constants.COPYFILE_EXCL);
    requireExactArtifact(packagedPath, entry, "Restored", Boolean(windowsArch));
    restored += 1;
  }
  function checkFiles(directory, prefix) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory() && directories.has(relative)) {
        checkFiles(path.join(directory, entry.name), relative);
        continue;
      }
      if (!entry.isFile() || !remaining.delete(relative)) {
        throw new Error(`Unexpected packaged Windows Desktop Tool entry: ${relative}`);
      }
    }
  }
  if (windowsArch) {
    checkFiles(packagedBrowserRoot, "");
    if (remaining.size > 0) throw new Error("Packaged Windows Desktop Tool closure is incomplete");
  }
  return restored;
};

export default async function restorePackagedRuntimeClosure(context) {
  if (!["darwin", "win32"].includes(context.electronPlatformName)) return;
  const projectRoot = context.packager.projectDir;
  const appPath =
    context.electronPlatformName === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      : context.appOutDir;
  const resourcesPath =
    context.electronPlatformName === "darwin"
      ? path.join(appPath, "Contents/Resources")
      : path.join(appPath, "resources");
  assertPackagedAppArchive(path.join(resourcesPath, "app.asar"));
  if (
    !readFileSync(path.join(resourcesPath, "prepared-electron-build.json")).equals(
      readFileSync(path.join(projectRoot, ".generated/prepared-electron-build.json")),
    )
  )
    throw new Error("Packaged prepared manifest differs from the verified build");
  // electron-builder Arch: x64=1, arm64=3. Reject every other desktop target.
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : null;
  if (!arch) throw new Error(`Unsupported desktop package architecture: ${context.arch}`);
  assertDesktopRuntimePayload({
    sourceRoot: projectRoot,
    resourcesPath,
    platform: context.electronPlatformName,
    arch,
  });
  if (context.electronPlatformName === "win32") {
    const desktopToolsRoot = path.join(resourcesPath, "browser-runtime");
    restorePackagedBrowserRuntimeClosure({
      sourceBrowserRoot: path.join(projectRoot, ...stagedBrowserRuntimePath),
      packagedBrowserRoot: desktopToolsRoot,
      windowsArch: arch,
    });
    stageWindowsVcRuntime(appPath, arch, { desktopToolsRoot });
    const files = verifyWindowsArchitectureClosure(appPath, arch, {
      nodeHost: path.join(appPath, "Nodex.exe"),
      desktopToolsRoot,
    });
    console.log(`Verified ${files.length} Windows ${arch} native images.`);
    return;
  }
  const restored = restorePackagedBrowserRuntimeClosure({
    sourceBrowserRoot: path.join(projectRoot, ...stagedBrowserRuntimePath),
    packagedBrowserRoot: path.join(appPath, ...packagedBrowserRuntimePath),
  });
  if (restored > 0) {
    console.log(`Restored ${restored} manifest-declared Browser runtime placeholder artifacts.`);
  }
}
