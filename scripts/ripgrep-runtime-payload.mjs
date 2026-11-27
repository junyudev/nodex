import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertRipgrepBytes,
  ripgrepSha256,
} from "../src/main/platform/node/ripgrep-runtime-artifact.mjs";
import { ripgrepExecutableName, ripgrepRelease } from "../src/shared/ripgrep-runtime-metadata.mjs";
import { assertPeArchitecture } from "./windows-pe.mjs";

export function assertRipgrepRuntimePayload(
  directory,
  target,
  { allowSigned = false, release = ripgrepRelease } = {},
) {
  const name = ripgrepExecutableName(target);
  const binary = join(directory, name);
  const license = join(directory, "LICENSE");
  if (!lstatSync(directory).isDirectory())
    throw new Error("Invalid standalone ripgrep resource directory");
  const auxiliaryFiles = readdirSync(directory).filter(
    (entry) => entry !== name && entry !== "LICENSE",
  );
  if (
    auxiliaryFiles.some(
      (entry) =>
        target !== "win32-arm64" ||
        !/^vcruntime140(?:_1|_threads)?\.dll$/u.test(entry) ||
        !lstatSync(join(directory, entry)).isFile(),
    ) ||
    !lstatSync(license).isFile() ||
    ripgrepSha256(readFileSync(license)) !== release.licenseSha256
  )
    throw new Error("Invalid standalone ripgrep resource directory or license");
  const stat = lstatSync(binary);
  // Windows stat cannot report POSIX executable bits, even for a macOS payload.
  const checkExecutableMode = process.platform !== "win32" && !target.startsWith("win32-");
  if (
    !stat.isFile() ||
    (checkExecutableMode && (stat.mode & 0o111) === 0) ||
    stat.size > release.builds[target].binarySize + 128 * 1024
  )
    throw new Error("Invalid standalone ripgrep executable");
  assertRipgrepBytes(readFileSync(binary), target, allowSigned ? "signed" : "upstream", release);
  if (target === "win32-x64" || target === "win32-arm64")
    assertPeArchitecture(binary, target === "win32-x64" ? "x64" : "arm64");
  return binary;
}
