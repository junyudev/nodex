import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { inspectOfficialAgentSkillsArtifact } from "./official-agent-skills-artifact.mjs";
import {
  isTestedBrowserAppServerPair,
  projectBrowserPeerRuntimeIdentity,
  projectBundledAppServerRuntimeIdentity,
} from "../src/shared/browser-app-server-compatibility.mjs";
import {
  canonicalBundledAgentRuntimeMetadataJson,
  parseBundledAgentRuntimeMetadata,
} from "../src/shared/codex-runtime-metadata.mjs";
import {
  CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID,
  parseCodexAppServerReleaseLock,
} from "../src/shared/codex-app-server-release-lock.mjs";

const PROVENANCE_SCHEMA_VERSION = 6;
const PREPARED_SCHEMA_VERSION = 4;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canonicalAgentRuntimeLockPath = path.join(
  projectRoot,
  "resources",
  "agent-runtime",
  "codex-app-server.lock.json",
);
const packagedAgentRuntimeArtifacts = [
  ...CODEX_APP_SERVER_REQUIRED_ARTIFACTS,
  "third-party/codex/LICENSE",
  "third-party/codex/NOTICE",
];
const resolveAgentRuntimeLockPath = (options) => {
  if (!options.testOnlyAgentRuntimeLockPath) return canonicalAgentRuntimeLockPath;
  if (process.env.VITEST !== "true") {
    throw new Error("A custom Agent runtime lock is available only to the Vitest harness");
  }
  return path.resolve(options.testOnlyAgentRuntimeLockPath);
};
const resourcesRelativePath = "Contents/Resources";
const provenanceRelativePath = `${resourcesRelativePath}/nodex-build-provenance.json`;
const preparedRelativePath = `${resourcesRelativePath}/prepared-electron-build.json`;
const appAsarRelativePath = `${resourcesRelativePath}/app.asar`;
const clipboardBridgeRelativePath = `${resourcesRelativePath}/native/nodex-clipboard.node`;
const nativeManifestRelativePath = `${resourcesRelativePath}/bin/rust-core-runtime.json`;
const agentManifestRelativePath = `${resourcesRelativePath}/agent-runtime.json`;
const browserManifestRelativePath = `${resourcesRelativePath}/browser-runtime/browser-runtime-manifest.json`;
const agentSkillsRelativePath = `${resourcesRelativePath}/agent-skills`;
const sparkleManifestRelativePath = `${resourcesRelativePath}/native/sparkle-runtime.json`;
const sparkleArtifactRelativePaths = {
  autoupdate: "Frameworks/Sparkle.framework/Versions/B/Autoupdate",
  bridge: "Resources/native/nodex-sparkle.node",
  frameworkExecutable: "Frameworks/Sparkle.framework/Versions/B/Sparkle",
  frameworkInfoPlist: "Frameworks/Sparkle.framework/Versions/B/Resources/Info.plist",
  updater: "Frameworks/Sparkle.framework/Versions/B/Updater.app/Contents/MacOS/Updater",
};

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const sha256Bytes = (value) => createHash("sha256").update(value).digest("hex");

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
};

const stableJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256StableJson = (value) => sha256Bytes(stableJson(value));

const readJson = (filePath, label) => {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is invalid: ${filePath}`, { cause: error });
  }
};

const requireSha256 = (value, label) => {
  if (typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)) return value;
  throw new Error(`${label} must be a SHA-256 digest`);
};

const requirePositiveSize = (value, label) => {
  if (Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`${label} must be a positive file size`);
};

const requireString = (value, label) => {
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`${label} must be a non-empty string`);
};

const assertExactKeys = (value, expected, label) => {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(`${label} has an unsupported shape`);
  }
};

const readCanonicalAgentRuntimeLock = (lockPath, targetArch) => {
  const value = parseCodexAppServerReleaseLock(
    readJson(lockPath, "Canonical Codex app-server release lock"),
  );
  const build = value.builds[`darwin-${targetArch}`];
  return {
    build,
    lockSha256: sha256File(lockPath),
    packageManifest: value.packageManifest,
    protocolSchemaFingerprint: value.protocolSchema.sha256,
    runtimeVersion: value.appServerRuntimeVersion,
    upstream: value.upstream,
  };
};

const verifyAgentRuntimeArtifactClosure = (appPath, metadata) => {
  const paths = metadata.artifacts.map(({ path: artifactPath }) => artifactPath);
  if (
    paths.length !== packagedAgentRuntimeArtifacts.length ||
    packagedAgentRuntimeArtifacts.some((artifactPath) => !paths.includes(artifactPath))
  ) {
    throw new Error("Packaged Agent runtime artifact closure is incomplete");
  }
  const resourcesPath = path.join(appPath, resourcesRelativePath);
  for (const artifact of metadata.artifacts) {
    const artifactPath = path.join(resourcesPath, ...artifact.path.split("/"));
    const stats = lstatSync(artifactPath);
    const executable = (stats.mode & 0o111) !== 0;
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      stats.size !== artifact.size ||
      executable !== artifact.executable ||
      sha256File(artifactPath) !== artifact.sha256
    ) {
      throw new Error(`Packaged Agent runtime artifact differs from metadata: ${artifact.path}`);
    }
  }
};

const inspectLockedAgentRuntime = (appPath, rawMetadata, targetArch, lockPath) => {
  const metadata = parseBundledAgentRuntimeMetadata(rawMetadata);
  if (!metadata) throw new Error("Packaged Agent runtime manifest is invalid or incomplete");
  const locked = readCanonicalAgentRuntimeLock(lockPath, targetArch);
  const metadataSha256 = sha256Bytes(canonicalBundledAgentRuntimeMetadataJson(metadata));
  const expectedPackageManifest = {
    ...locked.packageManifest,
    target: locked.build.targetTriple,
  };
  if (
    metadataSha256 !== locked.build.runtimeMetadataSha256 ||
    metadata.appServerRuntimeVersion !== locked.runtimeVersion ||
    metadata.runtimeFamily !== "codex-app-server" ||
    metadata.targetPlatform !== "darwin" ||
    metadata.targetArch !== targetArch ||
    metadata.targetTriple !== locked.build.targetTriple ||
    metadata.entrypoint !== locked.packageManifest.entrypoint ||
    stableJson(metadata.packageManifest) !== stableJson(expectedPackageManifest) ||
    JSON.stringify(metadata.searchPaths) !== JSON.stringify([locked.packageManifest.pathDir]) ||
    metadata.protocolSchemaFingerprint !== locked.protocolSchemaFingerprint ||
    metadata.releaseAsset.archiveSha256 !== locked.build.archiveSha256 ||
    metadata.releaseAsset.archiveSize !== locked.build.archiveSize ||
    metadata.releaseAsset.assetName !== locked.build.assetName ||
    metadata.releaseAsset.entrypointSha256 !== locked.build.entrypointSha256 ||
    metadata.releaseAsset.repository !== "openai/codex" ||
    metadata.releaseAsset.tag !== locked.upstream.tag ||
    metadata.sourceRevision.repository !== "openai/codex" ||
    metadata.sourceRevision.tag !== locked.upstream.tag ||
    metadata.sourceRevision.commit !== locked.upstream.commit
  ) {
    throw new Error("Packaged Agent runtime does not match the canonical release lock");
  }
  const entrypoint = metadata.artifacts.find(
    ({ path: artifactPath }) => artifactPath === metadata.entrypoint,
  );
  if (entrypoint?.sha256 !== locked.build.entrypointSha256) {
    throw new Error("Packaged Agent runtime entrypoint does not match the canonical release lock");
  }
  verifyAgentRuntimeArtifactClosure(appPath, metadata);
  return {
    identity: {
      archiveSha256: locked.build.archiveSha256,
      archiveSize: locked.build.archiveSize,
      assetName: locked.build.assetName,
      entrypointSha256: locked.build.entrypointSha256,
      lockSha256: locked.lockSha256,
      metadataSha256,
      signingTeamId: locked.upstream.signingTeamId,
      sourceCommit: locked.upstream.commit,
      sourceTag: locked.upstream.tag,
      targetTriple: locked.build.targetTriple,
      version: locked.runtimeVersion,
    },
    metadata,
  };
};

const parseAgentRuntimeIdentity = (value) => {
  assertExactKeys(
    value,
    [
      "archiveSha256",
      "archiveSize",
      "assetName",
      "entrypointSha256",
      "lockSha256",
      "metadataSha256",
      "signingTeamId",
      "sourceCommit",
      "sourceTag",
      "targetTriple",
      "version",
    ],
    "Packaged Agent runtime identity",
  );
  requireSha256(value.archiveSha256, "Packaged Agent runtime archive");
  requirePositiveSize(value.archiveSize, "Packaged Agent runtime archive");
  requireString(value.assetName, "Packaged Agent runtime asset name");
  requireSha256(value.entrypointSha256, "Packaged Agent runtime entrypoint");
  requireSha256(value.lockSha256, "Packaged Agent runtime lock");
  requireSha256(value.metadataSha256, "Packaged Agent runtime metadata");
  if (
    value.signingTeamId !== OFFICIAL_CODEX_MACOS_SIGNING_TEAM_ID ||
    typeof value.sourceCommit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.sourceCommit)
  ) {
    throw new Error("Packaged Agent runtime upstream identity is invalid");
  }
  requireString(value.sourceTag, "Packaged Agent runtime source tag");
  requireString(value.targetTriple, "Packaged Agent runtime target triple");
  requireString(value.version, "Packaged Agent runtime version");
  return value;
};

const parsePreparedManifest = (value) => {
  if (!isObject(value) || value.schemaVersion !== PREPARED_SCHEMA_VERSION) {
    throw new Error("Packaged prepared Electron manifest is unsupported");
  }
  requireSha256(value.generationId, "Prepared Electron generationId");
  requireSha256(value.inputDigest, "Prepared Electron inputDigest");
  if (!isObject(value.product)) {
    throw new Error("Prepared Electron product metadata is invalid");
  }
  requireString(value.product.name, "Prepared Electron product name");
  requireString(value.product.version, "Prepared Electron product version");
  assertExactKeys(
    value.agentSkills,
    ["manifestSha256", "treeSha256"],
    "Prepared Electron Agent Skills",
  );
  requireSha256(value.agentSkills.manifestSha256, "Prepared Electron Agent Skills manifestSha256");
  requireSha256(value.agentSkills.treeSha256, "Prepared Electron Agent Skills treeSha256");
  const { generationId, ...withoutGeneration } = value;
  if (sha256Bytes(JSON.stringify(withoutGeneration)) !== generationId) {
    throw new Error("Packaged prepared Electron generation identity is invalid");
  }
  return value;
};

const fileIdentity = (appPath, relativePath) => {
  const filePath = path.join(appPath, ...relativePath.split("/"));
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Packaged provenance payload must be a regular file: ${relativePath}`);
  }
  return {
    path: relativePath.slice(resourcesRelativePath.length + 1),
    sha256: sha256File(filePath),
    size: metadata.size,
  };
};

const optionalFileIdentity = (appPath, relativePath) =>
  existsSync(path.join(appPath, ...relativePath.split("/")))
    ? fileIdentity(appPath, relativePath)
    : null;

const isBrowserRuntimeCompatible = (
  browserManifest,
  browserManifestSha256,
  agentManifest,
  testedPairs,
) => {
  if (browserManifest === null) return false;
  try {
    return isTestedBrowserAppServerPair(
      projectBundledAppServerRuntimeIdentity(agentManifest),
      projectBrowserPeerRuntimeIdentity(browserManifest, browserManifestSha256),
      testedPairs,
    );
  } catch {
    return false;
  }
};

const contentsFileIdentity = (appPath, relativePath) => {
  const filePath = path.join(appPath, "Contents", ...relativePath.split("/"));
  const metadata = lstatSync(filePath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Packaged provenance payload must be a regular file: ${relativePath}`);
  }
  return {
    path: relativePath,
    sha256: sha256File(filePath),
    size: metadata.size,
  };
};

const parseFileIdentity = (value, expectedPath, label) => {
  assertExactKeys(value, ["path", "sha256", "size"], label);
  if (value.path !== expectedPath) throw new Error(`${label} path is invalid`);
  return {
    path: expectedPath,
    sha256: requireSha256(value.sha256, `${label} sha256`),
    size: requirePositiveSize(value.size, `${label} size`),
  };
};

const verifyFileIdentity = (appPath, actual, relativePath, label) => {
  const expected = fileIdentity(appPath, relativePath);
  if (
    actual.path !== expected.path ||
    actual.sha256 !== expected.sha256 ||
    actual.size !== expected.size
  ) {
    throw new Error(`${label} does not match the packaged provenance`);
  }
};

const verifyContentsFileIdentity = (appPath, actual, relativePath, label) => {
  const expected = contentsFileIdentity(appPath, relativePath);
  if (
    actual.path !== expected.path ||
    actual.sha256 !== expected.sha256 ||
    actual.size !== expected.size
  ) {
    throw new Error(`${label} does not match the packaged provenance`);
  }
};

const parseSparkleRuntimeManifest = (value) => {
  if (!isObject(value) || value.schemaVersion !== 3 || !isObject(value.artifacts)) {
    throw new Error("Packaged Sparkle runtime manifest is unsupported");
  }
  if (value.architecture !== "arm64" && value.architecture !== "x64") {
    throw new Error("Packaged Sparkle runtime architecture is invalid");
  }
  if (
    value.buildChannel !== "disabled" &&
    value.buildChannel !== "stable" &&
    value.buildChannel !== "nightly"
  ) {
    throw new Error("Packaged Sparkle runtime channel is invalid");
  }
  if (
    (value.buildChannel === "disabled" && value.feedUrls !== null) ||
    (value.buildChannel !== "disabled" &&
      (!isObject(value.feedUrls) ||
        value.feedUrls.stable !==
          `https://nodex.jyu.app/updates/stable/${value.architecture}/appcast.xml` ||
        value.feedUrls.nightly !==
          `https://nodex.jyu.app/updates/nightly/${value.architecture}/appcast.xml`))
  ) {
    throw new Error("Packaged Sparkle runtime feed is invalid");
  }
  if (
    typeof value.publicKey !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(value.publicKey) ||
    Buffer.from(value.publicKey, "base64").length !== 32 ||
    value.minimumMacOS !== "15.0" ||
    typeof value.sparkleVersion !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.sparkleArchiveSha256)
  ) {
    throw new Error("Packaged Sparkle runtime identity is invalid");
  }
  for (const [name, relativePath] of Object.entries(sparkleArtifactRelativePaths)) {
    parseFileIdentity(value.artifacts[name], relativePath, `Packaged Sparkle ${name}`);
  }
  return value;
};

export const writePackagedBuildProvenance = (appPath, options = {}) => {
  const resolvedAppPath = path.resolve(appPath);
  const preparedPath = path.join(resolvedAppPath, ...preparedRelativePath.split("/"));
  const prepared = parsePreparedManifest(
    readJson(preparedPath, "Packaged prepared Electron manifest"),
  );
  const nativeManifest = readJson(
    path.join(resolvedAppPath, ...nativeManifestRelativePath.split("/")),
    "Packaged native runtime manifest",
  );
  const rawAgentManifest = readJson(
    path.join(resolvedAppPath, ...agentManifestRelativePath.split("/")),
    "Packaged Agent runtime manifest",
  );
  const browserManifestPath = path.join(resolvedAppPath, ...browserManifestRelativePath.split("/"));
  const browserManifest = existsSync(browserManifestPath)
    ? readJson(browserManifestPath, "Packaged Browser runtime manifest")
    : null;
  if (browserManifest === null) {
    throw new Error("Packaged Browser runtime manifest is required");
  }
  const sparkleManifestPath = path.join(resolvedAppPath, ...sparkleManifestRelativePath.split("/"));
  const sparkleManifest = parseSparkleRuntimeManifest(
    readJson(sparkleManifestPath, "Packaged Sparkle runtime manifest"),
  );
  const sparkleArtifacts = Object.fromEntries(
    Object.entries(sparkleArtifactRelativePaths).map(([name, relativePath]) => [
      name,
      contentsFileIdentity(resolvedAppPath, relativePath),
    ]),
  );
  const agentSkills = inspectOfficialAgentSkillsArtifact(
    path.join(resolvedAppPath, ...agentSkillsRelativePath.split("/")),
  );
  for (const name of Object.keys(sparkleArtifactRelativePaths)) {
    if (
      sparkleManifest.artifacts[name].path !== sparkleArtifacts[name].path ||
      sparkleManifest.artifacts[name].sha256 !== sparkleArtifacts[name].sha256 ||
      sparkleManifest.artifacts[name].size !== sparkleArtifacts[name].size
    ) {
      throw new Error(`Packaged Sparkle ${name} manifest identity does not match its artifact`);
    }
  }
  if (
    agentSkills.manifestSha256 !== prepared.agentSkills.manifestSha256 ||
    agentSkills.treeSha256 !== prepared.agentSkills.treeSha256 ||
    agentSkills.releaseVersion !==
      (prepared.releaseIdentity?.sourceVersion ?? prepared.product.version)
  ) {
    throw new Error("Packaged Agent Skills do not match the prepared Electron source");
  }
  const targetArch = nativeManifest.targetArch;
  if (targetArch !== "arm64" && targetArch !== "x64") {
    throw new Error("Packaged native runtime target architecture is invalid");
  }
  const agentRuntime = inspectLockedAgentRuntime(
    resolvedAppPath,
    rawAgentManifest,
    targetArch,
    resolveAgentRuntimeLockPath(options),
  );
  const agentManifest = agentRuntime.metadata;
  if (
    nativeManifest.targetPlatform !== "darwin" ||
    (targetArch !== "arm64" && targetArch !== "x64") ||
    nativeManifest.productVersion !== prepared.product.version ||
    agentManifest.targetPlatform !== "darwin" ||
    agentManifest.targetArch !== targetArch ||
    sparkleManifest.architecture !== targetArch ||
    (browserManifest !== null &&
      (browserManifest.targetPlatform !== "darwin" ||
        browserManifest.targetArch !== targetArch ||
        !isBrowserRuntimeCompatible(
          browserManifest,
          sha256File(browserManifestPath),
          agentManifest,
          options.testedPairs,
        )))
  ) {
    throw new Error("Packaged runtime targets do not agree");
  }

  const body = {
    schemaVersion: PROVENANCE_SCHEMA_VERSION,
    product: {
      name: prepared.product.name,
      version: prepared.product.version,
    },
    target: {
      platform: "darwin",
      arch: targetArch,
    },
    preparedElectron: {
      generationId: prepared.generationId,
      manifestSha256: sha256File(preparedPath),
    },
    agentSkills: {
      manifestSha256: agentSkills.manifestSha256,
      treeSha256: agentSkills.treeSha256,
    },
    agentRuntime: agentRuntime.identity,
    payload: {
      appAsar: fileIdentity(resolvedAppPath, appAsarRelativePath),
      clipboardBridge: fileIdentity(resolvedAppPath, clipboardBridgeRelativePath),
      nativeRuntimeManifest: fileIdentity(resolvedAppPath, nativeManifestRelativePath),
      agentRuntimeManifest: fileIdentity(resolvedAppPath, agentManifestRelativePath),
      browserRuntimeManifest: optionalFileIdentity(resolvedAppPath, browserManifestRelativePath),
      sparkle: {
        artifacts: sparkleArtifacts,
        buildChannel: sparkleManifest.buildChannel,
        feedUrls: sparkleManifest.feedUrls,
        publicKey: sparkleManifest.publicKey,
        runtimeManifest: fileIdentity(resolvedAppPath, sparkleManifestRelativePath),
        sparkleVersion: sparkleManifest.sparkleVersion,
      },
    },
  };
  const manifest = {
    ...body,
    provenanceId: sha256StableJson(body),
  };
  const provenancePath = path.join(resolvedAppPath, ...provenanceRelativePath.split("/"));
  const temporaryPath = `${provenancePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o644,
    });
    renameSync(temporaryPath, provenancePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return manifest;
};

export const verifyPackagedBuildProvenance = (appPath, options = {}) => {
  const resolvedAppPath = path.resolve(appPath);
  const provenancePath = path.join(resolvedAppPath, ...provenanceRelativePath.split("/"));
  const value = readJson(provenancePath, "Packaged build provenance");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "product",
      "target",
      "preparedElectron",
      "agentSkills",
      "agentRuntime",
      "payload",
      "provenanceId",
    ],
    "Packaged build provenance",
  );
  if (value.schemaVersion !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error("Packaged build provenance schema is unsupported");
  }
  const { provenanceId, ...body } = value;
  if (requireSha256(provenanceId, "Packaged provenanceId") !== sha256StableJson(body)) {
    throw new Error("Packaged build provenance identity is invalid");
  }
  assertExactKeys(value.product, ["name", "version"], "Packaged product");
  requireString(value.product.name, "Packaged product name");
  requireString(value.product.version, "Packaged product version");
  assertExactKeys(value.target, ["platform", "arch"], "Packaged target");
  if (
    value.target.platform !== "darwin" ||
    (value.target.arch !== "arm64" && value.target.arch !== "x64")
  ) {
    throw new Error("Packaged build target is invalid");
  }
  if (options.expectedArch && value.target.arch !== options.expectedArch) {
    throw new Error(
      `Packaged build provenance is ${value.target.arch}, expected ${options.expectedArch}`,
    );
  }
  assertExactKeys(
    value.preparedElectron,
    ["generationId", "manifestSha256"],
    "Packaged prepared Electron identity",
  );
  requireSha256(value.preparedElectron.generationId, "Packaged prepared Electron generationId");
  assertExactKeys(
    value.agentSkills,
    ["manifestSha256", "treeSha256"],
    "Packaged Agent Skills identity",
  );
  requireSha256(value.agentSkills.manifestSha256, "Packaged Agent Skills manifestSha256");
  requireSha256(value.agentSkills.treeSha256, "Packaged Agent Skills treeSha256");
  requireSha256(value.preparedElectron.manifestSha256, "Packaged prepared Electron manifestSha256");
  const agentRuntimeIdentity = parseAgentRuntimeIdentity(value.agentRuntime);
  assertExactKeys(
    value.payload,
    [
      "appAsar",
      "clipboardBridge",
      "nativeRuntimeManifest",
      "agentRuntimeManifest",
      "browserRuntimeManifest",
      "sparkle",
    ],
    "Packaged payload",
  );
  const appAsar = parseFileIdentity(value.payload.appAsar, "app.asar", "Packaged app.asar");
  const clipboardBridge = parseFileIdentity(
    value.payload.clipboardBridge,
    "native/nodex-clipboard.node",
    "Packaged clipboard bridge",
  );
  const nativeRuntimeManifest = parseFileIdentity(
    value.payload.nativeRuntimeManifest,
    "bin/rust-core-runtime.json",
    "Packaged native runtime manifest",
  );
  const agentRuntimeManifest = parseFileIdentity(
    value.payload.agentRuntimeManifest,
    "agent-runtime.json",
    "Packaged Agent runtime manifest",
  );
  const browserRuntimeManifest =
    value.payload.browserRuntimeManifest === null
      ? null
      : parseFileIdentity(
          value.payload.browserRuntimeManifest,
          "browser-runtime/browser-runtime-manifest.json",
          "Packaged Browser runtime manifest",
        );
  if (browserRuntimeManifest === null) {
    throw new Error("Packaged Browser runtime manifest is required by provenance");
  }
  assertExactKeys(
    value.payload.sparkle,
    ["artifacts", "buildChannel", "feedUrls", "publicKey", "runtimeManifest", "sparkleVersion"],
    "Packaged Sparkle identity",
  );
  const sparkleRuntimeManifest = parseFileIdentity(
    value.payload.sparkle.runtimeManifest,
    "native/sparkle-runtime.json",
    "Packaged Sparkle runtime manifest",
  );
  assertExactKeys(
    value.payload.sparkle.artifacts,
    Object.keys(sparkleArtifactRelativePaths),
    "Packaged Sparkle artifacts",
  );
  const sparkleArtifacts = Object.fromEntries(
    Object.entries(sparkleArtifactRelativePaths).map(([name, relativePath]) => [
      name,
      parseFileIdentity(
        value.payload.sparkle.artifacts[name],
        relativePath,
        `Packaged Sparkle ${name}`,
      ),
    ]),
  );

  const preparedPath = path.join(resolvedAppPath, ...preparedRelativePath.split("/"));
  const prepared = parsePreparedManifest(
    readJson(preparedPath, "Packaged prepared Electron manifest"),
  );
  const agentSkills = inspectOfficialAgentSkillsArtifact(
    path.join(resolvedAppPath, ...agentSkillsRelativePath.split("/")),
  );
  if (
    sha256File(preparedPath) !== value.preparedElectron.manifestSha256 ||
    prepared.generationId !== value.preparedElectron.generationId ||
    prepared.product.name !== value.product.name ||
    prepared.product.version !== value.product.version ||
    prepared.agentSkills.manifestSha256 !== value.agentSkills.manifestSha256 ||
    prepared.agentSkills.treeSha256 !== value.agentSkills.treeSha256 ||
    agentSkills.manifestSha256 !== value.agentSkills.manifestSha256 ||
    agentSkills.treeSha256 !== value.agentSkills.treeSha256 ||
    agentSkills.releaseVersion !==
      (prepared.releaseIdentity?.sourceVersion ?? value.product.version)
  ) {
    throw new Error("Packaged prepared Electron manifest does not match provenance");
  }
  if (options.expectedPreparedManifestPath) {
    const expectedPreparedPath = path.resolve(options.expectedPreparedManifestPath);
    const expectedPrepared = parsePreparedManifest(
      readJson(expectedPreparedPath, "Current prepared Electron manifest"),
    );
    if (
      sha256File(expectedPreparedPath) !== value.preparedElectron.manifestSha256 ||
      expectedPrepared.generationId !== value.preparedElectron.generationId
    ) {
      throw new Error("Packaged build is stale for the current prepared Electron source");
    }
  }

  verifyFileIdentity(resolvedAppPath, appAsar, appAsarRelativePath, "Packaged app.asar");
  verifyFileIdentity(
    resolvedAppPath,
    clipboardBridge,
    clipboardBridgeRelativePath,
    "Packaged clipboard bridge",
  );
  verifyFileIdentity(
    resolvedAppPath,
    nativeRuntimeManifest,
    nativeManifestRelativePath,
    "Packaged native runtime manifest",
  );
  verifyFileIdentity(
    resolvedAppPath,
    agentRuntimeManifest,
    agentManifestRelativePath,
    "Packaged Agent runtime manifest",
  );
  if (browserRuntimeManifest) {
    verifyFileIdentity(
      resolvedAppPath,
      browserRuntimeManifest,
      browserManifestRelativePath,
      "Packaged Browser runtime manifest",
    );
  } else if (existsSync(path.join(resolvedAppPath, ...browserManifestRelativePath.split("/")))) {
    throw new Error("Packaged Browser runtime manifest is not bound by provenance");
  }
  verifyFileIdentity(
    resolvedAppPath,
    sparkleRuntimeManifest,
    sparkleManifestRelativePath,
    "Packaged Sparkle runtime manifest",
  );
  for (const [name, relativePath] of Object.entries(sparkleArtifactRelativePaths)) {
    verifyContentsFileIdentity(
      resolvedAppPath,
      sparkleArtifacts[name],
      relativePath,
      `Packaged Sparkle ${name}`,
    );
  }
  const nativeManifest = readJson(
    path.join(resolvedAppPath, ...nativeManifestRelativePath.split("/")),
    "Packaged native runtime manifest",
  );
  const rawAgentManifest = readJson(
    path.join(resolvedAppPath, ...agentManifestRelativePath.split("/")),
    "Packaged Agent runtime manifest",
  );
  const lockedAgentRuntime = inspectLockedAgentRuntime(
    resolvedAppPath,
    rawAgentManifest,
    value.target.arch,
    resolveAgentRuntimeLockPath(options),
  );
  if (JSON.stringify(lockedAgentRuntime.identity) !== JSON.stringify(agentRuntimeIdentity)) {
    throw new Error("Packaged Agent runtime identity does not match provenance");
  }
  const agentManifest = lockedAgentRuntime.metadata;
  const browserManifest = browserRuntimeManifest
    ? readJson(
        path.join(resolvedAppPath, ...browserManifestRelativePath.split("/")),
        "Packaged Browser runtime manifest",
      )
    : null;
  const sparkleManifest = parseSparkleRuntimeManifest(
    readJson(
      path.join(resolvedAppPath, ...sparkleManifestRelativePath.split("/")),
      "Packaged Sparkle runtime manifest",
    ),
  );
  for (const name of Object.keys(sparkleArtifactRelativePaths)) {
    if (
      sparkleManifest.artifacts[name].path !== sparkleArtifacts[name].path ||
      sparkleManifest.artifacts[name].sha256 !== sparkleArtifacts[name].sha256 ||
      sparkleManifest.artifacts[name].size !== sparkleArtifacts[name].size
    ) {
      throw new Error(`Packaged Sparkle ${name} manifest identity does not match provenance`);
    }
  }
  if (
    nativeManifest.targetPlatform !== value.target.platform ||
    nativeManifest.targetArch !== value.target.arch ||
    nativeManifest.productVersion !== value.product.version ||
    agentManifest.targetPlatform !== value.target.platform ||
    agentManifest.targetArch !== value.target.arch ||
    sparkleManifest.architecture !== value.target.arch ||
    sparkleManifest.buildChannel !== value.payload.sparkle.buildChannel ||
    JSON.stringify(sparkleManifest.feedUrls) !== JSON.stringify(value.payload.sparkle.feedUrls) ||
    sparkleManifest.publicKey !== value.payload.sparkle.publicKey ||
    sparkleManifest.sparkleVersion !== value.payload.sparkle.sparkleVersion ||
    (browserManifest !== null &&
      (browserManifest.targetPlatform !== value.target.platform ||
        browserManifest.targetArch !== value.target.arch ||
        !isBrowserRuntimeCompatible(
          browserManifest,
          sha256File(path.join(resolvedAppPath, ...browserManifestRelativePath.split("/"))),
          agentManifest,
          options.testedPairs,
        )))
  ) {
    throw new Error("Packaged runtime target does not match provenance");
  }
  return value;
};
