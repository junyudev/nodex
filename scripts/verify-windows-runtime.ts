import { join, resolve } from "node:path";
import { desktopBuildTarget } from "./desktop-build-target";
import { assertDesktopRuntimePayload } from "./desktop-runtime-payload.mjs";
import { verifyWindowsArchitectureClosure } from "./windows-pe.mjs";

const [root, arch = process.arch, mode, ...extra] = process.argv.slice(2);
if (!root || (mode !== undefined && mode !== "--packaged") || extra.length > 0)
  throw new Error("Usage: verify-windows-runtime.ts <root> [x64|arm64] [--packaged]");
const target = desktopBuildTarget("win32", arch);
const packaged = mode === "--packaged";
if (packaged) {
  assertDesktopRuntimePayload({
    platform: "win32",
    arch: target.arch,
    resourcesPath: join(root, "resources"),
  });
}
const files = verifyWindowsArchitectureClosure(resolve(root), target.arch, {
  nodeHost: packaged ? join(root, "Nodex.exe") : undefined,
});
process.stdout.write(`Verified ${files.length} ${target.key} native images in ${root}.\n`);
