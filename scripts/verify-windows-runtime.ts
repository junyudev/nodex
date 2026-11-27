import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  readBrowserRuntimeReleaseLock,
  resolveBrowserRuntimeReleaseLockPath,
} from "./browser-runtime-release-lock";
import { restorePackagedBrowserRuntimeClosure } from "./restore-packaged-runtime-closure.mjs";
import { desktopBuildTarget } from "./desktop-build-target";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

const [root, arch = process.arch] = process.argv.slice(2);
if (!root || process.argv.length > 4)
  throw new Error("Usage: verify-windows-runtime.ts <root> [x64|arm64]");
const target = desktopBuildTarget("win32", arch);
const desktopToolsRoot = [
  join(root, "resources/browser-runtime"),
  join(root, "agent-runtime/browser-runtime"),
  join(root, "browser-runtime"),
].find(existsSync);
if (desktopToolsRoot) {
  const lock = readBrowserRuntimeReleaseLock(resolveBrowserRuntimeReleaseLockPath(process.cwd()));
  const asset = lock.assets[target.key];
  if (!asset?.url) throw new Error("Unexpected Windows Desktop Tool payload");
  restorePackagedBrowserRuntimeClosure({
    packagedBrowserRoot: desktopToolsRoot,
    sourceBrowserRoot: desktopToolsRoot,
    expectedManifestSha256: asset.manifestSha256,
    windowsArch: target.arch,
    restore: false,
  });
}
const files = verifyWindowsArchitectureClosure(resolve(root), target.arch, {
  desktopToolsRoot: desktopToolsRoot && resolve(desktopToolsRoot),
  nodeHost: existsSync(join(root, "Nodex.exe")) ? join(root, "Nodex.exe") : undefined,
});
process.stdout.write(`Verified ${files.length} ${target.key} native images in ${root}.\n`);
