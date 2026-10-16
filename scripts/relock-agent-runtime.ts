import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCodexAppServerReleaseLock,
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
  type AgentRuntimeTargetKey,
  type CodexAppServerReleaseLock,
} from "./agent-runtime-release-lock";
import type { AgentRuntimeMacosPlatformContractVerifier } from "./agent-runtime-macos-platform-contract";
import { stageCodexRuntimeCandidate } from "./stage-codex-runtime";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = path.resolve(scriptDir, "..");
const ZERO_SHA256 = "0".repeat(64);

export type AgentRuntimeRelockOptions = {
  agentRuntimePlatformContractVerifier?: AgentRuntimeMacosPlatformContractVerifier;
  arm64ArchivePath: string;
  lockPath?: string;
  outputPath: string;
  projectRootPath?: string;
};

function sha256(filePath: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) return hash.digest("hex");
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    closeSync(descriptor);
  }
}

function inspectArchive(input: {
  archivePath: string;
  current: CodexAppServerReleaseLock["builds"][AgentRuntimeTargetKey];
}) {
  return {
    ...input.current,
    archiveSha256: sha256(input.archivePath),
    archiveSize: statSync(input.archivePath).size,
    entrypointSha256: ZERO_SHA256,
    runtimeMetadataSha256: ZERO_SHA256,
  };
}

export async function createAgentRuntimeRelockCandidate(
  options: AgentRuntimeRelockOptions,
): Promise<CodexAppServerReleaseLock> {
  const projectRoot = path.resolve(options.projectRootPath ?? defaultProjectRoot);
  const lockPath = path.resolve(
    options.lockPath ?? resolveCodexAppServerReleaseLockPath(projectRoot),
  );
  const lock = readCodexAppServerReleaseLock(lockPath);
  const temporaryRoot = path.join(os.tmpdir(), `nodex-runtime-relock-${randomUUID()}`);
  mkdirSync(temporaryRoot, { recursive: true });
  try {
    const arm64ArchivePath = path.resolve(options.arm64ArchivePath);

    const builds = {
      ...lock.builds,
      "darwin-arm64": inspectArchive({
        archivePath: arm64ArchivePath,
        current: lock.builds["darwin-arm64"],
      }),
    };
    let candidate = parseCodexAppServerReleaseLock({ ...lock, builds });
    const candidatePath = path.join(temporaryRoot, "candidate.lock.json");
    writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

    const stagedArm64 = await stageCodexRuntimeCandidate({
      agentRuntimePlatformContractVerifier: options.agentRuntimePlatformContractVerifier,
      archivePath: arm64ArchivePath,
      lockPath: candidatePath,
      outputPath: path.join(temporaryRoot, "stage-arm64"),
      projectRootPath: projectRoot,
      targetArch: "arm64",
      targetPlatform: "darwin",
    });
    candidate = parseCodexAppServerReleaseLock({
      ...candidate,
      builds: {
        ...candidate.builds,
        "darwin-arm64": {
          ...candidate.builds["darwin-arm64"],
          entrypointSha256: stagedArm64.metadata.releaseAsset.entrypointSha256,
          runtimeMetadataSha256: stagedArm64.metadataSha256,
        },
      },
    });
    return candidate;
  } finally {
    rmSync(temporaryRoot, { force: true, recursive: true });
  }
}

export function parseAgentRuntimeRelockCli(argv: string[]): AgentRuntimeRelockOptions {
  const args = argv.filter((value) => value !== "--");
  let arm64ArchivePath: string | undefined;
  let lockPath: string | undefined;
  let outputPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--arm64" || arg === "--base-lock" || arg === "--out") {
      if (!value) throw new Error(`Missing value for ${arg}`);
      if (arg === "--arm64") arm64ArchivePath = value;
      if (arg === "--base-lock") lockPath = value;
      if (arg === "--out") outputPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!arm64ArchivePath) {
    throw new Error("--arm64 official Codex release archive is required");
  }
  if (!lockPath) throw new Error("--base-lock is required");
  if (!outputPath) throw new Error("--out is required");
  const resolvedOutputPath = path.resolve(outputPath);
  const canonicalLockPath = resolveCodexAppServerReleaseLockPath(defaultProjectRoot);
  if (resolvedOutputPath === canonicalLockPath) {
    throw new Error("Relock output must not overwrite the canonical release lock");
  }
  return { arm64ArchivePath, lockPath, outputPath: resolvedOutputPath };
}

export function writeAgentRuntimeRelockCandidate(
  outputPath: string,
  candidate: CodexAppServerReleaseLock,
): void {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, { flag: "wx" });
}

async function main(): Promise<void> {
  const options = parseAgentRuntimeRelockCli(process.argv.slice(2));
  const candidate = await createAgentRuntimeRelockCandidate(options);
  writeAgentRuntimeRelockCandidate(options.outputPath, candidate);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
