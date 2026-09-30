// @effect-diagnostics asyncFunction:off - Filesystem reads are the Node capability boundary.
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Native history identity follows the physical home, including configured symlink aliases. */
export async function canonicalNativeSessionHome(home: string): Promise<string> {
  if (!isAbsolute(home)) throw new Error("Native conversation home must be an absolute path.");
  if (!(await stat(home)).isDirectory())
    throw new Error("Native conversation home must be a directory.");
  return realpath(home);
}

/** A missing workspace is unavailable; connecting never silently substitutes a different cwd. */
export async function nativeSessionCwdAvailable(cwd: string): Promise<boolean> {
  if (!isAbsolute(cwd) || Buffer.byteLength(cwd, "utf8") > 4096) return false;
  try {
    return (await stat(cwd)).isDirectory();
  } catch {
    return false;
  }
}
