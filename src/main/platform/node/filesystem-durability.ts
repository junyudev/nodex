import { closeSync, fsyncSync, openSync } from "node:fs";
import { open } from "node:fs/promises";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

// Node cannot flush Windows directory handles. Publishers still flush complete files before rename.
export function syncDirectorySync(directory: string): void {
  if (process.platform === "win32") return;
  const handle = openSync(directory, "r");
  try {
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
}

export async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

/** Preserve the caller's FileSystem capability and its scoped handle lifetime. */
export const syncEffectDirectory = (fs: FileSystem.FileSystem, directory: string) => {
  if (process.platform === "win32") return Effect.void;
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* fs.open(directory, { flag: "r" });
      yield* handle.sync;
    }),
  );
};
