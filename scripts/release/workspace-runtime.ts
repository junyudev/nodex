import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  extractPinnedTarArchive,
  sha256File,
} from "../../src/main/platform/node/pinned-tar-archive";
import { verifyWorkspaceDependencyBundle } from "../../src/main/platform/node/WorkspaceDependencyBundle";
import {
  readWorkspaceRuntimeLock,
  workspaceRuntimeAssetName,
  workspaceRuntimeSourceDigest,
  type WorkspaceRuntimeReleaseAsset,
} from "../workspace-runtime-release-lock";
import { gh } from "./github-release";
import { publishRuntimeArchive } from "./runtime-publication";

export async function unpackWorkspaceRuntime(
  archive: string,
  root: string,
  asset: WorkspaceRuntimeReleaseAsset,
  sourceDigest: string,
) {
  const stats = lstatSync(archive);
  if (basename(archive) !== asset.assetName || !stats.isFile() || stats.size !== asset.archiveSize)
    throw new Error("Workspace runtime archive name or size mismatch.");
  if ((await sha256File(archive)) !== asset.archiveSha256)
    throw new Error("Workspace runtime archive checksum mismatch.");
  const signal = new AbortController().signal;
  await extractPinnedTarArchive(archive, root, signal);
  const { manifest, unpackedBytes } = await verifyWorkspaceDependencyBundle(
    { root, platform: "darwin", arch: "arm64" },
    { manifestSha256: asset.manifestSha256, signal },
  );
  if (
    unpackedBytes !== asset.unpackedBytes ||
    manifest.sourceLockSha256 !== sourceDigest ||
    workspaceRuntimeAssetName(manifest.distributionId) !== asset.assetName
  )
    throw new Error("Workspace runtime archive does not match the source lock or unpacked size.");
  return manifest;
}

export async function verifyWorkspaceRuntimePublishInput(options: {
  readonly archivePath: string;
  readonly lockPath: string;
}) {
  const lock = readWorkspaceRuntimeLock(options.lockPath);
  const asset = lock.release.assets["darwin-arm64"];
  if (!asset?.url) throw new Error("Workspace runtime publication requires the final asset URL.");
  const root = mkdtempSync(join(tmpdir(), "nodex-workspace-runtime-publish-"));
  try {
    await unpackWorkspaceRuntime(
      resolve(options.archivePath),
      root,
      asset,
      workspaceRuntimeSourceDigest(lock),
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
  return { asset, ...lock.release, distributionId: lock.distributionId };
}

export function assertWorkspaceRuntimePublicationTarget(
  repo: string,
  tag: string,
  sourceCommit: string,
  github = gh,
): void {
  if (!/^[a-f0-9]{40}$/u.test(sourceCommit))
    throw new Error("Workspace runtime publication requires the full source commit SHA.");
  const ref = JSON.parse(github(["api", `repos/${repo}/git/ref/tags/${tag}`]));
  if (ref.object?.type !== "tag") throw new Error("Push an annotated workspace runtime tag first.");
  const annotated = JSON.parse(github(["api", `repos/${repo}/git/tags/${ref.object.sha}`]));
  if (annotated.object?.type !== "commit" || annotated.object.sha !== sourceCommit)
    throw new Error("The remote workspace runtime tag points at a different source commit.");
  const immutability = JSON.parse(github(["api", `repos/${repo}/immutable-releases`]));
  if (immutability.enabled !== true)
    throw new Error("Enable immutable releases on the repository before publishing.");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    options: {
      archive: { type: "string" },
      lock: { type: "string" },
      "source-commit": { type: "string" },
    },
  });
  if (!values.archive || !values.lock || !values["source-commit"])
    throw new Error("Use --archive <archive> --lock <candidate-lock> --source-commit <sha>.");
  const {
    asset,
    repository: repo,
    tag,
    distributionId,
  } = await verifyWorkspaceRuntimePublishInput({
    archivePath: values.archive,
    lockPath: values.lock,
  });
  assertWorkspaceRuntimePublicationTarget(repo, tag, values["source-commit"]);
  await publishRuntimeArchive(
    {
      repo,
      tag,
      title: `Nodex Document Tools runtime ${distributionId}`,
      notes: "Immutable Document Tools runtime for Nodex on Apple silicon.",
    },
    new Map([[asset.assetName, { sha256: asset.archiveSha256, size: asset.archiveSize }]]),
    new Map([[asset.assetName, resolve(values.archive)]]),
  );
  const published = JSON.parse(gh(["api", `repos/${repo}/releases/tags/${tag}`]));
  if (published.immutable !== true)
    throw new Error("GitHub did not report the Workspace runtime release as immutable.");
  console.log(published.html_url);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
