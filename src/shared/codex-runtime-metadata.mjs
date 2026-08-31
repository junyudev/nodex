export const AGENT_RUNTIME_LAYOUT_VERSION = 4;
export const AGENT_RUNTIME_METADATA_FILENAME = "agent-runtime.json";

const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value, expected) =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
const nonEmpty = (value) => typeof value === "string" && value.length > 0;
const safePath = (value) =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");

const artifact = (value) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["executable", "path", "sha256", "size"]) ||
    !nonEmpty(value.path) ||
    !safePath(value.path) ||
    !nonEmpty(value.sha256) ||
    !SHA256.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    typeof value.executable !== "boolean"
  ) {
    return null;
  }
  return {
    path: value.path,
    sha256: value.sha256,
    size: value.size,
    executable: value.executable,
  };
};

const packageManifest = (value) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "entrypoint",
      "layoutVersion",
      "pathDir",
      "resourcesDir",
      "target",
      "variant",
      "version",
    ]) ||
    !Number.isSafeInteger(value.layoutVersion) ||
    value.variant !== "codex-app-server" ||
    !nonEmpty(value.version) ||
    !nonEmpty(value.target) ||
    !nonEmpty(value.entrypoint) ||
    !safePath(value.entrypoint) ||
    !nonEmpty(value.resourcesDir) ||
    !safePath(value.resourcesDir) ||
    !nonEmpty(value.pathDir) ||
    !safePath(value.pathDir)
  ) {
    return null;
  }
  return {
    entrypoint: value.entrypoint,
    layoutVersion: value.layoutVersion,
    pathDir: value.pathDir,
    resourcesDir: value.resourcesDir,
    target: value.target,
    variant: value.variant,
    version: value.version,
  };
};

const releaseAsset = (value) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "archiveSha256",
      "archiveSize",
      "assetName",
      "entrypointSha256",
      "repository",
      "tag",
    ]) ||
    !nonEmpty(value.archiveSha256) ||
    !SHA256.test(value.archiveSha256) ||
    !Number.isSafeInteger(value.archiveSize) ||
    value.archiveSize <= 0 ||
    !nonEmpty(value.assetName) ||
    value.assetName.includes("/") ||
    value.assetName.includes("\\") ||
    !nonEmpty(value.entrypointSha256) ||
    !SHA256.test(value.entrypointSha256) ||
    value.repository !== "openai/codex" ||
    !nonEmpty(value.tag)
  ) {
    return null;
  }
  return {
    archiveSha256: value.archiveSha256,
    archiveSize: value.archiveSize,
    assetName: value.assetName,
    entrypointSha256: value.entrypointSha256,
    repository: value.repository,
    tag: value.tag,
  };
};

const sourceRevision = (value) => {
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["commit", "repository", "tag"]) ||
    !nonEmpty(value.commit) ||
    !COMMIT.test(value.commit) ||
    value.repository !== "openai/codex" ||
    !nonEmpty(value.tag)
  ) {
    return null;
  }
  return { commit: value.commit, repository: value.repository, tag: value.tag };
};

/** Strictly decodes the complete immutable Codex app-server runtime metadata contract. */
export function parseBundledAgentRuntimeMetadata(value) {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "appServerRuntimeVersion",
      "artifacts",
      "entrypoint",
      "layoutVersion",
      "packageManifest",
      "protocolSchemaFingerprint",
      "releaseAsset",
      "runtimeFamily",
      "searchPaths",
      "sourceRevision",
      "targetArch",
      "targetPlatform",
      "targetTriple",
    ]) ||
    value.layoutVersion !== AGENT_RUNTIME_LAYOUT_VERSION ||
    value.runtimeFamily !== "codex-app-server" ||
    !nonEmpty(value.appServerRuntimeVersion) ||
    !nonEmpty(value.protocolSchemaFingerprint) ||
    !SHA256.test(value.protocolSchemaFingerprint) ||
    !nonEmpty(value.entrypoint) ||
    !safePath(value.entrypoint) ||
    !nonEmpty(value.targetArch) ||
    !nonEmpty(value.targetPlatform) ||
    !nonEmpty(value.targetTriple) ||
    !Array.isArray(value.artifacts) ||
    !Array.isArray(value.searchPaths)
  ) {
    return null;
  }

  const artifacts = value.artifacts.map(artifact);
  if (artifacts.some((entry) => entry === null)) return null;
  const artifactPaths = new Set(artifacts.map((entry) => entry.path));
  if (
    artifactPaths.size !== artifacts.length ||
    !artifacts.some((entry) => entry.path === value.entrypoint && entry.executable)
  ) {
    return null;
  }
  if (!value.searchPaths.every((entry) => typeof entry === "string" && safePath(entry))) {
    return null;
  }
  if (new Set(value.searchPaths).size !== value.searchPaths.length) return null;

  const parsedPackageManifest = packageManifest(value.packageManifest);
  const parsedReleaseAsset = releaseAsset(value.releaseAsset);
  const parsedSourceRevision = sourceRevision(value.sourceRevision);
  if (
    !parsedPackageManifest ||
    !parsedReleaseAsset ||
    !parsedSourceRevision ||
    parsedPackageManifest.entrypoint !== value.entrypoint ||
    parsedPackageManifest.version !== value.appServerRuntimeVersion ||
    parsedPackageManifest.target !== value.targetTriple ||
    parsedReleaseAsset.tag !== parsedSourceRevision.tag ||
    !artifactPaths.has("codex-package.json") ||
    !value.searchPaths.includes(parsedPackageManifest.pathDir)
  ) {
    return null;
  }

  return {
    appServerRuntimeVersion: value.appServerRuntimeVersion,
    artifacts,
    entrypoint: value.entrypoint,
    layoutVersion: value.layoutVersion,
    packageManifest: parsedPackageManifest,
    protocolSchemaFingerprint: value.protocolSchemaFingerprint,
    releaseAsset: parsedReleaseAsset,
    runtimeFamily: value.runtimeFamily,
    searchPaths: value.searchPaths,
    sourceRevision: parsedSourceRevision,
    targetArch: value.targetArch,
    targetPlatform: value.targetPlatform,
    targetTriple: value.targetTriple,
  };
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/** Canonical semantic bytes used by the release lock's runtimeMetadataSha256 field. */
export const canonicalBundledAgentRuntimeMetadataJson = (metadata) => canonicalJson(metadata);
