/* @effect-diagnostics asyncFunction:off newPromise:off -- Node filesystem and tar adapter. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { isSafeWindowsBrowserRuntimePath } from "../../../shared/browser-runtime-metadata";

export function pinnedTarExecutable(): string {
  if (process.platform === "darwin") return "/usr/bin/tar";
  if (process.platform !== "win32") return "tar";
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("The Windows system directory could not be resolved.");
  }
  return path.win32.join(systemRoot, "System32", "tar.exe");
}

const TAR_OUTPUT_LIMIT = 32 * 1024 * 1024;

/**
 * Paths never reach tar's command line. Windows tar decodes its arguments with the ANSI code
 * page, which cannot spell every Profile path, so the archive arrives on stdin and extraction is
 * relative to the child's working directory; both cross the operating system's Unicode APIs.
 */
function runTar(
  args: readonly string[],
  archive: string,
  options: { readonly cwd?: string; readonly signal?: AbortSignal } = {},
): Promise<string> {
  const { cwd, signal } = options;
  signal?.throwIfAborted();
  // Wait for the child to close even on abort so the caller can safely remove its staging tree.
  return new Promise((resolve, reject) => {
    const { TAR_OPTIONS: _tarOptions, ...environment } = process.env;
    const child = spawn(pinnedTarExecutable(), [...args, "-f", "-"], {
      cwd,
      env: { ...environment, LANG: "C", LC_ALL: "C" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure ??= error;
      child.kill();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > TAR_OUTPUT_LIMIT) fail(new Error("tar output exceeded its limit."));
      else stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < 64 * 1024) stderr.push(chunk);
      stderrBytes += chunk.length;
    });
    child.stdout.on("error", fail);
    child.stderr.on("error", fail);
    // tar can stop reading after a failure; its exit status explains why, not the broken pipe.
    child.stdin.on("error", () => {});
    const input = createReadStream(archive);
    input.on("error", fail);
    input.pipe(child.stdin);
    const abort = () => fail(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", fail);
    child.on("close", (code, killSignal) => {
      signal?.removeEventListener("abort", abort);
      input.destroy();
      if (signal?.aborted) reject(signal.reason);
      else if (failure !== undefined) reject(failure);
      else if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`tar exited with ${code ?? killSignal}${detail ? `: ${detail}` : ""}`));
      } else resolve(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

export async function assertArchivePathsAreSafe(
  archivePath: string,
  windows: boolean,
  signal?: AbortSignal,
): Promise<void> {
  // List without stripping absolute path prefixes. Inspect names and entry types separately.
  const entries = (await runTar(["-Ptz"], archivePath, { signal })).split(/\r?\n/u).filter(Boolean);
  if (entries.length === 0) throw new Error("Component archive is empty.");
  const names = new Set<string>();
  const spellings = new Map<string, string>();
  for (const entry of entries) {
    const normalized = entry.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
    if (normalized === "." || normalized === "") {
      if (entry === "/" || entry.startsWith("/")) throw new Error("Unsafe component archive path.");
      continue;
    }
    const segments = normalized.split("/");
    if (
      normalized.includes("\\") ||
      /^[a-z]:/iu.test(normalized) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..") ||
      names.has(normalized) ||
      (windows && !isSafeWindowsBrowserRuntimePath(normalized))
    ) {
      throw new Error("Unsafe or duplicate component archive path.");
    }
    names.add(normalized);
    if (!windows) continue;
    let prefix = normalized;
    while (prefix !== ".") {
      const folded = prefix.toLowerCase();
      const prior = spellings.get(folded);
      if (prior && prior !== prefix) throw new Error("Aliased component archive path.");
      spellings.set(folded, prefix);
      prefix = path.posix.dirname(prefix);
    }
  }

  const details = (await runTar(["-Ptvz"], archivePath, { signal }))
    .split(/\r?\n/u)
    .filter(Boolean);
  if (details.length !== entries.length || details.some((line) => !/^[-d]/u.test(line))) {
    throw new Error("Component archives may contain only regular files and directories.");
  }
}

/** Speculative archives must fit their allocated expansion budget before tar reads them. */
export async function verifyGzipExpansion(
  archivePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<void> {
  await pipeline(
    createReadStream(archivePath),
    createGunzip(),
    async (content) => {
      let remaining = maxBytes;
      for await (const chunk of content) {
        remaining -= chunk.length;
        if (remaining < 0) throw new Error("Component archive exceeds its unpacked size budget.");
      }
    },
    { signal },
  );
}

export async function extractPinnedTarArchive(
  archivePath: string,
  destination: string,
  signal: AbortSignal,
  options = { windows: process.platform === "win32" },
): Promise<void> {
  await assertArchivePathsAreSafe(archivePath, options.windows, signal);
  await runTar(
    [
      "--no-same-owner",
      "--no-same-permissions",
      ...(process.platform === "win32" ? ["--no-acls", "--no-xattrs", "--no-fflags"] : []),
      "-xz",
    ],
    archivePath,
    { cwd: destination, signal },
  );
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

export async function inventoryRegularFiles(
  root: string,
  signal?: AbortSignal,
  expectedPaths?: readonly string[],
) {
  const directories = expectedPaths ? new Set<string>() : null;
  if (directories && expectedPaths) {
    for (const file of expectedPaths) {
      let directory = path.posix.dirname(file);
      while (directory !== "." && !directories.has(directory)) {
        directories.add(directory);
        directory = path.posix.dirname(directory);
      }
    }
  }
  const files = new Map<string, { size: number; mode: number }>();
  const walk = async (relative: string): Promise<void> => {
    signal?.throwIfAborted();
    for (const entry of await readdir(path.join(root, relative))) {
      const child = relative ? `${relative}/${entry}` : entry;
      const stats = await lstat(path.join(root, child));
      if (stats.isDirectory()) {
        if (directories && !directories.has(child))
          throw new Error("Component contains an unexpected directory.");
        await walk(child);
        continue;
      }
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error("Component contains an unsupported file.");
      }
      files.set(child, { size: stats.size, mode: stats.mode });
    }
  };
  await walk("");
  return files;
}
