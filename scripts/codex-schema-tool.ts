import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCodexAppServerReleaseLock,
  resolveCodexAppServerReleaseLockPath,
  type AgentRuntimeTargetKey,
} from "./agent-runtime-release-lock";
import { ensureImmutableArtifact, resolveImmutableArtifactPath } from "./immutable-artifact-cache";

const SYSTEM_TAR_PATH = "/usr/bin/tar";

function sha256File(filePath: string): string {
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

function validateArchive(filePath: string, expectedSize: number, expectedSha256: string): void {
  const stats = lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Codex schema tool archive is not a regular file: ${filePath}`);
  }
  if (stats.size !== expectedSize) {
    throw new Error(
      `Codex schema tool archive size mismatch: expected ${expectedSize}, found ${stats.size}`,
    );
  }
  const actualSha256 = sha256File(filePath);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Codex schema tool archive checksum mismatch: expected ${expectedSha256}, found ${actualSha256}`,
    );
  }
}

export function validateCodexSchemaToolArchivePaths(archivePath: string): void {
  const entries = execFileSync(SYSTEM_TAR_PATH, ["-tzf", archivePath], { encoding: "utf8" })
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const normalized = entry.replace(/\/$/u, "");
    const segments = normalized.split("/");
    if (
      entry.startsWith("/") ||
      entry.includes("\\") ||
      segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
      throw new Error(`Codex schema tool archive contains an unsafe path: ${entry}`);
    }
  }
  const verboseEntries = execFileSync(SYSTEM_TAR_PATH, ["-tvzf", archivePath], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  })
    .split("\n")
    .filter(Boolean);
  for (const entry of verboseEntries) {
    if (entry[0] !== "-" && entry[0] !== "d") {
      throw new Error("Codex schema tool archive may contain only regular files and directories");
    }
  }
}

function assertExtractedTree(rootPath: string, currentPath = rootPath): void {
  for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
    const entryPath = path.join(currentPath, entry.name);
    const stats = lstatSync(entryPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Codex schema tool archive contains a symlink: ${entry.name}`);
    }
    if (stats.isDirectory()) {
      assertExtractedTree(rootPath, entryPath);
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Codex schema tool archive contains an unsupported entry: ${entry.name}`);
    }
  }
}

function currentTargetKey(): AgentRuntimeTargetKey {
  if (process.platform !== "darwin" || (process.arch !== "arm64" && process.arch !== "x64")) {
    throw new Error(
      `Codex schema generation is unsupported on ${process.platform}/${process.arch}`,
    );
  }
  return `darwin-${process.arch}`;
}

/**
 * Runs a callback with the exact-release primary Codex CLI used only for schema export.
 * The production runtime remains the smaller standalone app-server package.
 */
export async function withPinnedCodexSchemaTool<A>(
  projectRoot: string,
  use: (binaryPath: string) => A | Promise<A>,
): Promise<A> {
  const lock = readCodexAppServerReleaseLock(resolveCodexAppServerReleaseLockPath(projectRoot));
  const asset = lock.protocolSchema.tools[currentTargetKey()];
  const archivePath = resolveImmutableArtifactPath({
    archiveSha256: asset.archiveSha256,
    assetName: asset.assetName,
    family: "agent-runtime",
    projectRoot,
  });
  await ensureImmutableArtifact({
    destinationPath: archivePath,
    expectedSize: asset.archiveSize,
    label: "Codex schema tool",
    url: asset.url,
    validate: (candidatePath) =>
      validateArchive(candidatePath, asset.archiveSize, asset.archiveSha256),
  });
  validateCodexSchemaToolArchivePaths(archivePath);

  const extractionRoot = mkdtempSync(path.join(os.tmpdir(), "nodex-codex-schema-tool-"));
  try {
    execFileSync(SYSTEM_TAR_PATH, ["-xzf", archivePath, "-C", extractionRoot]);
    assertExtractedTree(extractionRoot);
    const binaryPath = path.join(extractionRoot, ...asset.entrypoint.split("/"));
    const stats = statSync(binaryPath);
    if (!stats.isFile() || (stats.mode & 0o111) === 0) {
      throw new Error(`Codex schema tool entrypoint is not executable: ${asset.entrypoint}`);
    }
    return await use(binaryPath);
  } finally {
    rmSync(extractionRoot, { force: true, recursive: true });
  }
}
