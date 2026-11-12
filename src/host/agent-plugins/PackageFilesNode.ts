import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import type {
  AgentPluginDiagnostic,
  AgentPluginRejectionReason,
} from "../../shared/agent-plugins/types";
import {
  PACKAGE_LIMITS,
  type PackageFiles,
  type PackageFilesPort,
  type PackagePath,
} from "./PackageFiles";

type Entry =
  | { kind: "file"; stat: BigIntStats }
  | { kind: "directory" | "special" }
  | { kind: "link"; target: string };

class PackageFileError extends Error {
  constructor(readonly reason: AgentPluginRejectionReason) {
    super(reason.message);
  }
}

function fail(
  code: AgentPluginRejectionReason["code"],
  message: string,
  relativePath?: string,
): never {
  throw new PackageFileError({ code, message, path: relativePath });
}

function io<T>(operation: (signal: AbortSignal) => Promise<T>, relativePath?: string) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause): AgentPluginRejectionReason =>
      cause instanceof PackageFileError
        ? cause.reason
        : {
            code: "filesystem-error",
            path: relativePath,
            message: "Could not read the package files.",
          },
  });
}

async function inspectEntry(location: string): Promise<Entry> {
  const stat = await lstat(location, { bigint: true });
  if (stat.isDirectory()) return { kind: "directory" };
  if (stat.isFile()) return { kind: "file", stat };
  if (stat.isSymbolicLink()) return { kind: "link", target: await readlink(location) };
  return { kind: "special" };
}

async function inventory(root: string, signal: AbortSignal) {
  const entries = new Map<string, Entry>([[".", { kind: "directory" }]]);
  const children = new Map<string, string[]>();
  const directories = [{ relative: ".", depth: 0 }];
  let totalBytes = 0n;
  for (const { relative, depth } of directories) {
    signal.throwIfAborted();
    const location = path.join(root, relative);
    if ((await realpath(location)) !== location)
      fail("unsafe-path", "A package directory changed while reading it.", relative);
    const names: string[] = [];
    for await (const item of await opendir(location)) {
      signal.throwIfAborted();
      const key = relative === "." ? item.name : relative + "/" + item.name;
      if (entries.size >= PACKAGE_LIMITS.entries || depth >= PACKAGE_LIMITS.depth)
        fail("package-limit", "The package exceeds the entry count or directory depth limit.", key);

      const entry = await inspectEntry(path.join(root, key));
      entries.set(key, entry);
      names.push(item.name);
      if (entry.kind === "directory") directories.push({ relative: key, depth: depth + 1 });
      if (entry.kind !== "file") continue;

      totalBytes += entry.stat.size;
      if (entry.stat.size > PACKAGE_LIMITS.fileBytes || totalBytes > PACKAGE_LIMITS.totalBytes)
        fail("package-limit", "The package exceeds the file or total byte limit.", key);
    }
    children.set(relative, names.sort());
  }
  return { entries, children };
}

function linkSegments(root: string, target: string): string[] | undefined {
  if (!path.isAbsolute(target)) return target.split(path.sep);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (target === root) return [];
  if (target.startsWith(prefix)) return target.slice(prefix.length).split(path.sep);
  return undefined;
}

/** Resolve links from inventory without passing a link or its target to a filesystem read. */
function resolve(root: string, entries: ReadonlyMap<string, Entry>, relative: string): PackagePath {
  const resolved: string[] = [];
  let pending = relative.split("/");
  let links = 0;
  while (pending.length) {
    const segment = pending[0]!;
    pending = pending.slice(1);
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!resolved.length) return { kind: "unsafe" };
      resolved.pop();
      continue;
    }
    const key = [...resolved, segment].join("/");
    const entry = entries.get(key);
    if (!entry) return { kind: "missing" };
    if (entry.kind === "link") {
      const target = linkSegments(root, entry.target);
      if (!target || ++links > 40) return { kind: "unsafe" };
      if (path.isAbsolute(entry.target)) resolved.length = 0;
      pending = [...target, ...pending];
      continue;
    }
    if (entry.kind === "special") return { kind: "special" };
    if (entry.kind === "file") {
      if (pending.length) return { kind: "missing" };
      return { kind: "file", path: key, size: Number(entry.stat.size) };
    }
    resolved.push(segment);
  }
  return { kind: "directory", path: resolved.join("/") || "." };
}

function sameFile(expected: BigIntStats, actual: BigIntStats): boolean {
  return (
    actual.isFile() &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino &&
    actual.size === expected.size &&
    actual.mtimeNs === expected.mtimeNs &&
    actual.ctimeNs === expected.ctimeNs
  );
}

async function readFile(root: string, key: string, stat: BigIntStats, signal: AbortSignal) {
  const location = path.join(root, key);
  const unchanged = () => realpath(location).then((actual) => actual === location);
  if (!(await unchanged())) fail("unsafe-path", "A package file changed its resolved path.", key);
  // Nonblocking open also prevents a FIFO substituted between inventory and open from hanging.
  const handle = await open(
    location,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    if (!sameFile(stat, await handle.stat({ bigint: true })) || !(await unchanged()))
      fail("filesystem-error", "A package file changed during the read.", key);
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      signal.throwIfAborted();
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) fail("filesystem-error", "A package file changed during the read.", key);
      offset += bytesRead;
    }
    if (!sameFile(stat, await handle.stat({ bigint: true })))
      fail("filesystem-error", "A package file changed during the read.", key);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function openPackage(directory: string, signal: AbortSignal): Promise<PackageFiles> {
  const root = await realpath(directory).catch((cause: unknown) => {
    if (
      cause &&
      typeof cause === "object" &&
      "code" in cause &&
      ["ENOENT", "ENOTDIR"].includes(String(cause.code))
    )
      fail("invalid-root", "The package root must be a directory.");
    throw cause;
  });
  if (!(await lstat(root)).isDirectory())
    fail("invalid-root", "The package root must be a directory.");
  const { entries, children } = await inventory(root, signal);
  const inspect = (relative: string) => resolve(root, entries, relative);
  const read = (key: string) =>
    io((signal) => {
      const entry = entries.get(key);
      if (entry?.kind !== "file") fail("filesystem-error", "Expected a regular package file.", key);
      return readFile(root, key, entry.stat, signal);
    }, key);
  return {
    inspect,
    hasEntry: (relative) => {
      const slash = relative.lastIndexOf("/");
      const parent = inspect(slash === -1 ? "." : relative.slice(0, slash));
      if (parent.kind !== "directory") return false;
      const name = relative.slice(slash + 1);
      return entries.has(parent.path === "." ? name : parent.path + "/" + name);
    },
    children: (directory) => children.get(directory) ?? [],
    read,
    digest: io(async (signal) => {
      const hash = createHash("sha256").update("nodex-agent-plugin-v1\0");
      for (const key of [...entries.keys()].sort()) {
        signal.throwIfAborted();
        const entry = entries.get(key)!;
        if (entry.kind !== "file" && entry.kind !== "link") continue;
        const bytes =
          entry.kind === "file"
            ? await readFile(root, key, entry.stat, signal)
            : Buffer.from(entry.target);
        hash.update(JSON.stringify([key, entry.kind, bytes.length]) + "\0").update(bytes);
      }
      return hash.digest("hex");
    }),
    diagnostics: () =>
      [...entries.keys()].sort().flatMap((key): AgentPluginDiagnostic[] => {
        const entry = entries.get(key)!;
        if (entry.kind === "special")
          return [
            {
              code: "unsafe-path",
              path: key,
              message: "Special files are excluded from package reads.",
            },
          ];
        if (entry.kind !== "link" || inspect(key).kind !== "unsafe") return [];
        return [
          {
            code: "unsafe-path",
            path: key,
            message: "The symbolic link escapes the package or cannot be resolved safely.",
          },
        ];
      }),
  };
}

export const packageFilesNode: PackageFilesPort = {
  open: (root) => io((signal) => openPackage(root, signal)),
};
