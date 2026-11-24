import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import path from "node:path";
import { resolvePrimaryCheckoutRoot } from "../immutable-artifact-cache.ts";
import type { CachedSuiteReport } from "./run-cached-tests.ts";
import {
  localInputReader,
  portablePath,
  sameMembers,
  type LocalInputs,
} from "./test-cache-inputs.ts";
import type { TestEvidence } from "./test-cache-evidence.ts";
import type { SuiteId } from "../../config/test-suites.ts";
import type { TestRuntimeIdentity } from "./runtime.ts";

export interface CachedPass {
  readonly globalKey: string;
  readonly deps: Readonly<Record<string, string>>;
  readonly local?: LocalInputs;
}

export const digest = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

export function cacheDirectory(root: string, env: NodeJS.ProcessEnv, suite: SuiteId) {
  const override = env.NODEX_BUILD_CACHE_DIR?.trim();
  return path.join(
    override ? path.resolve(override) : path.join(resolvePrimaryCheckoutRoot(root), "cache.local"),
    "test-results",
    "v2",
    suite,
  );
}

export const fileStamp = (value: BigIntStats) =>
  [value.dev, value.ino, value.size, value.ctimeNs].join(":");

export function digestCachePath(root: string, env: NodeJS.ProcessEnv) {
  const results = path.dirname(cacheDirectory(root, env, "unit"));
  return path.join(results, "digests", digest(root) + ".json");
}

/** A stamp is only a shortcut for bytes hashed while that stamp was stable. */
export function stampDigests(filename?: string) {
  const pending = new Map<string, Promise<string | undefined>>();
  const additions = new Map<string, string>();
  const stored = (async () => {
    if (!filename) return new Map<string, string>();
    try {
      const record = await readFile(filename, "utf8");
      const payload = record.slice(65);
      if (record.slice(0, 65) === digest(payload) + "\n") {
        const entries = JSON.parse(payload) as Record<string, string>;
        return new Map(
          Object.entries(entries).filter(([, value]) => /^[a-f0-9]{64}$/u.test(value)),
        );
      }
    } catch {
      // The digest table is a performance hint. Re-read content if it is unavailable.
    }
    return new Map<string, string>();
  })();
  const fresh = async (file: string, stamp: string) => {
    const bytes = await readFile(file);
    const after = await stat(file, { bigint: true });
    return stamp === fileStamp(after) ? digest(bytes) : undefined;
  };
  return {
    async hash(file: string, before: BigIntStats) {
      const stamp = fileStamp(before);
      // A coarse filesystem clock can give a fresh change the same ctime as its predecessor.
      // Publish only stamps already older than one full clock tick when bytes are read.
      if (before.ctimeNs >= BigInt(Date.now() - 1_000) * 1_000_000n) return fresh(file, stamp);
      const existing = (await stored).get(stamp);
      if (existing) return existing;
      const cached = pending.get(stamp);
      if (cached) return cached;
      const computed = fresh(file, stamp).then((hash) => {
        if (hash) additions.set(stamp, hash);
        return hash;
      });
      pending.set(stamp, computed);
      return computed;
    },
    async flush() {
      if (!filename || additions.size === 0) return;
      const entries = [...(await stored), ...additions].slice(-32_768);
      const payload = JSON.stringify(Object.fromEntries(entries));
      await publish(filename, digest(payload) + "\n" + payload).catch(() => undefined);
    },
  };
}

export function fileHasher(root: string, digests = stampDigests()) {
  const canonicalRoot = realpath(root).catch(() => undefined);
  const read = new Map<
    string,
    Promise<{ hash: string; stamp: string; ctimeNs: bigint } | undefined>
  >();
  const readStat = (file: string) => stat(path.join(root, file), { bigint: true });
  const readInput = (file: string) => {
    const cached = read.get(file);
    if (cached) return cached;
    const input = (async () => {
      try {
        const before = await readStat(file);
        if (!before.isFile()) return undefined;
        const canonical = await canonicalRoot;
        if (
          !canonical ||
          (!file.startsWith("node_modules/") &&
            (await realpath(path.join(root, file))) !== path.join(canonical, file))
        )
          return undefined;
        const hash = await digests.hash(path.join(root, file), before);
        if (!hash) return undefined;
        return { hash, stamp: fileStamp(before), ctimeNs: before.ctimeNs };
      } catch {
        return undefined;
      }
    })();
    read.set(file, input);
    return input;
  };
  const hash = async (file: string, stableSince?: number) => {
    const input = await readInput(file);
    if (stableSince !== undefined && input && input.ctimeNs >= BigInt(stableSince) * 1_000_000n)
      return undefined;
    return input?.hash;
  };
  return Object.assign(hash, {
    async unchanged() {
      const results = await Promise.all(
        [...read].map(async ([file, pending]) => {
          const input = await pending;
          if (!input) return true;
          const current = await readStat(file).catch(() => undefined);
          return current && fileStamp(current) === input.stamp;
        }),
      );
      return results.every(Boolean);
    },
  });
}

const ignoredDirectories = new Set([
  ".git",
  ".agents",
  ".codex",
  ".cache",
  ".astro",
  ".generated",
  "dist",
  ".vite",
  ".vitest-attachments",
  "node_modules",
  "target",
  "out",
  "coverage",
]);

const ignoredRootDirectories = new Set([
  ".kanban",
  ".playwright-cli",
  ".vercel",
  "build",
  "test-results",
]);

export async function workspaceInputs(root: string, resultsRoot?: string) {
  const files = new Set<string>();
  const links = new Set<string>();
  const topology: string[] = [];
  async function visit(directory: string) {
    const entries = await readdir(path.join(root, directory), { withFileTypes: true });
    for (const entry of entries) {
      if (
        ignoredDirectories.has(entry.name) ||
        entry.name === ".DS_Store" ||
        entry.name.endsWith(".tsbuildinfo") ||
        (entry.isDirectory() &&
          (entry.name.endsWith(".local") || (!directory && ignoredRootDirectories.has(entry.name))))
      )
        continue;
      const file = directory ? directory + "/" + entry.name : entry.name;
      if (resultsRoot && path.join(root, file) === resultsRoot) continue;
      if (entry.isDirectory()) {
        topology.push(JSON.stringify([file]));
        await visit(file);
      } else if (entry.isSymbolicLink()) {
        links.add(file);
        topology.push(JSON.stringify([file, await readlink(path.join(root, file))]));
      } else if (entry.isFile()) {
        files.add(file);
        topology.push(JSON.stringify(file));
      }
    }
  }
  await visit("");
  return { files, links, topology: digest(topology.sort().join("\n")) };
}

export async function globalCacheKey(
  root: string,
  suite: SuiteId,
  env: NodeJS.ProcessEnv,
  epoch: string,
  workspace: Awaited<ReturnType<typeof workspaceInputs>>,
  hash: ReturnType<typeof fileHasher>,
  runtime: TestRuntimeIdentity,
  suiteIdentity: unknown,
  configDependencies: readonly string[] = [],
) {
  const sharedInput = (file: string) =>
    /^(?:config\/|patches\/|scripts\/testing\/|scripts\/tooling\/vitest-)/u.test(file) ||
    /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.env[^/]*|(?:vite|vitest|postcss)\.config\.[^/]+)$/u.test(
      file,
    ) ||
    (suite === "renderer" && file === "src/renderer/test/setup.ts") ||
    (suite === "browser" && /(?:^|\/)\.gitignore$/u.test(file)) ||
    [".node-version", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file);
  if ([...workspace.links].some(sharedInput)) return undefined;
  const globalFiles = [
    ...new Set([...workspace.files].filter(sharedInput).concat(configDependencies)),
  ].sort();
  if (!globalFiles.every((file) => workspace.files.has(file))) return undefined;
  const installed = await readFile(path.join(root, "node_modules/.modules.yaml"), "utf8").catch(
    () => undefined,
  );
  const [, installedLock] = await Promise.all([
    hash("node_modules/.modules.yaml"),
    hash("node_modules/.pnpm/lock.yaml"),
  ]);
  if (!installed || !installedLock) return undefined;
  const inputs = await Promise.all(
    globalFiles.map(async (file) => [file, await hash(file)] as const),
  );
  if (inputs.some(([, content]) => content === undefined)) return undefined;
  // The runtime exposes process.env to all tests. Normalize checkout paths and omit the
  // budget's reporting destination, which only instruments the runner.
  const environment = Object.entries(env)
    .filter(([name]) => name !== "NODEX_MACHINE_BUDGET_REPORT" && name !== "_")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, value?.replaceAll(root, "<workspace>")]);
  return digest(
    JSON.stringify([
      "v2",
      suite,
      runtime,
      suiteIdentity,
      epoch,
      environment,
      inputs,
      installedLock,
      installed.replace(/^\s*"prunedAt":.*\n/gmu, "").replaceAll(root, "<workspace>"),
    ]),
  );
}

export const cacheEpoch = (directory: string) =>
  readFile(path.join(directory, "epoch"), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
    throw error;
  });

async function publish(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

type CacheReportHistory = {
  readonly timings?: Record<string, number>;
  readonly auditedAt?: Record<string, number>;
};

const reportPath = (root: string, suite: SuiteId) =>
  path.join(root, "node_modules/.cache/test-result-reports", suite + ".json");

export async function readCacheReport(root: string, suite: SuiteId) {
  return readFile(reportPath(root, suite), "utf8")
    .then((content) => (JSON.parse(content) as CacheReportHistory | null) ?? {})
    .catch((): CacheReportHistory => ({}));
}

export const writeCacheReport = (
  root: string,
  suite: SuiteId,
  report: CacheReportHistory & {
    hits: readonly string[];
    summary: CachedSuiteReport;
    evidence: readonly Omit<TestEvidence, "deps">[];
  },
) => publish(reportPath(root, suite), JSON.stringify(report));

export const invalidateCache = (directory: string) =>
  publish(path.join(directory, "epoch"), randomUUID());

export async function changedPassInputs(
  pass: CachedPass,
  globalKey: string,
  file: string,
  hash: ReturnType<typeof fileHasher>,
  workspace: PassWorkspace,
) {
  if (pass?.globalKey !== globalKey || typeof pass.deps?.[file] !== "string")
    throw new CorruptCachedPass(file);
  const changed: string[] = [];
  for (const [dependency, expected] of Object.entries(pass.deps)) {
    if (typeof expected !== "string" || !portablePath(dependency))
      throw new CorruptCachedPass(file);
    if ((await hash(dependency)) !== expected) changed.push(dependency);
  }
  if (pass.local?.topology !== undefined && pass.local.topology !== workspace.topology)
    changed.push("workspace file names");
  for (const [file, expected] of Object.entries(pass.local?.probes ?? {})) {
    if (
      !portablePath(file) ||
      (expected !== "absent" && expected !== "directory" && expected !== "file")
    )
      throw new CorruptCachedPass(file);
    if ((await workspace.reader.state(file)) !== expected) changed.push(file);
  }
  for (const [pattern, expected] of Object.entries(pass.local?.globs ?? {})) {
    if (!portablePath(pattern) || !Array.isArray(expected)) throw new CorruptCachedPass(file);
    const members = await workspace.reader.glob(pattern);
    if (!members || !sameMembers(members, expected)) changed.push(pattern);
  }
  for (const entry of pass.local?.observed ?? []) {
    if (entry.path !== "." && !portablePath(entry.path)) throw new CorruptCachedPass(file);
    if (!(await workspace.reader.matches(entry))) changed.push(entry.path);
  }
  const missing = pass.local?.missingModules;
  if (missing) {
    if (
      typeof missing.root !== "string" ||
      !path.isAbsolute(missing.root) ||
      !Array.isArray(missing.candidates) ||
      !missing.candidates.every(
        (candidate) => typeof candidate === "string" && path.isAbsolute(candidate),
      )
    )
      throw new CorruptCachedPass(file);
    if (!(await workspace.reader.matchesMissingModules(missing)))
      changed.push("native module lookup candidates");
  }
  return [...new Set(changed)];
}

export type PassLookup =
  | { readonly kind: "hit" | "unrecorded" | "globalKeyMiss" }
  | { readonly kind: "changed"; readonly inputs: readonly string[] };

const entriesForFile = (directory: string, file: string) => path.join(directory, digest(file));
const maxEntries = 4;

export class CorruptCachedPass extends Error {}

interface PassWorkspace {
  readonly topology: string;
  readonly reader: ReturnType<typeof localInputReader>;
  readonly onHit?: (pass: CachedPass) => void;
}

export async function findPass(
  directory: string,
  file: string,
  key: string,
  hash: ReturnType<typeof fileHasher>,
  workspace: PassWorkspace = { topology: "", reader: localInputReader(directory) },
): Promise<PassLookup> {
  const base = entriesForFile(directory, file);
  const entries = (await readdir(base).catch(() => [])).filter((name) => name.endsWith(".json"));
  let closest: string[] | undefined;
  let otherGlobalKey = false;
  for (const name of entries) {
    if (!name.startsWith(key + "-")) {
      otherGlobalKey = true;
      continue;
    }
    const record = path.join(base, name);
    const content = await readFile(record, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (content === undefined) continue;
    if (name !== key + "-" + digest(content) + ".json") throw new CorruptCachedPass(file);
    const pass = JSON.parse(content) as CachedPass;
    const changed = await changedPassInputs(pass, key, file, hash, workspace);
    if (changed.length === 0) {
      const now = new Date();
      await utimes(record, now, now).catch(() => undefined);
      workspace.onHit?.(pass);
      return { kind: "hit" };
    }
    // Compare against the closest retained pass so old edits are not counted again.
    if (!closest || changed.length < closest.length) closest = changed;
  }
  if (closest) return { kind: "changed", inputs: closest };
  return { kind: otherGlobalKey ? "globalKeyMiss" : "unrecorded" };
}

export async function savePass(directory: string, file: string, pass: CachedPass) {
  const base = entriesForFile(directory, file);
  const contents = JSON.stringify(pass);
  await publish(path.join(base, pass.globalKey + "-" + digest(contents) + ".json"), contents);
  const entries = await readdir(base);
  const versions = await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (name) => {
        const filename = path.join(base, name);
        return {
          filename,
          mtime: await stat(filename)
            .then((value) => value.mtimeMs)
            .catch(() => 0),
        };
      }),
  );
  versions.sort(
    (left, right) => right.mtime - left.mtime || left.filename.localeCompare(right.filename),
  );
  await Promise.all(
    versions.slice(maxEntries).map(({ filename }) => rm(filename, { force: true })),
  );
}
