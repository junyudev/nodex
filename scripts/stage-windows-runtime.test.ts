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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
function nativeImage(arch: "x64" | "arm64"): Buffer {
  const buffer = Buffer.alloc(256);
  buffer.writeUInt16LE(0x5a4d);
  buffer.writeUInt32LE(128, 0x3c);
  buffer.writeUInt32LE(0x4550, 128);
  buffer.writeUInt16LE(arch === "x64" ? 0x8664 : 0xaa64, 132);
  return buffer;
}
function fixture(arch: "x64" | "arm64") {
  const root = mkdtempSync(join(tmpdir(), "nodex-windows-stage-"));
  roots.push(root);
  const lock = JSON.parse(
    readFileSync(
      new URL("../resources/agent-runtime/codex-app-server.lock.json", import.meta.url),
      "utf8",
    ),
  );
  const build = lock.builds[`win32-${arch}`];
  const source = join(root, "source");
  for (const file of build.requiredArtifacts as string[]) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, /\.(?:exe|dll)$/u.test(file) ? nativeImage(arch) : "fixture data");
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
  build.entrypointSha256 = createHash("sha256").update(nativeImage(arch)).digest("hex");
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
      targetArch: arch,
      outputPath: join(root, "output"),
      projectRootPath: root,
      sourceRoot: source,
      lockPath,
    },
  };
}

test.each(["x64", "arm64"] as const)(
  "stages a lock-bound %s Codex package without Desktop Tools",
  async (arch) => {
    const input = fixture(arch);
    const candidate = await stageCodexRuntimeCandidate(input.options);
    input.build.runtimeMetadataSha256 = candidate.metadataSha256;
    writeFileSync(input.lockPath, JSON.stringify(input.lock));
    const staged = await stageCodexRuntime({ ...input.options, reuseExisting: true });
    expect(staged).toEqual(candidate.metadata);
    expect(staged.entrypoint).toBe("bin/codex.exe");
    expect(staged.targetArch).toBe(arch);
    expect(
      staged.artifacts
        .filter((artifact) => artifact.executable)
        .every((artifact) => /\.(?:exe|dll)$/u.test(artifact.path)),
    ).toBe(true);
    expect(existsSync(join(input.options.outputPath, "agent-runtime/browser-runtime"))).toBe(false);
  },
);

test("rejects a foreign native image before publishing the runtime", async () => {
  const input = fixture("arm64");
  writeFileSync(join(input.source, "codex-path/rg.exe"), nativeImage("x64"));
  await expect(stageCodexRuntimeCandidate(input.options)).rejects.toThrow("architecture mismatch");
  expect(existsSync(join(input.options.outputPath, "agent-runtime"))).toBe(false);
});

test("rejects metadata that is not bound by the Windows release lock", async () => {
  const input = fixture("x64");
  await expect(stageCodexRuntime(input.options)).rejects.toThrow(
    "metadata does not match the release lock",
  );
});

test("relocks both Windows archives independently and retains the macOS pin", async () => {
  const inputs = [fixture("arm64"), fixture("x64")];
  const first = inputs[0]!;
  const archives = inputs.map((input) => {
    const archive = join(first.root, input.build.assetName);
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
    return archive;
  });
  const manifest = archives
    .map(
      (archive) =>
        `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archive.split(/[\\/]/u).at(-1)}\n`,
    )
    .join("");
  first.lock.upstream.checksumManifest.sha256 = createHash("sha256").update(manifest).digest("hex");
  first.lock.upstream.checksumManifest.size = Buffer.byteLength(manifest);
  writeFileSync(join(first.root, first.lock.upstream.checksumManifest.assetName), manifest);
  writeFileSync(first.lockPath, JSON.stringify(first.lock));
  const candidate = await createAgentRuntimeRelockCandidate({
    lockPath: first.lockPath,
    projectRootPath: first.root,
    outputPath: join(first.root, "candidate.json"),
    windowsArm64ArchivePath: archives[0]!,
    windowsX64ArchivePath: archives[1]!,
  });
  expect(candidate.builds["darwin-arm64"]).toEqual(first.lock.builds["darwin-arm64"]);
  writeFileSync(first.lockPath, JSON.stringify(candidate));
  for (const [index, arch] of (["arm64", "x64"] as const).entries()) {
    const input = inputs[index]!;
    const staged = await stageCodexRuntime({ ...input.options, lockPath: first.lockPath });
    expect(staged.targetArch).toBe(arch);
    expect(staged.packageManifest.execServer).toBe("bin/codex-exec-server.exe");
    expect(candidate.builds[`win32-${arch}`].entrypointSha256).toBe(
      createHash("sha256").update(nativeImage(arch)).digest("hex"),
    );
  }
});
