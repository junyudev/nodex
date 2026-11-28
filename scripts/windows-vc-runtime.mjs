// Export changes must be paired with windows-vc-runtime.d.mts.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { listWindowsPeImages } from "./windows-pe.mjs";
import { planWindowsVcRuntime } from "../src/main/platform/node/windows-vc-runtime-files.mjs";

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

/** Supplement immutable vendor images without changing their locked metadata. */
export function stageWindowsVcRuntime(root, arch, options = {}) {
  let sourceDirectory = options.redistDirectory;
  const sealedRoot = options.desktopToolsRoot && path.resolve(options.desktopToolsRoot);
  const files = listWindowsPeImages(root).filter(
    (file) => !sealedRoot || !path.resolve(root, file).startsWith(sealedRoot + path.sep),
  );
  const copies = planWindowsVcRuntime(root, arch, files, () => [
    (sourceDirectory ??= resolveWindowsVcRuntimeDirectory(arch)),
  ]);
  for (const { source, destination } of copies) copyFileSync(source, path.join(root, destination));
  return copies.map(({ destination }) => destination);
}
