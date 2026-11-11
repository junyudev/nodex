import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { classifyChangedPaths } from "../ci/classify-change.ts";
import { runCommand, withCommandSignal } from "../tooling/process.ts";
import { vitePlusCommand } from "../vite-plus-command.ts";
import { runCachedSuite, validationConcurrency } from "./run-cached-tests.ts";
import { runTests } from "./run-tests.ts";
import { CACHE_SUITES, isCacheSuite } from "./test-cache-policy.ts";

export function mergePathLists(...lists: readonly string[]): string[] {
  return [...new Set(lists.flatMap((list) => list.split("\0").filter(Boolean)))].sort();
}

export function readChangedPaths(root: string) {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const base = git("merge-base", "HEAD", "refs/heads/main").trim();
  const diff = ["diff", "--name-only", "--no-renames", "-z"];
  return {
    base,
    files: mergePathLists(
      git(...diff, base, "HEAD", "--"),
      git(...diff, "--cached", "HEAD", "--"),
      git(...diff, "--"),
      git("ls-files", "--others", "--exclude-standard", "-z", "--"),
    ),
  };
}

async function checkChanged(root: string, signal: AbortSignal): Promise<number> {
  const { base, files } = readChangedPaths(root);
  process.stdout.write(
    `[check:changed] ${files.length} changed paths since ${base.slice(0, 12)} (main)\n`,
  );
  const present = files.flatMap((file) => {
    const absolute = path.join(root, file);
    return existsSync(absolute) && lstatSync(absolute, { throwIfNoEntry: false })?.isFile()
      ? ["./" + file]
      : [];
  });
  const code = present.filter((file) => /\.[cm]?[jt]sx?$/u.test(file));
  const vp = async (...args: string[]) =>
    (await runCommand({ ...vitePlusCommand(args), cwd: root, signal })).exitCode;
  const paths = async () => {
    // Limit argv size for broad renames and generated changes.
    for (let index = 0; index < present.length; index += 200) {
      const result = await vp(
        "fmt",
        "--check",
        "--no-error-on-unmatched-pattern",
        ...present.slice(index, index + 200),
      );
      if (result) return result;
    }
    for (let index = 0; index < code.length; index += 200) {
      // The semantic gate enforces the warning ratchet across all projects.
      const result = await vp(
        "lint",
        "--quiet",
        "--no-error-on-unmatched-pattern",
        ...code.slice(index, index + 200),
      );
      if (result) return result;
    }
    return 0;
  };
  const semantic = () => vp("run", "check:semantic");
  const concurrency = validationConcurrency(availableParallelism(), process.availableMemory());
  if (concurrency > 1) {
    const results = await Promise.allSettled([paths(), semantic()]);
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
      if (result.value) return result.value;
    }
  } else {
    const status = (await paths()) || (await semantic());
    if (status) return status;
  }
  const context = {
    repositoryRoot: root,
    env: { ...process.env, NODEX_TEST_TIER: "default" },
    signal,
  };
  if (files.length === 0) return 0;
  const plan = classifyChangedPaths(files);
  if (plan.appTestSuites.length === 0) return 0;
  // A cached suite runs whole: unchanged files hit, so the change's dependents are never missed.
  for (const suite of CACHE_SUITES) {
    const status = await runCachedSuite(suite, [], context);
    if (status) return status;
  }
  const suites = plan.appTestSuites.filter((suite) => !isCacheSuite(suite));
  if (suites.length === 0) return 0;
  const related = plan.testMode === "related";
  return runTests(
    {
      suites,
      tier: "default",
      related,
      args: related ? plan.relatedPaths.map((file) => "./" + file) : [],
    },
    context,
  );
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
