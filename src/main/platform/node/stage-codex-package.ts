/* @effect-diagnostics asyncFunction:off -- Node filesystem adapter for Component staging. */
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import {
  AGENT_RUNTIME_LAYOUT_VERSION,
  AGENT_RUNTIME_METADATA_FILENAME,
  canonicalBundledAgentRuntimeMetadataJson,
  type AgentRuntimeArtifact,
  type BundledAgentRuntimeMetadata,
  type CodexAppServerPackageManifest,
} from "../../../shared/codex-runtime-metadata";
import { inventoryRegularFiles, sha256File } from "./pinned-tar-archive";

export const codexPackageFileMode = (executable: boolean) => (executable ? 0o755 : 0o644);

export function codexPackageArtifactIsExecutable(file: string, mode: number): boolean {
  return /\.(?:exe|dll)$/iu.test(file) || (process.platform !== "win32" && (mode & 0o111) !== 0);
}

export function codexPackageMetadataSha256(metadata: BundledAgentRuntimeMetadata): string {
  return createHash("sha256")
    .update(canonicalBundledAgentRuntimeMetadataJson(metadata))
    .digest("hex");
}

export function validateCodexPackageManifest(
  candidate: unknown,
  expected: Omit<CodexAppServerPackageManifest, "target">,
  target: string,
): CodexAppServerPackageManifest {
  const manifest = {
    layoutVersion: expected.layoutVersion,
    version: expected.version,
    target,
    variant: expected.variant,
    entrypoint: expected.entrypoint,
    execServer: expected.execServer,
    resourcesDir: expected.resourcesDir,
    pathDir: expected.pathDir,
  };
  if (
    !candidate ||
    typeof candidate !== "object" ||
    Array.isArray(candidate) ||
    Object.entries(manifest).some(([key, value]) => Reflect.get(candidate, key) !== value)
  ) {
    throw new Error(
      `Codex app-server package manifest does not match the release lock for ${target}`,
    );
  }
  return manifest;
}

export function makeCodexPackageMetadata(input: {
  readonly artifacts: AgentRuntimeArtifact[];
  readonly packageManifest: CodexAppServerPackageManifest;
  readonly build: Pick<
    BundledAgentRuntimeMetadata["releaseAsset"],
    "archiveSha256" | "archiveSize" | "assetName"
  >;
  readonly release: {
    readonly appServerRuntimeVersion: string;
    readonly runtimeFamily: "codex";
    readonly protocolSchema: { readonly sha256: string };
    readonly upstream: BundledAgentRuntimeMetadata["sourceRevision"];
  };
  readonly target: Pick<
    BundledAgentRuntimeMetadata,
    "targetArch" | "targetPlatform" | "targetTriple"
  >;
}): BundledAgentRuntimeMetadata {
  const { artifacts, build, packageManifest, release, target } = input;
  const { entrypoint, pathDir } = packageManifest;
  const executable = artifacts.find(({ path }) => path === entrypoint);
  if (!executable?.executable)
    throw new Error(`Staged Codex entrypoint is not executable: ${entrypoint}`);
  const { commit, repository, tag } = release.upstream;
  return {
    releaseAsset: {
      archiveSha256: build.archiveSha256,
      archiveSize: build.archiveSize,
      assetName: build.assetName,
      entrypointSha256: executable.sha256,
      repository,
      tag,
    },
    artifacts,
    appServerRuntimeVersion: release.appServerRuntimeVersion,
    entrypoint,
    layoutVersion: AGENT_RUNTIME_LAYOUT_VERSION,
    packageManifest,
    protocolSchemaFingerprint: release.protocolSchema.sha256,
    runtimeFamily: release.runtimeFamily,
    searchPaths: [pathDir],
    sourceRevision: { commit, repository, tag },
    targetArch: target.targetArch,
    targetPlatform: target.targetPlatform,
    targetTriple: target.targetTriple,
  };
}

export const serializeCodexPackageMetadata = (metadata: BundledAgentRuntimeMetadata) =>
  `${JSON.stringify(metadata, null, 2)}\n`;

export type CodexPackagePin = {
  readonly metadataSha256: string;
  readonly entrypointSha256: string;
};

export function verifyCodexPackageMetadataPin(
  metadata: BundledAgentRuntimeMetadata,
  pin: CodexPackagePin,
): void {
  if (
    metadata.releaseAsset.entrypointSha256 !== pin.entrypointSha256 ||
    codexPackageMetadataSha256(metadata) !== pin.metadataSha256
  ) {
    throw new Error("Codex app-server package metadata does not match the release lock.");
  }
}

/** Turn the already extracted, private release archive into the pinned app-server package. */
export async function stageCodexPackage(
  root: string,
  noticesDirectory: string,
  pin: CodexPackagePin,
  signal: AbortSignal,
): Promise<number> {
  const files = await inventoryRegularFiles(root, signal, release.requiredArtifacts);
  if (
    files.size !== release.requiredArtifacts.length ||
    release.requiredArtifacts.some((file) => !files.has(file))
  ) {
    throw new Error("Codex app-server package file closure differs from the release lock.");
  }
  const build = release.builds["darwin-arm64"];
  const packageManifest = validateCodexPackageManifest(
    JSON.parse(await readFile(join(root, "codex-package.json"), "utf8")),
    { ...release.packageManifest, variant: "codex" },
    build.targetTriple,
  );
  const notices = join(root, "third-party", "codex");
  await mkdir(notices, { recursive: true, mode: 0o755 });
  for (const name of ["LICENSE", "NOTICE"]) {
    const source = join(noticesDirectory, name);
    const destination = join(notices, name);
    await copyFile(source, destination);
    files.set(`third-party/codex/${name}`, await lstat(destination));
  }
  const artifacts: AgentRuntimeArtifact[] = [];
  for (const [path, { mode, size }] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    const file = join(root, path);
    const executable =
      !path.startsWith("third-party/") && codexPackageArtifactIsExecutable(path, mode);
    await chmod(file, codexPackageFileMode(executable));
    artifacts.push({ path, sha256: await sha256File(file, signal), size, executable });
  }
  const metadata = makeCodexPackageMetadata({
    artifacts,
    packageManifest,
    build,
    release: {
      ...release,
      runtimeFamily: "codex",
      upstream: { ...release.upstream, repository: "openai/codex" },
    },
    target: { targetArch: "arm64", targetPlatform: "darwin", targetTriple: build.targetTriple },
  });
  verifyCodexPackageMetadataPin(metadata, pin);
  const data = serializeCodexPackageMetadata(metadata);
  await writeFile(join(root, AGENT_RUNTIME_METADATA_FILENAME), data, { flag: "wx", mode: 0o644 });
  return artifacts.reduce((total, file) => total + file.size, Buffer.byteLength(data));
}
