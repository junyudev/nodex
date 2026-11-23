import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeRequirements } from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { runCommand, withCommandSignal } from "../tooling/process.ts";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts.ts";
import { discoverSuiteManifest, runtimeCommand } from "./runtime.ts";
import { runTests } from "./run-tests.ts";
import {
  cacheReach,
  chooseCacheAudits,
  isCacheSuite,
  partitionCacheFiles,
  type CacheResultSuite,
  type CacheSuite,
} from "./test-cache-policy.ts";
import {
  cacheDirectory,
  cacheEpoch,
  CorruptCachedPass,
  fileHasher,
  findPass,
  globalCacheKey,
  invalidateCache,
  readCacheReport,
  savePass,
  workspaceInputs,
  writeCacheReport,
  type PassLookup,
} from "./test-cache-store.ts";
import { localInputReader } from "./test-cache-inputs.ts";
import type { TestEvidence } from "./test-cache-graph.ts";

const GiB = 1024 ** 3;
export const validationConcurrency = (cores: number, memoryBytes: number) =>
  Math.max(1, Math.min(6, Math.floor(cores / 2), Math.floor(memoryBytes / (6 * GiB))));

interface CacheExclusion {
  readonly reason: string;
  readonly input?: string;
}

export interface CachedSuiteReport {
  readonly suite: CacheResultSuite;
  readonly selected: number;
  readonly hits: number;
  readonly ran: number;
  readonly cacheable: number;
  readonly uncacheable: readonly (CacheExclusion & { readonly count: number })[];
  readonly missCauses: readonly { input: string; count: number }[];
  readonly unrecorded: number;
  readonly globalKeyMisses: number;
  readonly lookupMs: number;
}

export type CachedSuiteContext = {
  repositoryRoot: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  onReport?: (report: CachedSuiteReport) => void;
};

interface CacheRun {
  selected: readonly string[];
  hits: readonly string[];
  ran: readonly string[];
  lookupMs?: number;
  readonly passes: Set<string>;
  readonly lookups: Map<string, PassLookup>;
  readonly exclusions: Map<string, CacheExclusion>;
}

function summarizeRun(suite: CacheSuite, run: CacheRun, lookupMs: number): CachedSuiteReport {
  const causes = new Map<string, number>();
  let unrecorded = 0;
  let globalKeyMisses = 0;
  for (const file of run.passes) {
    const lookup = run.lookups.get(file);
    if (lookup?.kind === "unrecorded") unrecorded++;
    if (lookup?.kind === "globalKeyMiss") globalKeyMisses++;
    if (lookup?.kind !== "changed") continue;
    for (const input of lookup.inputs) causes.set(input, (causes.get(input) ?? 0) + 1);
  }
  const exclusions = new Map<string, CacheExclusion & { count: number }>();
  for (const { reason, input } of run.exclusions.values()) {
    const key = JSON.stringify([reason, input]);
    const group = exclusions.get(key);
    if (group) group.count++;
    else exclusions.set(key, { reason, input, count: 1 });
  }
  return {
    suite,
    selected: run.selected.length,
    hits: run.hits.length,
    ran: run.ran.length,
    cacheable: run.passes.size,
    uncacheable: [...exclusions.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.reason.localeCompare(b.reason) ||
        (a.input ?? "").localeCompare(b.input ?? ""),
    ),
    missCauses: [...causes]
      .map(([input, count]) => ({ input, count }))
      .sort((a, b) => b.count - a.count || a.input.localeCompare(b.input)),
    unrecorded,
    globalKeyMisses,
    lookupMs,
  };
}

export async function runCachedSuite(
  suite: CacheSuite,
  filters: readonly string[],
  context: CachedSuiteContext,
): Promise<number> {
  const { env, onReport } = context;
  const tier = resolveVitestTestTier(env.NODEX_TEST_TIER);
  const runUncached = () =>
    runTests({ suites: [suite], tier, related: false, args: filters }, context);
  if (
    env.CI ||
    tier !== "default" ||
    env.NODEX_TEST_CACHE === "off" ||
    env.NODEX_TEST_TIMINGS ||
    process.platform !== "darwin"
  )
    return runUncached();

  const started = performance.now();
  const run: CacheRun = {
    selected: [],
    hits: [],
    ran: [],
    passes: new Set(),
    lookups: new Map(),
    exclusions: new Map(),
  };
  let fallback = false;
  try {
    const result = await runCachedFlow(suite, filters, context, run, started);
    if (result !== undefined) return result;
    fallback = true;
  } finally {
    if (!fallback)
      onReport?.(summarizeRun(suite, run, run.lookupMs ?? performance.now() - started));
  }
  return runUncached();
}

async function runCachedFlow(
  suite: CacheSuite,
  filters: readonly string[],
  { repositoryRoot: root, env, signal }: CachedSuiteContext,
  run: CacheRun,
  started: number,
): Promise<number | undefined> {
  const commandContext = { cwd: root, env: { ...env, NODEX_TEST_TIER: "default" }, signal };
  const directory = cacheDirectory(root, env, suite);
  const resultsRoot = path.dirname(path.dirname(directory));
  const [{ files: selected, isolated }, workspace, epoch, history] = await Promise.all([
    discoverSuiteManifest(suite, filters, false, commandContext),
    workspaceInputs(root, resultsRoot),
    cacheEpoch(directory),
    readCacheReport(root, suite),
  ]);
  // Skipping files changes the shared worker state when isolation is disabled.
  if (!isolated || selected.length === 0) return undefined;
  run.selected = selected;
  const hash = fileHasher(root);
  const globalKey = await globalCacheKey(root, suite, commandContext.env, epoch, workspace, hash);
  if (!globalKey) return undefined;

  const local = { topology: workspace.topology, reader: localInputReader(root) };
  const { cacheable, uncached } = partitionCacheFiles(suite, selected);
  for (const file of uncached) run.exclusions.set(file, { reason: "path policy" });
  try {
    const lookups = await Promise.all(
      cacheable.map(
        async (file) => [file, await findPass(directory, file, globalKey, hash, local)] as const,
      ),
    );
    for (const [file, lookup] of lookups) {
      run.lookups.set(file, lookup);
      if (lookup.kind === "hit") run.passes.add(file);
    }
  } catch (error) {
    if (!(error instanceof CorruptCachedPass)) throw error;
    await invalidateCache(directory);
    process.stderr.write(
      `[test-cache] Audit failed for ${error.message}: corrupted record. Invalidated ${suite} cached passes.\n`,
    );
    return 1;
  }
  const [audit] = chooseCacheAudits([...run.passes], randomUUID(), history.auditedAt);
  const batch = selected.filter((file) => !run.passes.has(file) || file === audit);
  const skipped = selected.filter((file) => run.passes.has(file) && file !== audit);
  const lookupMs = performance.now() - started;
  run.lookupMs = lookupMs;
  process.stdout.write(
    `[test-cache] ${suite}: ${skipped.length} hits, ${batch.length} files to run${audit ? " including audit " + audit : ""} (${(lookupMs / 1_000).toFixed(2)}s lookup)\n`,
  );

  const staging = await mkdtemp(path.join(os.tmpdir(), "nodex-test-cache-"));
  try {
    await writeFile(
      path.join(staging, "batch.json"),
      JSON.stringify({
        files: batch,
        workspace: [...workspace.files],
      }),
    );
    const prepared = await prepareNativeArtifacts(nativeRequirements(suite, batch), {
      repositoryRoot: root,
      profile: "dev",
      env: commandContext.env,
      signal,
    });
    const batchStarted = Date.now();
    if (signal.aborted) return 130;
    run.hits = skipped;
    run.ran = batch;
    for (const file of batch) {
      if (!run.exclusions.has(file)) run.exclusions.set(file, { reason: "missing test evidence" });
    }
    const result = await runCommand(
      runtimeCommand(
        suite,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          path.join(import.meta.dirname, "run-cache-batch.mts"),
          suite,
          staging,
        ],
        {
          ...commandContext,
          env: { ...commandContext.env, ...preparedNativeEnvironment(prepared) },
        },
      ),
    );
    if (signal.aborted) return result.exitCode;
    const evidence = await readFile(path.join(staging, "evidence.json"), "utf8")
      .then((content) => JSON.parse(content) as TestEvidence[])
      .catch(() => undefined);
    for (const { file, reason, input, deps, local } of evidence ?? []) {
      if (reason || !deps || !local)
        run.exclusions.set(file, { reason: reason ?? "missing module graph", input });
      else run.exclusions.delete(file);
    }
    const audited = evidence?.find(({ file }) => file === audit);
    if (audit && (!audited?.passed || !audited.deps || !audited.local)) {
      run.passes.clear();
      await invalidateCache(directory);
      process.stderr.write(
        `[test-cache] Audit failed for ${audit}. Invalidated ${suite} cached passes.\n`,
      );
      return result.exitCode || 1;
    }
    if ((await cacheEpoch(directory)) !== epoch) {
      run.passes.clear();
      process.stderr.write(`[test-cache] ${suite} passes were invalidated during this run.\n`);
      return result.exitCode || 1;
    }
    if (!evidence) return result.exitCode || 1;

    const currentWorkspace = await workspaceInputs(root, resultsRoot);
    const stable =
      currentWorkspace.topology === workspace.topology &&
      (await hash.unchanged()) &&
      (await local.reader.unchanged());
    if (!stable) run.passes.clear();
    for (const entry of evidence) {
      if (entry.file === audit || !entry.deps || !entry.local || entry.reason) continue;
      if (!stable) {
        run.exclusions.set(entry.file, { reason: "workspace inputs changed" });
        continue;
      }
      const inputs = await Promise.all(
        entry.deps.map(async (file) => [file, await hash(file, batchStarted)] as const),
      );
      const recorded = inputs.filter(
        (pair): pair is readonly [string, string] => pair[1] !== undefined,
      );
      if (recorded.length !== inputs.length) {
        run.exclusions.set(entry.file, { reason: "dependency unavailable or changed" });
        continue;
      }
      await savePass(directory, entry.file, {
        globalKey,
        deps: Object.fromEntries(recorded),
        local: {
          ...entry.local,
          topology: entry.broadTopology ? workspace.topology : undefined,
        },
      });
      run.passes.add(entry.file);
    }
    const timings = { ...history.timings };
    const auditedAt = { ...history.auditedAt };
    for (const { file, durationMs } of evidence) {
      if (durationMs !== undefined && durationMs > 0) timings[file] = durationMs;
    }
    if (audit) auditedAt[audit] = Date.now();
    const previous = cacheReach(selected, run.passes, history.timings ?? {});
    const usePrevious = previous.timed === selected.length;
    const reach = usePrevious ? previous : cacheReach(selected, run.passes, timings);
    const share =
      reach.timeShare === undefined
        ? ""
        : `, ${(100 * reach.timeShare).toFixed(1)}% of ${usePrevious ? "previous" : "observed"} file time` +
          (reach.timed < selected.length ? ` (${reach.timed}/${selected.length} timed)` : "");
    const summary = summarizeRun(suite, run, lookupMs);
    await writeCacheReport(root, suite, {
      hits: run.hits,
      evidence: evidence.map(({ file, passed, reason, input, durationMs }) => ({
        file,
        passed,
        reason,
        input,
        durationMs,
      })),
      timings,
      auditedAt,
      summary,
    });
    const reasons = new Map<string, number>();
    for (const { reason, count } of summary.uncacheable)
      reasons.set(reason, (reasons.get(reason) ?? 0) + count);
    process.stdout.write(
      `[test-cache] ${suite}: ${summary.cacheable}/${summary.selected} cacheable (${((summary.cacheable / summary.selected) * 100).toFixed(1)}% of files${share}); ${
        [...reasons]
          .sort((left, right) => right[1] - left[1])
          .map(([reason, count]) => `${reason} (${count})`)
          .join(", ") || `${uncached.length} excluded`
      }\n`,
    );
    if (!stable && audit) {
      process.stderr.write("[test-cache] Workspace inputs changed during validation.\n");
      return result.exitCode || 1;
    }
    return result.exitCode;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    const [suite, ...filters] = process.argv.slice(2);
    try {
      if (!suite || !isCacheSuite(suite) || filters.some((filter) => filter.startsWith("-"))) {
        throw new Error("Usage: vp run test:cached <unit|renderer> [file filters]");
      }
      return await runCachedSuite(suite, filters, {
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        env: process.env,
        signal,
      });
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}
