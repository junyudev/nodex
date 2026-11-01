import {
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { decodeBoundedJson, encodeBoundedJson } from "./codec";

export const ISOLATED_RUN_ID_ENV = "NODEX_INTERNAL_ISOLATED_RUN_ID";
export const ISOLATED_RUN_LEASE_DIRECTORY_NAME = "isolated-supervisor.lock";

const OWNER_FILE_NAME = "owner.json";
const CLAIM_FILE_NAME = "host-claim.json";
const DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_METADATA_BYTES = 4 * 1024;
const OWNER_PUBLICATION_RETRIES = 10;
const OWNER_PUBLICATION_RETRY_MS = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export interface IsolatedRunLeaseOwner {
  readonly version: 1;
  readonly runId: string;
  readonly supervisorPid: number;
  readonly acquiredAt: string;
}

export interface IsolatedRunClaim {
  readonly version: 1;
  readonly runId: string;
  readonly hostPid: number;
  readonly phase: "starting" | "ready";
  readonly claimedAt: string;
  readonly readyAt: string | null;
}

export interface IsolatedRunLease {
  readonly owner: IsolatedRunLeaseOwner;
  release(): void;
}

export type IsolatedRunBootstrapAccess =
  | { readonly kind: "ordinary" }
  | { readonly kind: "supervised"; readonly runId: string };

interface IsolatedRunPaths {
  readonly runDirectory: string;
  readonly leaseDirectory: string;
  readonly ownerPath: string;
  readonly claimPath: string;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFileSystemError = (error: unknown, code: string): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === code;

const assertOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  label: string,
): void => {
  const expected = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  if (unknown.length === 0) return;
  throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
};

const requireCanonicalRunId = (value: unknown, label = "Isolated run ID"): string => {
  if (typeof value === "string" && UUID_PATTERN.test(value)) return value;
  throw new Error(`${label} is invalid`);
};

const requirePid = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  throw new Error(`${label} is invalid`);
};

const requireIsoTimestamp = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length > 64) {
    throw new Error(`${label} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new Error(`${label} is invalid`);
  }
  return value;
};

const requireNullableIsoTimestamp = (value: unknown, label: string): string | null => {
  if (value === null) return null;
  return requireIsoTimestamp(value, label);
};

const requireAbsoluteNodexHome = (nodexHome: string): string => {
  if (!path.isAbsolute(nodexHome)) throw new Error("Nodex home must be absolute");
  return path.normalize(nodexHome);
};

const isolatedRunPaths = (nodexHome: string): IsolatedRunPaths => {
  const normalizedHome = requireAbsoluteNodexHome(nodexHome);
  const runDirectory = path.join(normalizedHome, "run");
  const leaseDirectory = path.join(runDirectory, ISOLATED_RUN_LEASE_DIRECTORY_NAME);
  return {
    runDirectory,
    leaseDirectory,
    ownerPath: path.join(leaseDirectory, OWNER_FILE_NAME),
    claimPath: path.join(leaseDirectory, CLAIM_FILE_NAME),
  };
};

export const isolatedRunLeaseDirectory = (nodexHome: string): string =>
  isolatedRunPaths(nodexHome).leaseDirectory;

const assertOwned = (stats: Stats, label: string): void => {
  const currentUid = process.getuid?.();
  if (currentUid === undefined || stats.uid === currentUid) return;
  throw new Error(`${label} is not owned by the current user`);
};

const assertMode = (stats: Stats, expected: number, label: string): void => {
  // Node's Windows mode bits do not describe the directory's inherited user ACL.
  if (process.platform === "win32") return;
  const actual = stats.mode & 0o777;
  if (actual === expected) return;
  throw new Error(`${label} has mode ${actual.toString(8)}; expected ${expected.toString(8)}`);
};

const inspectDirectory = (directory: string, label: string): Stats => {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stats.isDirectory()) throw new Error(`${label} must be a directory`);
  assertOwned(stats, label);
  assertMode(stats, DIRECTORY_MODE, label);
  return stats;
};

const inspectPrivateFile = (filePath: string, label: string): Stats => {
  const stats = lstatSync(filePath);
  if (stats.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stats.isFile()) throw new Error(`${label} must be a regular file`);
  assertOwned(stats, label);
  assertMode(stats, PRIVATE_FILE_MODE, label);
  if (stats.size > MAX_METADATA_BYTES) throw new Error(`${label} is oversized`);
  return stats;
};

const readMetadata = (filePath: string, label: string): unknown => {
  inspectPrivateFile(filePath, label);
  return decodeBoundedJson<unknown>(readFileSync(filePath), MAX_METADATA_BYTES, label);
};

const parseOwner = (value: unknown): IsolatedRunLeaseOwner => {
  if (!isRecord(value)) {
    throw new Error("Isolated run lease owner must be an object");
  }
  assertOnlyKeys(
    value,
    ["version", "runId", "supervisorPid", "acquiredAt"],
    "Isolated run lease owner",
  );
  if (value.version !== 1) {
    throw new Error("Isolated run lease owner version is unsupported");
  }
  return {
    version: 1,
    runId: requireCanonicalRunId(value.runId),
    supervisorPid: requirePid(value.supervisorPid, "Isolated run supervisor PID"),
    acquiredAt: requireIsoTimestamp(value.acquiredAt, "Isolated run lease acquisition time"),
  };
};

const parseClaim = (value: unknown): IsolatedRunClaim => {
  if (!isRecord(value)) throw new Error("Isolated run claim must be an object");
  assertOnlyKeys(
    value,
    ["version", "runId", "hostPid", "phase", "claimedAt", "readyAt"],
    "Isolated run claim",
  );
  if (value.version !== 1) {
    throw new Error("Isolated run claim version is unsupported");
  }
  const phase = value.phase;
  if (phase !== "starting" && phase !== "ready") {
    throw new Error("Isolated run claim phase is invalid");
  }
  const readyAt = requireNullableIsoTimestamp(value.readyAt, "Isolated run ready time");
  if ((phase === "starting" && readyAt !== null) || (phase === "ready" && readyAt === null)) {
    throw new Error("Isolated run claim phase and ready time disagree");
  }
  return {
    version: 1,
    runId: requireCanonicalRunId(value.runId),
    hostPid: requirePid(value.hostPid, "Isolated run host PID"),
    phase,
    claimedAt: requireIsoTimestamp(value.claimedAt, "Isolated run claim time"),
    readyAt,
  };
};

const readOwnerAtPath = (ownerPath: string): IsolatedRunLeaseOwner =>
  parseOwner(readMetadata(ownerPath, "Isolated run lease owner"));

const readClaimAtPath = (claimPath: string): IsolatedRunClaim =>
  parseClaim(readMetadata(claimPath, "Isolated run claim"));

const fsyncDirectory = (directory: string): void => {
  // Windows cannot open directories through this Node API. Metadata files are still flushed
  // before atomic publication, and layout/generation validation remains mandatory on every OS.
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const writePrivateTemporaryFile = (directory: string, prefix: string, value: unknown): string => {
  const bytes = encodeBoundedJson(value, MAX_METADATA_BYTES, prefix);
  const temporaryPath = path.join(directory, `.${prefix}.${process.pid}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporaryPath, "wx", PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return temporaryPath;
};

const ensureNodexHomeAndRunDirectory = (paths: IsolatedRunPaths): void => {
  inspectDirectory(path.dirname(paths.runDirectory), "Nodex home");
  try {
    mkdirSync(paths.runDirectory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
  }
  inspectDirectory(paths.runDirectory, "Nodex run directory");
};

const publishOwner = (paths: IsolatedRunPaths, owner: IsolatedRunLeaseOwner): void => {
  const temporaryPath = writePrivateTemporaryFile(paths.leaseDirectory, "owner", owner);
  try {
    renameSync(temporaryPath, paths.ownerPath);
    fsyncDirectory(paths.leaseDirectory);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
};

const waitForOwnerPublication = (): void => {
  const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  Atomics.wait(signal, 0, 0, OWNER_PUBLICATION_RETRY_MS);
};

const readExistingOwnerAfterContention = (paths: IsolatedRunPaths): IsolatedRunLeaseOwner => {
  for (let attempt = 0; attempt <= OWNER_PUBLICATION_RETRIES; attempt += 1) {
    inspectDirectory(paths.leaseDirectory, "Isolated run lease directory");
    try {
      return readOwnerAtPath(paths.ownerPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      if (attempt === OWNER_PUBLICATION_RETRIES) {
        throw new Error(
          "Isolated run lease is incomplete; preserve the Profile and inspect it manually",
          { cause: error },
        );
      }
      waitForOwnerPublication();
    }
  }
  throw new Error("Isolated run lease owner could not be read");
};

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isFileSystemError(error, "ESRCH")) return false;
    if (isFileSystemError(error, "EPERM")) return true;
    throw error;
  }
};

const releaseLease = (paths: IsolatedRunPaths, runId: string): void => {
  inspectDirectory(paths.leaseDirectory, "Isolated run lease directory");
  const owner = readOwnerAtPath(paths.ownerPath);
  if (owner.runId !== runId) {
    throw new Error("Isolated run lease ownership changed before release");
  }

  const entries = readdirSync(paths.leaseDirectory).sort();
  const allowedEntries = new Set([OWNER_FILE_NAME, CLAIM_FILE_NAME]);
  const unknownEntry = entries.find((entry) => !allowedEntries.has(entry));
  if (unknownEntry) {
    throw new Error(`Isolated run lease contains an unexpected entry: ${unknownEntry}`);
  }

  if (entries.includes(CLAIM_FILE_NAME)) {
    const claim = readClaimAtPath(paths.claimPath);
    if (claim.runId !== runId) {
      throw new Error("Isolated run claim ownership changed before release");
    }
  }

  if (entries.includes(CLAIM_FILE_NAME)) unlinkSync(paths.claimPath);
  unlinkSync(paths.ownerPath);
  rmdirSync(paths.leaseDirectory);
  fsyncDirectory(paths.runDirectory);
};

export function acquireIsolatedRunLease(input: {
  readonly nodexHome: string;
  readonly runId: string;
  readonly supervisorPid: number;
  readonly now?: Date;
}): IsolatedRunLease {
  const paths = isolatedRunPaths(input.nodexHome);
  const runId = requireCanonicalRunId(input.runId);
  const supervisorPid = requirePid(input.supervisorPid, "Isolated run supervisor PID");
  const owner: IsolatedRunLeaseOwner = {
    version: 1,
    runId,
    supervisorPid,
    acquiredAt: (input.now ?? new Date()).toISOString(),
  };

  ensureNodexHomeAndRunDirectory(paths);
  try {
    mkdirSync(paths.leaseDirectory, { mode: DIRECTORY_MODE });
  } catch (error) {
    if (!isFileSystemError(error, "EEXIST")) throw error;
    const existing = readExistingOwnerAfterContention(paths);
    if (isProcessAlive(existing.supervisorPid)) {
      throw new Error(
        `Another isolated run owns this Profile (supervisor PID ${existing.supervisorPid})`,
        { cause: error },
      );
    }
    throw new Error(
      "A stale isolated run lease owns this Profile; verify that Core is stopped before removing the validated lease manually",
      { cause: error },
    );
  }

  try {
    inspectDirectory(paths.leaseDirectory, "Isolated run lease directory");
    publishOwner(paths, owner);
  } catch (error) {
    try {
      rmdirSync(paths.leaseDirectory);
    } catch {
      // Leave partial evidence in place when safe rollback is not possible.
    }
    throw error;
  }

  let released = false;
  return {
    owner,
    release: () => {
      if (released) return;
      releaseLease(paths, runId);
      released = true;
    },
  };
}

export function readIsolatedRunLeaseOwner(nodexHome: string): IsolatedRunLeaseOwner | null {
  const paths = isolatedRunPaths(nodexHome);
  try {
    inspectDirectory(paths.leaseDirectory, "Isolated run lease directory");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
  return readOwnerAtPath(paths.ownerPath);
}

export function readIsolatedRunClaim(nodexHome: string): IsolatedRunClaim | null {
  const paths = isolatedRunPaths(nodexHome);
  const owner = readIsolatedRunLeaseOwner(nodexHome);
  if (!owner) return null;
  try {
    const claim = readClaimAtPath(paths.claimPath);
    if (claim.runId === owner.runId) return claim;
    throw new Error("Isolated run claim does not match its lease");
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) return null;
    throw error;
  }
}

export function publishIsolatedRunClaim(input: {
  readonly nodexHome: string;
  readonly runId: string;
  readonly hostPid: number;
  readonly now?: Date;
}): IsolatedRunClaim {
  const paths = isolatedRunPaths(input.nodexHome);
  const runId = requireCanonicalRunId(input.runId);
  const hostPid = requirePid(input.hostPid, "Isolated run host PID");
  const owner = readIsolatedRunLeaseOwner(input.nodexHome);
  if (!owner || owner.runId !== runId) {
    throw new Error("Isolated run claim requires its matching live lease");
  }

  const existing = readIsolatedRunClaim(input.nodexHome);
  if (existing) {
    if (existing.runId === runId) return existing;
    throw new Error("Another isolated run already claimed this Profile");
  }

  const claim: IsolatedRunClaim = {
    version: 1,
    runId,
    hostPid,
    phase: "starting",
    claimedAt: (input.now ?? new Date()).toISOString(),
    readyAt: null,
  };
  const temporaryPath = writePrivateTemporaryFile(paths.leaseDirectory, "host-claim", claim);
  try {
    try {
      linkSync(temporaryPath, paths.claimPath);
      fsyncDirectory(paths.leaseDirectory);
      return claim;
    } catch (error) {
      if (!isFileSystemError(error, "EEXIST")) throw error;
      const racedClaim = readClaimAtPath(paths.claimPath);
      if (racedClaim.runId === runId) return racedClaim;
      throw new Error("Another isolated run already claimed this Profile", { cause: error });
    }
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

export function markIsolatedRunClaimReady(input: {
  readonly nodexHome: string;
  readonly runId: string;
  readonly now?: Date;
}): IsolatedRunClaim {
  const paths = isolatedRunPaths(input.nodexHome);
  const runId = requireCanonicalRunId(input.runId);
  const owner = readIsolatedRunLeaseOwner(input.nodexHome);
  if (!owner || owner.runId !== runId) {
    throw new Error("Isolated run readiness requires its matching live lease");
  }
  const claim = readIsolatedRunClaim(input.nodexHome);
  if (!claim || claim.runId !== runId) {
    throw new Error("Isolated run readiness requires its primary-host claim");
  }
  if (claim.phase === "ready") return claim;

  const readyClaim: IsolatedRunClaim = {
    ...claim,
    phase: "ready",
    readyAt: (input.now ?? new Date()).toISOString(),
  };
  const temporaryPath = writePrivateTemporaryFile(
    paths.leaseDirectory,
    "host-claim-ready",
    readyClaim,
  );
  try {
    const currentClaim = readClaimAtPath(paths.claimPath);
    if (currentClaim.runId !== runId) {
      throw new Error("Isolated run claim ownership changed before readiness");
    }
    if (currentClaim.phase === "ready") return currentClaim;
    renameSync(temporaryPath, paths.claimPath);
    fsyncDirectory(paths.leaseDirectory);
    return readyClaim;
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
    }
  }
}

export function resolveIsolatedRunBootstrapAccess(input: {
  readonly nodexHome: string;
  readonly inheritedRunId: string | undefined;
}): IsolatedRunBootstrapAccess {
  const owner = readIsolatedRunLeaseOwner(input.nodexHome);
  if (!owner && input.inheritedRunId === undefined) return { kind: "ordinary" };
  if (!owner) {
    requireCanonicalRunId(input.inheritedRunId);
    throw new Error("Isolated run ID has no matching supervisor lease");
  }
  if (input.inheritedRunId === undefined) {
    throw new Error("Profile is managed by an isolated-run supervisor");
  }
  const runId = requireCanonicalRunId(input.inheritedRunId);
  if (owner.runId !== runId) {
    throw new Error("Profile is managed by a different isolated-run supervisor");
  }
  return { kind: "supervised", runId };
}
