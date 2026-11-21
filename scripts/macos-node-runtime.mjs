// Used by electron-builder hooks and the Mac distribution verifier.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const macNodeRuntimeExecutable = "node-runtime/node";
const release = JSON.parse(
  readFileSync(
    new URL("../resources/agent-runtime/node-runtime.lock.json", import.meta.url),
    "utf8",
  ),
);
const build = release.builds["darwin-arm64"];

export function assertMacNodeRuntime(resourcesPath) {
  const directory = join(resourcesPath, "node-runtime");
  if (
    !lstatSync(directory).isDirectory() ||
    readdirSync(directory).sort().join(",") !== "LICENSE,node,node-runtime.json"
  )
    throw new Error(
      "Packaged standalone Node must contain exactly its executable, manifest and license",
    );
  const executable = join(resourcesPath, macNodeRuntimeExecutable);
  const metadata = join(directory, "node-runtime.json");
  const license = join(directory, "LICENSE");
  for (const file of [executable, metadata, license]) {
    if (!lstatSync(file).isFile())
      throw new Error(`Standalone Node payload is not a regular file: ${file}`);
  }
  const manifest = JSON.parse(readFileSync(metadata, "utf8"));
  const expected = {
    schemaVersion: 1,
    targetPlatform: "darwin",
    targetArch: "arm64",
    version: release.version,
    executable: "node",
    sha256: build.sha256,
    size: build.size,
  };
  const binary = lstatSync(executable);
  const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
  if (
    Object.keys(manifest).length !== Object.keys(expected).length ||
    !Object.entries(expected).every(([key, value]) => manifest[key] === value) ||
    binary.size !== build.size ||
    (binary.mode & 0o111) === 0 ||
    digest(executable) !== build.sha256 ||
    digest(license) !== release.licenseSha256
  )
    throw new Error("Packaged standalone Node differs from the release lock");
  return executable;
}

export function assertMacNodeDeveloperId(executable) {
  const requirement =
    'anchor apple generic and certificate leaf[subject.OU] = "HX7739G8FX" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists';
  execFileSync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, executable]);
  const display = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", executable], {
    encoding: "utf8",
  });
  if (display.error) throw display.error;
  if (display.status !== 0)
    throw new Error(`Could not inspect standalone Node signature: ${display.stderr}`);
  assertMacNodeSigningDetails(display.stderr);
}

export function assertMacNodeSigningDetails(display) {
  if (
    !/^CodeDirectory .*flags=0x[0-9a-f]+\([^)\n]*\bruntime\b/imu.test(display) ||
    !/^Timestamp=\S/mu.test(display)
  )
    throw new Error("Standalone Node requires hardened runtime and a secure signing timestamp");
}
