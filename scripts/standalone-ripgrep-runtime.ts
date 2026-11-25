import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { ripgrepExecutableName, ripgrepRelease } from "../src/shared/ripgrep-runtime-metadata.mjs";
import { ripgrepSha256 } from "../src/main/platform/node/ripgrep-runtime-artifact.mjs";
import type { DesktopBuildTarget } from "./desktop-build-target";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";
import { replaceOwnedDirectory } from "./replace-owned-directory";
import { assertRipgrepRuntimePayload } from "./ripgrep-runtime-payload.mjs";
import { assertPeDependencies } from "./windows-pe.mjs";

export async function stageStandaloneRipgrepRuntime(
  root: string,
  target: DesktopBuildTarget,
  release = ripgrepRelease,
): Promise<void> {
  const output = join(root, ".generated/ripgrep-runtime", target.key);
  const verifyStage = (directory: string) => {
    const executable = assertRipgrepRuntimePayload(directory, target.key, { release });
    if (target.platform === "win32") assertPeDependencies(executable, target.arch);
  };
  try {
    verifyStage(output);
    return;
  } catch {
    // Replace only after the new stage has been fully verified.
  }

  const { archive, binarySize } = release.builds[target.key];
  const download = resolveImmutableArtifactPath({
    archiveSha256: archive.sha256,
    assetName: basename(new URL(archive.url).pathname),
    family: "ripgrep-runtime",
    projectRoot: root,
  });
  await ensureImmutableArtifact({
    destinationPath: download,
    expectedSize: archive.size,
    label: `ripgrep ${release.version} ${target.key}`,
    url: archive.url,
    validate: (file) => {
      if (
        lstatSync(file).size !== archive.size ||
        ripgrepSha256(readFileSync(file)) !== archive.sha256
      )
        throw new Error("Standalone ripgrep archive differs from its release lock");
    },
  });

  mkdirSync(dirname(output), { recursive: true });
  const staging = mkdtempSync(join(dirname(output), ".ripgrep-"));
  try {
    // Both supported hosts ship bsdtar, which streams this member from tar.gz or ZIP.
    const tar = process.platform === "win32" ? "tar.exe" : "/usr/bin/tar";
    const executable = join(staging, ripgrepExecutableName(target.key));
    const bytes = execFileSync(tar, ["-xOf", download, "--", archive.member], {
      maxBuffer: binarySize + 1024,
      windowsHide: true,
    });
    writeFileSync(executable, bytes);
    chmodSync(executable, 0o755);
    copyFileSync(join(root, "resources/ripgrep/LICENSE"), join(staging, "LICENSE"));
    verifyStage(staging);
    replaceOwnedDirectory(staging, output);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
