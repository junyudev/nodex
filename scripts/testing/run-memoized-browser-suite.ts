import { createHash, randomInt } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { suiteConfig } from "../../config/test-suites.ts";
import { resolveVitestTestTier } from "../../config/vitest-test-tier.ts";
import { withoutAgentShell } from "../../src/main/platform/node/agent-shell-environment.ts";
import { runCommand, withCommandSignal } from "../tooling/process.ts";
import type { BrowserCacheExclusion } from "./browser-cache-inputs.ts";
import type { BrowserBatchEvidence } from "./run-browser-cache-batch.mts";
import type { CachedSuiteContext, CachedSuiteReport } from "./run-cached-tests.ts";
import { runTests } from "./run-tests.ts";
import { discoverSuiteManifest, runtimeCommand } from "./runtime.ts";
import { relativeInput } from "./test-cache-policy.ts";
import { localInputReader, sameMembers } from "./test-cache-inputs.ts";
import {
  cacheDirectory,
  cacheEpoch,
  CorruptCachedPass,
  digest,
  fileHasher,
  findPass,
  globalCacheKey,
  invalidateCache,
  savePass,
  workspaceInputs,
  type CachedPass,
} from "./test-cache-store.ts";

const suite = "browser";
const unit = suiteConfig(suite);
const auditPeriod = 64;

async function binaryIdentity(file: string) {
  const readStamp = async () => {
    const snapshot = await stat(file, { bigint: true });
    if (!snapshot.isFile()) throw new Error("Browser runtime input must be a regular file.");
    return [snapshot.dev, snapshot.ino, snapshot.size, snapshot.ctimeNs].join(":");
  };
  const stamp = await readStamp();
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return {
    digest: hash.digest("hex"),
    unchanged: async () => stamp === (await readStamp().catch(() => undefined)),
  };
}

async function chromiumIdentity() {
  const executable = chromium.executablePath();
  // The full Playwright Chromium channel is a macOS application bundle.
  // Include its framework, helpers and resources as well as the launcher.
  const root = await realpath(path.resolve(path.dirname(executable), "../.."));
  const bundle = await workspaceInputs(root);
  const executableInput = relativeInput(root, await realpath(executable));
  if (!executableInput || !bundle.files.has(executableInput)) return undefined;
  const localLinks = await Promise.all(
    [...bundle.links].map(async (file) =>
      relativeInput(root, await realpath(path.join(root, file))),
    ),
  );
  if (localLinks.some((target) => !target)) return undefined;
  const entries = await Promise.all(
    [...bundle.files]
      .sort()
      .map(async (file) => [file, await binaryIdentity(path.join(root, file))] as const),
  );
  return {
    digest: digest(
      JSON.stringify([bundle.topology, entries.map(([file, entry]) => [file, entry.digest])]),
    ),
    async unchanged() {
      const [current, ...same] = await Promise.all([
        workspaceInputs(root),
        ...entries.map(([, entry]) => entry.unchanged()),
      ]);
      return current.topology === bundle.topology && same.every(Boolean);
    },
  };
}

const browserEnvironment = (env: NodeJS.ProcessEnv) =>
  Object.entries(env)
    .filter(([name]) =>
      /^(?:NODE_ENV$|NODEX_BROWSER_TRACE$|RUNNER_DEBUG$|PLAYWRIGHT_|PWDEBUG$|VITEST_|(?:HTTP|HTTPS|ALL|NO)_PROXY$|SSL_CERT_)/iu.test(
        name,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right));

type BrowserIdentity = Awaited<ReturnType<typeof browserIdentity>>;

async function browserIdentity(
  root: string,
  env: NodeJS.ProcessEnv,
  workspace: Awaited<ReturnType<typeof workspaceInputs>>,
  hash: ReturnType<typeof fileHasher>,
  selected: readonly string[],
) {
  // pnpm executable shims append their own virtual-store locations to NODE_PATH.
  // Keep those portable and refuse search roots outside the locked installation.
  const modulePaths = env.NODE_PATH
    ? env.NODE_PATH.split(path.delimiter).map(
        (entry) => path.isAbsolute(entry) && relativeInput(root, path.normalize(entry)),
      )
    : [];
  if (modulePaths.some((entry) => !entry || !entry.startsWith("node_modules/.pnpm/")))
    return undefined;
  const caPath = env.NODE_EXTRA_CA_CERTS;
  const [configuration, runtime, extraCa] = await Promise.all([
    globalCacheKey(root, suite, env, "", workspace, hash),
    chromiumIdentity().catch(() => undefined),
    caPath ? binaryIdentity(path.resolve(root, caPath)).catch(() => undefined) : undefined,
  ]);
  if (!configuration || !runtime || (caPath && !extraCa)) return undefined;
  return {
    identity: {
      "browser test files": digest(JSON.stringify(selected)),
      "browser configuration, environment, or install": digest(
        JSON.stringify([configuration, extraCa?.digest, modulePaths]),
      ),
      "Chromium runtime": digest(
        JSON.stringify([os.release(), os.version(), runtime.digest, browserEnvironment(env)]),
      ),
    },
    async unchanged() {
      return (await runtime.unchanged()) && (!extraCa || (await extraCa.unchanged()));
    },
  };
}

async function observeRun(
  root: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  workspace: ReadonlySet<string>,
) {
  const scratch = path.join(root, "node_modules/.cache");
  await mkdir(scratch, { recursive: true });
  const staging = await mkdtemp(path.join(scratch, "nodex-browser-cache-"));
  try {
    await writeFile(path.join(staging, "workspace.json"), JSON.stringify([...workspace]));
    const started = Date.now();
    const result = await runCommand(
      runtimeCommand(
        suite,
        [
          "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
          path.join(import.meta.dirname, "run-browser-cache-batch.mts"),
          staging,
        ],
        { cwd: root, env, signal },
      ),
    );
    const evidence = await readFile(path.join(staging, "evidence.json"), "utf8")
      .then((content) => JSON.parse(content) as BrowserBatchEvidence)
      .catch(() => undefined);
    return { exitCode: result.exitCode, evidence, started };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function recordPass(
  root: string,
  resultsRoot: string,
  workspace: Awaited<ReturnType<typeof workspaceInputs>>,
  reader: ReturnType<typeof localInputReader>,
  hash: ReturnType<typeof fileHasher>,
  identity: NonNullable<BrowserIdentity>,
  globalKey: string,
  selected: readonly string[],
  { evidence, started }: Awaited<ReturnType<typeof observeRun>>,
) {
  const reject = (reason: string, input?: string) => ({
    exclusions: [{ reason, input }],
    pass: undefined,
  });
  if (!evidence) return reject("missing browser suite evidence");
  if (!sameMembers(evidence.files, selected)) return reject("browser test discovery changed");
  if (evidence.exclusions.length) return { exclusions: evidence.exclusions, pass: undefined };
  const records = await Promise.all(
    evidence.inputs.map(async (file) => [file, await hash(file, started)] as const),
  );
  const unavailable = records.find(([, content]) => content === undefined);
  if (unavailable) return reject("browser dependency unavailable or changed", unavailable[0]);
  const [current, stable, runtimeStable] = await Promise.all([
    workspaceInputs(root, resultsRoot),
    hash.unchanged(),
    identity.unchanged(),
  ]);
  if (current.topology !== workspace.topology || !stable || !runtimeStable)
    return reject("browser inputs changed during validation");
  const local = {
    ...evidence.local,
    topology: evidence.broadTopology ? workspace.topology : undefined,
  };
  const probesMatch = (
    await Promise.all(
      Object.entries(local.probes).map(
        async ([file, expected]) => expected === (await reader.state(file)),
      ),
    )
  ).every(Boolean);
  const globsMatch = (
    await Promise.all(
      Object.entries(local.globs).map(async ([pattern, expected]) => {
        const members = await reader.glob(pattern);
        return members && sameMembers(members, expected);
      }),
    )
  ).every(Boolean);
  if (!probesMatch || !globsMatch || !(await reader.unchanged()))
    return reject("browser resolution changed during validation");
  return {
    exclusions: [],
    pass: {
      globalKey,
      identity: identity.identity,
      deps: Object.fromEntries(records as readonly (readonly [string, string])[]),
      local,
      immutableUrls: evidence.immutableUrls,
    } satisfies CachedPass,
  };
}

export async function runMemoizedBrowserSuite(context: CachedSuiteContext): Promise<number> {
  const { repositoryRoot: root, env, signal, onReport } = context;
  const tier = resolveVitestTestTier(env.NODEX_TEST_TIER);
  if (signal.aborted) return 130;
  const started = performance.now();
  const runUncached = () => runTests({ suites: [suite], tier, related: false, args: [] }, context);
  const commandEnv = { ...withoutAgentShell(env), NODEX_TEST_TIER: tier };
  const directory = cacheDirectory(root, env, suite);
  const resultsRoot = path.dirname(path.dirname(directory));
  const manifest = await discoverSuiteManifest(suite, [], false, {
    cwd: root,
    env: commandEnv,
    signal,
  });
  const selected = manifest.files;
  const total = selected.length;
  const report = (
    {
      hits = 0,
      ran = total,
      cacheable = 0,
      unrecorded = 0,
      globalKeyMisses = 0,
      lookupMs = performance.now() - started,
      missCauses = [],
    }: Partial<CachedSuiteReport>,
    exclusions: readonly BrowserCacheExclusion[] = [],
  ) =>
    onReport?.({
      suite,
      selected: total,
      hits,
      ran,
      cacheable,
      lookupMs,
      unrecorded,
      missCauses,
      globalKeyMisses,
      uncacheable: exclusions.map((exclusion) => ({ ...exclusion, count: total })),
    });
  const fallback = (reason: string) => {
    process.stdout.write(`[test-cache] browser: running full suite (${reason})\n`);
    report({}, [{ reason }]);
    return runUncached();
  };
  if (
    env.CI ||
    tier !== "default" ||
    env.NODEX_TEST_CACHE === "off" ||
    env.NODEX_TEST_TIMINGS ||
    // A preload or loader could introduce arbitrary Node-side inputs.
    env.NODE_OPTIONS?.trim()
      .split(/\s+/u)
      .some(
        (option) =>
          option && option !== "--use-system-ca" && !/^--max-old-space-size=\d+$/u.test(option),
      ) ||
    env.PWDEBUG ||
    process.platform !== "darwin"
  )
    return fallback("browser memoization disabled for this runtime");
  const workspace = await workspaceInputs(root, resultsRoot);
  if (!total || selected.some((file) => !workspace.files.has(file)))
    return fallback("unaccounted browser test collection");
  const hash = fileHasher(root);
  const reader = localInputReader(root);
  const [epoch, identity] = await Promise.all([
    cacheEpoch(directory),
    browserIdentity(root, commandEnv, workspace, hash, selected),
  ]);
  if (!identity) return fallback("browser runtime or install identity unavailable");
  const globalKey = digest(JSON.stringify(["browser-suite-v1", epoch]));
  let retained: CachedPass | undefined;
  const lookup = await findPass(directory, unit, globalKey, hash, {
    topology: workspace.topology,
    reader,
    identity: identity.identity,
    onHit(pass) {
      retained = pass;
    },
  }).catch(async (error: unknown) => {
    if (!(error instanceof CorruptCachedPass)) throw error;
    await invalidateCache(directory);
    process.stderr.write("[test-cache] browser: invalidated corrupted cached pass.\n");
    return undefined;
  });
  if (!lookup) {
    report({ ran: 0 }, [{ reason: "corrupted browser pass" }]);
    return 1;
  }
  const currentEpoch = () => cacheEpoch(directory);
  const hit =
    lookup.kind === "hit" &&
    (await hash.unchanged()) &&
    (await reader.unchanged()) &&
    (await identity.unchanged()) &&
    (await workspaceInputs(root, resultsRoot)).topology === workspace.topology &&
    (await currentEpoch()) === epoch;
  const lookupMs = performance.now() - started;
  const audit = hit && randomInt(auditPeriod) === 0;
  const announce = (hits: number, ran: number) =>
    process.stdout.write(
      `[test-cache] browser: ${hits} hits, ${ran} files to run${audit ? " (suite audit)" : ""} (${(lookupMs / 1_000).toFixed(2)}s lookup)\n`,
    );
  const announceInputs = (pass: CachedPass) =>
    process.stdout.write(
      `[test-cache] browser: ${Object.keys(pass.deps).length} files, ${Object.keys(pass.local?.probes ?? {}).length} path probes, ${Object.keys(pass.local?.globs ?? {}).length} globs, ${pass.immutableUrls?.length ?? 0} immutable URLs\n`,
    );
  if (hit && !audit && retained) {
    announce(total, 0);
    announceInputs(retained);
    report({ hits: total, ran: 0, cacheable: total, lookupMs });
    return 0;
  }
  announce(0, total);
  const observed = await observeRun(root, commandEnv, signal, workspace.files);
  if (signal.aborted) return observed.exitCode || 130;
  const { exclusions, pass } =
    observed.exitCode === 0
      ? await recordPass(
          root,
          resultsRoot,
          workspace,
          reader,
          hash,
          identity,
          globalKey,
          selected,
          observed,
        )
      : { exclusions: [{ reason: "incomplete browser pass" }], pass: undefined };
  let exitCode = observed.exitCode;
  if (audit && JSON.stringify(pass) !== JSON.stringify(retained)) {
    await invalidateCache(directory);
    process.stderr.write(
      "[test-cache] browser: suite audit disagreed with the cached pass. Invalidated browser passes.\n",
    );
    exitCode ||= 1;
  }
  if (pass && !exitCode && (await currentEpoch()) === epoch) {
    if (!audit) await savePass(directory, unit, pass);
    announceInputs(pass);
  }
  for (const { reason, input } of exclusions)
    process.stdout.write(`[test-cache] browser: ${reason}${input ? " (" + input + ")" : ""}\n`);
  report(
    {
      lookupMs,
      cacheable: pass && !exitCode ? total : 0,
      unrecorded: lookup.kind === "unrecorded" ? total : 0,
      globalKeyMisses: lookup.kind === "globalKeyMiss" ? total : 0,
      missCauses:
        lookup.kind === "changed" ? lookup.inputs.map((input) => ({ input, count: total })) : [],
    },
    exclusions,
  );
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  void withCommandSignal(async (signal) => {
    try {
      return await runMemoizedBrowserSuite({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        env: process.env,
        signal,
        onReport(report) {
          process.stdout.write(JSON.stringify(report) + "\n");
        },
      });
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}
