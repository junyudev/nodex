/* oxlint-disable effecttsgo/async-function -- File streaming and atomic cache publication are Node filesystem boundaries. */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

export const fileExportPath = (root: string, hash: string, defaultName: string): string => {
  if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error("Invalid File export content address");
  const suffix = path.extname(defaultName);
  const extension = /^\.[a-zA-Z0-9]{1,20}$/u.test(suffix) ? suffix : ".blob";
  return path.join(root, `${hash}${extension}`);
};

/** Bounded asynchronous reads keep cache validation off Main's synchronous I/O path. */
export const verifyFileExport = async (
  filePath: string,
  hash: string,
  byteLength: number,
  signal: AbortSignal,
): Promise<boolean> => {
  signal.throwIfAborted();
  let file;
  try {
    file = await fs.open(
      filePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size !== byteLength) throw new Error("Invalid cached File export");
    const digest = createHash("sha256");
    const chunk = new Uint8Array(64 * 1024);
    let length = 0;
    while (length < byteLength) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.byteLength, byteLength - length),
      );
      if (bytesRead === 0) throw new Error("Cached File export was truncated");
      digest.update(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (digest.digest("hex") !== hash) throw new Error("Cached File export content does not match");
    signal.throwIfAborted();
    return true;
  } finally {
    await file.close();
  }
};

const privateDirectory = async (directory: string): Promise<void> => {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("File export cache must be a directory");
};

/** Publishes only verified bytes, never overwriting an existing cache object. */
export const publishFileExport = async (
  root: string,
  filePath: string,
  bytes: Uint8Array,
  hash: string,
  signal: AbortSignal,
): Promise<void> => {
  if (path.dirname(filePath) !== root) throw new Error("File export target is outside its cache");
  const staging = `${root}.staging`;
  await privateDirectory(root);
  await privateDirectory(staging);
  signal.throwIfAborted();
  const temporary = path.join(staging, `${randomUUID()}.tmp`);
  const file = await fs.open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes, { signal });
    await file.sync();
    await verifyFileExport(temporary, hash, bytes.byteLength, signal);
    signal.throwIfAborted();
    try {
      await fs.link(temporary, filePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await verifyFileExport(filePath, hash, bytes.byteLength, signal);
  } finally {
    await file.close();
    await fs.unlink(temporary);
  }
};
