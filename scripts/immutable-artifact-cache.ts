import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export const LOCAL_ARTIFACT_CACHE_DIRECTORY = "cache.local";

export type ImmutableArtifactFamily =
  | "agent-runtime"
  | "browser-runtime"
  | "electron"
  | "rust-dev-runtime"
  | "sparkle"
  | "workspace-runtime";

type CacheLockOwner = {
  readonly pid: number;
  readonly token: string;
};

export interface ImmutableArtifactPathInput {
  readonly archiveSha256: string;
  readonly assetName: string;
  readonly cachePath?: string;
  readonly family: ImmutableArtifactFamily;
  readonly projectRoot: string;
}

export interface ImmutableDirectoryPathInput extends Omit<ImmutableArtifactPathInput, "assetName"> {
  /** Include the extraction/transformation recipe version in this name. */
  readonly directoryName: string;
}

export interface EnsureImmutableDirectoryInput {
  readonly destinationPath: string;
  readonly generate: (temporaryDirectory: string) => Promise<void> | void;
  readonly label: string;
  readonly validate: (directoryPath: string) => Promise<void> | void;
}

export interface EnsureImmutableArtifactInput {
  readonly destinationPath: string;
  readonly expectedSize: number;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly label: string;
  readonly replaceInvalid?: boolean;
  readonly url: string;
  readonly validate: (archivePath: string) => void;
}

export interface EnsureGeneratedImmutableArtifactInput {
  readonly destinationPath: string;
  readonly generate: (temporaryPath: string) => Promise<void> | void;
  readonly label: string;
  readonly replaceInvalid?: boolean;
  readonly validate: (artifactPath: string) => void;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const LOCK_OWNER_FILENAME = "owner.json";
const LOCK_MISSING_OWNER_GRACE_MS = 5_000;
const LOCK_POLL_INTERVAL_MS = 100;
const LOCK_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
const DIRECTORY_CONTENT_NAME = "content";
const DIRECTORY_INVENTORY_NAME = "inventory.json";

function assertAssetName(assetName: string): void {
  if (
    !assetName ||
    assetName === "." ||
    assetName === ".." ||
    assetName.includes("/") ||
    assetName.includes("\\") ||
    assetName.includes("\0")
  ) {
    throw new Error(`Invalid immutable artifact asset name: ${assetName || "<empty>"}`);
  }
}

function resolveCacheFamilyRoot(
  input: Pick<ImmutableArtifactPathInput, "cachePath" | "family" | "projectRoot">,
): string {
  if (input.cachePath !== undefined) return path.resolve(input.cachePath);
  const buildCacheDirectory = process.env.NODEX_BUILD_CACHE_DIR?.trim();
  if (buildCacheDirectory) return path.resolve(buildCacheDirectory, input.family);
  let checkoutRoot = path.resolve(input.projectRoot);
  try {
    // Git lists the primary checkout first; NUL records preserve spaces/newlines in paths.
    const firstRecord = execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: checkoutRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).split("\0")[0];
    if (firstRecord?.startsWith("worktree ")) checkoutRoot = firstRecord.slice(9);
  } catch {
    // Source archives and disposable non-Git test roots keep a local cache.
  }
  return path.join(checkoutRoot, LOCAL_ARTIFACT_CACHE_DIRECTORY, input.family);
}

function assertArchiveSha256(archiveSha256: string): void {
  if (SHA256_PATTERN.test(archiveSha256)) return;
  throw new Error(`Invalid immutable artifact SHA-256: ${archiveSha256}`);
}

/** Resolves a verified archive in the primary checkout's shared download cache. */
export function resolveImmutableArtifactPath(input: ImmutableArtifactPathInput): string {
  assertArchiveSha256(input.archiveSha256);
  assertAssetName(input.assetName);
  return path.join(resolveCacheFamilyRoot(input), input.archiveSha256, input.assetName);
}

/** Resolves a sealed directory entry, namespaced by archive content and recipe version. */
export function resolveImmutableDirectoryPath(input: ImmutableDirectoryPathInput): string {
  assertArchiveSha256(input.archiveSha256);
  assertAssetName(input.directoryName);
  return path.join(resolveCacheFamilyRoot(input), input.archiveSha256, input.directoryName);
}

const isErrno = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

function readLockOwner(lockPath: string): CacheLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path.join(lockPath, LOCK_OWNER_FILENAME), "utf8")) as {
      readonly pid?: unknown;
      readonly token?: unknown;
    };
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return null;
    if (typeof value.token !== "string" || value.token.length === 0) return null;
    return { pid: value.pid as number, token: value.token };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function canReclaimLock(lockPath: string): boolean {
  const owner = readLockOwner(lockPath);
  if (owner) return !isProcessAlive(owner.pid);
  try {
    return Date.now() - lstatSync(lockPath).mtimeMs >= LOCK_MISSING_OWNER_GRACE_MS;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function reclaimLock(lockPath: string): boolean {
  if (!canReclaimLock(lockPath)) return false;
  const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(lockPath, stalePath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
  rmSync(stalePath, { force: true, recursive: true });
  return true;
}

function validArtifactExists(
  destinationPath: string,
  validate: (archivePath: string) => void,
  replaceInvalid: boolean,
): boolean {
  if (!existsSync(destinationPath)) return false;
  try {
    validate(destinationPath);
    return true;
  } catch (error) {
    if (!replaceInvalid) throw error;
    return false;
  }
}

async function acquireCacheLock(input: {
  readonly allowValidatedResult?: boolean;
  readonly destinationPath: string;
  readonly replaceInvalid: boolean;
  readonly validate: (archivePath: string) => void;
}): Promise<{ readonly release: () => void } | null> {
  const lockPath = `${input.destinationPath}.lock`;
  const owner: CacheLockOwner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;

  while (true) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      writeFileSync(path.join(lockPath, LOCK_OWNER_FILENAME), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return {
        release: () => {
          if (readLockOwner(lockPath)?.token !== owner.token) return;
          rmSync(lockPath, { force: true, recursive: true });
        },
      };
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
    }

    if (
      input.allowValidatedResult !== false &&
      validArtifactExists(input.destinationPath, input.validate, input.replaceInvalid)
    ) {
      return null;
    }
    if (reclaimLock(lockPath)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for immutable artifact cache lock: ${lockPath}`);
    }
    await delay(LOCK_POLL_INTERVAL_MS);
  }
}

function removeAbandonedPartialFiles(destinationPath: string): void {
  const parent = path.dirname(destinationPath);
  const prefix = `${path.basename(destinationPath)}.part-`;
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    rmSync(path.join(parent, entry.name), { force: true, recursive: true });
  }
}

function errorChain(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 4) {
    if (!messages.includes(current.message)) messages.push(current.message);
    current = current.cause;
  }
  return messages.join(": ") || String(error);
}

async function downloadAndPublish(input: EnsureImmutableArtifactInput): Promise<void> {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImplementation(input.url, { redirect: "follow" });
  } catch (error) {
    throw new Error(`Failed to download ${input.label}: ${errorChain(error)}`, { cause: error });
  }
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${input.label}: HTTP ${response.status}`);
  }
  const reportedLength = response.headers.get("content-length");
  if (reportedLength && Number(reportedLength) !== input.expectedSize) {
    throw new Error(
      `${input.label} download size mismatch: expected ${input.expectedSize}, ` +
        `server reported ${reportedLength}`,
    );
  }

  const temporaryPath = `${input.destinationPath}.part-${process.pid}-${randomUUID()}`;
  let downloadedSize = 0;
  const sizeLimiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloadedSize += chunk.length;
      if (downloadedSize > input.expectedSize) {
        callback(new Error(`${input.label} download exceeded its locked size`));
        return;
      }
      callback(null, chunk);
    },
  });

  try {
    const body = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>);
    await pipeline(
      body,
      sizeLimiter,
      createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
    );
    if (downloadedSize !== input.expectedSize) {
      throw new Error(
        `${input.label} download size mismatch: expected ${input.expectedSize}, ` +
          `received ${downloadedSize}`,
      );
    }
    input.validate(temporaryPath);
    if (existsSync(input.destinationPath)) {
      try {
        input.validate(input.destinationPath);
        return;
      } catch (error) {
        if (input.replaceInvalid === false) throw error;
        rmSync(input.destinationPath, { force: true });
      }
    }
    renameSync(temporaryPath, input.destinationPath);
    input.validate(input.destinationPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/** Downloads, verifies, and atomically publishes one archive for all local worktrees. */
export async function ensureImmutableArtifact(input: EnsureImmutableArtifactInput): Promise<void> {
  if (!Number.isSafeInteger(input.expectedSize) || input.expectedSize <= 0) {
    throw new Error(`Invalid immutable artifact size for ${input.label}: ${input.expectedSize}`);
  }
  const replaceInvalid = input.replaceInvalid ?? true;
  if (validArtifactExists(input.destinationPath, input.validate, replaceInvalid)) return;

  mkdirSync(path.dirname(input.destinationPath), { mode: 0o700, recursive: true });
  const lock = await acquireCacheLock({
    destinationPath: input.destinationPath,
    replaceInvalid,
    validate: input.validate,
  });
  if (!lock) return;

  try {
    if (validArtifactExists(input.destinationPath, input.validate, replaceInvalid)) return;
    if (existsSync(input.destinationPath)) rmSync(input.destinationPath, { force: true });
    removeAbandonedPartialFiles(input.destinationPath);
    await downloadAndPublish(input);
  } finally {
    lock.release();
  }
}

/** Builds, verifies, and atomically publishes one immutable artifact for all local worktrees. */
export async function ensureGeneratedImmutableArtifact(
  input: EnsureGeneratedImmutableArtifactInput,
): Promise<void> {
  const replaceInvalid = input.replaceInvalid ?? true;
  if (validArtifactExists(input.destinationPath, input.validate, replaceInvalid)) return;

  mkdirSync(path.dirname(input.destinationPath), { mode: 0o700, recursive: true });
  const lock = await acquireCacheLock({
    destinationPath: input.destinationPath,
    replaceInvalid,
    validate: input.validate,
  });
  if (!lock) return;

  const temporaryPath = `${input.destinationPath}.part-${process.pid}-${randomUUID()}`;
  try {
    if (validArtifactExists(input.destinationPath, input.validate, replaceInvalid)) return;
    if (existsSync(input.destinationPath)) rmSync(input.destinationPath, { force: true });
    removeAbandonedPartialFiles(input.destinationPath);
    await input.generate(temporaryPath);
    input.validate(temporaryPath);
    if (existsSync(input.destinationPath)) {
      if (validArtifactExists(input.destinationPath, input.validate, replaceInvalid)) return;
      rmSync(input.destinationPath, { force: true });
    }
    renameSync(temporaryPath, input.destinationPath);
    input.validate(input.destinationPath);
  } catch (error) {
    throw new Error(`Failed to build ${input.label}: ${errorChain(error)}`, { cause: error });
  } finally {
    rmSync(temporaryPath, { force: true });
    lock.release();
  }
}

type DirectoryInventoryEntry =
  | { readonly path: string; readonly type: "directory"; readonly mode: number }
  | {
      readonly path: string;
      readonly type: "file";
      readonly mode: number;
      readonly size: number;
      readonly sha256: string;
    }
  | { readonly path: string; readonly type: "symlink"; readonly target: string };

function readFileSha256(filePath: string, buffer: Buffer): string {
  const hash = createHash("sha256");
  const file = openSync(filePath, "r");
  try {
    let size = readSync(file, buffer, 0, buffer.length, null);
    while (size > 0) {
      hash.update(buffer.subarray(0, size));
      size = readSync(file, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } finally {
    closeSync(file);
  }
}

function assertInternalSymlink(root: string, relativePath: string, target: string): void {
  const resolvedTarget = path.resolve(root, path.dirname(relativePath), target);
  const relativeTarget = path.relative(root, resolvedTarget);
  if (
    path.isAbsolute(target) ||
    path.isAbsolute(relativeTarget) ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`Immutable directory symlink escapes its content root: ${relativePath}`);
  }
}

function readDirectoryInventory(root: string): DirectoryInventoryEntry[] {
  if (!lstatSync(root).isDirectory()) {
    throw new Error(`Immutable directory content must be a real directory: ${root}`);
  }
  const entries: DirectoryInventoryEntry[] = [];
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const visit = (relativePath: string): void => {
    const absolutePath = path.join(root, relativePath);
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolutePath);
      assertInternalSymlink(root, relativePath, target);
      entries.push({ path: relativePath, target, type: "symlink" });
      return;
    }
    const mode = stat.mode & 0o777;
    if (stat.isFile()) {
      entries.push({
        mode,
        path: relativePath,
        sha256: readFileSha256(absolutePath, buffer),
        size: stat.size,
        type: "file",
      });
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Unsupported immutable directory entry: ${relativePath}`);
    }
    entries.push({ mode, path: relativePath, type: "directory" });
    for (const name of readdirSync(absolutePath).sort()) visit(path.join(relativePath, name));
  };
  visit("");
  return entries;
}

function directoryInventoryJson(contentPath: string): string {
  return `${JSON.stringify({ version: 1, entries: readDirectoryInventory(contentPath) })}\n`;
}

/** Identifies a complete independent output tree, including contents, modes and internal links. */
export function immutableDirectoryDigest(directoryPath: string): string {
  return createHash("sha256").update(directoryInventoryJson(directoryPath)).digest("hex");
}

async function validateImmutableDirectory(
  entryPath: string,
  validate: EnsureImmutableDirectoryInput["validate"],
): Promise<void> {
  if (!lstatSync(entryPath).isDirectory()) {
    throw new Error(`Immutable directory cache entry must be a real directory: ${entryPath}`);
  }
  const contentPath = path.join(entryPath, DIRECTORY_CONTENT_NAME);
  const actualInventory = directoryInventoryJson(contentPath);
  const inventoryPath = path.join(entryPath, DIRECTORY_INVENTORY_NAME);
  if (
    !lstatSync(inventoryPath).isFile() ||
    readFileSync(inventoryPath, "utf8") !== actualInventory
  ) {
    throw new Error(`Immutable directory cache inventory mismatch: ${entryPath}`);
  }
  await validate(contentPath);
}

async function validImmutableDirectoryExists(
  destinationPath: string,
  validate: EnsureImmutableDirectoryInput["validate"],
): Promise<boolean> {
  if (!existsSync(destinationPath)) return false;
  try {
    await validateImmutableDirectory(destinationPath, validate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Publishes a sealed extraction once. Generation, validation and consumption receive its content
 * directory; consume runs under the cache lock so a repair cannot remove files being cloned.
 */
export async function ensureImmutableDirectory(
  input: EnsureImmutableDirectoryInput,
  consume?: (directoryPath: string) => Promise<void> | void,
): Promise<void> {
  mkdirSync(path.dirname(input.destinationPath), { mode: 0o700, recursive: true });
  const lock = await acquireCacheLock({
    allowValidatedResult: false,
    destinationPath: input.destinationPath,
    replaceInvalid: true,
    validate: () => {},
  });
  if (!lock)
    throw new Error(`Failed to acquire immutable directory lock: ${input.destinationPath}`);

  const temporaryPath = `${input.destinationPath}.part-${process.pid}-${randomUUID()}`;
  try {
    if (!(await validImmutableDirectoryExists(input.destinationPath, input.validate))) {
      rmSync(input.destinationPath, { force: true, recursive: true });
      removeAbandonedPartialFiles(input.destinationPath);
      mkdirSync(temporaryPath, { mode: 0o700 });
      const contentPath = path.join(temporaryPath, DIRECTORY_CONTENT_NAME);
      await input.generate(contentPath);
      await input.validate(contentPath);
      writeFileSync(
        path.join(temporaryPath, DIRECTORY_INVENTORY_NAME),
        directoryInventoryJson(contentPath),
        {
          flag: "wx",
          mode: 0o600,
        },
      );
      renameSync(temporaryPath, input.destinationPath);
    }
    await consume?.(path.join(input.destinationPath, DIRECTORY_CONTENT_NAME));
  } catch (error) {
    throw new Error(`Failed to prepare ${input.label}: ${errorChain(error)}`, { cause: error });
  } finally {
    rmSync(temporaryPath, { force: true, recursive: true });
    lock.release();
  }
}

/** Makes independent files using a filesystem clone where available, with an ordinary-copy fallback. */
export function cloneImmutableFile(sourcePath: string, destinationPath: string): void {
  const source = statSync(sourcePath);
  if (!source.isFile())
    throw new Error(`Immutable file source must be a regular file: ${sourcePath}`);
  try {
    const destination = statSync(destinationPath);
    if (source.dev === destination.dev && source.ino === destination.ino) {
      throw new Error("Immutable file source and destination must be different files");
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  rmSync(destinationPath, { force: true });
  if (process.platform === "darwin") {
    // Node 24/libuv 1.51 returns ENOSYS for APFS FICLONE; cp -c uses native clonefile instead.
    execFileSync("/bin/cp", ["-cp", path.resolve(sourcePath), path.resolve(destinationPath)]);
    return;
  }
  copyFileSync(sourcePath, destinationPath, constants.COPYFILE_FICLONE);
}

function assertCloneDirectoryTree(root: string, relativePath = ""): void {
  const absolutePath = path.join(root, relativePath);
  const stat = lstatSync(absolutePath);
  if (stat.isSymbolicLink()) {
    assertInternalSymlink(root, relativePath, readlinkSync(absolutePath));
    return;
  }
  if (stat.isFile()) return;
  if (!stat.isDirectory())
    throw new Error(`Unsupported immutable directory entry: ${absolutePath}`);
  for (const name of readdirSync(absolutePath))
    assertCloneDirectoryTree(root, path.join(relativePath, name));
}

function assertEmptyDirectoryDestination(sourcePath: string, destinationPath: string): void {
  const relativeDestination = path.relative(
    path.resolve(sourcePath),
    path.resolve(destinationPath),
  );
  if (
    relativeDestination === "" ||
    (!path.isAbsolute(relativeDestination) &&
      relativeDestination !== ".." &&
      !relativeDestination.startsWith(`..${path.sep}`))
  ) {
    throw new Error("Immutable directory destination must be outside its source tree");
  }
  try {
    if (!lstatSync(destinationPath).isDirectory() || readdirSync(destinationPath).length > 0) {
      throw new Error(
        `Immutable directory destination must be absent or empty: ${destinationPath}`,
      );
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error;
  }
}

/** Clones a tree into an absent or empty directory, preserving modes and internal relative symlinks. */
export function cloneImmutableDirectory(sourcePath: string, destinationPath: string): void {
  const source = lstatSync(sourcePath);
  if (!source.isDirectory()) {
    throw new Error(`Immutable directory source must be a real directory: ${sourcePath}`);
  }
  assertEmptyDirectoryDestination(sourcePath, destinationPath);
  assertCloneDirectoryTree(sourcePath);
  mkdirSync(path.dirname(destinationPath), { recursive: true });
  if (process.platform === "darwin") {
    // One native tree clone avoids a subprocess for every runtime file; -c falls back across volumes.
    execFileSync("/bin/cp", [
      "-cRpP",
      `${path.resolve(sourcePath)}${path.sep}`,
      path.resolve(destinationPath),
    ]);
    return;
  }
  cpSync(sourcePath, destinationPath, {
    mode: constants.COPYFILE_FICLONE,
    recursive: true,
    verbatimSymlinks: true,
  });
  // cpSync preserves newly created directories, but leaves an existing root's mode unchanged.
  chmodSync(destinationPath, source.mode & 0o7777);
}
