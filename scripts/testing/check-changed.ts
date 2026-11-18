import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import type { CiGatePlan } from "../ci/ci-gate-plan.ts";
import { acquireMachineBudget } from "../tooling/machine-budget.ts";
import { runCommand, withCommandSignal } from "../tooling/process.ts";
import { vitePlusCommand } from "../vite-plus-command.ts";
import { runCachedSuite, validationConcurrency } from "./run-cached-tests.ts";
import { runTests } from "./run-tests.ts";
import { CACHE_SUITES, isCacheSuite } from "./test-cache-policy.ts";

export function mergePathLists(...lists: readonly string[]): string[] {
  return [...new Set(lists.flatMap((list) => list.split("\0").filter(Boolean)))].sort();
}

export const comparisonRef = (refs: readonly string[]): string => {
  const ref = ["refs/remotes/origin/main", "refs/heads/main"].find((ref) => refs.includes(ref));
  if (!ref) throw new Error("check:changed requires origin/main or a local main ref.");
  return ref;
};

export function readChangedPaths(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const ref = comparisonRef(
    git("for-each-ref", "--format=%(refname)", "refs/remotes/origin/main", "refs/heads/main")
      .trim()
      .split("\n"),
  );
  const base = git("merge-base", "HEAD", ref).trim();
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  return {
    base,
    ref,
    files: mergePathLists(
      git(...diff, base, "HEAD", "--"),
      git(...diff, "--cached", "HEAD", "--"),
      git(...diff, "--"),
      git("ls-files", "--others", "--exclude-standard", "-z", "--"),
    ),
  };
}

interface CheckStep {
  readonly name: string;
  readonly args: readonly string[];
  readonly rust?: boolean;
}

/** Mirror the selected static and Rust CI lanes; the types lane includes the semantic gate. */
export function planCheckSteps(plan: CiGatePlan): {
  readonly preflight: readonly CheckStep[];
  readonly gates: readonly CheckStep[];
} {
  const types = plan.staticGroups.includes("types");
  const preflight: CheckStep[] = [
    {
      name: types ? "static types" : "semantic",
      args: ["run", types ? "check" : "check:semantic"],
    },
  ];
  const gates: CheckStep[] = plan.staticGroups
    .filter((group) => group !== "types")
    .map((group) => ({
      name: `static ${group}`,
      args: ["exec", "tsx", "scripts/ci/verify-static.ts", "--group", group],
    }));
  if (plan.rustFast) {
    gates.push(
      { name: "rust format", args: ["exec", "cargo", "fmt", "--all", "--check"] },
      ...(["clippy", "tests"] as const).map((kind) => ({
        name: `rust ${kind}`,
        args: ["exec", "tsx", "scripts/ci/run-affected-rust.ts", "--kind", kind],
        rust: true,
      })),
    );
  }
  if (plan.protocolContracts) {
    gates.push({ name: "protocol contracts", args: ["run", "core:protocol:verify"], rust: true });
  }
  if (plan.rustMigration) {
    gates.push({ name: "rust migration", args: ["run", "core:test:migration"], rust: true });
  }
  return { preflight, gates };
}

/** Full-workspace CI lanes omit the path list so broad changes stay below ARG_MAX. */
export const rustGateEnvironment = (plan: CiGatePlan, files: readonly string[]) => ({
  CI_CHANGED_PATHS_JSON: JSON.stringify(plan.rustFull ? [] : files),
  CI_RUST_FULL: String(plan.rustFull),
  CARGO_BUILD_JOBS: "4",
  NEXTEST_TEST_THREADS: "2",
});

async function runGate(name: string, run: () => Promise<number>): Promise<void> {
  process.stdout.write(`[check:changed] ${name}\n`);
  try {
    const status = await run();
    if (status) throw new Error(`exit ${status}`);
  } catch (error) {
    throw new Error(`[check:changed] ${name} failed: ${String(error)}`, { cause: error });
  }
}

async function checkChanged(root: string, signal: AbortSignal): Promise<number> {
  const { base, ref, files } = readChangedPaths(root);
  process.stdout.write(
    `[check:changed] ${files.length} changed paths since ${base.slice(0, 12)} (${ref})\n`,
  );
  const present = files.flatMap((file) => {
    const absolute = path.join(root, file);
    return existsSync(absolute) && lstatSync(absolute, { throwIfNoEntry: false })?.isFile()
      ? ["./" + file]
      : [];
  });
  // Deleted inputs require full suites, just as in the CI classifier's CLI.
  // No unpushed or working-tree changes must not become the classifier's all-gates fallback.
  const plan = files.length
    ? classifyChangedPaths(files, { forceFullTests: present.length !== files.length })
    : null;
  const steps = plan ? planCheckSteps(plan) : { preflight: [], gates: [] };
  const code = present.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
  const controller = new AbortController();
  const preflightSignal = AbortSignal.any([signal, controller.signal]);
  const vp = async (args: readonly string[], commandSignal = signal, env = process.env) =>
    (await runCommand({ ...vitePlusCommand(args), cwd: root, signal: commandSignal, env }))
      .exitCode;
  const paths = async () => {
    // The types lane already checks repository-wide formatting.
    // Limit argv size for broad renames and generated changes.
    for (
      let index = 0;
      !plan?.staticGroups.includes("types") && index < present.length;
      index += 200
    ) {
      const result = await vp(
        ["fmt", "--check", "--no-error-on-unmatched-pattern", ...present.slice(index, index + 200)],
        preflightSignal,
      );
      if (result) return result;
    }
    for (let index = 0; index < code.length; index += 200) {
      // The semantic gate enforces the warning ratchet across all projects.
      const result = await vp(
        ["lint", "--quiet", "--no-error-on-unmatched-pattern", ...code.slice(index, index + 200)],
        preflightSignal,
      );
      if (result) return result;
    }
    return 0;
  };
  const preliminary = [
    () => runGate("changed-file format/lint", paths),
    ...(plan ? steps.preflight : [{ name: "semantic", args: ["run", "check:semantic"] }]).map(
      (step) => () => runGate(step.name, () => vp(step.args, preflightSignal)),
    ),
    // ui-contracts owns the same catalog check when selected.
    ...(files.some((file) => file.startsWith("src/")) &&
    !plan?.staticGroups.includes("ui-contracts")
      ? [() => runGate("i18n", () => vp(["run", "i18n:check"], preflightSignal))]
      : []),
  ];
  const concurrency = validationConcurrency(availableParallelism(), process.availableMemory());
  if (concurrency > 1) {
    const pending = preliminary.map((run) => run());
    try {
      await Promise.all(pending);
    } catch (error) {
      controller.abort();
      await Promise.allSettled(pending);
      throw error;
    }
  } else {
    for (const run of preliminary) await run();
  }
  for (const step of steps.gates) {
    await runGate(step.name, async () => {
      if (!step.rust || !plan) return vp(step.args);
      const env = {
        ...process.env,
        ...rustGateEnvironment(plan, files),
      };
      const lease = await acquireMachineBudget(
        { weight: 4, memoryGiB: 6, label: step.name },
        { cwd: root, env, signal },
      );
      try {
        return await vp(step.args, signal, { ...env, ...lease.env });
      } finally {
        lease.release();
      }
    });
  }
  const context = {
    repositoryRoot: root,
    env: { ...process.env, NODEX_TEST_TIER: "default" },
    signal,
  };
  if (!plan || plan.appTestSuites.length === 0) return 0;
  // A cached suite runs whole: unchanged files hit, so the change's dependents are never missed.
  for (const suite of CACHE_SUITES) {
    await runGate(`app ${suite}`, () => runCachedSuite(suite, [], context));
  }
  const suites = plan.appTestSuites.filter((suite) => !isCacheSuite(suite));
  if (suites.length === 0) return 0;
  const related = plan.testMode === "related";
  await runGate(`app ${suites.join(", ")}`, () =>
    runTests(
      {
        suites,
        tier: "default",
        related,
        args: related ? plan.relatedPaths.map((file) => "./" + file) : [],
      },
      context,
    ),
  );
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    try {
      return await checkChanged(path.resolve(import.meta.dirname, "../.."), signal);
    } catch (error) {
      process.stderr.write(String(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}
