import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cloneImmutableFile,
  ensureImmutableArtifact,
  resolveImmutableArtifactPath,
} from "./immutable-artifact-cache";
import { desktopBuildTarget, type WindowsArchitecture } from "./desktop-build-target";
import { assertPeArchitecture } from "./windows-pe.mjs";

interface NodeReleaseArtifact {
  readonly sha256: string;
  readonly size: number;
}
interface NodeReleaseLock {
  readonly version: string;
  readonly builds: Readonly<Record<`win32-${WindowsArchitecture}`, NodeReleaseArtifact>>;
  readonly licenseSha256: string;
}
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

export const standaloneNodeDirectory = (root: string, arch: WindowsArchitecture): string =>
  join(root, ".generated/node-runtime", `win32-${arch}`);

/** Windows Node is independently pinned; Desktop Tools remain a macOS-only capability. */
export async function stageStandaloneNodeRuntime(
  root: string,
  arch: WindowsArchitecture,
): Promise<void> {
  const target = desktopBuildTarget("win32", arch);
  const lock = JSON.parse(
    readFileSync(join(root, "resources/agent-runtime/node-runtime.lock.json"), "utf8"),
  ) as NodeReleaseLock;
  const build = lock.builds[`win32-${arch}`];
  const validate = (file: string) => {
    if (statSync(file).size !== build.size || digest(file) !== build.sha256)
      throw new Error(`Standalone Node checksum mismatch: ${target.key}`);
    assertPeArchitecture(file, arch);
  };
  const archive = resolveImmutableArtifactPath({
    archiveSha256: build.sha256,
    assetName: "node.exe",
    family: "node-runtime",
    projectRoot: root,
  });
  await ensureImmutableArtifact({
    destinationPath: archive,
    expectedSize: build.size,
    label: `Node ${lock.version} ${target.key}`,
    url: `https://nodejs.org/dist/v${lock.version}/win-${arch}/node.exe`,
    validate,
  });
  const output = standaloneNodeDirectory(root, arch);
  mkdirSync(output, { recursive: true });
  const executable = join(output, "node.exe");
  try {
    validate(executable);
  } catch {
    cloneImmutableFile(archive, executable);
  }
  validate(join(output, "node.exe"));
  const license = join(root, "resources/third-party/node/LICENSE");
  if (digest(license) !== lock.licenseSha256)
    throw new Error("Standalone Node license checksum mismatch");
  cloneImmutableFile(license, join(output, "LICENSE"));
  writeFileSync(
    join(output, "node-runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, targetPlatform: "win32", targetArch: arch, version: lock.version, executable: "node.exe", ...build }, null, 2)}\n`,
  );
}

export function assertStandaloneNodeRuntime(
  root: string,
  arch: WindowsArchitecture,
): { executable: string; version: string } {
  const lock = JSON.parse(
    readFileSync(join(root, "resources/agent-runtime/node-runtime.lock.json"), "utf8"),
  ) as NodeReleaseLock;
  const executable = join(standaloneNodeDirectory(root, arch), "node.exe");
  const build = lock.builds[`win32-${arch}`];
  if (statSync(executable).size !== build.size || digest(executable) !== build.sha256)
    throw new Error("Standalone Node differs from its release lock; stage the runtime first");
  assertPeArchitecture(executable, arch);
  return { executable, version: lock.version };
}
