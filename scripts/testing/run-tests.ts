import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { runTimedCommand } from "../ci/run-timed.ts";
import path from "node:path";
import {
  STANDARD_TEST_SUITES,
  NIGHTLY_TEST_SUITES,
  STRESS_TEST_SUITES,
  LIVE_TEST_SUITES,
  nativeRequirements,
  requiresAgentRuntime,
  parseTestSuite,
  runtimeForSuite,
  type SuiteId,
  type NativeArtifactId,
} from "../../config/test-suites.ts";
import { resolveVitestTestTier, type VitestTestScope } from "../../config/vitest-test-tier.ts";
import { runCommand, withCommandSignal, type Command } from "../tooling/process.ts";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts.ts";
import { discoverSuite, testRuntimeEnvironment, vitestCommand } from "./runtime.ts";
import { prepareElectronRuntime } from "../prepare-electron-runtime.ts";

export interface TestSelection {
  readonly suites: readonly SuiteId[];
  readonly tier: VitestTestScope;
  readonly related: boolean;
  readonly args: readonly string[];
}

const tierSelections = {
  standard: STANDARD_TEST_SUITES,
  nightly: NIGHTLY_TEST_SUITES,
  stress: STRESS_TEST_SUITES,
  live: LIVE_TEST_SUITES,
} as const;

export function parseTestSelection(args: readonly string[], tier: VitestTestScope): TestSelection {
  const [name, ...rest] = args;
  const related = rest[0] === "--related";
  const forwarded = related ? rest.slice(1) : rest;
  if (!name) throw new Error("Expected standard, nightly, stress, live, or a test suite.");
  if (name === "standard" || name === "nightly" || name === "stress" || name === "live") {
    if (forwarded.length || related)
      throw new Error("Use a named suite for focused or related tests.");
    return {
      suites: tierSelections[name],
      tier: name === "standard" ? "default" : name,
      related: false,
      args: [],
    };
  }
  if (
    forwarded.some(
      (arg) => arg === "--" || arg === "--config" || arg.startsWith("--config=") || arg === "-c",
    )
  ) {
    throw new Error(
      "The suite owns its config. Pass focused paths directly, without a standalone --.",
    );
  }
  return {
    suites: [parseTestSuite(name)],
    tier: related && tier === "default" ? "related" : tier,
    related,
    args: forwarded,
  };
}

interface TestRunContext {
  readonly repositoryRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly prepare?: typeof prepareNativeArtifacts;
  readonly discover?: typeof discoverSuite;
  readonly execute?: typeof runCommand;
  readonly onStdout?: Command["onStdout"];
  readonly onStderr?: Command["onStderr"];
  readonly prepareElectron?: typeof prepareElectronRuntime;
  readonly isolatedVitestDirectory?: string;
  readonly exactFiles?: readonly string[];
}

export async function runTests(selection: TestSelection, context: TestRunContext): Promise<number> {
  if (selection.related && !context.isolatedVitestDirectory)
    return runIsolatedTests(selection, context);

  // Tests run as independent Nodex processes: an Agent shell that launched the run must not leak its CLI binding.
  const environment: NodeJS.ProcessEnv = {
    ...testRuntimeEnvironment(context.env),
    NODEX_TEST_TIER: selection.tier,
  };
  const commandContext: Pick<Command, "cwd" | "env" | "signal"> = {
    cwd: context.repositoryRoot,
    env: environment,
    signal: context.signal,
  };
  const requirements: NativeArtifactId[] = [];
  const relatedFiles = new Map<SuiteId, readonly string[]>();
  const usesExactRelated =
    selection.related && (selection.tier === "related" || selection.tier === "nightly");
  if (context.signal.aborted) return 130;
  // Discovery also runs under Electron; prepare before either path resolves its lazy executable.
  if (selection.suites.some((suite) => runtimeForSuite(suite) === "electron-node")) {
    await (context.prepareElectron ?? prepareElectronRuntime)({
      projectRoot: context.repositoryRoot,
    });
  }
  for (const suite of selection.suites) {
    if (context.signal.aborted) return 130;
    const needsSelection =
      usesExactRelated ||
      (nativeRequirements(suite).length > 0 &&
        (selection.tier !== "default" || selection.related || selection.args.length > 0));
    const files =
      context.exactFiles ??
      (needsSelection
        ? await (context.discover ?? discoverSuite)(
            suite,
            selection.args,
            selection.related ? "related" : "run",
            commandContext,
          )
        : undefined);
    if (usesExactRelated && files) relatedFiles.set(suite, files);
    requirements.push(...nativeRequirements(suite, files));
    if (requiresAgentRuntime(suite, selection.tier, files)) requirements.push("agent-runtime");
  }
  const prepared = await (context.prepare ?? prepareNativeArtifacts)([...new Set(requirements)], {
    repositoryRoot: context.repositoryRoot,
    profile: selection.tier === "stress" ? "release" : "dev",
    env: environment,
    signal: context.signal,
  });
  for (const suite of selection.suites) {
    if (context.signal.aborted) return 130;
    const files = relatedFiles.get(suite);
    if (files?.length === 0) {
      (context.onStdout ?? ((output: string) => process.stdout.write(output)))(
        "No affected test files found, exiting with code 0\n",
      );
      continue;
    }
    if (files && context.isolatedVitestDirectory)
      await writeFile(
        path.join(context.isolatedVitestDirectory, "files.json"),
        JSON.stringify(files),
      );
    const command = {
      ...vitestCommand(
        suite,
        selection.args,
        selection.related,
        { ...commandContext, env: { ...environment, ...preparedNativeEnvironment(prepared) } },
        context.isolatedVitestDirectory,
      ),
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    };
    const result =
      context.execute || !environment.NODEX_TEST_TIMINGS
        ? await (context.execute ?? runCommand)(command)
        : await runTimedCommand({
            ...command,
            commandArguments: command.args,
            name: "test-" + suite,
            timingDirectory: environment.NODEX_TEST_TIMINGS,
          });
    if (result.exitCode !== 0) return result.exitCode;
  }
  return 0;
}

export async function runIsolatedTests(
  selection: TestSelection,
  context: TestRunContext,
  priority: readonly string[] = [],
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "nodex-test-uncached-"));
  try {
    await writeFile(path.join(directory, "priority.json"), JSON.stringify(priority));
    if (context.exactFiles)
      await writeFile(path.join(directory, "files.json"), JSON.stringify(context.exactFiles));
    return await runTests(selection, { ...context, isolatedVitestDirectory: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    try {
      const selection = parseTestSelection(
        process.argv.slice(2),
        resolveVitestTestTier(process.env.NODEX_TEST_TIER),
      );
      return await runTests(selection, {
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        env: process.env,
        signal,
      });
    } catch (error) {
      if (signal.aborted) return 130;
      process.stderr.write(String(error) + "\n");
      return 1;
    }
  });
}
