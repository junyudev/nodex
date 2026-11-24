import { spawnSync } from "node:child_process";
import type { BudgetQueueEvent } from "../tooling/machine-budget.ts";
import type { SuiteId } from "../../config/test-suites.ts";
import type { FastTestSelection } from "./check-changed-plan.ts";
import type { CachedSuiteReport } from "./run-cached-tests.ts";

interface ComparisonBase {
  readonly base: string;
  readonly ref: string;
}

const originMain = "refs/remotes/origin/main";
const localMain = "refs/heads/main";

const git = (cwd: string, args: readonly string[]) =>
  spawnSync("git", args, { cwd, maxBuffer: 128 * 1024 * 1024 });

function gitOutput(cwd: string, ...args: string[]): Buffer {
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
  const { base, ref } = selectComparisonBase(branch, explicitRef, (candidate) => {
    const rev = git(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      candidate + "^{commit}",
    ]);
    if (rev.status !== 0) return undefined;
    const result = git(root, ["merge-base", "HEAD", rev.stdout.toString().trim()]);
    if (result.status !== 0) return undefined;
    const base = result.stdout.toString().trim();
    const ahead = Number(
      gitOutput(root, "rev-list", "--count", base + "..HEAD")
        .toString()
        .trim(),
    );
    return { base, ahead };
  });
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  const files = mergePathLists(
    gitOutput(root, ...diff, base, "HEAD", "--").toString(),
    gitOutput(root, ...diff, "--cached", "HEAD", "--").toString(),
    gitOutput(root, ...diff, "--").toString(),
    gitOutput(root, "ls-files", "--others", "--exclude-standard", "-z", "--").toString(),
  );
  return { base, ref, files };
}

export interface StepResult {
  readonly name: string;
  readonly outcome: "pass" | "FAIL" | "TIMEOUT" | "skipped";
  readonly runMs: number;
  readonly queueMs: number;
  readonly reason?: string;
  readonly cache?: CachedSuiteReport;
  readonly activity?: {
    readonly start: number;
    readonly end: number;
    readonly waits: readonly (readonly [number, number])[];
  };
}

export interface RunRecord {
  readonly startedAt: string;
  readonly worktree: string;
  readonly base: string | null;
  readonly ref: string | null;
  readonly pathCount: number;
  readonly steps: readonly StepResult[];
  readonly totalMs: number;
  readonly idleQueueMs?: number;
  readonly fastTests?: Partial<
    Record<
      SuiteId,
      Omit<FastTestSelection, "files"> & {
        readonly selected: number;
      }
    >
  >;
  readonly error?: string;
}

/** Merge overlapping budget requests from a step and its descendants. */
export function queueWindows(events: readonly BudgetQueueEvent[], endedAt: number) {
  const grants = new Map(
    events.flatMap((event) => ("grantedAt" in event ? [[event.id, event.grantedAt]] : [])),
  );
  const requests = events
    .filter((event) => "requestedAt" in event)
    .sort((a, b) => a.requestedAt - b.requestedAt);
  const windows: [number, number][] = [];
  for (const { id, requestedAt } of requests) {
    const end = Math.min(grants.get(id) ?? endedAt, endedAt);
    if (end <= requestedAt) continue;
    const previous = windows.at(-1);
    if (previous && requestedAt <= previous[1]) previous[1] = Math.max(previous[1], end);
    else windows.push([requestedAt, end]);
  }
  return windows;
}

export const queueTime = (events: readonly BudgetQueueEvent[], endedAt: number) =>
  queueWindows(events, endedAt).reduce((total, [start, end]) => total + end - start, 0);

/** Only remove waits on the wall clock when every running step was waiting. */
export function idleQueueTime(steps: readonly StepResult[]) {
  const points = steps
    .flatMap(({ activity }) => {
      if (!activity) return [];
      const { start, end, waits } = activity;
      return [
        [start, 1, 0],
        [end, -1, 0],
        ...waits.flatMap(([from, to]) => [
          [Math.max(start, from), 0, 1],
          [Math.min(end, to), 0, -1],
        ]),
      ];
    })
    .sort(([a], [b]) => a - b);
  let active = 0;
  let waiting = 0;
  let idleMs = 0;
  let previous = 0;
  for (const [time, activeDelta, waitingDelta] of points) {
    if (active > 0 && active === waiting) idleMs += time - previous;
    active += activeDelta;
    waiting += waitingDelta;
    previous = time;
  }
  return idleMs;
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
  const rows = record.steps.map(({ name, outcome, runMs, queueMs, reason, cache }) => {
    const details = reason ? [reason] : [];
    const selection = record.fastTests?.[name.slice(4) as SuiteId];
    if (selection) {
      const { selected, unobservable, unrecorded, unaffected, nativeDeferred } = selection;
      const deferred = Object.entries(nativeDeferred ?? {});
      const nativeCount = deferred.reduce((sum, [, count]) => sum + count, 0);
      details.push(
        `${selected} selected, ${unobservable + unrecorded + unaffected + nativeCount} skipped` +
          ` (${unobservable} unobservable, ${unrecorded} without evidence, ${unaffected} unaffected` +
          (nativeCount ? `, ${nativeCount} left to CI)` : ")"),
      );
      if (nativeCount)
        details.push(
          "Left to CI: " +
            deferred
              .map(([artifact, count]) => `${count} need a current local ${artifact} build`)
              .join(", "),
        );
    }
    if (cache) {
      const share = cache.selected ? (100 * cache.cacheable) / cache.selected : undefined;
      details.push(`${cache.hits}/${cache.selected} hits`);
      if (share !== undefined) details.push(`${share.toFixed(1)}% cacheable`);
      const misses = topCounts(cache.missCauses, ({ input }) => input);
      if (misses) details.push(`misses: ${misses}`);
      const reasons = topCounts(cache.uncacheable, ({ reason }) => reason);
      if (reasons) details.push(`always run: ${reasons}`);
      if (cache.globalKeyMisses) details.push(`runtime/config changes (${cache.globalKeyMisses})`);
      if (cache.unrecorded) details.push(`new passes (${cache.unrecorded})`);
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
    `Total wall time: ${duration(record.totalMs)}` +
      (record.idleQueueMs
        ? ` (${duration(record.totalMs - record.idleQueueMs)} excluding queue)`
        : ""),
    ...(record.fastTests
      ? [
          "Fast check skips the full lint ratchet, repository-wide static contracts, unselected tests, and full Rust gates. CI runs those gates.",
        ]
      : []),
    "",
  ].join("\n");
}
