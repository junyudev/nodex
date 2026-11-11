import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeRequirements } from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { runCommand, withCommandSignal } from "../tooling/process.ts";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts.ts";
import { discoverSuite, runtimeCommand } from "./runtime.ts";
import { runTests } from "./run-tests.ts";
import {
  chooseCacheAudits,
  isCacheSuite,
  partitionCacheFiles,
  type CacheSuite,
} from "./test-cache-policy.ts";
import {
  cacheDirectory,
  cacheEpoch,
  fileHasher,
  findPass,
  globalCacheKey,
  invalidateCache,
  savePass,
  workspaceInputs,
  writeCacheReport,
} from "./test-cache-store.ts";
import type { TestEvidence } from "./test-cache-graph.ts";

const GiB = 1024 ** 3;
export const validationConcurrency = (cores: number, memoryBytes: number) =>
  Math.max(1, Math.min(6, Math.floor(cores / 2), Math.floor(memoryBytes / (6 * GiB))));

type SuiteContext = { repositoryRoot: string; env: NodeJS.ProcessEnv; signal: AbortSignal };

export async function runCachedSuite(
  suite: CacheSuite,
  filters: readonly string[],
  context: SuiteContext,
): Promise<number> {
  const { repositoryRoot: root, env, signal } = context;
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
  const commandContext = { cwd: root, env: { ...env, NODEX_TEST_TIER: tier }, signal };
  const directory = cacheDirectory(root, env, suite);
  const resultsRoot = path.dirname(path.dirname(directory));
  const [selected, workspace, epoch] = await Promise.all([
    discoverSuite(suite, filters, false, commandContext),
    workspaceInputs(root, resultsRoot),
    cacheEpoch(directory),
  ]);
  const hash = fileHasher(root);
  const globalKey = await globalCacheKey(root, suite, commandContext.env, epoch, workspace, hash);
  if (!globalKey || selected.length === 0) return runUncached();

  const { cacheable, uncached } = partitionCacheFiles(suite, selected);
  const hits = new Set(
    (
      await Promise.all(
        cacheable.map(async (file) =>
          (await findPass(directory, file, globalKey, hash)) ? file : undefined,
        ),
      )
    ).filter((file) => file !== undefined),
  );
  const [audit] = chooseCacheAudits([...hits], randomUUID());
  const batch = selected.filter((file) => !hits.has(file) || file === audit);
  process.stdout.write(
    `[test-cache] ${suite}: ${hits.size} hits, ${batch.length} files to run${audit ? " including audit " + audit : ""} (${((performance.now() - started) / 1_000).toFixed(2)}s lookup)\n`,
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
    const audited = evidence?.find(({ file }) => file === audit);
    if (audit && (!audited?.passed || !audited.deps)) {
      await invalidateCache(directory);
      process.stderr.write(
        `[test-cache] Audit failed for ${audit}. Invalidated ${suite} cached passes.\n`,
      );
      return result.exitCode || 1;
    }
    if ((await cacheEpoch(directory)) !== epoch) {
      process.stderr.write(`[test-cache] ${suite} passes were invalidated during this run.\n`);
      return result.exitCode || 1;
    }
    if (!evidence) return result.exitCode || 1;

    const currentWorkspace = await workspaceInputs(root, resultsRoot);
    const stable = currentWorkspace.topology === workspace.topology && (await hash.unchanged());
    const reasons = new Map<string, number>();
    let eligible = hits.size;
    for (const entry of evidence) {
      if (entry.file === audit) continue;
      const deps = entry.deps;
      const reason = entry.reason ?? (!deps ? "missing module graph" : undefined);
      if (reason || !deps) {
        reasons.set(
          reason ?? "missing module graph",
          (reasons.get(reason ?? "missing module graph") ?? 0) + 1,
        );
        continue;
      }
      eligible++;
      if (!stable) continue;
      const inputs = await Promise.all(
        deps.map(async (file) => [file, await hash(file, batchStarted)] as const),
      );
      if (inputs.some(([, content]) => content === undefined)) continue;
      await savePass(directory, entry.file, {
        globalKey,
        deps: Object.fromEntries(
          inputs.filter((pair): pair is readonly [string, string] => pair[1] !== undefined),
        ),
      });
    }
    await writeCacheReport(root, suite, {
      hits: [...hits],
      evidence: evidence.map(({ file, passed, reason }) => ({ file, passed, reason })),
    });
    const missing = batch.length - evidence.length;
    if (missing > 0) reasons.set("missing test evidence", missing);
    process.stdout.write(
      `[test-cache] ${suite}: ${eligible}/${selected.length} cacheable; ${
        [...reasons]
          .sort((left, right) => right[1] - left[1])
          .map(([reason, count]) => `${reason} (${count})`)
          .join(", ") || `${uncached.length} excluded`
      }\n`,
    );
    if (!stable && hits.size > 0) {
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
