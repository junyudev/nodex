import { randomInt, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  nativeRequirements,
  parseTestSuite,
  runtimeForSuite,
  suiteConfig,
  type SuiteId,
} from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { prepareElectronRuntime } from "../prepare-electron-runtime.ts";
import { runCommand, withCommandSignal, type Command } from "../tooling/process.ts";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts.ts";
import { discoverSuiteManifest, runtimeCommand, testRuntimeEnvironment } from "./runtime.ts";
import { runTests } from "./run-tests.ts";
import { chooseCacheAudits, relativeInput } from "./test-cache-policy.ts";
import {
  cacheDirectory,
  cacheEpoch,
  digestCachePath,
  stampDigests,
  changedPassInputs,
  CorruptCachedPass,
  fileHasher,
  findPass,
  globalCacheKey,
  invalidateCache,
  readCacheReport,
  savePass,
  workspaceInputs,
  writeCacheReport,
  type CachedPass,
  type PassLookup,
} from "./test-cache-store.ts";
import { localInputReader, observationKey, portablePath } from "./test-cache-inputs.ts";
import {
  binaryIdentity,
  browserRuntimeIdentity,
  electronAddonIdentity,
} from "./test-runtime-identity.ts";
import type { CacheExclusion, TestEvidence } from "./test-cache-evidence.ts";

export interface CachedSuiteReport {
  readonly suite: SuiteId;
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
  workspace?: () => ReturnType<typeof workspaceInputs>;
  digests?: () => ReturnType<typeof stampDigests>;
  onStdout?: Command["onStdout"];
  onStderr?: Command["onStderr"];
  execute?: <T>(run: () => Promise<T>) => Promise<T>;
};

interface CacheUnit {
  readonly id: string;
  readonly files: readonly string[];
}

interface SuiteInputs {
  readonly units: readonly CacheUnit[];
  readonly globalKey: string;
  readonly directory: string;
  readonly workspace: Awaited<ReturnType<typeof workspaceInputs>>;
  readonly hash: ReturnType<typeof fileHasher>;
  readonly browser: boolean;
  readonly stable: () => Promise<boolean>;
}

const totalFiles = (units: readonly CacheUnit[]) =>
  units.reduce((count, unit) => count + unit.files.length, 0);

async function collectSuiteInputs(
  suite: SuiteId,
  filters: readonly string[],
  context: CachedSuiteContext,
  digests: ReturnType<typeof stampDigests>,
): Promise<SuiteInputs | undefined> {
  const { repositoryRoot: root, env, signal } = context;
  const browser = suite === "browser";
  const electron = runtimeForSuite(suite) === "electron-node";
  const directory = cacheDirectory(root, env, suite);
  const resultsRoot = path.dirname(path.dirname(directory));
  if (electron) await prepareElectronRuntime({ projectRoot: root });
  const caPath = env.NODE_EXTRA_CA_CERTS;
  const command = runtimeCommand(suite, [], { cwd: root, env, signal }).command;
  const [manifest, epoch, workspace, extra, ca, executable] = await Promise.all([
    discoverSuiteManifest(suite, filters, false, { cwd: root, env, signal }),
    cacheEpoch(directory),
    context.workspace?.() ?? workspaceInputs(root, resultsRoot),
    (browser
      ? browserRuntimeIdentity(env, digests)
      : electron
        ? electronAddonIdentity(root, digests)
        : Promise.resolve(undefined)
    ).catch(() => undefined),
    caPath ? binaryIdentity(path.resolve(root, caPath), digests).catch(() => undefined) : undefined,
    binaryIdentity(command, digests).catch(() => undefined),
  ]);
  const { files, isolated, runtime, configDependencies } = manifest;
  // File hits require isolated Vitest realms and a complete record for every collected spec.
  if ((!browser && !isolated) || !files.length || files.some((file) => !workspace.files.has(file)))
    return undefined;
  if (!executable || ((browser || electron) && !extra) || (caPath && !ca)) return undefined;
  const hash = fileHasher(root, digests);
  const configInputs = configDependencies.map((file) => relativeInput(root, file));
  if (configInputs.some((file) => file === undefined)) return undefined;
  const globalKey = await globalCacheKey(
    root,
    suite,
    env,
    epoch,
    workspace,
    hash,
    runtime,
    [executable.digest, extra?.digest, ca?.digest, browser ? files : undefined],
    configInputs.flatMap((file) => (file && !file.startsWith("node_modules/.pnpm/") ? [file] : [])),
  );
  if (!globalKey) return undefined;
  return {
    units: browser
      ? [{ id: suiteConfig(suite), files }]
      : files.map((file) => ({ id: file, files: [file] })),
    globalKey,
    directory,
    workspace,
    hash,
    browser,
    async stable() {
      const [current, sameHashes, sameRuntime, currentEpoch, sameCa, sameExecutable] =
        await Promise.all([
          workspaceInputs(root, resultsRoot),
          hash.unchanged(),
          extra?.unchanged(),
          cacheEpoch(directory),
          ca?.unchanged(),
          executable.unchanged(),
        ]);
      return (
        current.topology === workspace.topology &&
        sameHashes &&
        sameRuntime !== false &&
        sameCa !== false &&
        sameExecutable &&
        currentEpoch === epoch
      );
    },
  };
}

function summarize(
  suite: SuiteId,
  units: readonly CacheUnit[],
  hits: readonly CacheUnit[],
  ran: readonly CacheUnit[],
  lookups: ReadonlyMap<string, PassLookup>,
  exclusions: ReadonlyMap<string, readonly CacheExclusion[]>,
  lookupMs: number,
): CachedSuiteReport {
  const causes = new Map<string, number>();
  const reasons = new Map<string, { reason: string; count: number }>();
  let unrecorded = 0;
  let globalKeyMisses = 0;
  let cacheable = 0;
  for (const { id, files } of units) {
    const count = files.length;
    const rejected = exclusions.get(id);
    for (const reason of new Set(rejected?.map((item) => item.reason))) {
      const group = reasons.get(reason);
      if (group) group.count += count;
      else reasons.set(reason, { reason, count });
    }
    if (rejected) continue;
    cacheable += count;
    const lookup = lookups.get(id);
    if (lookup?.kind === "unrecorded") unrecorded += count;
    if (lookup?.kind === "globalKeyMiss") globalKeyMisses += count;
    if (lookup?.kind === "changed")
      for (const input of lookup.inputs) causes.set(input, (causes.get(input) ?? 0) + count);
  }
  const byCount = (a: { count: number }, b: { count: number }) => b.count - a.count;
  return {
    suite,
    selected: totalFiles(units),
    hits: totalFiles(hits),
    ran: totalFiles(ran),
    cacheable,
    uncacheable: [...reasons.values()].sort(byCount),
    missCauses: [...causes].map(([input, count]) => ({ input, count })).sort(byCount),
    unrecorded,
    globalKeyMisses,
    lookupMs,
  };
}

async function executeBatch(
  suite: SuiteId,
  files: readonly string[],
  priority: readonly string[],
  inputs: SuiteInputs,
  { repositoryRoot: root, env, signal, onStdout, onStderr, execute }: CachedSuiteContext,
) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "nodex-test-cache-"));
  try {
    await writeFile(
      path.join(staging, "batch.json"),
      JSON.stringify({
        files,
        workspace: [...inputs.workspace.files],
        priority,
      }),
    );
    const run = async () => {
      const prepared = await prepareNativeArtifacts(nativeRequirements(suite, files), {
        repositoryRoot: root,
        profile: "dev",
        env,
        signal,
      });
      const started = Date.now();
      // Repeated Node fixture launches can reuse parsed bytecode within this batch.
      const nodeCompileCache =
        env.NODE_COMPILE_CACHE ??
        (env.NODE_V8_COVERAGE ? undefined : path.join(staging, "node-bytecode"));
      const { exitCode } = await runCommand({
        ...runtimeCommand(
          suite,
          [
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            path.join(
              import.meta.dirname,
              inputs.browser ? "run-browser-cache-batch.mts" : "run-cache-batch.mts",
            ),
            ...(inputs.browser ? [] : [suite]),
            staging,
          ],
          {
            cwd: root,
            env: {
              ...env,
              ...preparedNativeEnvironment(prepared),
              ...(inputs.browser
                ? {}
                : {
                    NODE_COMPILE_CACHE: nodeCompileCache,
                    NODEX_TEST_OBSERVATIONS: path.join(staging, "observations"),
                    NODEX_TEST_OBSERVATION_ROOT: root,
                    NODEX_TEST_OBSERVATION_RUNTIME: runtimeCommand(suite, [], {
                      cwd: root,
                      env,
                      signal,
                    }).command,
                  }),
            },
            signal,
          },
        ),
        onStdout,
        onStderr,
      });
      return { started, exitCode };
    };
    const result = await (execute ? execute(run) : run());
    const evidence = await readFile(path.join(staging, "evidence.json"), "utf8")
      .then((content) => JSON.parse(content) as TestEvidence[])
      .catch(() => []);
    return { ...result, evidence };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function preparePass(
  unit: CacheUnit,
  entry: TestEvidence | undefined,
  inputs: SuiteInputs,
  reader: ReturnType<typeof localInputReader>,
  started: number,
): Promise<CachedPass | readonly CacheExclusion[]> {
  if (entry?.exclusions?.length) return entry.exclusions;
  if (!entry?.passed || !entry.deps || !entry.local || entry.reason)
    return [{ reason: entry?.reason ?? "missing passing test evidence", input: entry?.input }];
  const deps = await Promise.all(
    entry.deps.map(
      async (file) =>
        [file, portablePath(file) ? await inputs.hash(file, started) : undefined] as const,
    ),
  );
  const unavailable = deps.find(([, hash]) => hash === undefined);
  if (unavailable) return [{ reason: "dependency unavailable or changed", input: unavailable[0] }];
  const pass: CachedPass = {
    globalKey: inputs.globalKey,
    deps: Object.fromEntries(deps) as Record<string, string>,
    local: {
      ...entry.local,
      topology: entry.broadTopology ? inputs.workspace.topology : undefined,
    },
  };
  const changed = await changedPassInputs(pass, inputs.globalKey, unit.id, inputs.hash, {
    topology: inputs.workspace.topology,
    reader,
  });
  if (changed.length) return [{ reason: "observed paths changed", input: changed[0] }];
  return pass;
}

const isPass = (candidate: CachedPass | readonly CacheExclusion[]): candidate is CachedPass =>
  "globalKey" in candidate;

function comparablePass(pass: CachedPass) {
  const pairs = (record: Readonly<Record<string, unknown>> = {}) =>
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([
    pairs(pass.deps),
    pairs(pass.local?.probes),
    pairs(pass.local?.globs),
    pass.local?.topology,
    pass.local?.missingModules,
    pass.local?.observed?.toSorted((a, b) => observationKey(a).localeCompare(observationKey(b))),
  ]);
}

export async function memoizeSuite(
  suite: SuiteId,
  inputs: SuiteInputs,
  context: CachedSuiteContext,
  started: number,
  fallback: (stage: "lookup" | "recording") => Promise<number>,
  runBatch: (files: readonly string[]) => Promise<{
    started: number;
    exitCode: number;
    evidence: readonly TestEvidence[];
  }>,
  auditEnabled = !inputs.browser || randomInt(64) === 0,
) {
  const { units, hash, directory, globalKey, workspace } = inputs;
  const reader = localInputReader(context.repositoryRoot);
  const history = await readCacheReport(context.repositoryRoot, suite);
  const retained = new Map<string, CachedPass>();
  const log = context.onStdout ?? ((chunk: string) => process.stdout.write(chunk));
  const error = context.onStderr ?? ((chunk: string) => process.stderr.write(chunk));
  const invalidate = async (message: string, exit = 1) => {
    await invalidateCache(directory);
    error(`[test-cache] ${message}. Invalidated ${suite} passes.\n`);
    return exit;
  };
  const lookups = new Map<string, PassLookup>();
  try {
    await Promise.all(
      units.map(async ({ id }) => {
        lookups.set(
          id,
          await findPass(directory, id, globalKey, hash, {
            topology: workspace.topology,
            reader,
            onHit: (pass) => retained.set(id, pass),
          }),
        );
      }),
    );
  } catch (cause) {
    if (!(cause instanceof CorruptCachedPass)) throw cause;
    return invalidate(`Corrupted pass for ${cause.message}`);
  }
  // Keep the expensive whole-suite audit sampled at its existing cadence.
  const [audit] = chooseCacheAudits(
    [...retained.keys()],
    randomUUID(),
    history.auditedAt,
    auditEnabled ? 1 : 0,
  );
  const hits = units.filter(({ id }) => retained.has(id) && id !== audit);
  const batch = units.filter(({ id }) => !retained.has(id) || id === audit);
  const retainedInputs = [...retained.values()].flatMap(({ local }) => (local ? [local] : []));
  // A candidate that already missed cannot invalidate the inputs of reused passes.
  if (hits.length && (!(await inputs.stable()) || !(await reader.unchanged(retainedInputs))))
    return fallback("lookup");
  const lookupMs = performance.now() - started;
  log(
    `[test-cache] ${suite}: ${totalFiles(hits)} hits, ${totalFiles(batch)} files to run${audit ? " including audit " + audit : ""} (${(lookupMs / 1_000).toFixed(2)}s lookup)\n`,
  );

  const exclusions = new Map<string, readonly CacheExclusion[]>();
  const auditedAt = { ...history.auditedAt };
  const timings = { ...history.timings };
  let evidence: readonly TestEvidence[] = [];
  let exitCode = 0;
  if (batch.length) {
    const result = await runBatch(batch.flatMap(({ files }) => files));
    if (context.signal.aborted) return result.exitCode || 130;
    evidence = result.evidence;
    exitCode = result.exitCode;
    const byUnit = new Map(evidence.map((entry) => [entry.file, entry]));
    const fresh = localInputReader(context.repositoryRoot);
    const passes = await Promise.all(
      batch.map(
        async (unit) =>
          [
            unit.id,
            await preparePass(unit, byUnit.get(unit.id), inputs, fresh, result.started),
          ] as const,
      ),
    );
    const newInputs = passes.flatMap(([, pass]) =>
      isPass(pass) && pass.local ? [pass.local] : [],
    );
    if (
      !(await inputs.stable()) ||
      !(await reader.unchanged(retainedInputs)) ||
      !(await fresh.unchanged(newInputs))
    )
      return exitCode || (await fallback("recording"));
    for (const [id, pass] of passes) {
      if (id === audit) {
        const previous = retained.get(id);
        if (!isPass(pass) || !previous || comparablePass(previous) !== comparablePass(pass))
          return invalidate(`Audit could not reproduce ${id}`, exitCode || 1);
        auditedAt[id] = Date.now();
      }
      if (!isPass(pass)) exclusions.set(id, pass);
    }
    await Promise.all(
      passes.flatMap(([id, pass]) => (isPass(pass) ? [savePass(directory, id, pass)] : [])),
    );
    for (const { file, durationMs } of evidence) {
      if (durationMs !== undefined && durationMs > 0) timings[file] = durationMs;
    }
  }
  const summary = summarize(suite, units, hits, batch, lookups, exclusions, lookupMs);
  context.onReport?.(summary);
  await writeCacheReport(context.repositoryRoot, suite, {
    hits: hits.map(({ id }) => id),
    evidence: evidence.map(({ file, passed, reason, input, exclusions, durationMs }) => ({
      file,
      passed,
      reason,
      input,
      exclusions,
      durationMs,
    })),
    timings,
    auditedAt,
    summary,
  });
  return exitCode;
}

export async function runCachedSuite(
  suite: SuiteId,
  filters: readonly string[],
  context: CachedSuiteContext,
  priority: readonly string[] = [],
): Promise<number> {
  const start = performance.now();
  const tier = resolveVitestTestTier(context.env.NODEX_TEST_TIER);
  const env: NodeJS.ProcessEnv = { ...testRuntimeEnvironment(context.env), NODEX_TEST_TIER: tier };
  delete env.NODEX_TEST_OBSERVATIONS;
  delete env.NODEX_TEST_OBSERVATION_ROOT;
  delete env.NODEX_TEST_OBSERVATION_RUNTIME;
  delete env.NODEX_TEST_OBSERVATION_CHILD;
  delete env.NODEX_TEST_TRANSFORM_CACHES;
  const runUncached = async () => {
    const staging = await mkdtemp(path.join(os.tmpdir(), "nodex-test-uncached-"));
    try {
      await writeFile(path.join(staging, "priority.json"), JSON.stringify(priority));
      return await runTests(
        { suites: [suite], tier, related: false, args: filters },
        { ...context, env, execute: undefined, isolatedVitestDirectory: staging },
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
  const fallback = (reason: string) => {
    (context.onStdout ?? ((chunk: string) => process.stdout.write(chunk)))(
      `[test-cache] ${suite}: ${reason}\n`,
    );
    return context.execute ? context.execute(runUncached) : runUncached();
  };
  if (
    env.CI ||
    tier !== "default" ||
    env.NODEX_TEST_CACHE === "off" ||
    env.NODEX_TEST_TIMINGS ||
    env.PWDEBUG ||
    process.platform !== "darwin" ||
    // Additional loaders and preloads can have unobserved inputs.
    env.NODE_OPTIONS?.trim()
      .split(/\s+/u)
      .some(
        (option) =>
          option && option !== "--use-system-ca" && !/^--max-old-space-size=\d+$/u.test(option),
      )
  )
    return fallback("running without result reuse");
  if (context.signal.aborted) return 130;
  const digests = context.digests?.() ?? stampDigests(digestCachePath(context.repositoryRoot, env));
  const validate = async (suiteContext: CachedSuiteContext, retry: boolean): Promise<number> => {
    if (suiteContext.signal.aborted) return 130;
    const inputs = await collectSuiteInputs(suite, filters, suiteContext, digests);
    if (!inputs) return fallback("suite identity or file isolation unavailable");
    return memoizeSuite(
      suite,
      inputs,
      suiteContext,
      start,
      (stage) => {
        // Static checks can finish writing temporary files while lookup is in progress.
        if (stage === "lookup" && retry)
          return validate({ ...suiteContext, workspace: undefined }, false);
        return fallback("inputs changed during validation");
      },
      (files) => executeBatch(suite, files, priority, inputs, suiteContext),
    );
  };
  try {
    return await validate({ ...context, env }, true);
  } finally {
    if (!context.digests) await digests.flush();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    const [name, ...filters] = process.argv.slice(2);
    try {
      if (
        !name ||
        filters.some((filter) => filter.startsWith("-")) ||
        (name === "browser" && filters.length)
      )
        throw new Error("Usage: vp run test:cached <suite> [file filters; omit for browser]");
      return await runCachedSuite(parseTestSuite(name), filters, {
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        env: process.env,
        signal,
        onReport: (report) => process.stdout.write(JSON.stringify(report) + "\n"),
      });
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}
