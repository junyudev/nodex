import { execFileSync } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface DirectoryUsage {
  readonly path: string;
  readonly exists: boolean;
  readonly logicalBytes: number;
  readonly allocatedBytes: number;
  readonly files: number;
  readonly links: number;
  readonly excludedDirectories: number;
  readonly errors: readonly string[];
}

const profileDirectories = new Set([".nodex", "runs.local", "runtime-profiles"]);
const isMissing = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Reads filesystem metadata only; links and known Profile directories are never traversed. */
export async function measureDirectory(directory: string): Promise<DirectoryUsage> {
  const root = path.resolve(directory);
  const seen = new Set<string>();
  const result = {
    path: root,
    exists: false,
    logicalBytes: 0,
    allocatedBytes: 0,
    files: 0,
    links: 0,
    excludedDirectories: 0,
    errors: [] as string[],
  };
  const visit = async (entryPath: string): Promise<void> => {
    try {
      const stat = await lstat(entryPath);
      result.exists = true;
      if (stat.isDirectory() && profileDirectories.has(path.basename(entryPath))) {
        result.excludedDirectories += 1;
        return;
      }
      const identity = `${stat.dev}:${stat.ino}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      result.allocatedBytes += stat.blocks * 512;
      if (stat.isSymbolicLink()) {
        result.links += 1;
        return;
      }
      if (stat.isFile()) {
        result.logicalBytes += stat.size;
        result.files += 1;
        return;
      }
      if (!stat.isDirectory()) return;
      for (const name of await readdir(entryPath)) await visit(path.join(entryPath, name));
    } catch (error) {
      if (isMissing(error)) return;
      result.errors.push(`${entryPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  await visit(root);
  return result;
}

export function parseWorktreePaths(porcelain: string): readonly string[] {
  return porcelain
    .split("\0")
    .filter((record) => record.startsWith("worktree "))
    .map((record) => record.slice("worktree ".length));
}

export function parseCacheReportArguments(args: readonly string[]): {
  readonly allWorktrees: boolean;
  readonly json: boolean;
} {
  if (args.some((argument) => !["--all-worktrees", "--json"].includes(argument))) {
    throw new Error("Usage: cache:report [--all-worktrees] [--json]");
  }
  return { allWorktrees: args.includes("--all-worktrees"), json: args.includes("--json") };
}

export async function createCacheReport(input: {
  readonly repositoryRoot: string;
  readonly allWorktrees?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly globalDirectories?: readonly string[];
}) {
  const repositoryRoot = path.resolve(input.repositoryRoot);
  const environment = input.environment ?? process.env;
  const worktreePaths = parseWorktreePaths(
    execFileSync("git", ["worktree", "list", "--porcelain", "-z"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  const selected = input.allWorktrees ? worktreePaths : [repositoryRoot];
  const worktrees = [];
  for (const worktree of selected) {
    const directories = [];
    for (const name of ["target", "node_modules", ".generated", "out"]) {
      directories.push({ name, ...(await measureDirectory(path.join(worktree, name))) });
    }
    worktrees.push({ path: worktree, directories });
  }
  const cacheRoot = path.resolve(
    environment.NODEX_BUILD_CACHE_DIR?.trim() || path.join(worktreePaths[0], "cache.local"),
  );
  const cargoHome = environment.CARGO_HOME || path.join(os.homedir(), ".cargo");
  const globalDirectories = input.globalDirectories ?? [
    path.join(cargoHome, "registry"),
    path.join(cargoHome, "git"),
    path.join(environment.RUSTUP_HOME || path.join(os.homedir(), ".rustup"), "toolchains"),
    ...(process.platform === "darwin"
      ? [
          path.join(os.homedir(), "Library/Caches/Mozilla.sccache"),
          path.join(os.homedir(), "Library/Caches/electron"),
          path.join(os.homedir(), "Library/Caches/ms-playwright"),
          path.join(os.homedir(), ".local/share/pnpm/store"),
        ]
      : []),
  ];
  const shared = [];
  for (const directory of [cacheRoot, ...globalDirectories])
    shared.push(await measureDirectory(directory));
  return {
    version: 1,
    measurement:
      "Allocated bytes deduplicate hard links within each directory. Filesystem clones may share blocks across entries; totals are not estimates of reclaimable space. Profile directories and symlink targets are excluded.",
    worktrees,
    shared,
  };
}

const size = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

async function main(): Promise<void> {
  const options = parseCacheReportArguments(process.argv.slice(2));
  const report = await createCacheReport({ repositoryRoot: process.cwd(), ...options });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  console.log(report.measurement);
  for (const worktree of report.worktrees) {
    console.log(`\n${worktree.path}`);
    for (const directory of worktree.directories) {
      console.log(
        `  ${directory.name.padEnd(14)} ${size(directory.allocatedBytes)}${directory.exists ? "" : " (absent)"}`,
      );
    }
  }
  console.log("\nShared caches");
  for (const directory of report.shared)
    console.log(`  ${size(directory.allocatedBytes)}  ${directory.path}`);
  const errors = [
    ...report.shared,
    ...report.worktrees.flatMap((worktree) => worktree.directories),
  ].flatMap((directory) => directory.errors);
  for (const error of errors) console.error(error);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
