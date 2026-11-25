import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { stageCodexRuntime, stageCodexRuntimeCandidate } from "./stage-codex-runtime";
import { createAgentRuntimeRelockCandidate } from "./relock-agent-runtime";

import { windowsPeFixture } from "./testing/windows-pe-fixture";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const nativeImage = () => windowsPeFixture(0x8664);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nodex-windows-stage-"));
  roots.push(root);
  const lock = JSON.parse(
    readFileSync(
      new URL("../resources/agent-runtime/codex-app-server.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const build = lock.builds["win32-x64"];
  const source = join(root, "source");
  for (const file of build.requiredArtifacts as string[]) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, /\.(?:exe|dll)$/u.test(file) ? nativeImage() : "fixture data");
  }
  writeFileSync(
    join(source, "codex-package.json"),
    JSON.stringify({
      ...lock.packageManifest,
      entrypoint: "bin/codex.exe",
      execServer: "bin/codex-exec-server.exe",
      target: build.targetTriple,
    }),
  );
  build.entrypointSha256 = createHash("sha256").update(nativeImage()).digest("hex");
  build.runtimeMetadataSha256 = "0".repeat(64);
  const lockPath = join(root, "lock.json");
  writeFileSync(lockPath, JSON.stringify(lock));
  cpSync(
    new URL("../resources/third-party/codex", import.meta.url),
    join(root, "resources/third-party/codex"),
    { recursive: true },
  );
  return {
    root,
    source,
    lock,
    build,
    lockPath,
    options: {
      targetPlatform: "win32" as const,
      targetArch: "x64" as const,
      outputPath: join(root, "output"),
      projectRootPath: root,
      sourceRoot: source,
      lockPath,
    },
  };
}

test("stages a lock-bound x64 Codex package without Desktop Tools", async () => {
  const input = fixture();
  const candidate = await stageCodexRuntimeCandidate(input.options);
  input.build.runtimeMetadataSha256 = candidate.metadataSha256;
  writeFileSync(input.lockPath, JSON.stringify(input.lock));
  const staged = await stageCodexRuntime({ ...input.options, reuseExisting: true });
  expect(staged).toEqual(candidate.metadata);
  expect(staged.entrypoint).toBe("bin/codex.exe");
  expect(staged.targetArch).toBe("x64");
  expect(
    staged.artifacts
      .filter((artifact) => artifact.executable)
      .every((artifact) => /\.(?:exe|dll)$/u.test(artifact.path)),
  ).toBe(true);
  expect(existsSync(join(input.options.outputPath, "agent-runtime/browser-runtime"))).toBe(false);
});

test("rejects a foreign native image before publishing the runtime", async () => {
  const input = fixture();
  writeFileSync(join(input.source, "codex-path/rg.exe"), windowsPeFixture(0x14c));
  await expect(stageCodexRuntimeCandidate(input.options)).rejects.toThrow("Unsupported PE Machine");
  expect(existsSync(join(input.options.outputPath, "agent-runtime"))).toBe(false);
});

test("derives upstream metadata without the Windows build host's CRT", async () => {
  const input = fixture();
  writeFileSync(
    join(input.source, "codex-path/rg.exe"),
    windowsPeFixture(0x8664, ["vcruntime140.dll"]),
  );

  const candidate = await stageCodexRuntimeCandidate(input.options);

  expect(candidate.metadata.artifacts.map(({ path }) => path)).toContain("codex-path/rg.exe");
  expect(
    existsSync(join(input.options.outputPath, "agent-runtime/codex-path/vcruntime140.dll")),
  ).toBe(false);
});

test("rejects metadata that is not bound by the Windows release lock", async () => {
  const input = fixture();
  await expect(stageCodexRuntime(input.options)).rejects.toThrow(
    "metadata does not match the release lock",
  );
});

test("relocks the Windows x64 archive and retains the macOS pin", async () => {
  const input = fixture();
  const archive = join(input.root, input.build.assetName);
  const tar =
    process.platform === "win32"
      ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
      : "/usr/bin/tar";
  execFileSync(tar, [
    "-czf",
    archive,
    "-C",
    input.source,
    "bin",
    "codex-package.json",
    "codex-path",
    "codex-resources",
  ]);
  const manifest = `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${input.build.assetName}\n`;
  input.lock.upstream.checksumManifest.sha256 = createHash("sha256").update(manifest).digest("hex");
  input.lock.upstream.checksumManifest.size = Buffer.byteLength(manifest);
  writeFileSync(join(input.root, input.lock.upstream.checksumManifest.assetName), manifest);
  writeFileSync(input.lockPath, JSON.stringify(input.lock));
  const candidate = await createAgentRuntimeRelockCandidate({
    lockPath: input.lockPath,
    projectRootPath: input.root,
    outputPath: join(input.root, "candidate.json"),
    windowsX64ArchivePath: archive,
  });
  expect(candidate.builds["darwin-arm64"]).toEqual(input.lock.builds["darwin-arm64"]);
  writeFileSync(input.lockPath, JSON.stringify(candidate));

  const staged = await stageCodexRuntime(input.options);
  expect(staged.targetArch).toBe("x64");
  expect(staged.packageManifest.execServer).toBe("bin/codex-exec-server.exe");
  expect(candidate.builds["win32-x64"].entrypointSha256).toBe(
    createHash("sha256").update(nativeImage()).digest("hex"),
  );
});
