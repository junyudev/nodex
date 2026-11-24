import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import type { BudgetQueueEvent } from "../tooling/machine-budget.ts";
import type { CachedSuiteReport } from "./run-cached-tests.ts";

interface ComparisonBase {
  readonly base: string;
  readonly ref: string;
}

const originMain = "refs/remotes/origin/main";
const localMain = "refs/heads/main";

const git = (cwd: string, args: readonly string[]) =>
  spawnSync("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 });

export function gitOutput(cwd: string, ...args: string[]): Buffer {
  const result = git(cwd, args);
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result.stdout;
}

export function selectComparisonBase(
  branch: string,
  explicitRef: string | undefined,
  resolve: (ref: string) => { readonly base: string; readonly ahead: number } | undefined,
): ComparisonBase {
  const refs = explicitRef
    ? [explicitRef]
    : branch === localMain
      ? [originMain]
      : [originMain, localMain];
  const candidates = refs.flatMap((ref) => {
    const candidate = resolve(ref);
    return candidate ? [{ ...candidate, ref }] : [];
  });
  const selected = candidates.sort((a, b) => a.ahead - b.ahead)[0];
  if (!selected)
    throw new Error(
      `No merge base with HEAD for ${refs.join(" or ")}. Supply a comparison ref with a shared history.`,
    );
  return { base: selected.base, ref: selected.ref };
}

export function mergePathLists(...lists: readonly string[]): string[] {
  return [...new Set(lists.flatMap((list) => list.split("\0").filter(Boolean)))].sort();
}

export function readChangedPaths(root: string, explicitRef?: string) {
  const branch = git(root, ["symbolic-ref", "--quiet", "HEAD"]).stdout.toString().trim();
  const [shallow, head] = gitOutput(root, "rev-parse", "--is-shallow-repository", "HEAD")
    .toString()
    .trim()
    .split("\n");
  const { base, ref } = selectComparisonBase(branch, explicitRef, (candidate) => {
    const rev = git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      candidate + "^{commit}",
    ]);
    if (rev.status !== 0) return undefined;
    const result = git(root, ["merge-base", head, rev.stdout.toString().trim()]);
    if (result.status !== 0) return undefined;
    const base = result.stdout.toString().trim();
    const ahead = Number(
      gitOutput(root, "rev-list", "--count", `${base}..${head}`).toString().trim(),
    );
    return { base, ahead };
  });
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  const files = mergePathLists(
    gitOutput(root, ...diff, base, head, "--").toString(),
    gitOutput(root, ...diff, "--cached", head, "--").toString(),
    gitOutput(root, ...diff, "--").toString(),
    gitOutput(root, "ls-files", "--others", "--exclude-standard", "-z", "--").toString(),
  );
  return { base, ref, head, shallow: shallow === "true", files };
}

export const passKey = (inputs: readonly unknown[]) =>
  createHash("sha256").update(JSON.stringify(inputs)).digest("hex");

const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function fileDigest(root: string, file: string, follow = false) {
  const absolute = path.join(root, file);
  const stats = lstatSync(absolute, { throwIfNoEntry: false });
  if (!stats) return null;
  if (stats.isSymbolicLink() && !follow)
    return ["symlink", digest(readlinkSync(absolute, { encoding: "buffer" }))];
  if (!stats.isFile() && !stats.isSymbolicLink()) return ["non-file"];
  return [stats.mode, digest(readFileSync(absolute))];
}

// Includes the suite cache's environment inputs and switches used by its runners and checks.
const validationEnvironment =
  /^(?:CI$|NODE_ENV$|NODE_OPTIONS$|NODE_EXTRA_CA_CERTS$|TZ$|LANG$|LC_|VITE_|VITEST_|PLAYWRIGHT_|RUNNER_DEBUG$|NODEX_TEST_|NODEX_SENTRY_FORCE_TEST$|NODEX_BUILD_CACHE_DIR$|NODEX_BROWSER_TRACE$|NODEX_CORE_EXECUTABLE$|NODEX_YJS_YRS_BRIDGE_EXECUTABLE$|ESLINT_BETTER_TAILWIND$|NODEX_TOOLING_FIXTURE_MODE$|RUSTFLAGS$|RUSTUP_TOOLCHAIN$)/u;

export function readPassKey(
  root: string,
  { base, ref, head, shallow, files }: ReturnType<typeof readChangedPaths>,
  explicitRef: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  const diff = ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-renames"];
  const envFiles = mergePathLists(
    gitOutput(
      root,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      ":(glob)**/.env*",
    ).toString(),
  );
  return passKey([
    process.version,
    base,
    ref,
    head,
    shallow,
    explicitRef,
    digest(gitOutput(root, ...diff, base, "--")),
    digest(gitOutput(root, ...diff, "--cached", base, "--")),
    files.map((file) => [file, fileDigest(root, file)]),
    ["node_modules/.modules.yaml", "node_modules/.pnpm/lock.yaml", ...envFiles].map((file) => [
      file,
      fileDigest(root, file, true),
    ]),
    Object.keys(env)
      .filter((name) => validationEnvironment.test(name))
      .sort()
      .map((name) => [name, env[name]]),
  ]);
}

export interface StepResult {
  readonly name: string;
  readonly outcome: "pass" | "FAIL" | "TIMEOUT" | "skipped";
  readonly runMs: number;
  readonly queueMs: number;
  readonly reason?: string;
  readonly cache?: CachedSuiteReport;
}

export interface RunRecord {
  readonly startedAt: string;
  readonly worktree: string;
  readonly base: string | null;
  readonly ref: string | null;
  readonly pathCount: number;
  readonly steps: readonly StepResult[];
  readonly totalMs: number;
  readonly reused?: boolean;
  readonly reusedFrom?: string;
  readonly error?: string;
}

/** Count elapsed queue time once even when concurrent descendants queue together. */
export function queueTime(events: readonly BudgetQueueEvent[], endedAt: number): number {
  const grants = new Map(
    events.flatMap((event) => ("grantedAt" in event ? [[event.id, event.grantedAt]] : [])),
  );
  const requests = events
    .filter((event) => "requestedAt" in event)
    .sort((a, b) => a.requestedAt - b.requestedAt);
  let countedUntil = 0;
  let total = 0;
  for (const { id, requestedAt } of requests) {
    const end = Math.min(grants.get(id) ?? endedAt, endedAt);
    total += Math.max(0, end - Math.max(requestedAt, countedUntil));
    countedUntil = Math.max(end, countedUntil);
  }
  return total;
}

export const duration = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const topCounts = <T extends { readonly count: number }>(
  items: readonly T[],
  label: (item: T) => string,
) =>
  items
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((item) => `${label(item)} (${item.count})`)
    .join(", ");

export function formatSummary(record: RunRecord): string {
  const width = Math.max(4, ...record.steps.map(({ name }) => name.length));
  const line = (name: string, outcome: string, run: string, queue: string, details: string) =>
    [name.padEnd(width), outcome.padEnd(7), run.padStart(8), queue.padStart(8), details]
      .join("  ")
      .trimEnd();
  const warnings: string[] = [];
  const rows = record.steps.map(({ name, outcome, runMs, queueMs, reason, cache }) => {
    const details = reason ? [reason] : [];
    if (cache) {
      const share = cache.selected ? (100 * cache.cacheable) / cache.selected : undefined;
      details.push(`${cache.hits}/${cache.selected} hits`);
      if (share !== undefined) details.push(`${share.toFixed(1)}% cacheable`);
      const misses = topCounts(cache.missCauses, ({ input }) => input);
      if (misses) details.push(`misses: ${misses}`);
      if (share !== undefined && share < 90) {
        const reasons = topCounts(cache.uncacheable, ({ reason, input }) =>
          input ? `${reason}: ${input}` : reason,
        );
        warnings.push(
          `WARNING: ${name} was ${share.toFixed(1)}% cacheable. ${reasons || "No uncacheable reasons reported."}`,
        );
      }
    }
    return line(
      name,
      outcome,
      outcome === "skipped" ? "-" : duration(runMs),
      outcome === "skipped" ? "-" : duration(queueMs),
      details.join(" · "),
    );
  });
  return [
    "",
    line("Step", "Outcome", "Run", "Queue", "Details"),
    ...rows,
    ...warnings,
    `Total wall time: ${duration(record.totalMs)}`,
    "",
  ].join("\n");
}
