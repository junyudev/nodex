import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { ChromeBrowserAuthority } from "./ChromeBrowserFamilyRegistry";
import { resolveChromeNativeMessagingManifestPaths } from "./ChromeBrowserFamilyRegistry";

const NATIVE_HOST_REGISTRY_FILE_NAME = "chrome-native-hosts-v2.json";
const NATIVE_HOST_CLOSURE_DIRECTORY = "chrome-control/native-host-v2";
const NATIVE_HOST_REGISTRY_SCHEMA_VERSION = 2;
const APP_SERVER_PROTOCOL_VERSION = 2;
const NATIVE_HOST_PROTOCOL_VERSION = 2;
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
const RUNTIME_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u;

export interface ChromeNativeHostRuntimePaths {
  readonly browserClientPath: string;
  readonly browserServicePath: string;
  readonly codexCliPath: string;
  readonly nativeHostPath: string;
  readonly nodePath: string;
  readonly nodeModuleDirs: readonly string[];
  readonly nodeReplPath: string;
  readonly resourcesPath: string;
}

export interface ChromeNativeHostIdentity {
  readonly signingIdentifier: string;
  readonly teamId: string;
}

export interface ChromeNativeHostInstallResult {
  readonly manifestPaths: readonly string[];
  readonly nativeHostPath: string;
  readonly peerIdentity: ChromeNativeHostIdentity;
  readonly registryPaths: readonly string[];
}

export interface ChromeNativeHostInstallerOptions {
  readonly authority: ChromeBrowserAuthority;
  readonly channel: string;
  readonly expectedNativeHost: {
    readonly sha256: string;
    readonly signingTeamId: string;
    readonly size: number;
  };
  readonly homeDirectory: string;
  readonly runtimePaths: ChromeNativeHostRuntimePaths;
  readonly runtimeStateHome: string;
  readonly runtimeVersion: string;
  /** Rechecks code-signing identity at both the attested source and materialized destination. */
  readonly verifyNativeHost: (nativeHostPath: string) => Promise<ChromeNativeHostIdentity>;
}

type CommandReader = (command: string, args: readonly string[]) => string;

interface ChromeNativeHostManifest {
  readonly allowed_origins: readonly string[];
  readonly description: string;
  readonly name: string;
  readonly path: string;
  readonly type: "stdio";
}

interface ChromeNativeHostRegistryEntry {
  readonly appServerProtocolVersion: 2;
  readonly appVersion: string;
  readonly channel: string;
  readonly cliVersion: string;
  readonly entryId: string;
  readonly extensionBuildChannels: readonly string[];
  readonly extensionIds: readonly string[];
  readonly installId: string;
  readonly nativeHostNames: readonly string[];
  readonly nativeHostProtocolVersion: 2;
  readonly nativeHostVersion: string;
  readonly paths: {
    readonly browserClientPath: string;
    readonly browserServicePath: string;
    readonly codexCliPath: string;
    readonly codexHome: string;
    readonly extensionHostPath: string;
    readonly nodePath: string;
    readonly nodeModuleDirs: readonly string[];
    readonly nodeReplPath: string;
    readonly resourcesPath: string;
  };
  readonly presence: {
    readonly lastSeenAt: string;
    readonly pid: number;
    readonly startedAt: string;
  };
  readonly proxyHost: "127.0.0.1";
  readonly proxyPort: 0;
  readonly schemaVersion: 2;
  readonly updatedAt: string;
}

interface ChromeNativeHostRegistry {
  readonly entries: readonly unknown[];
  readonly schemaVersion: 2;
}

function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && Reflect.get(error, "code") === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireAbsoluteRegularPath(value: string, label: string): string {
  const resolved = path.resolve(value);
  if (!path.isAbsolute(value) || resolved !== value || value.includes("\0")) {
    throw new Error(`${label} must be a canonical absolute path`);
  }
  return resolved;
}

function requireContained(root: string, candidate: string, label: string): void {
  if (candidate === root || candidate.startsWith(`${root}${path.sep}`)) return;
  throw new Error(`${label} escaped its canonical root`);
}

async function verifyRegularFile(filePath: string, executable: boolean): Promise<void> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(`Chrome native host runtime path is not a regular file: ${filePath}`);
    }
    if (executable && (stats.mode & 0o111) === 0) {
      throw new Error(`Chrome native host is not executable: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

async function canonicalRegularFile(
  filePath: string,
  label: string,
  executable: boolean,
): Promise<string> {
  const requested = requireAbsoluteRegularPath(filePath, label);
  await verifyRegularFile(requested, executable);
  return await fs.realpath(requested);
}

async function canonicalExistingDirectory(directoryPath: string, label: string): Promise<string> {
  const requested = requireAbsoluteRegularPath(directoryPath, label);
  const stats = await fs.lstat(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  return await fs.realpath(requested);
}

async function canonicalOwnedRoot(rootPath: string, label: string): Promise<string> {
  const requested = requireAbsoluteRegularPath(rootPath, label);
  await fs.mkdir(requested, { mode: 0o700, recursive: true });
  const stats = await fs.lstat(requested);
  const currentUserId = process.getuid?.();
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${label} is not a regular directory`);
  }
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error(`${label} is owned by another user`);
  }
  if ((stats.mode & 0o022) !== 0) throw new Error(`${label} is writable by another user`);
  return await fs.realpath(requested);
}

async function ensureContainedDirectory(
  canonicalRoot: string,
  relativeDirectory: string,
): Promise<string> {
  const segments = relativeDirectory.split(path.sep).filter(Boolean);
  let current = canonicalRoot;
  for (const segment of segments) {
    if (segment === "." || segment === ".." || segment.includes("\0")) {
      throw new Error("Chrome native host destination contains an unsafe path segment");
    }
    current = path.join(current, segment);
    requireContained(canonicalRoot, current, "Chrome native host destination");
    try {
      await fs.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }
    const stats = await fs.lstat(current);
    const currentUserId = process.getuid?.();
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Chrome native host destination is not a regular directory: ${current}`);
    }
    if (currentUserId !== undefined && stats.uid !== currentUserId) {
      throw new Error(`Chrome native host destination is owned by another user: ${current}`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`Chrome native host destination is writable by another user: ${current}`);
    }
    if ((await fs.realpath(current)) !== current) {
      throw new Error(`Chrome native host destination is not canonical: ${current}`);
    }
  }
  return current;
}

async function readAttestedFile(
  filePath: string,
  expected: { readonly sha256: string; readonly size: number },
): Promise<Buffer> {
  if (
    !/^[a-f0-9]{64}$/u.test(expected.sha256) ||
    !Number.isSafeInteger(expected.size) ||
    expected.size < 0
  ) {
    throw new Error("Chrome native host artifact identity is invalid");
  }
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size !== expected.size || (stats.mode & 0o111) === 0) {
      throw new Error("Chrome native host does not match its manifest artifact");
    }
    const bytes = await handle.readFile();
    if (createHash("sha256").update(bytes).digest("hex") !== expected.sha256) {
      throw new Error("Chrome native host failed its manifest hash check");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeAtomically(filePath: string, bytes: Uint8Array, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(
      temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode,
    );
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, mode);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeJsonAtomically(filePath: string, value: unknown, mode: number): Promise<void> {
  await writeAtomically(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"), mode);
}

function stringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > 128) return null;
  const strings = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.length > 0 && entry.length <= 1_024,
  );
  return strings.length === value.length ? strings : null;
}

function registryEntryConflicts(
  existing: unknown,
  replacement: ChromeNativeHostRegistryEntry,
): boolean {
  if (!isRecord(existing)) return false;
  if (existing.entryId === replacement.entryId) return true;
  if (existing.installId !== replacement.installId || existing.channel !== replacement.channel) {
    return false;
  }
  const extensionIds = stringArray(existing.extensionIds);
  const nativeHostNames = stringArray(existing.nativeHostNames);
  if (!extensionIds || !nativeHostNames) return false;
  return (
    extensionIds.some((extensionId) => replacement.extensionIds.includes(extensionId)) &&
    nativeHostNames.some((hostName) => replacement.nativeHostNames.includes(hostName))
  );
}

async function readNativeHostRegistry(registryPath: string): Promise<ChromeNativeHostRegistry> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(registryPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      return { entries: [], schemaVersion: NATIVE_HOST_REGISTRY_SCHEMA_VERSION };
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    const currentUserId = process.getuid?.();
    if (!stats.isFile() || stats.size > MAX_REGISTRY_BYTES) {
      throw new Error(`Chrome native host registry is not a bounded regular file: ${registryPath}`);
    }
    if (currentUserId !== undefined && stats.uid !== currentUserId) {
      throw new Error(`Chrome native host registry is owned by another user: ${registryPath}`);
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`Chrome native host registry is writable by another user: ${registryPath}`);
    }
    const parsed: unknown = JSON.parse(await handle.readFile("utf8"));
    if (
      !isRecord(parsed) ||
      parsed.schemaVersion !== NATIVE_HOST_REGISTRY_SCHEMA_VERSION ||
      !Array.isArray(parsed.entries) ||
      parsed.entries.length > 4_096
    ) {
      throw new Error(`Chrome native host registry is invalid: ${registryPath}`);
    }
    return {
      entries: parsed.entries,
      schemaVersion: NATIVE_HOST_REGISTRY_SCHEMA_VERSION,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Chrome native host registry is invalid JSON: ${registryPath}`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function writeNativeHostRegistry(
  registryPath: string,
  entry: ChromeNativeHostRegistryEntry,
): Promise<void> {
  const registry = await readNativeHostRegistry(registryPath);
  const entries = [
    ...registry.entries.filter((existing) => !registryEntryConflicts(existing, entry)),
    entry,
  ].sort((left, right) => {
    const key = (value: unknown): string => {
      if (!isRecord(value)) return "";
      const nativeHostName = stringArray(value.nativeHostNames)?.[0] ?? "";
      const channel = typeof value.channel === "string" ? value.channel : "";
      const entryId = typeof value.entryId === "string" ? value.entryId : "";
      return `${nativeHostName}:${channel}:${entryId}`;
    };
    return key(left).localeCompare(key(right));
  });
  await writeJsonAtomically(
    registryPath,
    { entries, schemaVersion: NATIVE_HOST_REGISTRY_SCHEMA_VERSION },
    0o600,
  );
}

function stableRuntimeId(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 32);
}

export function resolveChromeNativeHostRegistryPaths(
  canonicalHome: string,
  canonicalRuntimeStateHome: string,
): readonly string[] {
  return [
    path.join(
      canonicalHome,
      "Library",
      "Application Support",
      "OpenAI",
      "Codex",
      NATIVE_HOST_REGISTRY_FILE_NAME,
    ),
    path.join(canonicalRuntimeStateHome, NATIVE_HOST_REGISTRY_FILE_NAME),
  ].filter((candidate, index, paths) => paths.indexOf(candidate) === index);
}

async function verifyInstalledFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    const currentUserId = process.getuid?.();
    if (!stats.isFile()) {
      throw new Error(`Chrome native host install did not produce a regular file: ${filePath}`);
    }
    if (currentUserId !== undefined && stats.uid !== currentUserId) {
      throw new Error(
        `Chrome native host install produced a file owned by another user: ${filePath}`,
      );
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new Error(`Chrome native host install produced a writable shared file: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
}

function requireIdentity(
  identity: ChromeNativeHostIdentity,
  expectedTeamId: string,
): ChromeNativeHostIdentity {
  if (
    !identity.signingIdentifier ||
    identity.signingIdentifier.length > 256 ||
    identity.signingIdentifier.includes("\0") ||
    identity.teamId !== expectedTeamId
  ) {
    throw new Error("Chrome native host code-signing identity does not match the runtime manifest");
  }
  return identity;
}

function defaultCommandReader(command: string, args: readonly string[]): string {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${String(result.status)}`);
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

/** Returns the identity the peer-authorizer addon will observe for the selected native host. */
export function readChromeNativeHostIdentity(
  nativeHostPath: string,
  runCommand: CommandReader = defaultCommandReader,
): ChromeNativeHostIdentity {
  const output = runCommand("/usr/bin/codesign", ["-dv", "--verbose=4", nativeHostPath]);
  const signingIdentifier = /^Identifier=(.+)$/mu.exec(output)?.[1]?.trim();
  const teamId = /^TeamIdentifier=(.+)$/mu.exec(output)?.[1]?.trim();
  if (!signingIdentifier || !teamId) {
    throw new Error("Chrome native host code-signing identity is unavailable");
  }
  return { signingIdentifier, teamId };
}

/**
 * Materializes the attested native host into a Profile-owned versioned closure, then installs
 * browser manifests that point only at that immutable identity. No packaged Resource is mutated.
 */
export async function installChromeNativeHost(
  options: ChromeNativeHostInstallerOptions,
): Promise<ChromeNativeHostInstallResult> {
  const channel = options.channel.trim();
  if (!channel || channel.length > 64) throw new Error("Chrome native host channel is invalid");
  const runtimeVersion = options.runtimeVersion.trim();
  if (!RUNTIME_VERSION_PATTERN.test(runtimeVersion)) {
    throw new Error("Chrome native host runtime version is invalid");
  }

  const requestedResourcesPath = requireAbsoluteRegularPath(
    options.runtimePaths.resourcesPath,
    "resourcesPath",
  );
  const resourcesPath = await canonicalExistingDirectory(requestedResourcesPath, "resourcesPath");
  const containedRuntimeFile = async (
    value: string,
    label: string,
    executable: boolean,
  ): Promise<string> => {
    const requested = requireAbsoluteRegularPath(value, label);
    const relativePath = path.relative(requestedResourcesPath, requested);
    if (
      !relativePath ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`${label} escaped the verified browser runtime`);
    }
    const canonical = await canonicalRegularFile(requested, label, executable);
    const expectedCanonical = path.join(resourcesPath, relativePath);
    if (canonical !== expectedCanonical) {
      throw new Error(`${label} contains a non-canonical parent path`);
    }
    requireContained(resourcesPath, canonical, label);
    return canonical;
  };
  const containedRuntimeDirectory = async (value: string, label: string): Promise<string> => {
    const requested = requireAbsoluteRegularPath(value, label);
    const relativePath = path.relative(requestedResourcesPath, requested);
    if (
      !relativePath ||
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      throw new Error(`${label} escaped the verified browser runtime`);
    }
    const canonical = await canonicalExistingDirectory(requested, label);
    const expectedCanonical = path.join(resourcesPath, relativePath);
    if (canonical !== expectedCanonical) {
      throw new Error(`${label} contains a non-canonical parent path`);
    }
    requireContained(resourcesPath, canonical, label);
    return canonical;
  };
  if (options.runtimePaths.nodeModuleDirs.length > 64) {
    throw new Error("Chrome native host Node module directories are invalid");
  }

  const runtimePaths = {
    browserClientPath: await containedRuntimeFile(
      options.runtimePaths.browserClientPath,
      "browserClientPath",
      false,
    ),
    browserServicePath: await containedRuntimeFile(
      options.runtimePaths.browserServicePath,
      "browserServicePath",
      false,
    ),
    codexCliPath: await containedRuntimeFile(
      options.runtimePaths.codexCliPath,
      "codexCliPath",
      true,
    ),
    nativeHostPath: await containedRuntimeFile(
      options.runtimePaths.nativeHostPath,
      "nativeHostPath",
      true,
    ),
    nodePath: await containedRuntimeFile(options.runtimePaths.nodePath, "nodePath", true),
    nodeModuleDirs: await Promise.all(
      options.runtimePaths.nodeModuleDirs.map((directory, index) =>
        containedRuntimeDirectory(directory, `nodeModuleDirs[${index}]`),
      ),
    ),
    nodeReplPath: await containedRuntimeFile(
      options.runtimePaths.nodeReplPath,
      "nodeReplPath",
      false,
    ),
    resourcesPath,
  };
  if (new Set(runtimePaths.nodeModuleDirs).size !== runtimePaths.nodeModuleDirs.length) {
    throw new Error("Chrome native host Node module directories contain duplicates");
  }
  const sourceBytes = await readAttestedFile(
    runtimePaths.nativeHostPath,
    options.expectedNativeHost,
  );
  const sourceIdentity = requireIdentity(
    await options.verifyNativeHost(runtimePaths.nativeHostPath),
    options.expectedNativeHost.signingTeamId,
  );

  const canonicalRuntimeStateHome = await canonicalOwnedRoot(
    options.runtimeStateHome,
    "Chrome runtime state home",
  );
  const closureDirectory = await ensureContainedDirectory(
    canonicalRuntimeStateHome,
    path.join(NATIVE_HOST_CLOSURE_DIRECTORY, options.expectedNativeHost.sha256),
  );
  const nativeHostPath = path.join(closureDirectory, "native-host");
  requireContained(canonicalRuntimeStateHome, nativeHostPath, "Chrome native host path");
  await writeAtomically(nativeHostPath, sourceBytes, 0o700);
  await readAttestedFile(nativeHostPath, options.expectedNativeHost);
  const peerIdentity = requireIdentity(
    await options.verifyNativeHost(nativeHostPath),
    options.expectedNativeHost.signingTeamId,
  );
  if (
    peerIdentity.signingIdentifier !== sourceIdentity.signingIdentifier ||
    peerIdentity.teamId !== sourceIdentity.teamId
  ) {
    throw new Error("Materialized Chrome native host changed its code-signing identity");
  }

  const canonicalHome = await canonicalOwnedRoot(options.homeDirectory, "Chrome user home");
  const registryPaths = resolveChromeNativeHostRegistryPaths(
    canonicalHome,
    canonicalRuntimeStateHome,
  );
  const extensionBuildChannels = options.authority.hostName.endsWith(".internal")
    ? [...new Set([channel, "prod"])]
    : [channel];
  const registryRuntimePaths: ChromeNativeHostRegistryEntry["paths"] = {
    browserClientPath: runtimePaths.browserClientPath,
    browserServicePath: runtimePaths.browserServicePath,
    codexCliPath: runtimePaths.codexCliPath,
    codexHome: canonicalRuntimeStateHome,
    extensionHostPath: nativeHostPath,
    nodeModuleDirs: runtimePaths.nodeModuleDirs,
    nodePath: runtimePaths.nodePath,
    nodeReplPath: runtimePaths.nodeReplPath,
    resourcesPath: runtimePaths.resourcesPath,
  };
  const installId = `codex-install-${stableRuntimeId([
    options.authority.hostName,
    registryRuntimePaths.resourcesPath,
    registryRuntimePaths.codexHome,
  ])}`;
  const entryId = `codex-runtime-${stableRuntimeId([
    options.authority.hostName,
    ...options.authority.extensionIds,
    channel,
    runtimeVersion,
    registryRuntimePaths.extensionHostPath,
    registryRuntimePaths.codexCliPath,
    registryRuntimePaths.codexHome,
    registryRuntimePaths.resourcesPath,
  ])}`;
  const updatedAt = new Date().toISOString();
  const registryEntry: ChromeNativeHostRegistryEntry = {
    appServerProtocolVersion: APP_SERVER_PROTOCOL_VERSION,
    appVersion: runtimeVersion,
    channel,
    cliVersion: runtimeVersion,
    entryId,
    extensionBuildChannels,
    extensionIds: options.authority.extensionIds,
    installId,
    nativeHostNames: [options.authority.hostName],
    nativeHostProtocolVersion: NATIVE_HOST_PROTOCOL_VERSION,
    nativeHostVersion: runtimeVersion,
    paths: registryRuntimePaths,
    presence: { lastSeenAt: updatedAt, pid: process.pid, startedAt: updatedAt },
    proxyHost: "127.0.0.1",
    proxyPort: 0,
    schemaVersion: NATIVE_HOST_REGISTRY_SCHEMA_VERSION,
    updatedAt,
  };
  for (const registryPath of registryPaths) {
    const registryRoot = registryPath.startsWith(`${canonicalRuntimeStateHome}${path.sep}`)
      ? canonicalRuntimeStateHome
      : canonicalHome;
    requireContained(registryRoot, registryPath, "Chrome native host registry");
    const relativeParent = path.relative(registryRoot, path.dirname(registryPath));
    await ensureContainedDirectory(registryRoot, relativeParent);
    await writeNativeHostRegistry(registryPath, registryEntry);
  }

  const manifestPaths = resolveChromeNativeMessagingManifestPaths(canonicalHome, options.authority);
  const manifest: ChromeNativeHostManifest = {
    allowed_origins: options.authority.extensionIds.map(
      (extensionId) => `chrome-extension://${extensionId}/`,
    ),
    description: "ChatGPT browser native messaging host",
    name: options.authority.hostName,
    path: nativeHostPath,
    type: "stdio",
  };

  for (const manifestPath of manifestPaths) {
    requireContained(canonicalHome, manifestPath, "Chrome native messaging manifest");
    const relativeParent = path.relative(canonicalHome, path.dirname(manifestPath));
    await ensureContainedDirectory(canonicalHome, relativeParent);
    await writeJsonAtomically(manifestPath, manifest, 0o644);
  }
  await Promise.all([nativeHostPath, ...registryPaths, ...manifestPaths].map(verifyInstalledFile));
  await readAttestedFile(nativeHostPath, options.expectedNativeHost);
  const finalIdentity = requireIdentity(
    await options.verifyNativeHost(nativeHostPath),
    options.expectedNativeHost.signingTeamId,
  );
  if (
    finalIdentity.signingIdentifier !== peerIdentity.signingIdentifier ||
    finalIdentity.teamId !== peerIdentity.teamId
  ) {
    throw new Error("Installed Chrome native host changed its code-signing identity");
  }
  return { manifestPaths, nativeHostPath, peerIdentity, registryPaths };
}
