import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  cloneImmutableFile,
  ensureImmutableArtifact,
  resolveImmutableArtifactPath,
} from "./immutable-artifact-cache";
import type { DesktopBuildTarget } from "./desktop-build-target";
import { replaceOwnedDirectory } from "./replace-owned-directory";
import { assertPeArchitecture } from "./windows-pe.mjs";
import {
  nodeRuntimeRelease,
  parseStandaloneNodeManifest,
} from "../src/shared/node-runtime-metadata";

type NodeReleaseLock = typeof nodeRuntimeRelease;
type NodeReleaseArtifact = { readonly sha256: string; readonly size: number };
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const standaloneNodeDirectory = (root: string, target: DesktopBuildTarget): string =>
  join(root, ".generated/node-runtime", target.key);

const readLock = (root: string): NodeReleaseLock =>
  JSON.parse(readFileSync(join(root, "resources/agent-runtime/node-runtime.lock.json"), "utf8"));

function assertLockedFile(file: string, expected: NodeReleaseArtifact, label: string): void {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size !== expected.size || digest(file) !== expected.sha256)
    throw new Error(`${label} checksum mismatch`);
}

function assertExecutable(file: string, target: DesktopBuildTarget, lock: NodeReleaseLock): void {
  assertLockedFile(file, lock.builds[target.key], `Standalone Node ${target.key}`);
  if (target.platform === "win32") {
    assertPeArchitecture(file, target.arch);
    return;
  }
  const arch = execFileSync("/usr/bin/lipo", ["-archs", file], { encoding: "utf8" }).trim();
  if (arch !== target.arch || (lstatSync(file).mode & 0o111) === 0)
    throw new Error(`Expected an executable arm64 Mach-O at ${file}`);
}

/** Stream just the regular bin/node member. Tar never writes archive paths to disk. */
function extractMacNode(archive: string, member: string, executable: string): void {
  const entries = execFileSync("/usr/bin/tar", ["-tvzf", archive, "--", member], {
    encoding: "utf8",
  })
    .trimEnd()
    .split("\n");
  if (entries.length !== 1 || !entries[0]?.startsWith("-") || !entries[0].endsWith(` ${member}`))
    throw new Error("Expected exactly one regular bin/node in the standalone Node archive");
  const descriptor = openSync(executable, "wx", 0o700);
  try {
    execFileSync("/usr/bin/tar", ["-xOzf", archive, "--", member], {
      stdio: ["ignore", descriptor, "inherit"],
    });
  } finally {
    closeSync(descriptor);
  }
  chmodSync(executable, 0o755);
}

export async function stageStandaloneNodeRuntime(
  root: string,
  target: DesktopBuildTarget,
): Promise<void> {
  const lock = readLock(root);
  const build = lock.builds[target.key];
  const executableName = `node${target.executableSuffix}`;
  const releaseUrl = `https://nodejs.org/dist/v${lock.version}`;
  const tarball = target.platform === "darwin" ? lock.builds["darwin-arm64"].archive : null;
  const artifact = tarball ?? build;
  const download = resolveImmutableArtifactPath({
    archiveSha256: artifact.sha256,
    assetName: tarball?.name ?? executableName,
    family: "node-runtime",
    projectRoot: root,
  });
  await ensureImmutableArtifact({
    destinationPath: download,
    expectedSize: artifact.size,
    label: `Node ${lock.version} ${target.key}`,
    url: tarball ? `${releaseUrl}/${tarball.name}` : `${releaseUrl}/win-${target.arch}/node.exe`,
    validate: (file) =>
      tarball
        ? assertLockedFile(file, artifact, "Standalone Node archive")
        : assertExecutable(file, target, lock),
  });

  const license = join(root, "resources/third-party/node/LICENSE");
  if (digest(license) !== lock.licenseSha256)
    throw new Error("Standalone Node license checksum mismatch");

  const output = standaloneNodeDirectory(root, target);
  const writeMetadata = (directory: string) => {
    cloneImmutableFile(license, join(directory, "LICENSE"));
    writeFileSync(
      join(directory, "node-runtime.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          targetPlatform: target.platform,
          targetArch: target.arch,
          version: lock.version,
          executable: executableName,
          sha256: build.sha256,
          size: build.size,
        },
        null,
        2,
      )}\n`,
    );
  };

  if (target.platform === "win32") {
    mkdirSync(output, { recursive: true });
    const executable = join(output, executableName);
    try {
      assertExecutable(executable, target, lock);
    } catch {
      cloneImmutableFile(download, executable);
    }
    assertExecutable(executable, target, lock);
    writeMetadata(output);
    return;
  }

  try {
    assertStandaloneNodeRuntime(root, target);
    if (digest(join(output, "LICENSE")) === lock.licenseSha256) return;
  } catch {
    // A missing or damaged stage is replaced only after complete verification.
  }
  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".node-runtime-"));
  try {
    const executable = join(staging, executableName);
    extractMacNode(download, `node-v${lock.version}-${target.key}/bin/node`, executable);
    assertExecutable(executable, target, lock);
    writeMetadata(staging);
    replaceOwnedDirectory(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function assertStandaloneNodeRuntime(
  root: string,
  target: DesktopBuildTarget,
): { executable: string; version: string } {
  const lock = readLock(root);
  const directory = standaloneNodeDirectory(root, target);
  const manifest = parseStandaloneNodeManifest(
    JSON.parse(readFileSync(join(directory, "node-runtime.json"), "utf8")),
    target,
    lock,
  );
  const executable = join(directory, manifest.executable);
  assertExecutable(executable, target, lock);
  return { executable, version: manifest.version };
}
