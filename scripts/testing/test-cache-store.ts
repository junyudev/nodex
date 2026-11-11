import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { resolvePrimaryCheckoutRoot } from "../immutable-artifact-cache.ts";
import type { CacheSuite } from "./test-cache-policy.ts";

export interface CachedPass {
  readonly globalKey: string;
  readonly deps: Readonly<Record<string, string>>;
}

export const digest = (content: string | Buffer) =>
  createHash("sha256").update(content).digest("hex");

export function cacheDirectory(root: string, env: NodeJS.ProcessEnv, suite: CacheSuite) {
  const override = env.NODEX_BUILD_CACHE_DIR?.trim();
  return path.join(
    override ? path.resolve(override) : path.join(resolvePrimaryCheckoutRoot(root), "cache.local"),
    "test-results",
    "v1",
    suite,
  );
}

export function fileHasher(root: string) {
  const read = new Map<
    string,
    Promise<{ hash: string; stamp: string; ctimeNs: bigint } | undefined>
  >();
  const stamp = (value: Awaited<ReturnType<typeof readStat>>) =>
    [value.dev, value.ino, value.size, value.ctimeNs].join(":");
  const readStat = (file: string) => stat(path.join(root, file), { bigint: true });
  const readInput = (file: string) => {
    const cached = read.get(file);
    if (cached) return cached;
    const input = (async () => {
      try {
        const before = await readStat(file);
        if (!before.isFile()) return undefined;
        const bytes = await readFile(path.join(root, file));
        const after = await readStat(file);
        if (stamp(before) !== stamp(after)) return undefined;
        return { hash: digest(bytes), stamp: stamp(after), ctimeNs: after.ctimeNs };
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
          const current = await readStat(file).catch(() => undefined);
          return input ? current && stamp(current) === input.stamp : current === undefined;
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
        await visit(file);
      } else if (entry.isSymbolicLink()) {
        topology.push(JSON.stringify([file, await readlink(path.join(root, file))]));
      } else if (entry.isFile()) {
        files.add(file);
        topology.push(JSON.stringify(file));
      }
    }
  }
  await visit("");
  return { files, topology: digest(topology.sort().join("\n")) };
}

export async function globalCacheKey(
  root: string,
  suite: CacheSuite,
  env: NodeJS.ProcessEnv,
  epoch: string,
  workspace: Awaited<ReturnType<typeof workspaceInputs>>,
  hash: ReturnType<typeof fileHasher>,
) {
  const globalFiles = [...workspace.files]
    .filter(
      (file) =>
        /^(?:config\/|patches\/|scripts\/testing\/|scripts\/tooling\/vitest-)/u.test(file) ||
        /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json|\.env[^/]*|(?:vite|vitest|postcss)\.config\.[^/]+)$/u.test(
          file,
        ) ||
        (suite === "renderer" && file === "src/renderer/test/setup.ts") ||
        [".node-version", ".npmrc", "pnpm-lock.yaml", "pnpm-workspace.yaml"].includes(file),
    )
    .sort();
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
  const environment = Object.entries(env)
    .filter(([name]) =>
      /^(?:NODEX_TEST_TIER$|NODEX_SENTRY_FORCE_TEST$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|CI$|TZ$|LANG$|LC_|VITE_)/u.test(
        name,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return digest(
    JSON.stringify([
      "v1",
      suite,
      process.versions,
      process.platform,
      process.arch,
      epoch,
      environment,
      workspace.topology,
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

export const writeCacheReport = (
  root: string,
  suite: CacheSuite,
  report: { hits: readonly string[]; evidence: readonly unknown[] },
) =>
  publish(
    path.join(root, "node_modules/.cache/test-result-reports", suite + ".json"),
    JSON.stringify(report),
  );

export const invalidateCache = (directory: string) =>
  publish(path.join(directory, "epoch"), randomUUID());

export async function matchesPass(
  pass: CachedPass,
  globalKey: string,
  file: string,
  hash: (file: string) => Promise<string | undefined>,
) {
  if (pass.globalKey !== globalKey || typeof pass.deps?.[file] !== "string") return false;
  for (const [dependency, expected] of Object.entries(pass.deps)) {
    if (
      typeof expected !== "string" ||
      path.isAbsolute(dependency) ||
      path.posix.normalize(dependency) !== dependency ||
      dependency.startsWith("../") ||
      (await hash(dependency)) !== expected
    )
      return false;
  }
  return true;
}

const entriesForFile = (directory: string, file: string) => path.join(directory, digest(file));
const maxEntries = 4;

export async function findPass(
  directory: string,
  file: string,
  key: string,
  hash: ReturnType<typeof fileHasher>,
) {
  const base = entriesForFile(directory, file);
  const entries = await readdir(base).catch(() => []);
  for (const name of entries.filter(
    (entry) => entry.startsWith(key + "-") && entry.endsWith(".json"),
  )) {
    const record = path.join(base, name);
    const pass = await readFile(record, "utf8")
      .then((data) => JSON.parse(data) as CachedPass)
      .catch(() => undefined);
    if (pass && (await matchesPass(pass, key, file, hash))) {
      const now = new Date();
      await utimes(record, now, now).catch(() => undefined);
      return true;
    }
  }
  return false;
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
