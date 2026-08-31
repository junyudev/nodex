import { createHash } from "node:crypto";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import {
  canonicalBundledAgentRuntimeMetadataJson,
  type BundledAgentRuntimeMetadata,
} from "../src/shared/codex-runtime-metadata";
import { readCodexAppServerReleaseLock } from "./agent-runtime-release-lock";
import { assertCodexRuntimeMatchesReleaseLock } from "./verify-codex-runtime";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

test("binds final runtime verification to the complete canonical metadata digest", () => {
  const lock = readCodexAppServerReleaseLock(
    path.resolve("resources/agent-runtime/codex-app-server.lock.json"),
  );
  const build = lock.builds["darwin-arm64"];
  const packageManifest = { ...lock.packageManifest, target: build.targetTriple };
  const artifact = (artifactPath: string, executable: boolean) => ({
    executable,
    path: artifactPath,
    sha256: sha256(artifactPath),
    size: artifactPath.length,
  });
  const artifacts = [
    artifact("codex-package.json", false),
    artifact("bin/codex-app-server", true),
    artifact("bin/codex-code-mode-host", true),
    artifact("codex-path/rg", true),
    artifact("codex-resources/zsh/bin/zsh", true),
    artifact("third-party/codex/LICENSE", false),
    artifact("third-party/codex/NOTICE", false),
  ];
  const entrypointSha256 = artifacts[1]!.sha256;
  const metadata: BundledAgentRuntimeMetadata = {
    appServerRuntimeVersion: lock.appServerRuntimeVersion,
    artifacts,
    entrypoint: lock.packageManifest.entrypoint,
    layoutVersion: 4,
    packageManifest,
    protocolSchemaFingerprint: lock.protocolSchema.sha256,
    releaseAsset: {
      archiveSha256: build.archiveSha256,
      archiveSize: build.archiveSize,
      assetName: build.assetName,
      entrypointSha256,
      repository: lock.upstream.repository,
      tag: lock.upstream.tag,
    },
    runtimeFamily: "codex-app-server",
    searchPaths: [lock.packageManifest.pathDir],
    sourceRevision: {
      commit: lock.upstream.commit,
      repository: lock.upstream.repository,
      tag: lock.upstream.tag,
    },
    targetArch: "arm64",
    targetPlatform: "darwin",
    targetTriple: build.targetTriple,
  };
  const fixtureLock = {
    ...lock,
    builds: {
      ...lock.builds,
      "darwin-arm64": {
        ...build,
        entrypointSha256,
        runtimeMetadataSha256: sha256(canonicalBundledAgentRuntimeMetadataJson(metadata)),
      },
    },
  };

  expect(() => assertCodexRuntimeMatchesReleaseLock(metadata, fixtureLock)).not.toThrow();

  const tampered: BundledAgentRuntimeMetadata = {
    ...metadata,
    artifacts: metadata.artifacts.map((entry) =>
      entry.path === "codex-path/rg" ? { ...entry, sha256: "f".repeat(64) } : entry,
    ),
  };
  expect(() => assertCodexRuntimeMatchesReleaseLock(tampered, fixtureLock)).toThrow(
    "canonical rust-v0.152.0 release lock",
  );
});
