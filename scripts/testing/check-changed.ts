import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import {
  acquireMachineBudget,
  MACHINE_BUDGET_REPORT_ENV,
  type BudgetQueueEvent,
} from "../tooling/machine-budget.ts";
import { runCommand, withCommandSignal, type Command } from "../tooling/process.ts";
import { vitePlusCommand } from "../vite-plus-command.ts";
import { findFocusedTests, planCheckSteps, type CheckStep } from "./check-changed-plan.ts";
import {
  duration,
  formatSummary,
  queueTime,
  readChangedPaths,
  readPassKey,
  type RunRecord,
  type StepResult,
} from "./check-changed-record.ts";
import {
  runCachedSuite,
  validationConcurrency,
  type CachedSuiteReport,
} from "./run-cached-tests.ts";
import { runMemoizedBrowserSuite } from "./run-memoized-browser-suite.ts";
import { runTests } from "./run-tests.ts";

export { mergePathLists } from "./check-changed-record.ts";

const write = (line: string) => process.stdout.write(line + "\n");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export function parseCheckArguments(args: readonly string[], env: NodeJS.ProcessEnv) {
  let ref: string | undefined;
  let override: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--timeout" && override === undefined && args[index + 1] !== undefined) {
      override = args[++index];
    } else if (argument && !argument.startsWith("-") && ref === undefined) {
      ref = argument;
    } else {
      throw new Error("Usage: vp run check:changed [<ref>] [--timeout <seconds>]");
    }
  }
  const timeoutMs = Number(override ?? (env.CHECK_CHANGED_TIMEOUT || "1200")) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error(
      "Set --timeout or CHECK_CHANGED_TIMEOUT to a positive number of seconds within the timer limit.",
    );
  return { ref, timeoutMs };
}

type ActiveStep = Exclude<CheckStep, { kind: "skip" }>;

interface StepWork {
  readonly step: ActiveStep;
  readonly rustEnv: ReturnType<typeof planCheckSteps>["rustEnv"];
  readonly cacheReport: string;
}

/** One process per step keeps runner output, test cache reports, and cancellation scoped. */
async function runStepWork(file: string, signal: AbortSignal): Promise<number> {
  const { step, rustEnv, cacheReport } = JSON.parse(readFileSync(file, "utf8")) as StepWork;
  const repositoryRoot = process.cwd();
  const env = { ...process.env, NODEX_TEST_TIER: "default" };
  const context = { repositoryRoot, env, signal };
  if (step.kind === "cached") {
    const cachedContext = {
      ...context,
      onReport: (report: CachedSuiteReport) => {
        const pending = cacheReport + ".tmp";
        writeFileSync(pending, JSON.stringify(report));
        renameSync(pending, cacheReport);
      },
    };
    return step.suite === "browser"
      ? runMemoizedBrowserSuite(cachedContext)
      : runCachedSuite(step.suite, step.filters, cachedContext);
  }
  if (step.kind === "tests") {
    return runTests(
      { suites: [step.suite], tier: "default", related: step.related, args: step.args },
      context,
    );
  }

  const commandEnv = step.budget ? { ...process.env, ...rustEnv } : process.env;
  const lease = step.budget
    ? await acquireMachineBudget(
        { weight: 4, memoryGiB: 6, label: step.name },
        { cwd: repositoryRoot, env: commandEnv, signal },
      )
    : undefined;
  try {
    let exitCode = 0;
    for (const { args, label } of step.commands) {
      if (signal.aborted) return 130;
      if (label) write(`[static] ${label}`);
      const result = await runCommand({
        ...vitePlusCommand(args),
        cwd: repositoryRoot,
        signal,
        env: { ...commandEnv, ...lease?.env },
      });
      if (result.exitCode) {
        write(`[check:changed] vp ${args.slice(0, 5).join(" ")} exited ${result.exitCode}`);
        exitCode ||= result.exitCode;
      }
    }
    return exitCode;
  } finally {
    lease?.release();
  }
}

const readIfPresent = (file: string) => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if (!isMissing(error)) throw error;
    return "";
  }
};

const readQueueEvents = (file: string) =>
  readIfPresent(file)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BudgetQueueEvent);

interface StepContext {
  readonly root: string;
  readonly directory: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export async function runStep(
  name: string,
  invocation: Pick<Command, "command" | "args">,
  context: StepContext,
  reportName: string,
  cached = false,
): Promise<StepResult> {
  write(`[check:changed] START ${name}`);
  const budgetReport = path.join(context.directory, reportName + ".budget.jsonl");
  const chunks: string[] = [];
  const capture = (chunk: string) => chunks.push(chunk);
  const started = performance.now();
  const startedAt = Date.now();
  const timeout = new AbortController();
  let timedOutAt: number | undefined;
  // Waiting for the machine budget is not running time, so it never counts against the limit.
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - startedAt - queueTime(readQueueEvents(budgetReport), now) < context.timeoutMs) return;
    timedOutAt = now;
    timeout.abort();
  }, 1_000);
  let failure: string | undefined;
  try {
    const { exitCode } = await runCommand({
      ...invocation,
      cwd: context.root,
      env: { ...process.env, [MACHINE_BUDGET_REPORT_ENV]: budgetReport },
      signal: AbortSignal.any([context.signal, timeout.signal]),
      onStdout: capture,
      onStderr: capture,
    });
    if (exitCode && !timeout.signal.aborted)
      failure = context.signal.aborted ? "cancelled" : `exit ${exitCode}`;
  } catch (error) {
    capture(message(error));
    failure = message(error);
  } finally {
    clearInterval(timer);
  }
  const elapsed = Math.round(performance.now() - started);
  const queueMs = Math.min(
    elapsed,
    queueTime(readQueueEvents(budgetReport), timedOutAt ?? Date.now()),
  );
  const runMs = elapsed - queueMs;
  const cacheJson = cached
    ? readIfPresent(path.join(context.directory, reportName + ".cache.json"))
    : "";
  const cache = cacheJson ? (JSON.parse(cacheJson) as CachedSuiteReport) : undefined;
  const outcome = timeout.signal.aborted ? "TIMEOUT" : failure ? "FAIL" : "pass";
  const reason = timeout.signal.aborted
    ? `running-time limit ${duration(context.timeoutMs)}`
    : (failure ?? (cached && !cache ? "cache report unavailable" : undefined));
  const output = chunks.join("").trimEnd();
  const block = outcome === "pass" ? output.slice(-2000).split("\n").slice(-3).join("\n") : output;
  write(
    [
      `[check:changed] ${outcome} ${name} (run ${duration(runMs)}, queue ${duration(queueMs)})${reason ? ` · ${reason}` : ""}`,
      timeout.signal.aborted
        ? "The step exceeded its limit. This is not a check failure. Raise it with --timeout <seconds> or CHECK_CHANGED_TIMEOUT."
        : "",
      block,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return { name, outcome, runMs, queueMs, reason, cache };
}

/** A blocked lane holds its position in the admission order. Other work already running can finish. */
export async function runStepQueue(
  steps: readonly CheckStep[],
  concurrency: number,
  signal: AbortSignal,
  run: (step: ActiveStep, index: number) => Promise<StepResult>,
): Promise<readonly StepResult[]> {
  const results: Promise<StepResult>[] = [];
  const active = new Set<Promise<StepResult>>();
  const lanes = new Set<NonNullable<CheckStep["lane"]>>();
  for (const [index, step] of steps.entries()) {
    const { lane, name } = step;
    if (step.kind !== "skip") {
      const canStart = () => active.size < concurrency && (!lane || !lanes.has(lane));
      while (!signal.aborted && !canStart()) await Promise.race(active);
    }
    if (step.kind === "skip" || signal.aborted) {
      const reason = step.kind === "skip" ? step.reason : "run cancelled before admission";
      results.push(Promise.resolve({ name, outcome: "skipped", reason, runMs: 0, queueMs: 0 }));
      continue;
    }
    if (lane) lanes.add(lane);
    const pending = run(step, index)
      .catch((error: unknown): StepResult => {
        const reason = message(error);
        write(`[check:changed] FAIL ${name} · ${reason}`);
        return { name, outcome: "FAIL", reason, runMs: 0, queueMs: 0 };
      })
      .finally(() => {
        active.delete(pending);
        if (lane) lanes.delete(lane);
      });
    active.add(pending);
    results.push(pending);
  }
  return Promise.all(results);
}

function presentSiblings(root: string, directory: string): string[] {
  try {
    return readdirSync(path.join(root, directory), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error) {
    if (!isMissing(error) && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw error;
    return [];
  }
}

interface PassRecord {
  readonly key: string;
  readonly record: RunRecord;
}

function readLastPass(file: string): PassRecord | undefined {
  try {
    return JSON.parse(readIfPresent(file)) as PassRecord;
  } catch {
    return undefined;
  }
}

async function checkChanged(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const totalMs = () => Math.round(performance.now() - started);
  const directory = path.join(root, "node_modules/.cache");
  const lastPassFile = path.join(directory, "check-changed-last-pass.json");
  // A fresh install can replace node_modules while the first step is running.
  const generated = path.join(root, ".generated");
  mkdirSync(generated, { recursive: true });
  const staging = mkdtempSync(path.join(generated, "check-changed-"));
  const steps: StepResult[] = [];
  let comparison: ReturnType<typeof readChangedPaths> | undefined;
  let record: RunRecord | undefined;
  const createRecord = (): RunRecord => ({
    startedAt,
    worktree: root,
    base: comparison?.base ?? null,
    ref: comparison?.ref ?? null,
    pathCount: comparison?.files.length ?? 0,
    steps,
    totalMs: totalMs(),
  });
  try {
    const { ref: explicitRef, timeoutMs } = parseCheckArguments(args, process.env);
    const context = { root, directory: staging, timeoutMs, signal };
    const install = await runStep(
      "install dependencies",
      vitePlusCommand(["install", "--frozen-lockfile"]),
      context,
      "install",
    );
    steps.push(install);
    if (install.outcome !== "pass") return signal.aborted ? 130 : 1;

    comparison = readChangedPaths(root, explicitRef);
    const { base, ref, files } = comparison;
    write(`[check:changed] ${files.length} changed paths since ${base.slice(0, 12)} (${ref})`);
    const fingerprint = (changed: ReturnType<typeof readChangedPaths>) => {
      try {
        return readPassKey(root, changed, explicitRef, process.env);
      } catch (error) {
        write(`[check:changed] Could not fingerprint the worktree. ${message(error)}`);
        return undefined;
      }
    };
    const key = fingerprint(comparison);
    const previous = key && readLastPass(lastPassFile);
    if (previous && previous.key === key) {
      write("Nothing changed since the last passing run");
      write(formatSummary(previous.record));
      record = { ...createRecord(), reused: true, reusedFrom: previous.record.startedAt };
      return 0;
    }

    const present = files.filter((file) =>
      lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
    );
    const focused = findFocusedTests(files, new Set(present), (directory) =>
      presentSiblings(root, directory),
    );
    const { steps: plan, rustEnv } = planCheckSteps(comparison, present, focused);
    const concurrency = validationConcurrency(availableParallelism(), process.availableMemory());
    steps.push(
      ...(await runStepQueue(plan, concurrency, signal, async (step, index) => {
        const name = String(index);
        const input = path.join(staging, name + ".json");
        const work: StepWork = {
          step,
          rustEnv,
          cacheReport: path.join(staging, name + ".cache.json"),
        };
        writeFileSync(input, JSON.stringify(work));
        return runStep(
          step.name,
          {
            command: process.execPath,
            args: ["--import", "tsx", import.meta.filename, "--step", input],
          },
          context,
          name,
          step.kind === "cached",
        );
      })),
    );
    if (signal.aborted) return 130;
    if (steps.some(({ outcome }) => outcome === "FAIL" || outcome === "TIMEOUT")) return 1;

    if (key && key === fingerprint(readChangedPaths(root, explicitRef))) {
      record = createRecord();
      const temp = lastPassFile + "." + path.basename(staging) + ".tmp";
      mkdirSync(directory, { recursive: true });
      try {
        writeFileSync(temp, JSON.stringify({ key, record } satisfies PassRecord));
        renameSync(temp, lastPassFile);
      } finally {
        rmSync(temp, { force: true });
      }
    } else if (key) {
      write("[check:changed] Worktree inputs changed during validation. Pass record omitted.");
    }
    return 0;
  } catch (error) {
    record = { ...createRecord(), error: message(error) };
    write(`[check:changed] ${record.error}`);
    return signal.aborted ? 130 : 1;
  } finally {
    record ??= createRecord();
    try {
      if (!record.reused) write(formatSummary(record));
      const runDirectory = path.join(resolvePrimaryCheckoutRoot(root), "cache.local/check-changed");
      mkdirSync(runDirectory, { recursive: true });
      appendFileSync(path.join(runDirectory, "runs.jsonl"), JSON.stringify(record) + "\n");
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  void withCommandSignal(async (signal) => {
    const args = process.argv.slice(2);
    try {
      if (args[0] === "--step" && args.length === 2) return await runStepWork(args[1], signal);
      return await checkChanged(path.resolve(import.meta.dirname, "../.."), args, signal);
    } catch (error) {
      process.stderr.write(message(error) + "\n");
      return signal.aborted ? 130 : 1;
    }
  });
}
