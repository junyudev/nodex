import { runTimedCommand } from "../ci/run-timed.ts";
import path from "node:path";
import {
  STANDARD_TEST_SUITES,
  STRESS_TEST_SUITES,
  nativeRequirements,
  parseTestSuite,
  type SuiteId,
  type NativeArtifactId,
} from "../../config/test-suites.ts";
import { resolveVitestTestTier, type VitestTestTier } from "../../config/vitest-test-tier.ts";
import { runCommand, withCommandSignal, type Command } from "../tooling/process.ts";
import { prepareNativeArtifacts, preparedNativeEnvironment } from "./native-artifacts.ts";
import { discoverSuite, vitestCommand } from "./runtime.ts";

export interface TestSelection {
  readonly suites: readonly SuiteId[];
  readonly tier: VitestTestTier;
  readonly related: boolean;
  readonly args: readonly string[];
}

export function parseTestSelection(
  args: readonly string[],
  tier = resolveVitestTestTier(),
): TestSelection {
  const [name, ...rest] = args;
  const related = rest[0] === "--related";
  const forwarded = related ? rest.slice(1) : rest;
  if (!name) throw new Error("Expected standard, stress, or a test suite.");
  if (name === "standard" || name === "stress") {
    if (forwarded.length || related)
      throw new Error("Use a named suite for focused or related tests.");
    return {
      suites: name === "standard" ? STANDARD_TEST_SUITES : STRESS_TEST_SUITES,
      tier: name === "standard" ? "default" : "stress",
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
  return { suites: [parseTestSuite(name)], tier, related, args: forwarded };
}

export async function runTests(
  selection: TestSelection,
  context: {
    readonly repositoryRoot: string;
    readonly env: NodeJS.ProcessEnv;
    readonly signal: AbortSignal;
    readonly prepare?: typeof prepareNativeArtifacts;
    readonly discover?: typeof discoverSuite;
    readonly execute?: typeof runCommand;
  },
): Promise<number> {
  const environment: NodeJS.ProcessEnv = { ...context.env, NODEX_TEST_TIER: selection.tier };
  const commandContext: Pick<Command, "cwd" | "env" | "signal"> = {
    cwd: context.repositoryRoot,
    env: environment,
    signal: context.signal,
  };
  const requirements: NativeArtifactId[] = [];
  for (const suite of selection.suites) {
    if (context.signal.aborted) return 130;
    const needsSelection =
      nativeRequirements(suite).length > 0 &&
      (selection.tier === "stress" || selection.related || selection.args.length > 0);
    const files = needsSelection
      ? await (context.discover ?? discoverSuite)(
          suite,
          selection.args,
          selection.related,
          commandContext,
        )
      : undefined;
    requirements.push(...nativeRequirements(suite, files));
  }
  const prepared = await (context.prepare ?? prepareNativeArtifacts)([...new Set(requirements)], {
    repositoryRoot: context.repositoryRoot,
    env: environment,
    signal: context.signal,
  });
  for (const suite of selection.suites) {
    if (context.signal.aborted) return 130;
    const command = vitestCommand(suite, selection.args, selection.related, {
      ...commandContext,
      env: { ...environment, ...preparedNativeEnvironment(prepared) },
    });
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

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    try {
      return await runTests(parseTestSelection(process.argv.slice(2)), {
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
