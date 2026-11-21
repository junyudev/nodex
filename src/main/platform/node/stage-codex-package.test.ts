import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vite-plus/test";
import release from "../../../../resources/agent-runtime/codex-app-server.lock.json";
import { stageCodexRuntimeCandidate } from "../../../../scripts/stage-codex-runtime";
import { verifyCodexPackage } from "../../codex/codex-runtime";
import { extractPinnedTarArchive } from "./pinned-tar-archive";
import { stageCodexPackage } from "./stage-codex-package";

test.skipIf(process.platform === "win32")(
  "stages the same pinned closure as the build and rejects changed files",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-component-staging-"));
    const source = path.join(root, "source");
    const runtime = path.join(root, "component");
    const archive = path.join(root, "codex.tgz");
    const build = path.join(root, "build");
    const signal = new AbortController().signal;
    try {
      for (const artifact of release.requiredArtifacts) {
        const file = path.join(source, artifact);
        await mkdir(path.dirname(file), { recursive: true });
        const content =
          artifact === "codex-package.json"
            ? JSON.stringify({
                ...release.packageManifest,
                target: release.builds["darwin-arm64"].targetTriple,
              })
            : artifact;
        await writeFile(file, content, { mode: artifact.startsWith("bin/") ? 0o700 : 0o600 });
      }
      execFileSync("tar", ["-czf", archive, "-C", source, "."]);
      const { metadata, metadataSha256 } = await stageCodexRuntimeCandidate({
        outputPath: build,
        sourceRoot: source,
        targetArch: "arm64",
        targetPlatform: "darwin",
        agentRuntimePlatformContractVerifier: () => {},
      });
      await mkdir(runtime);
      await extractPinnedTarArchive(archive, runtime, signal);
      const pin = { metadataSha256, entrypointSha256: metadata.releaseAsset.entrypointSha256 };
      const license = path.resolve("resources", "third-party", "codex");
      const added = path.join(runtime, "unexpected");
      const entrypoint = path.join(runtime, "bin", "codex");
      const entrypointBytes = await readFile(entrypoint);
      await writeFile(added, "");
      await expect(stageCodexPackage(runtime, license, pin, signal)).rejects.toThrow(
        "file closure",
      );
      await rm(added);
      await rm(entrypoint);
      await expect(stageCodexPackage(runtime, license, pin, signal)).rejects.toThrow(
        "file closure",
      );
      await symlink("codex-exec-server", entrypoint);
      await expect(stageCodexPackage(runtime, license, pin, signal)).rejects.toThrow(
        "unsupported file",
      );
      await rm(entrypoint);
      await writeFile(entrypoint, entrypointBytes, { mode: 0o700 });
      const size = await stageCodexPackage(runtime, license, pin, signal);
      const receipt = Buffer.alloc(8);
      receipt.writeBigUInt64LE(BigInt(size + 8));
      await writeFile(path.join(runtime, ".installed-size"), receipt, { mode: 0o600 });
      expect(await readFile(path.join(runtime, "agent-runtime.json"))).toEqual(
        await readFile(path.join(build, "agent-runtime", "agent-runtime.json")),
      );

      const location = {
        rootPath: runtime,
        source: "component",
        missingBinaryMessage: "",
        pin,
      } as const;
      const verify = () =>
        verifyCodexPackage(location, { platform: "darwin", architecture: "arm64" });
      await expect(verify()).resolves.toMatchObject({ binaryPath: entrypoint });
      await writeFile(entrypoint, Buffer.alloc(entrypointBytes.length, "x"));
      await expect(verify()).rejects.toThrow("checksum");
      await rm(entrypoint);
      await expect(verify()).rejects.toThrow("unexpected file");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
