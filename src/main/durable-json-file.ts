import { closeSync, fsyncSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeDurableJson(
  filePath: string,
  value: unknown,
  maxBytes: number,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(payload, "utf8") > maxBytes) {
    throw new Error("Durable JSON payload exceeds its size limit");
  }
  const temporaryPath = join(
    dirname(filePath),
    `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    await syncDirectory(dirname(filePath));
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

// Node cannot flush Windows directory handles. Every publisher must flush its
// staged file before the atomic rename; POSIX hosts also flush the parent entry.
export async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(directoryPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

export function syncDirectorySync(directoryPath: string): void {
  if (process.platform === "win32") return;
  try {
    const descriptor = openSync(directoryPath, "r");
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
  }
}

export function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
