import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CHANGES_DIRECTORY, RELEASE_MEDIA_PATH } from "../../src/shared/changelog";
import { MEDIA_FILE } from "../../src/shared/release-media";
import { resolveMediaStore } from "./store";

const REFERENCE = /[0-9a-f]{64}\.(?:png|mp4)/gu;
// The same pattern in the extended syntax git grep reads.
const REFERENCE_ERE = "[0-9a-f]{64}\\.(png|mp4)";
const DAY = 86_400_000;

export interface StoredMedia {
  readonly name: string;
  readonly bytes: number;
  /** When the file was stored, in milliseconds since the epoch. */
  readonly stored: number;
}

/**
 * Stored pictures that no change file mentions and that were stored before the grace period. The
 * grace period spares a picture an Agent has just stored but not yet written into a change file.
 */
export function orphanedMedia(
  stored: readonly StoredMedia[],
  referenced: ReadonlySet<string>,
  now: number,
  graceDays: number,
): StoredMedia[] {
  return stored.filter(
    ({ name, stored }) => !referenced.has(name) && now - stored >= graceDays * DAY,
  );
}

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * Every media name mentioned in the change files or release media YAML across all worktrees,
 * including edits not committed yet, and every branch and tag.
 * Matching names in the raw text keeps a picture whenever any file mentions it, even one that does
 * not parse.
 */
export function referencedMedia(cwd: string): Set<string> {
  const names = new Set<string>();
  const collect = (text: string) => {
    for (const [name] of text.matchAll(REFERENCE)) names.add(name);
  };

  for (const line of git(cwd, ["worktree", "list", "--porcelain", "-z"]).split("\0")) {
    if (!line.startsWith("worktree ")) continue;
    const worktree = line.slice("worktree ".length);
    const backfill = join(worktree, RELEASE_MEDIA_PATH);
    if (existsSync(backfill)) collect(readFileSync(backfill, "utf8"));
    const directory = join(worktree, CHANGES_DIRECTORY);
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) collect(readFileSync(join(entry.parentPath, entry.name), "utf8"));
    }
  }

  const refs = git(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/heads",
    "refs/remotes",
    "refs/tags",
  ])
    .split("\n")
    .filter(Boolean);
  for (let start = 0; start < refs.length; start += 200) {
    try {
      collect(
        git(cwd, [
          "grep",
          "--no-color",
          "-h",
          "-o",
          "-E",
          REFERENCE_ERE,
          ...refs.slice(start, start + 200),
          "--",
          CHANGES_DIRECTORY,
          RELEASE_MEDIA_PATH,
        ]),
      );
    } catch (error) {
      // git grep exits with 1 when nothing matches.
      if ((error as { status?: number }).status !== 1) throw error;
    }
  }
  return names;
}

export function storedMedia(store: string): StoredMedia[] {
  if (!existsSync(store)) return [];
  return readdirSync(store)
    .filter((name) => MEDIA_FILE.test(name))
    .map((name) => {
      const { size, mtimeMs } = statSync(join(store, name));
      return { name, bytes: size, stored: mtimeMs };
    });
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

function main(): void {
  const args = process.argv.slice(2);
  if (args[0] === "--") args.shift();
  const { values } = parseArgs({
    args,
    options: {
      delete: { type: "boolean", default: false },
      "grace-days": { type: "string", default: "14" },
    },
  });
  const graceDays = Number(values["grace-days"]);
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new Error("Usage: vp run media:prune -- [--delete] [--grace-days <whole days>].");
  }
  const cwd = process.cwd();
  const store = resolveMediaStore(cwd);
  const stored = storedMedia(store);
  const orphans = orphanedMedia(stored, referencedMedia(cwd), Date.now(), graceDays);
  const total = orphans.reduce((sum, { bytes }) => sum + bytes, 0);
  for (const { name, bytes } of orphans) process.stdout.write(`${name}  ${megabytes(bytes)}\n`);
  if (orphans.length === 0) {
    process.stdout.write(`Every picture in ${store} is still referenced or recent.\n`);
    return;
  }
  if (!values.delete) {
    process.stdout.write(
      `${orphans.length} of ${stored.length} pictures (${megabytes(total)}) are unreferenced and older than ${graceDays} days. Run with --delete to remove them.\n`,
    );
    return;
  }
  for (const { name } of orphans) rmSync(join(store, name));
  process.stdout.write(`Deleted ${orphans.length} pictures (${megabytes(total)}) from ${store}.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
