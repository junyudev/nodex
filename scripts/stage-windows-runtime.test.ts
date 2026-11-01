import { createHash } from "node:crypto";
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
