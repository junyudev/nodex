// Export changes must be paired with windows-vc-runtime.d.mts.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  assertPeArchitecture,
  isWindowsSystemDll,
  listWindowsPeImages,
  readPeImports,
} from "./windows-pe.mjs";

// Retail redistributables only; never debug runtimes, MFC, or arbitrary host DLLs.
const runtimeDlls = new Set([
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

/** Locate the newest installed MSVC retail CRT for the package's CPU via vswhere. */
export function resolveWindowsVcRuntimeDirectory(arch) {
  if (process.platform !== "win32")
    throw new Error("MSVC redistributable staging requires a Windows build host");
  const vswhere = path.join(
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  const installation = execFileSync(
    vswhere,
    ["-latest", "-products", "*", "-property", "installationPath"],
    { encoding: "utf8", timeout: 10_000 },
  ).trim();
  if (!installation)
    throw new Error("vswhere found no Visual Studio installation with MSVC redistributables");
  const root = path.join(installation, "VC/Redist/MSVC");
  const versions = readdirSync(root)
    .filter((name) => /^\d+(?:\.\d+)+$/u.test(name))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
  for (const version of versions) {
    const cpu = path.join(root, version, arch);
    if (!existsSync(cpu)) continue;
    const crt = readdirSync(cpu)
      .filter((name) => /^Microsoft\.VC\d+\.CRT$/u.test(name))
      .sort()
      .at(-1);
    if (crt) return path.join(cpu, crt);
  }
  throw new Error(`No retail MSVC ${arch} CRT under ${root}; install the matching C++ build tools`);
}

/** Supplement immutable vendor images without rewriting their bytes or locked metadata.
 * Only missing retail CRT imports are copied, recursively, beside the consumer.
 * The complete PE verifier remains the authority for all other dependencies.
 */
export function stageWindowsVcRuntime(root, arch, options = {}) {
  let sourceDirectory;
  const copied = [];
  const pending = listWindowsPeImages(root).map((file) => path.join(root, file));
  const seen = new Set();
  while (pending.length) {
    const file = pending.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    assertPeArchitecture(file, arch);
    const directory = path.dirname(file);
    const siblings = new Set(readdirSync(directory).map((name) => name.toLowerCase()));
    for (const { name } of readPeImports(file)) {
      const normalized = name.toLowerCase();
      if (isWindowsSystemDll(name) || siblings.has(normalized) || !runtimeDlls.has(normalized))
        continue;
      // Nodex owns these binaries: they must use static CRT, never a packaged workaround.
      if (
        /^nodex-core\.exe$/iu.test(path.basename(file)) ||
        (/^nodex\.exe$/iu.test(path.basename(file)) &&
          path.basename(directory).toLowerCase() === "bin")
      )
        throw new Error(`Nodex native image must use static CRT: ${file} imports ${name}`);
      sourceDirectory ??= options.redistDirectory ?? resolveWindowsVcRuntimeDirectory(arch);
      const sourceName = readdirSync(sourceDirectory).find(
        (entry) => entry.toLowerCase() === normalized,
      );
      if (!sourceName)
        throw new Error(`MSVC ${arch} redistributable is missing ${name}: ${sourceDirectory}`);
      const source = path.join(sourceDirectory, sourceName);
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`MSVC redistributable must be a regular file: ${source}`);
      assertPeArchitecture(source, arch);
      const destination = path.join(directory, normalized);
      copyFileSync(source, destination);
      siblings.add(normalized);
      copied.push(path.relative(root, destination).split(path.sep).join("/"));
      pending.push(destination);
    }
  }
  return copied;
}
