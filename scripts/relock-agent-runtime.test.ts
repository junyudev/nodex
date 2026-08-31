import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import {
  createAgentRuntimeRelockCandidate,
  parseAgentRuntimeRelockCli,
  writeAgentRuntimeRelockCandidate,
} from "./relock-agent-runtime";
import type { CodexAppServerReleaseLock } from "./agent-runtime-release-lock";
import { stageCodexRuntime } from "./stage-codex-runtime";

const roots: string[] = [];
const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const skipPlatformInspection = () => undefined;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createArchive(root: string, target: string): string {
  const packageRoot = path.join(root, `package-${target}`);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(
    path.join(packageRoot, "codex-package.json"),
    `${JSON.stringify({
      entrypoint: "bin/codex-app-server",
      layoutVersion: 1,
      pathDir: "codex-path",
      resourcesDir: "codex-resources",
      target,
      variant: "codex-app-server",
      version: "0.152.0",
    })}\n`,
  );
  for (const artifact of [
    "bin/codex-app-server",
    "bin/codex-code-mode-host",
    "codex-path/rg",
    "codex-resources/zsh/bin/zsh",
  ]) {
    const filePath = path.join(packageRoot, artifact);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "#!/bin/sh\nexit 0\n");
    chmodSync(filePath, 0o755);
  }
  const archivePath = path.join(root, `codex-app-server-package-${target}.tar.gz`);
  execFileSync("/usr/bin/tar", [
    "-czf",
    archivePath,
    "-C",
    packageRoot,
    "bin",
    "codex-package.json",
    "codex-path",
    "codex-resources",
  ]);
  return archivePath;
}

function fixture() {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-runtime-relock-test-"));
  roots.push(projectRoot);
  const licensePath = path.join(projectRoot, "resources/third-party/codex/LICENSE");
  const noticePath = path.join(projectRoot, "resources/third-party/codex/NOTICE");
  mkdirSync(path.dirname(licensePath), { recursive: true });
  writeFileSync(licensePath, "license\n");
  writeFileSync(noticePath, "notice\n");
  const lock = JSON.parse(
    readFileSync(path.resolve("resources/agent-runtime/codex-app-server.lock.json"), "utf8"),
  ) as CodexAppServerReleaseLock;
  lock.notices.licenseSha256 = sha256("license\n");
  lock.notices.noticeSha256 = sha256("notice\n");
  const arm64ArchivePath = createArchive(projectRoot, "aarch64-apple-darwin");
  const x64ArchivePath = createArchive(projectRoot, "x86_64-apple-darwin");
  const manifestBody =
    `${sha256(readFileSync(arm64ArchivePath))}  ${path.basename(arm64ArchivePath)}\n` +
    `${sha256(readFileSync(x64ArchivePath))}  ${path.basename(x64ArchivePath)}\n`;
  writeFileSync(path.join(projectRoot, lock.upstream.checksumManifest.assetName), manifestBody);
  lock.upstream.checksumManifest.sha256 = sha256(manifestBody);
  lock.upstream.checksumManifest.size = Buffer.byteLength(manifestBody);
  const lockPath = path.join(projectRoot, "resources/agent-runtime/codex-app-server.lock.json");
  mkdirSync(path.dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  return {
    arm64ArchivePath,
    lockPath,
    projectRoot,
    x64ArchivePath,
  };
}

test("relocks both official archives and produces stageable metadata", async () => {
  const input = fixture();
  const candidate = await createAgentRuntimeRelockCandidate({
    ...input,
    agentRuntimePlatformContractVerifier: skipPlatformInspection,
    outputPath: path.join(input.projectRoot, "candidate.json"),
    projectRootPath: input.projectRoot,
  });

  expect(candidate.schemaVersion).toBe(1);
  expect(candidate.upstream).toMatchObject({ repository: "openai/codex", tag: "rust-v0.152.0" });
  expect(candidate.builds["darwin-arm64"].archiveSha256).toBe(
    sha256(readFileSync(input.arm64ArchivePath)),
  );
  expect(candidate.builds["darwin-arm64"].entrypointSha256).toBe(sha256("#!/bin/sh\nexit 0\n"));
  expect(candidate.builds["darwin-x64"].runtimeMetadataSha256).not.toBe("0".repeat(64));

  const immutableCandidatePath = path.join(input.projectRoot, "review/candidate.lock.json");
  writeAgentRuntimeRelockCandidate(immutableCandidatePath, candidate);
  expect(() => writeAgentRuntimeRelockCandidate(immutableCandidatePath, candidate)).toThrow();

  const candidatePath = path.join(input.projectRoot, "candidate.lock.json");
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
  await expect(
    stageCodexRuntime({
      agentRuntimePlatformContractVerifier: skipPlatformInspection,
      archivePath: input.arm64ArchivePath,
      lockPath: candidatePath,
      outputPath: path.join(input.projectRoot, "verified"),
      projectRootPath: input.projectRoot,
      targetArch: "arm64",
      targetPlatform: "darwin",
    }),
  ).resolves.toMatchObject({ appServerRuntimeVersion: "0.152.0", targetArch: "arm64" });
});

test("requires explicit archives, base lock, and non-canonical output", () => {
  expect(() => parseAgentRuntimeRelockCli(["--out", "/tmp/candidate.json"])).toThrow(
    "official Codex release archives",
  );
  expect(() =>
    parseAgentRuntimeRelockCli([
      "--arm64",
      "/tmp/arm64.tar.gz",
      "--x64",
      "/tmp/x64.tar.gz",
      "--out",
      "/tmp/candidate.json",
    ]),
  ).toThrow("--base-lock is required");
  expect(() =>
    parseAgentRuntimeRelockCli([
      "--arm64",
      "/tmp/arm64.tar.gz",
      "--x64",
      "/tmp/x64.tar.gz",
      "--base-lock",
      "/tmp/base.json",
      "--out",
      path.resolve("resources/agent-runtime/codex-app-server.lock.json"),
    ]),
  ).toThrow("must not overwrite the canonical");
});
