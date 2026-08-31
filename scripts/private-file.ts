import { randomUUID } from "node:crypto";
import { chmod, lstat, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

export const resolveRegularPrivateFileSource = async (
  source: string,
  label: string,
): Promise<string> => {
  const resolved = await realpath(path.resolve(source));
  const stats = await lstat(resolved);
  if (!stats.isFile()) {
    throw new Error(`${label} must be a regular file: ${resolved}`);
  }
  return resolved;
};

/** Installs a private file atomically so interrupted writers never expose partial credentials. */
export const installPrivateFile = async (
  destination: string,
  write: (temporaryPath: string) => Promise<void>,
): Promise<void> => {
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await write(temporaryPath);
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, destination);
    await chmod(destination, 0o600);
  } finally {
    await rm(temporaryPath, { force: true });
  }
};
