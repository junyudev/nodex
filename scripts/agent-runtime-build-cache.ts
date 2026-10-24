import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { immutableDirectoryDigest } from "./immutable-artifact-cache";
import { type NodeBuildMode } from "../config/node-build-optimization";

import type { AgentRuntimeNative } from "./agent-runtime-native";

const implementationPath = fileURLToPath(import.meta.url);
const ignoredDirectories = new Set([
  ".cache",
  ".generated",
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const digest = (contents: string | Buffer): string =>
  createHash("sha256").update(contents).digest("hex");

/** Include dependency link destinations, since relinking a package can change import resolution. */
function dependencyLinks(root: string): readonly unknown[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name !== ".bin" && name !== ".pnpm")
    .sort()
    .map((name) => {
      const entry = join(root, name);
      const stat = lstatSync(entry);
      if (stat.isSymbolicLink()) return [name, readlinkSync(entry)];
      if (stat.isDirectory() && name.startsWith("@")) return [name, dependencyLinks(entry)];
      return [name, stat.isDirectory() ? "directory" : digest(readFileSync(entry))];
    });
}

/** Cover source-file additions, resolver metadata, and dependency link destinations. */
function treeIdentity(root: string, ignoreGenerated = true): string {
  if (!existsSync(root)) return "missing";
  const hash = createHash("sha256");
  const visited = new Set<string>();
  const visit = (entry: string): void => {
    const stat = lstatSync(entry);
    hash.update(`${relative(root, entry)}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${readlinkSync(entry)}\0`);
      if (existsSync(entry)) visit(realpathSync(entry));
      return;
    }
    if (stat.isFile()) {
      // esbuild's actual input bytes are hashed separately. Other files matter for
      // module resolution only through their names and resolver JSON metadata.
      if (entry === root || extname(entry) === ".json") hash.update(readFileSync(entry));
      hash.update("\0");
      return;
    }
    if (!stat.isDirectory()) throw new Error(`Unsupported Agent Runtime input: ${entry}`);
    if (visited.has(entry)) return;
    visited.add(entry);
    for (const name of readdirSync(entry).sort()) {
      if (name === "node_modules") {
        hash.update(JSON.stringify(dependencyLinks(join(entry, name))));
        continue;
      }
      if (!ignoreGenerated || !ignoredDirectories.has(name)) visit(join(entry, name));
    }
  };
  visit(root);
  return hash.digest("hex");
}

/** esbuild reads source-map sidecars and missing embedded source contents outside its metafile. */
function sourceMapInputs(file: string, contents: Buffer): readonly (readonly [string, string])[] {
  const inputs = new Map<string, string>();
  const inspectMap = (text: string, location: string): void => {
    let map: {
      sourceRoot?: string;
      sources?: unknown[];
      sourcesContent?: unknown[];
      sections?: { map?: unknown; url?: string }[];
    };
    try {
      map = JSON.parse(text) as typeof map;
    } catch {
      return; // esbuild diagnoses malformed source maps; their bytes still invalidate the cache.
    }
    if (!map || typeof map !== "object") return;
    for (const [index, source] of (Array.isArray(map.sources) ? map.sources : []).entries()) {
      if (typeof source !== "string" || typeof map.sourcesContent?.[index] === "string") continue;
      const reference = `${typeof map.sourceRoot === "string" ? `${map.sourceRoot}/` : ""}${source}`;
      const path = localReference(reference, location);
      if (path)
        inputs.set(
          path,
          existsSync(path) && statSync(path).isFile() ? digest(readFileSync(path)) : "missing",
        );
    }
    for (const section of Array.isArray(map.sections) ? map.sections : []) {
      if (section.map) inspectMap(JSON.stringify(section.map), location);
      if (typeof section.url === "string") inspectReference(section.url, location);
    }
  };
  const inspectReference = (reference: string, location: string): void => {
    if (reference.startsWith("data:")) {
      const separator = reference.indexOf(",");
      if (separator < 0) return;
      const value = reference.slice(separator + 1);
      try {
        inspectMap(
          reference.slice(0, separator).endsWith(";base64")
            ? Buffer.from(value, "base64").toString("utf8")
            : decodeURIComponent(value),
          location,
        );
      } catch {
        // Invalid data URLs are diagnosed by esbuild as well.
      }
      return;
    }
    const path = localReference(reference, location);
    if (!path || inputs.has(path)) return;
    if (!existsSync(path) || !statSync(path).isFile()) {
      inputs.set(path, "missing");
      return;
    }
    const map = readFileSync(path);
    inputs.set(path, digest(map));
    inspectMap(map.toString("utf8"), path);
  };
  for (const match of contents
    .toString("utf8")
    .matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)|\/\*[#@]\s*sourceMappingURL=([^\s*]+)/gu)) {
    inspectReference((match[1] ?? match[2])!, file);
  }
  return [...inputs].sort(([left], [right]) => left.localeCompare(right));
}

function localReference(reference: string, source: string): string | null {
  if (reference.startsWith("file:")) {
    try {
      return fileURLToPath(reference);
    } catch {
      return null;
    }
  }
  if (/^[a-z]+:/iu.test(reference)) return null;
  return resolve(dirname(source), reference);
}

function inputIdentity(root: string, files: readonly string[]): readonly unknown[] {
  return [...files].sort().map((file) => {
    const absolute = resolve(root, file);
    const contents = readFileSync(absolute);
    return [file, digest(contents), sourceMapInputs(absolute, contents)];
  });
}

function enclosingPackage(root: string, file: string): string {
  let directory = dirname(file);
  while (directory !== root) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return file;
}

export interface AgentRuntimeBuildIdentity {
  readonly root: string;
  readonly binary: string;
  readonly sdk: string;
  readonly mode: NodeBuildMode;
  readonly inputs: readonly string[];
  readonly native: AgentRuntimeNative;
}

export function agentRuntimeBuildIdentity(input: AgentRuntimeBuildIdentity): string {
  const { root } = input;
  // Fingerprint source topology so adding a higher-priority module invalidates the old graph.
  const trees = ["packages", "src/shared", "resources/agent-runtime"].map((path) =>
    join(root, path),
  );
  const insideTree = (file: string): boolean =>
    trees.some((tree) => file === tree || file.startsWith(`${tree}/`));
  const dependencyTrees = new Set(
    input.inputs
      .map((file) => resolve(root, file))
      .filter((file) => !insideTree(file))
      .map((file) => enclosingPackage(root, file)),
  );
  const configuration = [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".npmrc",
    "config/node-build-optimization.ts",
    ...readdirSync(root).filter((name) => /^tsconfig(?:\..+)?\.json$/u.test(name)),
  ];
  return digest(
    JSON.stringify({
      version: 1,
      root,
      platform: process.platform,
      architecture: process.arch,
      node: process.version,
      mode: input.mode,
      environment: ["NODE_ENV", "NODE_PATH", "NODE_OPTIONS", "ESBUILD_BINARY_PATH"].map((key) => [
        key,
        process.env[key] ?? "",
      ]),
      builder: digest(readFileSync(new URL("./build-agent-runtime.ts", import.meta.url))),
      cache: digest(readFileSync(implementationPath)),
      binary: [input.binary, digest(readFileSync(input.binary))],
      configuration: configuration.sort().map((path) => [path, treeIdentity(join(root, path))]),
      sources: trees.map((tree) => [tree, treeIdentity(tree)]),
      dependencies: [...dependencyTrees].sort().map((tree) => [tree, treeIdentity(tree, false)]),
      inputs: inputIdentity(root, input.inputs),
      notices: ["LICENSE.t3code", "UPSTREAM.json"].map((notice) => [
        notice,
        digest(readFileSync(join(root, "packages/agent-runtime", notice))),
      ]),
      dependencyLinks: dependencyLinks(join(root, "node_modules")),
      nodePathLinks: (process.env.NODE_PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((path) => [path, dependencyLinks(path)]),
      sdk: [input.sdk, immutableDirectoryDigest(input.sdk)],
      native: [
        input.native.identity,
        immutableDirectoryDigest(input.native.packageRoot),
        digest(readFileSync(input.native.manifestPath)),
      ],
    }),
  );
}

/** Custom Node loaders can import mutable files that are absent from esbuild's input graph. */
export const canReuseAgentRuntimeBuild = (root: string): boolean =>
  // pnpm exports its worktree-local dependency lookup paths to scripts.
  !(process.env.NODE_PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((path) => !resolve(path).startsWith(`${join(root, "node_modules")}/`)) &&
  !process.env.ESBUILD_BINARY_PATH &&
  !/--(?:require|import|(?:experimental-)?loader)\b|(?:^|\s)-r/u.test(
    process.env.NODE_OPTIONS ?? "",
  );

export interface AgentRuntimeBuildReceipt {
  readonly identity: string;
  readonly inputs: readonly string[];
  readonly output: string;
  readonly metafile: string;
}

export function readAgentRuntimeBuildReceipt(path: string): AgentRuntimeBuildReceipt | null {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as AgentRuntimeBuildReceipt;
    if (
      typeof value.identity !== "string" ||
      typeof value.output !== "string" ||
      typeof value.metafile !== "string" ||
      !Array.isArray(value.inputs) ||
      value.inputs.length === 0 ||
      !value.inputs.every((input) => typeof input === "string")
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export const agentRuntimeMetafileDigest = (path: string): string => digest(readFileSync(path));

function lockOwner(path: string): { pid: number; token: string } | null {
  try {
    const owner = JSON.parse(readFileSync(join(path, "owner.json"), "utf8")) as {
      pid: number;
      token: string;
    };
    return Number.isSafeInteger(owner.pid) && owner.pid > 0 && typeof owner.token === "string"
      ? owner
      : null;
  } catch {
    return null;
  }
}

function isStaleLock(path: string): boolean {
  const owner = lockOwner(path);
  if (!owner) return Date.now() - lstatSync(path).mtimeMs > 5_000;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

/** Keep concurrent dev/build invocations from interleaving bundle publication. */
export function withAgentRuntimeBuildLock<T>(root: string, build: () => T): T {
  const lock = join(root, ".generated/agent-runtime-build.lock");
  mkdirSync(dirname(lock), { recursive: true });
  const owner = { pid: process.pid, token: randomUUID() };
  const deadline = Date.now() + 30 * 60 * 1_000;
  const waiting = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "owner.json"), JSON.stringify(owner));
      break;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    try {
      if (isStaleLock(lock)) {
        const abandoned = `${lock}.stale-${randomUUID()}`;
        renameSync(lock, abandoned);
        rmSync(abandoned, { force: true, recursive: true });
        continue;
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for Agent Runtime build: ${lock}`);
    Atomics.wait(waiting, 0, 0, 50);
  }
  try {
    return build();
  } finally {
    if (lockOwner(lock)?.token === owner.token) rmSync(lock, { force: true, recursive: true });
  }
}
