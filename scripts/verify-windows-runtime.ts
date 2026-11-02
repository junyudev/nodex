import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { desktopBuildTarget } from "./desktop-build-target";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

const [root, arch = process.arch] = process.argv.slice(2);
if (!root || process.argv.length > 4)
  throw new Error("Usage: verify-windows-runtime.ts <root> [x64|arm64]");
const target = desktopBuildTarget("win32", arch);
const files = verifyWindowsArchitectureClosure(resolve(root), target.arch, {
  nodeHost: existsSync(join(root, "Nodex.exe")) ? join(root, "Nodex.exe") : undefined,
});
process.stdout.write(`Verified ${files.length} ${target.key} native images in ${root}.\n`);
