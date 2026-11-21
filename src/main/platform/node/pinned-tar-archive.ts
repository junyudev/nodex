/* @effect-diagnostics asyncFunction:off newPromise:off -- Node filesystem and tar adapter. */
import { execFile } from "./child-stdio-errors";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { isSafeWindowsBrowserRuntimePath } from "../../../shared/browser-runtime-metadata";

function runTar(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  // Wait for the child to close even on abort so the caller can safely remove its staging tree.
  return new Promise((resolve, reject) => {
    const { TAR_OPTIONS: _tarOptions, ...environment } = process.env;
    const child = execFile(
      process.platform === "darwin" ? "/usr/bin/tar" : "tar",
      args,
      {
        encoding: "utf8",
        env: { ...environment, LANG: "C", LC_ALL: "C" },
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) reject(signal.reason);
        else if (error) reject(error);
        else resolve(stdout);
      },
    );
    const abort = () => {
      child.kill();
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function assertArchivePathsAreSafe(
  archivePath: string,
  windows: boolean,
  signal?: AbortSignal,
): Promise<void> {
  // List without stripping absolute path prefixes. Inspect names and entry types separately.
  const entries = (await runTar(["-Ptzf", archivePath], signal)).split("\n").filter(Boolean);
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

  const details = (await runTar(["-Ptvzf", archivePath], signal)).split("\n").filter(Boolean);
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
): Promise<void> {
  await assertArchivePathsAreSafe(archivePath, false, signal);
  await runTar(
    ["--no-same-owner", "--no-same-permissions", "-xzf", archivePath, "-C", destination],
    signal,
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
