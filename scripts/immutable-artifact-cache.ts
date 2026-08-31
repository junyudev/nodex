import { randomUUID } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export const LOCAL_ARTIFACT_CACHE_DIRECTORY = "cache.local";

export type ImmutableArtifactFamily = "agent-runtime" | "browser-runtime" | "sparkle";

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

/** Resolves one verified archive beneath the machine-local cache family root. */
export function resolveImmutableArtifactPath(input: ImmutableArtifactPathInput): string {
  if (!SHA256_PATTERN.test(input.archiveSha256)) {
    throw new Error(`Invalid immutable artifact SHA-256: ${input.archiveSha256}`);
  }
  assertAssetName(input.assetName);
  const familyRoot = path.resolve(
    input.cachePath ?? path.join(input.projectRoot, LOCAL_ARTIFACT_CACHE_DIRECTORY, input.family),
  );
  return path.join(familyRoot, input.archiveSha256, input.assetName);
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

    if (validArtifactExists(input.destinationPath, input.validate, input.replaceInvalid)) {
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
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    rmSync(path.join(parent, entry.name), { force: true });
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
