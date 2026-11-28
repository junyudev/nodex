import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { assertPeArchitecture, readPeImports } from "./windows-pe.mjs";

// Retail redistributables only; never debug runtimes, MFC, or arbitrary host DLLs.
export const WINDOWS_VC_RUNTIME_DLLS = Object.freeze([
  "vcruntime140.dll",
  "vcruntime140_1.dll",
  "vcruntime140_threads.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "concrt140.dll",
]);
export const CODEX_CRT_RESOURCES_DIRECTORY = "codex-crt";

const runtimeDlls = new Set(WINDOWS_VC_RUNTIME_DLLS);

/** Map missing retail CRT imports to app-local files beside each consumer. */
export function planWindowsVcRuntime(root, arch, images, redistDirectories) {
  const pending = images.map((file) => ({ source: path.join(root, file), destination: file }));
  const known = new Set(images.map((file) => file.toLowerCase()));
  const copies = [];
  let sources;
  for (let index = 0; index < pending.length; index++) {
    const { source, destination } = pending[index];
    assertPeArchitecture(source, arch);
    const directory = path.posix.dirname(destination);
    for (const { name } of readPeImports(source)) {
      const normalized = name.toLowerCase();
      const target = path.posix.join(directory, normalized);
      if (!runtimeDlls.has(normalized) || known.has(target.toLowerCase())) continue;
      // Nodex owns these binaries and builds them with a static CRT.
      if (
        /^nodex-core\.exe$/iu.test(path.posix.basename(destination)) ||
        (/^nodex\.exe$/iu.test(path.posix.basename(destination)) &&
          path.posix.basename(directory).toLowerCase() === "bin")
      ) {
        throw new Error(`Nodex native image must use static CRT: ${source} imports ${name}`);
      }
      sources ??= redistDirectories().flatMap((dir) =>
        readdirSync(dir).map((file) => path.join(dir, file)),
      );
      const dependency = sources.find((file) => path.basename(file).toLowerCase() === normalized);
      if (!dependency) throw new Error(`MSVC ${arch} redistributable is missing ${name}`);
      const stat = lstatSync(dependency);
      if (!stat.isFile() || stat.nlink !== 1)
        throw new Error(`MSVC redistributable must be a regular file: ${dependency}`);
      const copy = { source: dependency, destination: target };
      copies.push(copy);
      pending.push(copy);
      known.add(target.toLowerCase());
    }
  }
  return copies;
}
