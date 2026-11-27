/* @effect-diagnostics asyncFunction:off -- File streaming and atomic cache publication are Node filesystem boundaries. */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isPortableFileName } from "../../../shared/portable-file-name";
import { openRegularFile } from "./open-regular-file";

const readOnlyMode = 0o444;

const isFsError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const missingEntry = (error: unknown): undefined => {
  if (isFsError(error, "ENOENT")) return undefined;
  throw error;
};

const fileExportPath = (root: string, hash: string, defaultName: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid File export content address");
  if (isPortableFileName(defaultName)) return path.join(root, hash, defaultName);
  const suffix = path.extname(defaultName);
  const extension = /^\.[a-zA-Z0-9]{1,20}$/u.test(suffix) ? suffix : ".blob";
  return path.join(root, hash, `File${extension}`);
};

// A hash directory can contain names that alias on a case-insensitive filesystem.
const directoryOperations = new Map<string, Promise<void>>();

const withExportDirectory = async <T>(
  directory: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const pending = (directoryOperations.get(directory) ?? Promise.resolve()).then(operation);
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  directoryOperations.set(directory, settled);
  try {
    return await pending;
  } finally {
    if (directoryOperations.get(directory) === settled) directoryOperations.delete(directory);
  }
};

const privateDirectory = async (directory: string, create: boolean): Promise<boolean> => {
  let stat = await fs.lstat(directory).catch(missingEntry);
  if (!stat && create) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    stat = await fs.lstat(directory);
  }
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("File export cache must be a directory");
  return true;
};

const cacheDirectories = async (
  root: string,
  directory: string,
  create: boolean,
): Promise<boolean> => {
  for (const entry of [path.dirname(root), root, directory]) {
    if (!(await privateDirectory(entry, create))) return false;
  }
  return true;
};

/** Bounded asynchronous reads keep cache validation off Main's synchronous I/O path. */
const matchesBytes = async (
  file: fs.FileHandle,
  hash: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<boolean> => {
  const digest = createHash("sha256");
  const chunk = new Uint8Array(64 * 1024);
  let length = 0;
  while (length < byteLength) {
    signal.throwIfAborted();
    const { bytesRead } = await file.read(
      chunk,
      0,
      Math.min(chunk.byteLength, byteLength - length),
      length,
    );
    if (bytesRead === 0) return false;
    digest.update(chunk.subarray(0, bytesRead));
    length += bytesRead;
  }
  return digest.digest("hex") === hash;
};

const reuseFileExport = async (
  target: string,
  hash: string,
  byteLength: number,
  signal: AbortSignal,
  removeInvalid = false,
): Promise<boolean> => {
  signal.throwIfAborted();
  const file = await openRegularFile(target).catch(missingEntry);
  if (!file) return false;
  try {
    const original = await file.stat({ bigint: true });
    const matches =
      original.size === BigInt(byteLength) && (await matchesBytes(file, hash, byteLength, signal));
    const current = await fs.lstat(target, { bigint: true }).catch(missingEntry);
    if (!current) return false;
    if (
      !current.isFile() ||
      current.dev !== original.dev ||
      current.ino !== original.ino ||
      current.ctimeNs !== original.ctimeNs ||
      current.mtimeNs !== original.mtimeNs ||
      current.size !== original.size
    )
      throw new Error("Cached File export changed during verification");

    signal.throwIfAborted();
    const readOnly = (current.mode & 0o7777n) === BigInt(readOnlyMode);
    if (matches && readOnly) return true;
    if (matches && current.nlink === 1n) {
      await file.chmod(readOnlyMode);
      return true;
    }
    // A writable hard link may share permissions with a file outside the cache.
    if (removeInvalid) await fs.unlink(target);
    return false;
  } finally {
    await file.close();
  }
};

export const findFileExport = async (
  root: string,
  hash: string,
  defaultName: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<string | null> => {
  const target = fileExportPath(root, hash, defaultName);
  const directory = path.dirname(target);
  return withExportDirectory(directory, async () => {
    if (!(await cacheDirectories(root, directory, false))) return null;
    return (await reuseFileExport(target, hash, byteLength, signal)) ? target : null;
  });
};

/** Stage and verify a replacement before removing an invalid export. Link without overwriting. */
export const publishFileExport = async (
  root: string,
  hash: string,
  defaultName: string,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<string> => {
  const target = fileExportPath(root, hash, defaultName);
  const directory = path.dirname(target);
  return withExportDirectory(directory, async () => {
    signal.throwIfAborted();
    const staging = path.join(root, ".staging");
    if (
      !(await cacheDirectories(root, directory, true)) ||
      !(await privateDirectory(staging, true))
    )
      throw new Error("File export cache disappeared");

    if (await reuseFileExport(target, hash, bytes.byteLength, signal)) return target;

    const temporary = path.join(staging, `${randomUUID()}.tmp`);
    const file = await fs.open(temporary, "wx+", 0o600);
    try {
      try {
        await file.writeFile(bytes, { signal });
        await file.sync();
        const stat = await file.stat();
        if (
          stat.size !== bytes.byteLength ||
          !(await matchesBytes(file, hash, bytes.byteLength, signal))
        )
          throw new Error("Staged File export content does not match");
      } finally {
        await file.close();
      }

      if (await reuseFileExport(target, hash, bytes.byteLength, signal, true)) return target;
      try {
        await fs.link(temporary, target);
      } catch (error) {
        if (!isFsError(error, "EEXIST")) throw error;
      }
    } finally {
      // Windows shares the read-only attribute across hard links. Drop the staging name first.
      await fs.unlink(temporary);
    }
    if (!(await reuseFileExport(target, hash, bytes.byteLength, signal)))
      throw new Error("Published File export content does not match");
    return target;
  });
};
