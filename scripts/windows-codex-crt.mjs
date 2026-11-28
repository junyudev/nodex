import { copyFileSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertPeArchitecture } from "./windows-pe.mjs";
import { resolveWindowsVcRuntimeDirectory } from "./windows-vc-runtime.mjs";
import { CODEX_CRT_RESOURCES_DIRECTORY as directoryName } from "../src/main/platform/node/windows-vc-runtime-files.mjs";

// The pinned Windows Codex packages import this CRT in Voice on both CPUs and in arm64 ripgrep.
const codexCrtDll = "vcruntime140.dll";

/** Provision the CRT source used by the shared per-consumer staging mapper. */
export function stageWindowsCodexCrt(resourcesPath, arch) {
  const image = join(resolveWindowsVcRuntimeDirectory(arch), codexCrtDll);
  if (!lstatSync(image).isFile())
    throw new Error(`MSVC redistributable must be a regular file: ${image}`);
  assertPeArchitecture(image, arch);
  const directory = join(resourcesPath, directoryName);
  mkdirSync(directory);
  copyFileSync(image, join(directory, codexCrtDll));
}

export function assertWindowsCodexCrt(resourcesPath) {
  const directory = join(resourcesPath, directoryName);
  if (!lstatSync(directory).isDirectory())
    throw new Error("Packaged Codex CRT directory is missing");
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.length !== 1 || entries[0].name !== codexCrtDll || !entries[0].isFile())
    throw new Error("Packaged Codex CRT inventory does not match the required redistributable");
}
