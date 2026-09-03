import { createHash } from "node:crypto";
import { constants, copyFileSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const manifestFilename = "browser-runtime-manifest.json";
const stagedBrowserRuntimePath = [
  ".generated",
  "codex-runtime",
  "agent-runtime",
  "browser-runtime",
];
const packagedBrowserRuntimePath = ["Contents", "Resources", "browser-runtime"];
const electronBuilderSkippedBasenames = new Set([".gitkeep"]);
// The restore tests construct their fixture from the canonical TypeScript manifest version, so a
// future schema bump cannot silently restore artifacts under stale packaging semantics.
const browserRuntimeSchemaVersion = 6;

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

const requireExactArtifact = (artifactPath, entry, label) => {
  const metadata = lstatSync(artifactPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o111) !== 0 ||
    metadata.size !== entry.size ||
    sha256File(artifactPath) !== entry.sha256
  ) {
    throw new Error(`${label} Browser runtime artifact does not match its manifest: ${entry.path}`);
  }
};

export const restorePackagedBrowserRuntimeClosure = ({
  packagedBrowserRoot,
  sourceBrowserRoot,
}) => {
  const sourceManifestPath = path.join(sourceBrowserRoot, manifestFilename);
  const packagedManifestPath = path.join(packagedBrowserRoot, manifestFilename);
  const sourceManifestBytes = readFileSync(sourceManifestPath);
  const packagedManifestBytes = readFileSync(packagedManifestPath);
  if (!sourceManifestBytes.equals(packagedManifestBytes)) {
    throw new Error("Packaged Browser runtime manifest differs from the verified staged source");
  }

  const manifest = JSON.parse(sourceManifestBytes.toString("utf8"));
  if (
    manifest.schemaVersion !== browserRuntimeSchemaVersion ||
    !Array.isArray(manifest.artifacts)
  ) {
    throw new Error(`Unsupported Browser runtime manifest: ${sourceManifestPath}`);
  }

  let restored = 0;
  for (const entry of manifest.artifacts) {
    const segments = requireSafeArtifactPath(entry.path, sourceManifestPath);
    if (!electronBuilderSkippedBasenames.has(segments.at(-1))) continue;
    if (
      entry.kind !== "data" ||
      entry.executable !== false ||
      typeof entry.size !== "number" ||
      typeof entry.sha256 !== "string"
    ) {
      throw new Error(`Invalid restorable Browser runtime artifact: ${entry.path}`);
    }

    const sourcePath = path.join(sourceBrowserRoot, ...segments);
    const packagedPath = path.join(packagedBrowserRoot, ...segments);
    requireExactArtifact(sourcePath, entry, "Staged");
    requireRealDirectoryChain(packagedBrowserRoot, segments.slice(0, -1));

    try {
      requireExactArtifact(packagedPath, entry, "Packaged");
      continue;
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "ENOENT") throw error;
    }

    copyFileSync(sourcePath, packagedPath, constants.COPYFILE_EXCL);
    requireExactArtifact(packagedPath, entry, "Restored");
    restored += 1;
  }
  return restored;
};

export default async function restorePackagedRuntimeClosure(context) {
  if (context.electronPlatformName !== "darwin") return;
  const projectRoot = context.packager.projectDir;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const restored = restorePackagedBrowserRuntimeClosure({
    sourceBrowserRoot: path.join(projectRoot, ...stagedBrowserRuntimePath),
    packagedBrowserRoot: path.join(appPath, ...packagedBrowserRuntimePath),
  });
  if (restored > 0) {
    console.log(`Restored ${restored} manifest-declared Browser runtime placeholder artifacts.`);
  }
}
