import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { runtimeForSuite } from "../../config/test-suites.ts";
import { runCachedSuite, type CachedSuiteReport } from "../testing/run-cached-tests.ts";
import { cacheDirectory, cacheEpoch, digest } from "../testing/test-cache-store.ts";
import { prepareNativeArtifacts } from "../testing/native-artifacts.ts";
import { withCommandSignal } from "../tooling/process.ts";

import { parseAppTestSuite, planAppTestSuite } from "./app-test-suite.ts";
import { appShardCount, parseCiGatePlan } from "./ci-gate-plan.ts";

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}.`);
  return value;
};

export const commandForAppTestSuite = (
  suiteValue: string,
  planValue: unknown,
): readonly string[] => {
  const suite = parseAppTestSuite(suiteValue);
  const plan = parseCiGatePlan(planValue);
  if (!plan.appTestSuites.includes(suite)) {
    throw new Error(`Application suite ${JSON.stringify(suite)} is not selected by the gate plan.`);
  }
  const suitePlan = planAppTestSuite(suite);
  if (plan.testMode === "full")
    return [process.platform === "win32" ? "vp.cmd" : "vp", "run", suitePlan.packageScript];
  if (plan.testMode === "related") {
    return [
      process.platform === "win32" ? "vp.cmd" : "vp",
      "run",
      suitePlan.relatedPackageScript,
      ...plan.relatedPaths.map((changedPath) => `./${changedPath}`),
    ];
  }
  throw new Error("A selected application suite requires full or related test mode.");
};

const root = path.resolve(import.meta.dirname, "../..");
const require = createRequire(import.meta.url);

export function fileShard(file: string, count: number): number {
  return Number.parseInt(digest(file).slice(0, 8), 16) % count;
}

function parseSegment(value: string, rawPlan: unknown) {
  const plan = parseCiGatePlan(rawPlan);
  const [suiteValue, shardValue, ...rest] = value.split(":");
  const suite = parseAppTestSuite(suiteValue);
  if (!plan.appTestSuites.includes(suite))
    throw new Error("Application suite is not selected: " + suite);
  const count = appShardCount(suite);
  const shard = Number(shardValue);
  if (
    rest.length ||
    String(shard) !== shardValue ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= count
  )
    throw new Error("Invalid application test shard: " + value);
  return { suite, shard, count, plan };
}

// Job metadata and cache service credentials must not reach Vitest. The engine
// fingerprints every variable that the worker actually receives.
export function linuxTestEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "CI",
    "GITHUB_ACTIONS",
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "SHELL",
    "TMPDIR",
    "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS",
    "DISPLAY",
    "XAUTHORITY",
    "PLAYWRIGHT_BROWSERS_PATH",
    "DEBUG",
    "RUNNER_DEBUG",
    "NODEX_TEST_TIMINGS",
    "NODEX_TEST_CACHE",
    "VP_CLI_BIN",
  ];
  return Object.fromEntries(
    allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
  );
}

async function linuxRunnerIdentity() {
  const { ImageOS, ImageVersion, GITHUB_ACTIONS } = process.env;
  if (process.platform !== "linux" || GITHUB_ACTIONS !== "true" || !ImageOS || !ImageVersion)
    return;
  const osRelease = await readFile("/etc/os-release", "utf8").catch(() => undefined);
  if (!osRelease) return;
  return digest(
    JSON.stringify([
      ImageOS,
      ImageVersion,
      osRelease,
      os.release(),
      process.arch,
      os.availableParallelism(),
      (process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header
        .glibcVersionRuntime,
    ]),
  );
}

async function runSegment(
  segment: string,
  plan: unknown,
  prepareCache: boolean,
  signal: AbortSignal,
) {
  const { suite, shard, count, plan: gatePlan } = parseSegment(segment, plan);
  const host = await linuxRunnerIdentity();
  const directory = cacheDirectory(
    root,
    { NODEX_BUILD_CACHE_DIR: path.join(root, ".cache/ci-app-results", `${shard + 1}of${count}`) },
    suite,
  );
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required.");
  if (prepareCache) {
    if (!host || process.env.NODEX_TEST_CACHE === "off") return 0;
    const runtime = runtimeForSuite(suite);
    const version =
      runtime === "chromium"
        ? (require("playwright/package.json") as { version: string }).version
        : runtime === "electron-node"
          ? (require("electron/package.json") as { version: string }).version
          : undefined;
    const lock = digest(await readFile(path.join(root, "pnpm-lock.yaml")));
    const identity = digest(JSON.stringify([host, process.versions, runtime, version, lock]));
    await appendFile(
      output,
      `path=${directory}\nprefix=nodex-app-passes-v2-${suite}-${shard + 1}of${count}-${identity}-\n`,
    );
    return 0;
  }

  const previousEpoch = await cacheEpoch(directory);
  const report: { current?: CachedSuiteReport } = {};
  const exit = await runCachedSuite(suite, [], {
    repositoryRoot: root,
    env: linuxTestEnvironment(process.env),
    signal,
    linuxCI: {
      host,
      directory,
      select: (file) => fileShard(file, count) === shard,
      relatedPaths:
        gatePlan.testMode === "related"
          ? gatePlan.relatedPaths.map((file) => "./" + file)
          : undefined,
    },
    onReport: (current) => {
      report.current = current;
    },
    prepare: (artifacts, context) =>
      prepareNativeArtifacts(artifacts, { ...context, env: process.env }),
  });
  const summary = report.current;
  const measurements = summary
    ? { ...summary, shard: shard + 1, shards: count }
    : { suite, shard: shard + 1, shards: count, hits: 0, fallback: true };
  process.stdout.write(`[ci-test-cache] ${JSON.stringify(measurements)}\n`);
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    const result = summary
      ? `${summary.hits} hits, ${summary.ran} ran, ${summary.recorded} recorded`
      : "0 hits, suite or shard executed without result reuse";
    await appendFile(stepSummary, `- ${suite} shard ${shard + 1}/${count}: ${result}\n`);
  }
  // A failed sample must shadow the previous archive on the next run. The shard already re-ran
  // every file, so evidence that did not reproduce warns rather than failing passing tests.
  const invalidated = previousEpoch !== (await cacheEpoch(directory));
  if (invalidated)
    process.stdout.write(
      `::warning title=Test cache invalidated::${suite} shard ${shard + 1}/${count} discarded its saved passes and ran every file; the [test-cache] log line names the evidence that did not reproduce.\n`,
    );
  if (invalidated || (exit === 0 && summary && summary.recorded > 0))
    await appendFile(output, "publish=true\n");
  return exit;
}

const main = async (signal: AbortSignal): Promise<number> => {
  const args = process.argv.slice(2);
  const suite = readOption(args, "--suite") ?? "";
  const planJson = process.env.CI_GATE_PLAN_JSON;
  if (!planJson) throw new Error("CI_GATE_PLAN_JSON is required.");
  const plan: unknown = JSON.parse(planJson);
  const segment = readOption(args, "--segment");
  if (segment) return runSegment(segment, plan, args.includes("--cache-key"), signal);
  const command = commandForAppTestSuite(suite, plan);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    env: { ...process.env, NODEX_TEST_TIER: "default" },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(main).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
