import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const windowsDrivePrefix = /^[a-z]:/iu;
const windowsAbsolutePath = /^[a-z]:[\\/]/iu;
const windowsUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u;

/** Resolve authored image URLs on their source host; foreign native paths are never guessed. */
export function resolveMarkdownImagePath(
  sourcePath: string,
  sourceCwd: string,
  platform: "win32" | "posix",
): string {
  const windows = platform === "win32";
  if (windowsDrivePrefix.test(sourcePath) || windowsUncPath.test(sourcePath)) {
    if (!windows)
      throw new Error(
        "A reply in this conversation links a Windows image path this computer cannot read.",
      );
    if (!windowsAbsolutePath.test(sourcePath) && !windowsUncPath.test(sourcePath))
      throw new Error("A reply in this conversation links a relative Windows image path.");
    return nodePath.win32.normalize(decodeURIComponent(sourcePath));
  }
  const path = windows ? nodePath.win32 : nodePath.posix;
  const url = new URL(sourcePath, pathToFileURL(`${sourceCwd}${path.sep}`, { windows }));
  if (!windows && /^\/[a-z]:[\\/]/iu.test(url.pathname))
    throw new Error(
      "A reply in this conversation links a Windows image path this computer cannot read.",
    );
  return fileURLToPath(url, { windows });
}
