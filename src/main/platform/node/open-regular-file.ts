import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

/** Reject substituted links on Windows as well as hosts that support O_NOFOLLOW. */
export async function openRegularFile(filePath: string) {
  const entry = await lstat(filePath, { bigint: true });
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Expected a regular file");
  const file = await open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await file.stat({ bigint: true });
    const current = await lstat(filePath, { bigint: true });
    if (
      !opened.isFile() ||
      !current.isFile() ||
      current.isSymbolicLink() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino
    )
      throw new Error("File identity changed while it was being opened");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}
