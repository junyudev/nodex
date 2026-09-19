import { createHash } from "node:crypto";
import path from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect, test } from "vite-plus/test";
import {
  canonicalBundledAgentRuntimeMetadataJson,
  type BundledAgentRuntimeMetadata,
} from "../src/shared/codex-runtime-metadata";
import { readCodexAppServerReleaseLock } from "./agent-runtime-release-lock";
import {
  assertCodexRuntimeMatchesReleaseLock,
  verifyAgentVendorSignatures,
} from "./verify-codex-runtime";

test("verifies Mach-O vendor signatures regardless of file mode, not executable data", () => {
  const root = mkdtempSync(path.join(tmpdir(), "nodex-vendor-signatures-"));
  try {
    writeFileSync(path.join(root, "runtime.json"), "{}", { mode: 0o755 });
    writeFileSync(path.join(root, "voice-host"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), {
      mode: 0o755,
    });
    writeFileSync(path.join(root, "library.dylib"), Buffer.from([0xca, 0xfe, 0xba, 0xbe]), {
      mode: 0o644,
    });
    const artifacts = ["runtime.json", "voice-host", "library.dylib"].map((path) => ({ path }));
    const checked: string[] = [];
    verifyAgentVendorSignatures(root, artifacts, "vendor", (file) => {
      checked.push(path.basename(file));
      return "vendor";
    });
    expect(checked).toEqual(["voice-host", "library.dylib"]);
    expect(() =>
      verifyAgentVendorSignatures(root, artifacts, "vendor", () => "wrong-team"),
    ).toThrow("found wrong-team");
    expect(() =>
      verifyAgentVendorSignatures(root, artifacts, "vendor", () => {
        throw new Error("unsigned code");
      }),
    ).toThrow("unsigned code");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
  const executablePaths = new Set([
    lock.packageManifest.entrypoint,
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/voice/bin/codex-voice-host",
    "codex-resources/zsh/bin/zsh",
  ]);
  const artifactPaths = [
    ...lock.requiredArtifacts,
    "third-party/codex/LICENSE",
    "third-party/codex/NOTICE",
  ];
  const artifacts = artifactPaths.map((artifactPath) =>
    artifact(artifactPath, executablePaths.has(artifactPath)),
  );
  const entrypointSha256 = artifacts.find(
    ({ path: artifactPath }) => artifactPath === lock.packageManifest.entrypoint,
  )?.sha256;
  if (!entrypointSha256)
    throw new Error("Release lock entrypoint is missing from required artifacts");
  const metadata: BundledAgentRuntimeMetadata = {
    appServerRuntimeVersion: lock.appServerRuntimeVersion,
    artifacts,
    entrypoint: lock.packageManifest.entrypoint,
    layoutVersion: 5,
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
    runtimeFamily: "codex",
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
    `canonical ${lock.upstream.tag} release lock`,
  );
});
