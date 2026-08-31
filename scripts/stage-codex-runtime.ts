import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_RUNTIME_LAYOUT_VERSION,
  AGENT_RUNTIME_METADATA_FILENAME,
  canonicalBundledAgentRuntimeMetadataJson,
  type AgentRuntimeArtifact,
  type BundledAgentRuntimeMetadata,
  type CodexAppServerPackageManifest,
  parseBundledAgentRuntimeMetadata,
} from "../src/shared/codex-runtime-metadata";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
  type AgentRuntimeBuild,
  type AgentRuntimeTargetArch,
  type AgentRuntimeTargetPlatform,
  type CodexAppServerReleaseLock,
} from "./agent-runtime-release-lock";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";
import { stageBrowserRuntime } from "./stage-browser-runtime";
import type { BrowserRuntimePlatformArtifactVerifier } from "../src/main/codex/browser-runtime-bundle";
import { projectBundledAppServerRuntimeIdentity } from "../src/shared/browser-app-server-compatibility";
import {
  AGENT_RUNTIME_PRODUCT_MINIMUM_MACOS,
  type AgentRuntimeMacosPlatformContractVerifier,
  verifyAgentRuntimeMacosPlatformContract,
} from "./agent-runtime-macos-platform-contract";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const EXECUTABLE_RUNTIME_MODE = 0o755;
const REGULAR_RUNTIME_MODE = 0o644;
const SYSTEM_TAR_PATH = "/usr/bin/tar";
const canonicalRuntimeMode = (executable: boolean): number =>
  executable ? EXECUTABLE_RUNTIME_MODE : REGULAR_RUNTIME_MODE;

export type StageAgentRuntimeOptions = {
  agentRuntimePlatformContractVerifier?: AgentRuntimeMacosPlatformContractVerifier;
  archivePath?: string;
  browserRuntimePlatformArtifactVerifier?: BrowserRuntimePlatformArtifactVerifier;
  browserRuntimeSourceRoot?: string;
  cachePath?: string;
  checksumManifestPath?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lockPath?: string;
  outputPath: string;
  projectRootPath?: string;
  reuseExisting?: boolean;
  sourceRoot?: string;
  targetArch: AgentRuntimeTargetArch;
  targetPlatform: AgentRuntimeTargetPlatform;
};

type CliOptions = StageAgentRuntimeOptions;

export type AgentRuntimeTarget = {
  targetArch: AgentRuntimeTargetArch;
  targetKey: `darwin-${AgentRuntimeTargetArch}`;
  targetPlatform: AgentRuntimeTargetPlatform;
  targetTriple: string;
};

export function resolveCodexRuntimeTarget(
  targetPlatform: AgentRuntimeTargetPlatform,
  targetArch: AgentRuntimeTargetArch,
): AgentRuntimeTarget {
  if (targetPlatform !== "darwin") {
    throw new Error(`Unsupported agent runtime target: ${targetPlatform}/${targetArch}`);
  }
  return {
    targetPlatform,
    targetArch,
    targetKey: `darwin-${targetArch}`,
    targetTriple: targetArch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin",
  };
}

function readSha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fileDescriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(fileDescriptor);
  }
}

function assertRegularFile(filePath: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(filePath);
  } catch {
    throw new Error(`Codex app-server release is missing ${label}: ${filePath}`);
  }
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Codex app-server release ${label} is not a regular file: ${filePath}`);
  }
}

function listClosedRegularFilePaths(rootPath: string, currentPath = rootPath): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = join(currentPath, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Codex app-server release contains a symlink: ${relative(rootPath, entryPath)}`,
      );
    }
    if (stats.isDirectory()) {
      paths.push(...listClosedRegularFilePaths(rootPath, entryPath));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(
        `Codex app-server release contains an unsupported entry: ${relative(rootPath, entryPath)}`,
      );
    }
    paths.push(relative(rootPath, entryPath).split(sep).join("/"));
  }
  return paths;
}

function assertExactPackageFileClosure(
  rootPath: string,
  requiredArtifacts: readonly string[],
): void {
  const actual = listClosedRegularFilePaths(rootPath).sort((left, right) =>
    left.localeCompare(right),
  );
  const expected = [...requiredArtifacts].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(actual) === JSON.stringify(expected)) return;
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((artifactPath) => !actualSet.has(artifactPath));
  const unexpected = actual.filter((artifactPath) => !expectedSet.has(artifactPath));
  throw new Error(
    `Codex app-server package file closure differs from the release lock ` +
      `(missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"})`,
  );
}

function copyRuntimeFile(sourcePath: string, destinationPath: string): void {
  assertRegularFile(sourcePath, relative(dirname(sourcePath), sourcePath));
  const sourceMode = statSync(sourcePath).mode;
  mkdirSync(dirname(destinationPath), { recursive: true });
  copyFileSync(sourcePath, destinationPath);
  chmodSync(destinationPath, canonicalRuntimeMode((sourceMode & 0o111) !== 0));
}

function listRuntimeArtifacts(
  runtimeRoot: string,
  currentPath = runtimeRoot,
): AgentRuntimeArtifact[] {
  const artifacts: AgentRuntimeArtifact[] = [];
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const artifactPath = join(currentPath, entry.name);
    if (entry.isDirectory()) {
      artifacts.push(...listRuntimeArtifacts(runtimeRoot, artifactPath));
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Unsupported staged agent runtime artifact: ${artifactPath}`);
    }
    const stats = statSync(artifactPath);
    artifacts.push({
      path: relative(runtimeRoot, artifactPath).split(sep).join("/"),
      sha256: readSha256(artifactPath),
      size: stats.size,
      executable: (stats.mode & 0o111) !== 0,
    });
  }
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export const bundledAgentRuntimeMetadataSha256 = (metadata: BundledAgentRuntimeMetadata): string =>
  createHash("sha256").update(canonicalBundledAgentRuntimeMetadataJson(metadata)).digest("hex");

const metadataMatchesLock = (input: {
  lock: CodexAppServerReleaseLock;
  metadata: BundledAgentRuntimeMetadata;
  target: AgentRuntimeTarget;
}): boolean => {
  const { lock, metadata, target } = input;
  const build = lock.builds[target.targetKey];
  return (
    bundledAgentRuntimeMetadataSha256(metadata) === build.runtimeMetadataSha256 &&
    metadata.appServerRuntimeVersion === lock.appServerRuntimeVersion &&
    metadata.protocolSchemaFingerprint === lock.protocolSchema.sha256 &&
    metadata.entrypoint === lock.packageManifest.entrypoint &&
    metadata.packageManifest.layoutVersion === lock.packageManifest.layoutVersion &&
    metadata.packageManifest.pathDir === lock.packageManifest.pathDir &&
    metadata.packageManifest.resourcesDir === lock.packageManifest.resourcesDir &&
    metadata.packageManifest.target === target.targetTriple &&
    metadata.packageManifest.variant === lock.packageManifest.variant &&
    metadata.packageManifest.version === lock.packageManifest.version &&
    metadata.runtimeFamily === lock.runtimeFamily &&
    JSON.stringify(metadata.searchPaths) === JSON.stringify([lock.packageManifest.pathDir]) &&
    metadata.releaseAsset.archiveSha256 === build.archiveSha256 &&
    metadata.releaseAsset.archiveSize === build.archiveSize &&
    metadata.releaseAsset.assetName === build.assetName &&
    metadata.releaseAsset.entrypointSha256 === build.entrypointSha256 &&
    metadata.releaseAsset.repository === lock.upstream.repository &&
    metadata.releaseAsset.tag === lock.upstream.tag &&
    metadata.sourceRevision.commit === lock.upstream.commit &&
    metadata.sourceRevision.repository === lock.upstream.repository &&
    metadata.sourceRevision.tag === lock.upstream.tag &&
    metadata.targetArch === target.targetArch &&
    metadata.targetPlatform === target.targetPlatform &&
    metadata.targetTriple === target.targetTriple
  );
};

function readReusableRuntime(input: {
  lock: CodexAppServerReleaseLock;
  outputPath: string;
  repositoryRoot: string;
  target: AgentRuntimeTarget;
}): BundledAgentRuntimeMetadata | null {
  const runtimeRoot = join(input.outputPath, "agent-runtime");
  const metadataPath = join(runtimeRoot, AGENT_RUNTIME_METADATA_FILENAME);
  let metadata: BundledAgentRuntimeMetadata | null;
  try {
    const runtimeRootStats = lstatSync(runtimeRoot);
    if (!runtimeRootStats.isDirectory() || runtimeRootStats.isSymbolicLink()) return null;
    const stats = lstatSync(metadataPath);
    if (!stats.isFile() || stats.isSymbolicLink()) return null;
    if ((stats.mode & 0o777) !== REGULAR_RUNTIME_MODE) return null;
    metadata = parseBundledAgentRuntimeMetadata(
      JSON.parse(readFileSync(metadataPath, "utf8")) as unknown,
    );
  } catch {
    return null;
  }
  if (!metadata || !metadataMatchesLock({ lock: input.lock, metadata, target: input.target })) {
    return null;
  }

  const expectedPaths = [
    ...input.lock.requiredArtifacts,
    "third-party/codex/LICENSE",
    "third-party/codex/NOTICE",
  ].sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(metadata.artifacts.map(({ path }) => path)) !== JSON.stringify(expectedPaths)
  ) {
    return null;
  }

  let actualArtifacts: AgentRuntimeArtifact[];
  try {
    actualArtifacts = listRuntimeArtifacts(runtimeRoot).filter(
      ({ path }) =>
        path !== AGENT_RUNTIME_METADATA_FILENAME && !path.startsWith("browser-runtime/"),
    );
  } catch {
    return null;
  }
  if (JSON.stringify(actualArtifacts) !== JSON.stringify(metadata.artifacts)) return null;
  for (const artifact of metadata.artifacts) {
    const mode = lstatSync(join(runtimeRoot, ...artifact.path.split("/"))).mode & 0o777;
    if (mode !== (artifact.executable ? 0o755 : 0o644)) return null;
  }

  const licensePath = join(input.repositoryRoot, ...input.lock.notices.licensePath.split("/"));
  const noticePath = join(input.repositoryRoot, ...input.lock.notices.noticePath.split("/"));
  try {
    if (
      readSha256(licensePath) !== input.lock.notices.licenseSha256 ||
      readSha256(noticePath) !== input.lock.notices.noticeSha256
    )
      return null;
  } catch {
    return null;
  }
  return metadata;
}

function readAndValidatePackageManifest(
  sourceRoot: string,
  lock: CodexAppServerReleaseLock,
  targetTriple: string,
): CodexAppServerPackageManifest {
  const manifestPath = join(sourceRoot, "codex-package.json");
  assertRegularFile(manifestPath, "codex-package.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    throw new Error(`Invalid Codex app-server package manifest at ${manifestPath}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Codex app-server package manifest at ${manifestPath}`);
  }
  const candidate = value as Record<string, unknown>;
  const expected = lock.packageManifest;
  if (
    candidate.layoutVersion !== expected.layoutVersion ||
    candidate.version !== expected.version ||
    candidate.variant !== expected.variant ||
    candidate.entrypoint !== expected.entrypoint ||
    candidate.resourcesDir !== expected.resourcesDir ||
    candidate.pathDir !== expected.pathDir ||
    candidate.target !== targetTriple
  ) {
    throw new Error(
      `Codex app-server package manifest does not match the release lock for ${targetTriple}`,
    );
  }
  return {
    layoutVersion: expected.layoutVersion,
    version: expected.version,
    target: targetTriple,
    variant: expected.variant,
    entrypoint: expected.entrypoint,
    resourcesDir: expected.resourcesDir,
    pathDir: expected.pathDir,
  };
}

function validateArtifactIdentity(input: {
  expectedSha256: string;
  expectedSize: number;
  filePath: string;
  label: string;
}): void {
  assertRegularFile(input.filePath, input.label);
  const stats = statSync(input.filePath);
  if (stats.size !== input.expectedSize) {
    throw new Error(
      `${input.label} size mismatch: expected ${input.expectedSize}, found ${stats.size}`,
    );
  }
  const actualSha256 = readSha256(input.filePath);
  if (actualSha256 !== input.expectedSha256) {
    throw new Error(
      `${input.label} checksum mismatch: expected ${input.expectedSha256}, found ${actualSha256}`,
    );
  }
}

function validateChecksumManifest(input: {
  build: AgentRuntimeBuild;
  lock: CodexAppServerReleaseLock;
  manifestPath: string;
}): void {
  const manifest = input.lock.upstream.checksumManifest;
  validateArtifactIdentity({
    expectedSha256: manifest.sha256,
    expectedSize: manifest.size,
    filePath: input.manifestPath,
    label: "Codex checksum manifest",
  });
  const entries = readFileSync(input.manifestPath, "utf8")
    .split(/\r?\n/u)
    .flatMap((line) => {
      if (line.length === 0) return [];
      const match = /^([a-f0-9]{64})  ([^/\\]+)$/u.exec(line);
      if (!match?.[1] || !match[2]) {
        throw new Error("Codex checksum manifest contains an invalid entry");
      }
      return [{ assetName: match[2], sha256: match[1] }];
    });
  const matches = entries.filter(({ assetName }) => assetName === input.build.assetName);
  if (matches.length !== 1 || matches[0]?.sha256 !== input.build.archiveSha256) {
    throw new Error(
      `Codex checksum manifest does not bind ${input.build.assetName} to the locked archive`,
    );
  }
}

function validateArchivePaths(archivePath: string): void {
  const entries = execFileSync(SYSTEM_TAR_PATH, ["-tzf", archivePath], { encoding: "utf8" })
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  for (const entry of entries) {
    if (entry.startsWith("/") || entry.includes("\\")) {
      throw new Error(`Codex app-server archive contains an unsafe path: ${entry}`);
    }
    const segments = entry.replace(/\/$/u, "").split("/");
    if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
      throw new Error(`Codex app-server archive contains an unsafe path: ${entry}`);
    }
  }
  const verboseEntries = execFileSync(SYSTEM_TAR_PATH, ["-tvzf", archivePath], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  })
    .split("\n")
    .filter((entry) => entry.length > 0);
  for (const entry of verboseEntries) {
    if (entry[0] !== "-" && entry[0] !== "d") {
      throw new Error("Codex app-server archive may contain only regular files and directories");
    }
  }
}

async function resolveSourceRoot(input: {
  archivePath?: string;
  cachePath?: string;
  checksumManifestPath?: string;
  extractionParent: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  lock: CodexAppServerReleaseLock;
  projectRoot: string;
  sourceRoot?: string;
  target: AgentRuntimeTarget;
}): Promise<{ cleanup: () => void; sourceRoot: string }> {
  if (input.sourceRoot) {
    const sourceRoot = resolve(input.sourceRoot);
    assertExactPackageFileClosure(sourceRoot, input.lock.requiredArtifacts);
    return { sourceRoot, cleanup: () => undefined };
  }

  const build = input.lock.builds[input.target.targetKey];
  const manifest = input.lock.upstream.checksumManifest;
  const siblingManifestPath = input.archivePath
    ? join(dirname(resolve(input.archivePath)), manifest.assetName)
    : undefined;
  const explicitManifestPath = input.checksumManifestPath
    ? resolve(input.checksumManifestPath)
    : siblingManifestPath && existsSync(siblingManifestPath)
      ? siblingManifestPath
      : undefined;
  const manifestPath = resolve(
    explicitManifestPath ??
      resolveImmutableArtifactPath({
        archiveSha256: manifest.sha256,
        assetName: manifest.assetName,
        cachePath: input.cachePath,
        family: "agent-runtime",
        projectRoot: input.projectRoot,
      }),
  );
  if (!explicitManifestPath) {
    await ensureImmutableArtifact({
      destinationPath: manifestPath,
      expectedSize: manifest.size,
      fetch: input.fetch,
      label: "Codex checksum manifest",
      url: manifest.url,
      validate: (candidatePath) =>
        validateChecksumManifest({ build, lock: input.lock, manifestPath: candidatePath }),
    });
  }
  validateChecksumManifest({ build, lock: input.lock, manifestPath });
  const archivePath = resolve(
    input.archivePath ??
      resolveImmutableArtifactPath({
        archiveSha256: build.archiveSha256,
        assetName: build.assetName,
        cachePath: input.cachePath,
        family: "agent-runtime",
        projectRoot: input.projectRoot,
      }),
  );
  if (input.archivePath) {
    validateArtifactIdentity({
      expectedSha256: build.archiveSha256,
      expectedSize: build.archiveSize,
      filePath: archivePath,
      label: "Codex app-server archive",
    });
  } else {
    await ensureImmutableArtifact({
      destinationPath: archivePath,
      expectedSize: build.archiveSize,
      fetch: input.fetch,
      label: `Codex app-server ${input.target.targetTriple}`,
      url: build.url,
      validate: (candidatePath) =>
        validateArtifactIdentity({
          expectedSha256: build.archiveSha256,
          expectedSize: build.archiveSize,
          filePath: candidatePath,
          label: "Codex app-server archive",
        }),
    });
  }
  validateArchivePaths(archivePath);

  const extractionRoot = mkdtempSync(join(input.extractionParent, "codex-app-server-extract-"));
  try {
    execFileSync(SYSTEM_TAR_PATH, ["-xzf", archivePath, "-C", extractionRoot]);
    assertExactPackageFileClosure(extractionRoot, input.lock.requiredArtifacts);
    return {
      sourceRoot: extractionRoot,
      cleanup: () => rmSync(extractionRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    rmSync(extractionRoot, { recursive: true, force: true });
    throw error;
  }
}

function validateNotice(input: {
  destinationPath: string;
  expectedSha256: string;
  label: string;
  sourcePath: string;
}): void {
  assertRegularFile(input.sourcePath, input.label);
  const sha256 = readSha256(input.sourcePath);
  if (sha256 !== input.expectedSha256) {
    throw new Error(`${input.label} checksum does not match the Codex app-server release lock`);
  }
  copyRuntimeFile(input.sourcePath, input.destinationPath);
}

async function stageCodexRuntimeClosure(
  options: StageAgentRuntimeOptions,
  verifyMetadataSha256: boolean,
): Promise<{
  metadata: BundledAgentRuntimeMetadata;
  metadataSha256: string;
}> {
  const repositoryRoot = resolve(options.projectRootPath ?? projectRoot);
  const lockPath = resolve(
    options.lockPath ?? resolveCodexAppServerReleaseLockPath(repositoryRoot),
  );
  const lock = readCodexAppServerReleaseLock(lockPath);
  const target = resolveCodexRuntimeTarget(options.targetPlatform, options.targetArch);
  const platformContractVerifier =
    options.agentRuntimePlatformContractVerifier ?? verifyAgentRuntimeMacosPlatformContract;
  const build = lock.builds[target.targetKey];
  if (build.targetTriple !== target.targetTriple) {
    throw new Error(`Codex app-server release lock target mismatch for ${target.targetKey}`);
  }

  const outputPath = resolve(options.outputPath);
  const outputParent = dirname(outputPath);
  mkdirSync(outputParent, { recursive: true });
  if (existsSync(outputPath) && lstatSync(outputPath).isSymbolicLink()) {
    throw new Error(`Agent runtime output root must not be a symlink: ${outputPath}`);
  }
  mkdirSync(outputPath, { recursive: true });
  if (options.reuseExisting) {
    const reusable = readReusableRuntime({
      lock,
      outputPath,
      repositoryRoot,
      target,
    });
    if (reusable) {
      platformContractVerifier({
        productMinimumMacos: AGENT_RUNTIME_PRODUCT_MINIMUM_MACOS,
        requiredArtifacts: lock.requiredArtifacts,
        runtimeRoot: join(outputPath, "agent-runtime"),
        targetArch: target.targetArch,
      });
      if (options.browserRuntimeSourceRoot) {
        stageBrowserRuntime({
          appServerIdentity: projectBundledAppServerRuntimeIdentity(reusable),
          platformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
          runtimeRoot: join(outputPath, "agent-runtime"),
          sourceRoot: options.browserRuntimeSourceRoot,
          targetArch: target.targetArch,
          targetPlatform: target.targetPlatform,
        });
      }
      process.stderr.write("Reused verified staged agent runtime.\n");
      return {
        metadata: reusable,
        metadataSha256: bundledAgentRuntimeMetadataSha256(reusable),
      };
    }
  }
  const tempOutputPath = mkdtempSync(join(outputPath, ".agent-runtime-stage-"));
  const tempRuntimeRoot = join(tempOutputPath, "agent-runtime");
  const cachePath = options.cachePath ? resolve(options.cachePath) : undefined;
  let sourceCleanup = (): void => undefined;

  try {
    const resolvedSource = await resolveSourceRoot({
      archivePath: options.archivePath,
      cachePath,
      checksumManifestPath: options.checksumManifestPath,
      extractionParent: outputParent,
      fetch: options.fetch,
      lock,
      projectRoot: repositoryRoot,
      sourceRoot: options.sourceRoot,
      target,
    });
    sourceCleanup = resolvedSource.cleanup;
    const packageManifest = readAndValidatePackageManifest(
      resolvedSource.sourceRoot,
      lock,
      target.targetTriple,
    );

    for (const artifactPath of lock.requiredArtifacts) {
      const sourcePath = join(resolvedSource.sourceRoot, ...artifactPath.split("/"));
      const destinationPath = join(tempRuntimeRoot, ...artifactPath.split("/"));
      copyRuntimeFile(sourcePath, destinationPath);
    }

    const noticesRoot = join(tempRuntimeRoot, "third-party", "codex");
    validateNotice({
      sourcePath: join(repositoryRoot, ...lock.notices.licensePath.split("/")),
      destinationPath: join(noticesRoot, "LICENSE"),
      expectedSha256: lock.notices.licenseSha256,
      label: "Codex LICENSE",
    });
    validateNotice({
      sourcePath: join(repositoryRoot, ...lock.notices.noticePath.split("/")),
      destinationPath: join(noticesRoot, "NOTICE"),
      expectedSha256: lock.notices.noticeSha256,
      label: "Codex NOTICE",
    });
    const artifacts = listRuntimeArtifacts(tempRuntimeRoot);
    for (const artifact of artifacts) {
      const expectedMode = canonicalRuntimeMode(artifact.executable);
      const artifactPath = join(tempRuntimeRoot, ...artifact.path.split("/"));
      if ((lstatSync(artifactPath).mode & 0o777) !== expectedMode) {
        throw new Error(`Staged agent runtime artifact has an unsafe mode: ${artifact.path}`);
      }
    }
    const artifactByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
    for (const artifactPath of lock.requiredArtifacts) {
      if (!artifactByPath.has(artifactPath)) {
        throw new Error(`Staged agent runtime is missing required artifact ${artifactPath}`);
      }
    }
    const entrypoint = artifactByPath.get(packageManifest.entrypoint);
    if (!entrypoint?.executable) {
      throw new Error(
        `Staged agent runtime entrypoint is not executable: ${packageManifest.entrypoint}`,
      );
    }
    if (verifyMetadataSha256 && entrypoint.sha256 !== build.entrypointSha256) {
      throw new Error(
        `Staged agent runtime entrypoint does not match the release lock for ${target.targetKey}: ${entrypoint.sha256}`,
      );
    }
    platformContractVerifier({
      productMinimumMacos: AGENT_RUNTIME_PRODUCT_MINIMUM_MACOS,
      requiredArtifacts: lock.requiredArtifacts,
      runtimeRoot: tempRuntimeRoot,
      targetArch: target.targetArch,
    });

    const metadata: BundledAgentRuntimeMetadata = {
      releaseAsset: {
        archiveSha256: build.archiveSha256,
        archiveSize: build.archiveSize,
        assetName: build.assetName,
        entrypointSha256: entrypoint.sha256,
        repository: lock.upstream.repository,
        tag: lock.upstream.tag,
      },
      artifacts,
      appServerRuntimeVersion: lock.appServerRuntimeVersion,
      entrypoint: packageManifest.entrypoint,
      layoutVersion: AGENT_RUNTIME_LAYOUT_VERSION,
      packageManifest,
      protocolSchemaFingerprint: lock.protocolSchema.sha256,
      runtimeFamily: lock.runtimeFamily,
      searchPaths: [packageManifest.pathDir],
      sourceRevision: {
        commit: lock.upstream.commit,
        repository: lock.upstream.repository,
        tag: lock.upstream.tag,
      },
      targetArch: target.targetArch,
      targetPlatform: target.targetPlatform,
      targetTriple: target.targetTriple,
    };

    const metadataSha256 = bundledAgentRuntimeMetadataSha256(metadata);
    if (verifyMetadataSha256 && metadataSha256 !== build.runtimeMetadataSha256) {
      throw new Error(
        `Staged agent runtime metadata does not match the release lock for ${target.targetKey}: ${metadataSha256}`,
      );
    }

    const metadataPath = join(tempRuntimeRoot, AGENT_RUNTIME_METADATA_FILENAME);
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    chmodSync(metadataPath, REGULAR_RUNTIME_MODE);
    if (options.browserRuntimeSourceRoot) {
      stageBrowserRuntime({
        appServerIdentity: projectBundledAppServerRuntimeIdentity(metadata),
        platformArtifactVerifier: options.browserRuntimePlatformArtifactVerifier,
        runtimeRoot: tempRuntimeRoot,
        sourceRoot: options.browserRuntimeSourceRoot,
        targetArch: target.targetArch,
        targetPlatform: target.targetPlatform,
      });
    }
    replaceOwnedDirectory(tempRuntimeRoot, join(outputPath, "agent-runtime"));
    return { metadata, metadataSha256 };
  } finally {
    sourceCleanup();
    rmSync(tempOutputPath, { recursive: true, force: true });
  }
}

export async function stageCodexRuntime(
  options: StageAgentRuntimeOptions,
): Promise<BundledAgentRuntimeMetadata> {
  const result = await stageCodexRuntimeClosure(options, true);
  return result.metadata;
}

/**
 * Builds the same canonical closure as production staging while returning the
 * candidate metadata digest before that digest is committed to the release lock.
 */
export function stageCodexRuntimeCandidate(
  options: StageAgentRuntimeOptions,
): Promise<{ metadata: BundledAgentRuntimeMetadata; metadataSha256: string }> {
  return stageCodexRuntimeClosure({ ...options, reuseExisting: false }, false);
}

function parseCliOptions(argv: string[]): CliOptions {
  const args = argv.filter((value) => value !== "--");
  let targetPlatform: AgentRuntimeTargetPlatform | null = null;
  let targetArch: AgentRuntimeTargetArch | null = null;
  let outputPath: string | null = null;
  let archivePath: string | undefined;
  let browserRuntimeSourceRoot: string | undefined;
  let reuseExisting = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const nextValue = args[index + 1];

    if (arg === "--target-platform") {
      if (nextValue !== "darwin") {
        throw new Error(`Unsupported --target-platform value: ${nextValue ?? "<missing>"}`);
      }
      targetPlatform = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--target-arch") {
      if (nextValue !== "arm64" && nextValue !== "x64") {
        throw new Error(`Unsupported --target-arch value: ${nextValue ?? "<missing>"}`);
      }
      targetArch = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--out") {
      if (!nextValue) throw new Error("Missing value for --out");
      outputPath = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--archive") {
      if (!nextValue) throw new Error("Missing value for --archive");
      archivePath = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--browser-runtime-source") {
      if (!nextValue) throw new Error("Missing value for --browser-runtime-source");
      browserRuntimeSourceRoot = nextValue;
      index += 1;
      continue;
    }
    if (arg === "--reuse-existing") {
      reuseExisting = true;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  if (!targetPlatform || !targetArch || !outputPath) {
    throw new Error(
      "Usage: stage-codex-runtime.ts --target-platform darwin --target-arch <arm64|x64> " +
        "--out <dir> [--archive <tar.gz>] [--browser-runtime-source <dir>] " +
        "[--reuse-existing]",
    );
  }
  return {
    archivePath,
    browserRuntimeSourceRoot,
    targetPlatform,
    targetArch,
    outputPath: resolve(projectRoot, outputPath),
    reuseExisting,
  };
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const metadata = await stageCodexRuntime(options);
  process.stdout.write(`${JSON.stringify(metadata)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
