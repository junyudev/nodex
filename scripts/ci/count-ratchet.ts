import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export type CountBaseline = Record<string, Record<string, number>>;

export const baselineGrowthFlag = "--allow-baseline-growth";

export function parseRatchetArguments(args: readonly string[], entrypoint: string) {
  if (args.some((argument) => !["--update", "--all", baselineGrowthFlag].includes(argument)))
    throw new Error(`Usage: ${entrypoint} [--all] [--update [${baselineGrowthFlag}]]`);
  const update = args.includes("--update");
  const allowGrowth = args.includes(baselineGrowthFlag);
  if (allowGrowth && !update) throw new Error(`${baselineGrowthFlag} requires --update.`);
  return { update, allowGrowth, all: args.includes("--all") };
}

type RatchetArguments = ReturnType<typeof parseRatchetArguments>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function readBaseline(baselinePath: string, { update, allowGrowth }: RatchetArguments) {
  if (!existsSync(baselinePath) && update && allowGrowth) return {};
  const value: unknown = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (!isRecord(value)) throw new Error(`${baselinePath} must map files to named counts.`);
  for (const [filename, counts] of Object.entries(value)) {
    if (!filename || !isRecord(counts) || Object.keys(counts).length === 0)
      throw new Error(`Invalid baseline for ${filename} in ${baselinePath}.`);
    for (const [key, count] of Object.entries(counts)) {
      if (!key || typeof count !== "number" || !Number.isSafeInteger(count) || count <= 0)
        throw new Error(`Invalid baseline count for ${filename}: ${key} in ${baselinePath}.`);
    }
  }
  return value as CountBaseline;
}

function git(args: readonly string[], environment: NodeJS.ProcessEnv = process.env) {
  return spawnSync("git", args, { encoding: "utf8", env: environment });
}

/** A private index lets Git detect unstaged moves without touching the caller's index. */
export function followBaselineRenames(baseline: CountBaseline): CountBaseline {
  if (git(["rev-parse", "--show-toplevel"]).status !== 0) return baseline;
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-baseline-renames-"));
  const environment = { ...process.env, GIT_INDEX_FILE: path.join(directory, "index") };
  try {
    for (const args of [
      ["read-tree", "HEAD"],
      ["add", "--all"],
    ]) {
      const result = git(args, environment);
      if (result.status !== 0) throw new Error(`Cannot inspect baseline renames: ${result.stderr}`);
    }
    const main = ["main", "origin/main"]
      .map((ref) => git(["merge-base", "HEAD", ref]))
      .find((result) => result.status === 0)
      ?.stdout.trim();
    const references = [...new Set([main, "HEAD"].filter((ref) => ref !== undefined))];
    return references.reduce((current, reference) => {
      const result = git(
        ["diff", "--cached", "--name-status", "-z", "--find-renames", reference],
        environment,
      );
      if (result.status !== 0) throw new Error(`Cannot inspect baseline renames: ${result.stderr}`);
      const fields = result.stdout.split("\0");
      const renames = new Map<string, string>();
      for (let index = 0; index < fields.length - 1;) {
        const status = fields[index++];
        const source = fields[index++];
        if (status.startsWith("R")) renames.set(source, fields[index++]);
      }
      return Object.fromEntries(
        Object.entries(current).map(([filename, counts]) => [
          renames.get(filename) ?? filename,
          counts,
        ]),
      );
    }, baseline);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function compareBaseline(counts: CountBaseline, baseline: CountBaseline) {
  const regressions = Object.entries(counts).flatMap(([file, rules]) =>
    Object.entries(rules)
      .filter(([rule, count]) => count > (baseline[file]?.[rule] ?? 0))
      .map(([rule, count]) => ({ file, rule, count, previous: baseline[file]?.[rule] ?? 0 })),
  );
  const stale = Object.entries(baseline).flatMap(([file, rules]) =>
    Object.entries(rules)
      .filter(([rule, count]) => count > (counts[file]?.[rule] ?? 0))
      .map(([rule, count]) => ({ file, rule, count, actual: counts[file]?.[rule] ?? 0 })),
  );
  return { regressions, stale };
}

function writeBaseline(baselinePath: string, counts: CountBaseline): void {
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((file) => [
        file,
        Object.fromEntries(
          Object.keys(counts[file])
            .sort()
            .map((rule) => [rule, counts[file][rule]]),
        ),
      ]),
  );
  writeFileSync(baselinePath, JSON.stringify(sorted, null, 2) + "\n");
}

/** Share only-shrinks policy; callers print their own diagnostics before accepting an update. */
export function finishRatchet({
  counts,
  comparison: { regressions, stale },
  options: { update, allowGrowth },
  baselinePath,
  unit,
  forbiddenMessage,
  updateCommand,
  updatedLabel,
}: {
  readonly counts: CountBaseline;
  readonly comparison: ReturnType<typeof compareBaseline>;
  readonly options: RatchetArguments;
  readonly baselinePath: string;
  readonly unit: string;
  readonly forbiddenMessage: string;
  readonly updateCommand: string;
  readonly updatedLabel: string;
}): number {
  for (const { file, rule, count, previous } of regressions)
    console.error(
      `${file}: ${rule}: ${count} ${unit} (baseline ${previous}, +${count - previous}).`,
    );
  if (regressions.length > 0 && !(update && allowGrowth)) {
    console.error(forbiddenMessage);
    return 1;
  }
  if (!update && stale.length > 0) {
    for (const { file, rule, count, actual } of stale)
      console.error(`${file}: ${rule}: ${actual} ${unit} (stale baseline ${count}).`);
    console.error(`Run ${updateCommand} to lock in fixed counts and file moves.`);
    return 1;
  }
  const total = Object.values(counts)
    .flatMap(Object.values)
    .reduce((sum, count) => sum + count, 0);
  if (!update) {
    console.log(`${total} baseline ${unit}, 0 new.`);
    return 0;
  }
  if (allowGrowth)
    console.error(
      `WARNING: ${baselineGrowthFlag} permits baseline increases; review every added count.`,
    );
  writeBaseline(baselinePath, counts);
  console.log(`${updatedLabel}: ${total} ${unit}.`);
  return 0;
}
