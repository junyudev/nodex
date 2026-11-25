import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** Resolve symlinks in the part of a directory path that already exists. */
function canonicalDirectory(
  directory: string,
  paths: typeof path.posix,
  realpath: (absolutePath: string) => string | null,
): string {
  let ancestor = directory;
  for (;;) {
    const canonical = realpath(ancestor);
    if (canonical !== null) return paths.resolve(canonical, paths.relative(ancestor, directory));
    const parent = paths.dirname(ancestor);
    if (parent === ancestor) return directory;
    ancestor = parent;
  }
}

export function isInsideSystemTempDirectory(
  directory: string,
  options: {
    readonly tempDirectory: string;
    readonly platform: NodeJS.Platform;
    readonly realpath: (absolutePath: string) => string | null;
  },
): boolean {
  const paths = options.platform === "win32" ? path.win32 : path.posix;
  const candidate = paths.resolve(directory);
  const systemTemp = paths.resolve(options.tempDirectory);
  // /tmp stays temporary even when the system sets TMPDIR to a different directory.
  const tempRoots =
    options.platform === "win32" || systemTemp === "/tmp" ? [systemTemp] : [systemTemp, "/tmp"];
  const contains = (root: string, entry: string) => {
    const relative = paths.relative(root, entry);
    return (
      relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
    );
  };

  if (tempRoots.some((root) => contains(root, candidate))) return true;

  const canonicalCandidate = canonicalDirectory(candidate, paths, options.realpath);
  // Keep both spellings. A symlink stored in a temporary directory can be removed too.
  return tempRoots.some((root) => {
    const canonicalRoot = canonicalDirectory(root, paths, options.realpath);
    return (
      contains(root, canonicalCandidate) ||
      contains(canonicalRoot, candidate) ||
      contains(canonicalRoot, canonicalCandidate)
    );
  });
}

export function isSystemTempDirectory(directory: string): boolean {
  return isInsideSystemTempDirectory(directory, {
    tempDirectory: tmpdir(),
    platform: process.platform,
    realpath: (absolutePath) => {
      try {
        return realpathSync.native(absolutePath);
      } catch {
        return null;
      }
    },
  });
}
