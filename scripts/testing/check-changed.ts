import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, totalmem } from "node:os";
import path from "node:path";
import {
  APP_TEST_SUITES,
  isNativeExecutable,
  nativeRequirements,
  ownerOfTest,
  type NativeExecutableId,
  type SuiteId,
} from "../../config/test-suites.ts";
import {
  selectAffectedRustPackageNames,
  selectTouchedRustPackageNames,
  type CargoMetadata,
} from "../ci/run-affected-rust.ts";
import { resolvePrimaryCheckoutRoot } from "../primary-checkout.ts";
import {
  acquireMachineBudget,
  MACHINE_BUDGET_REPORT_ENV,
  type BudgetQueueEvent,
} from "../tooling/machine-budget.ts";
import { runCommand, withCommandSignal, type Command } from "../tooling/process.ts";
import { vitePlusCommand } from "../vite-plus-command.ts";
import {
  changesRustWorkspace,
  deferNativeTests,
  findFocusedTests,
  isTestFile,
  observedChangedInput,
  planCheckSteps,
  planFastCheckSteps,
  selectAffectedTests,
  selectFocusedBrowserTests,
  type CheckStep,
} from "./check-changed-plan.ts";
import {
  duration,
  formatSummary,
  idleQueueTime,
  queueTime,
  queueWindows,
  readChangedPaths,
  type RunRecord,
  type StepResult,
} from "./check-changed-record.ts";
import {
  runCachedSuite,
  type CachedSuiteReport,
  type CachedSuiteContext,
} from "./run-cached-tests.ts";
import { randomUUID } from "node:crypto";
import { nativeArtifactPackage, prepareNativeArtifacts } from "./native-artifacts.ts";
import { readPreparedNativeTests } from "./native-test-readiness.ts";
import { runIsolatedTests } from "./run-tests.ts";
import { testRuntimeEnvironment } from "./runtime.ts";
import {
  cacheDirectory,
  digestCachePath,
  readSelectionEvidence,
  stampDigests,
  workspaceInputs,
} from "./test-cache-store.ts";

export { mergePathLists } from "./check-changed-record.ts";

const write = (line: string) => process.stdout.write(line + "\n");
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const isMissing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const validationConcurrency = (cores: number, memoryBytes: number) =>
  Math.max(1, Math.min(6, Math.floor(cores / 2), Math.floor(memoryBytes / (6 * 1024 ** 3))));

export function parseCheckArguments(args: readonly string[], env: NodeJS.ProcessEnv) {
  let ref: string | undefined;
  let override: string | undefined;
  let full = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--timeout" && override === undefined && args[index + 1] !== undefined) {
      override = args[++index];
    } else if (argument === "--full" && !full) {
      full = true;
    } else if (argument && !argument.startsWith("-") && ref === undefined) {
      ref = argument;
    } else {
      throw new Error("Usage: vp run check:changed [<ref>] [--full] [--timeout <seconds>]");
    }
  }
  const configured = override ?? (env.CHECK_CHANGED_TIMEOUT || undefined);
  const timeoutMs = Number(configured ?? "1200") * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647)
    throw new Error(
      "Set --timeout or CHECK_CHANGED_TIMEOUT to a positive number of seconds within the timer limit.",
    );
  return { ref, full, timeoutMs, suiteTimeoutMs: configured === undefined ? 3_600_000 : timeoutMs };
}

type ActiveStep = Exclude<CheckStep, { kind: "skip" }>;

interface StepWork {
  readonly step: Extract<CheckStep, { kind: "command" }>;
  readonly rustEnv: NodeJS.ProcessEnv | null;
}

/** Static commands run in subprocesses with scoped output and cancellation. */
async function runStepWork(file: string, signal: AbortSignal): Promise<number> {
  const { step, rustEnv } = JSON.parse(readFileSync(file, "utf8")) as StepWork;
  const repositoryRoot = process.cwd();
  const budgeted = step.resource === "rust-budget";
  const commandEnv = budgeted ? { ...process.env, ...rustEnv } : process.env;
  const lease = budgeted
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
  readonly cacheReport?: false;
  readonly commandLane?: (
    env: NodeJS.ProcessEnv,
    signal: AbortSignal,
    run: () => Promise<number>,
  ) => Promise<number>;
}

type StepInvocation =
  | Pick<Command, "command" | "args">
  | ((
      context: Pick<CachedSuiteContext, "env" | "signal" | "onReport" | "onStdout" | "onStderr">,
    ) => Promise<number>);

export async function runStep(
  name: string,
  invocation: StepInvocation,
  context: StepContext,
  reportName: string,
  onBudgetGranted?: () => void,
): Promise<StepResult> {
  write(`[check:changed] START ${name}`);
  const budgetReport = path.join(context.directory, reportName + ".budget.jsonl");
  const chunks: string[] = [];
  const capture = (chunk: string) => chunks.push(chunk);
  const started = performance.now();
  const startedAt = Date.now();
  const timeout = new AbortController();
  let timedOutAt: number | undefined;
  let budgetGranted = false;
  // Waiting for the machine budget is not running time, so it never counts against the limit.
  const timer = setInterval(() => {
    const now = Date.now();
    const events = readQueueEvents(budgetReport);
    if (onBudgetGranted && !budgetGranted && events.some((event) => "grantedAt" in event)) {
      budgetGranted = true;
      onBudgetGranted();
    }
    if (now - startedAt - queueTime(events, now) < context.timeoutMs) return;
    timedOutAt = now;
    timeout.abort();
  }, 1_000);
  let failure: string | undefined;
  let cache: CachedSuiteReport | undefined;
  try {
    const commandContext = {
      env: { ...process.env, [MACHINE_BUDGET_REPORT_ENV]: budgetReport },
      signal: AbortSignal.any([context.signal, timeout.signal]),
      onStdout: capture,
      onStderr: capture,
    };
    let exitCode: number;
    if (typeof invocation === "function") {
      exitCode = await invocation({
        ...commandContext,
        onReport: (report) => {
          cache = report;
        },
      });
    } else {
      const run = async () =>
        (await runCommand({ ...invocation, ...commandContext, cwd: context.root })).exitCode;
      exitCode = await (context.commandLane
        ? context.commandLane(commandContext.env, commandContext.signal, run)
        : run());
    }
    if (exitCode && !timeout.signal.aborted)
      failure = context.signal.aborted ? "cancelled" : `exit ${exitCode}`;
  } catch (error) {
    capture(message(error));
    failure = message(error);
  } finally {
    clearInterval(timer);
  }
  const elapsed = Math.round(performance.now() - started);
  const end = Date.now();
  const waits = queueWindows(readQueueEvents(budgetReport), timedOutAt ?? end);
  const queueMs = Math.min(
    elapsed,
    waits.reduce((total, [from, to]) => total + to - from, 0),
  );
  const runMs = elapsed - queueMs;
  const outcome = timeout.signal.aborted ? "TIMEOUT" : failure ? "FAIL" : "pass";
  const reason = timeout.signal.aborted
    ? `running-time limit ${duration(context.timeoutMs)}`
    : (failure ??
      (typeof invocation === "function" && context.cacheReport !== false && !cache
        ? "cache report unavailable"
        : undefined));
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
  return {
    name,
    outcome,
    runMs,
    queueMs,
    reason,
    cache,
    activity: { start: startedAt, end, waits },
  };
}

/** Limit background commands. Feedback starts immediately and Rust waits in its own lane. */
export async function runStepQueue(
  steps: readonly CheckStep[],
  concurrency: number,
  signal: AbortSignal,
  run: (step: ActiveStep, index: number) => Promise<StepResult>,
): Promise<readonly StepResult[]> {
  const local = new Set<Promise<StepResult>>();
  let rust = Promise.resolve<unknown>(undefined);
  const admit = async (step: CheckStep, index: number): Promise<StepResult> => {
    const { name } = step;
    const usesLocalSlot = step.kind === "command" && !step.resource;
    if (usesLocalSlot) {
      while (!signal.aborted && local.size >= concurrency) await Promise.race(local);
    }
    if (step.kind === "skip" || signal.aborted) {
      const reason = step.kind === "skip" ? step.reason : "run cancelled before admission";
      return { name, outcome: "skipped", reason, runMs: 0, queueMs: 0 };
    }
    const start = async () => run(step, index);
    const pending = start()
      .catch((error: unknown): StepResult => {
        const reason = message(error);
        write(`[check:changed] FAIL ${name} · ${reason}`);
        return { name, outcome: "FAIL", reason, runMs: 0, queueMs: 0 };
      })
      .finally(() => local.delete(pending));
    if (usesLocalSlot) local.add(pending);
    return pending;
  };
  return Promise.all(
    steps.map((step, index) => {
      if (step.lane !== "rust") return admit(step, index);
      const pending = rust.then(() => admit(step, index));
      rust = pending;
      return pending;
    }),
  );
}

export function validationLanes(semanticReady: Promise<void>) {
  let cargoReady = semanticReady;
  const cargo = <T>(env: NodeJS.ProcessEnv, signal: AbortSignal, run: () => Promise<T>) => {
    const previous = cargoReady;
    const turn = deferred();
    cargoReady = turn.promise;
    return runAfter(previous, "shared Cargo outputs", env, signal, run).finally(turn.resolve);
  };
  return {
    cargo,
    suite<T>(
      suite: SuiteId,
      env: NodeJS.ProcessEnv,
      signal: AbortSignal,
      run: () => Promise<T>,
      files?: readonly string[],
    ) {
      // Native suites and Rust gates can replace the same executables while tests launch them.
      if (nativeRequirements(suite, files).some(isNativeExecutable)) return cargo(env, signal, run);
      return runAfter(semanticReady, "semantic admission", env, signal, run);
    },
  };
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

async function runAfter<T>(
  ready: Promise<void>,
  label: string,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  const id = randomUUID();
  const report = (event: BudgetQueueEvent) => {
    const file = env[MACHINE_BUDGET_REPORT_ENV];
    if (file) appendFileSync(file, JSON.stringify(event) + "\n");
  };
  const requestedAt = Date.now();
  report({ id, label, requestedAt });
  await ready;
  const grantedAt = Date.now();
  report({ id, label, grantedAt, waitedMs: grantedAt - requestedAt });
  signal.throwIfAborted();
  return run();
}

async function planAffectedTests(
  root: string,
  workspace: ReadonlySet<string>,
  changed: readonly string[],
  present: ReadonlySet<string>,
  focused: Readonly<Partial<Record<SuiteId, readonly string[]>>>,
  signal: AbortSignal,
) {
  const bySuite = new Map<SuiteId, string[]>();
  for (const file of workspace) {
    if (!isTestFile(file)) continue;
    const owner = ownerOfTest(file);
    if (owner?.tier !== "default") continue;
    const files = bySuite.get(owner.suite) ?? [];
    files.push(file);
    bySuite.set(owner.suite, files);
  }

  const matches = changed.length
    ? (pass: Parameters<typeof observedChangedInput>[0]) =>
        observedChangedInput(pass, changed, present)
    : undefined;
  const tests = await Promise.all(
    APP_TEST_SUITES.map(async (suite) => {
      const files = bySuite.get(suite) ?? [];
      const focus = new Set(focused[suite]);
      if (suite === "browser") return [suite, selectFocusedBrowserTests(files, focus)] as const;
      const directory = cacheDirectory(root, process.env, suite);
      const candidates = [];
      // Retained passes can be large. Bound open files and discard each pass after matching.
      for (let index = 0; index < files.length; index += 16) {
        signal.throwIfAborted();
        candidates.push(
          ...(await Promise.all(
            files.slice(index, index + 16).map(async (file) => ({
              file,
              evidence: await readSelectionEvidence(directory, file, matches),
            })),
          )),
        );
      }
      return [suite, selectAffectedTests(candidates, focus)] as const;
    }),
  );
  return Object.fromEntries(tests);
}

function readRustChanges(root: string, files: readonly string[]) {
  const workspace = files.some(changesRustWorkspace);
  if (!workspace && !files.some((file) => file.startsWith("crates/"))) {
    return { touched: [], affected: new Set<string>() };
  }
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--locked", "--format-version", "1", "--no-deps"], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as CargoMetadata;
  const changed = workspace ? ["Cargo.toml"] : files;
  const buildMetadata = {
    ...metadata,
    packages: metadata.packages.map((pkg) => ({
      ...pkg,
      dependencies: pkg.dependencies.filter(({ kind }) => kind !== "dev"),
    })),
  };
  const memberDirectories = metadata.packages
    .filter(({ id }) => metadata.workspace_members.includes(id))
    .map(({ manifest_path }) =>
      path.relative(root, path.dirname(manifest_path)).split(path.sep).join("/"),
    );
  const buildInputs = workspace
    ? changed
    : changed.filter((file) =>
        memberDirectories.some((directory) => file.startsWith(directory + "/")),
      );
  return {
    touched: selectTouchedRustPackageNames(metadata, root, changed),
    affected: new Set(selectAffectedRustPackageNames(buildMetadata, root, buildInputs)),
  };
}

function prepareFastNativeTests(affected: ReadonlySet<string>): typeof prepareNativeArtifacts {
  return async (artifacts, context) => {
    const current = readPreparedNativeTests(context, artifacts.filter(isNativeExecutable));
    const remaining = artifacts.filter(
      (artifact) => !isNativeExecutable(artifact) || !current[artifact],
    );
    const stale = remaining
      .filter(isNativeExecutable)
      .find((artifact) => !affected.has(nativeArtifactPackage(artifact)));
    if (stale)
      throw new Error(
        `${stale} preparation changed while the check was queued. Rerun the fast check.`,
      );
    const built = await prepareNativeArtifacts(remaining, context);
    return { executables: { ...current, ...built.executables } };
  };
}

async function checkChanged(
  root: string,
  args: readonly string[],
  signal: AbortSignal,
): Promise<number> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const totalMs = () => Math.round(performance.now() - started);
  // A fresh install can replace node_modules while the first step is running.
  const generated = path.join(root, ".generated");
  mkdirSync(generated, { recursive: true });
  const staging = mkdtempSync(path.join(generated, "check-changed-"));
  const steps: StepResult[] = [];
  let digests: ReturnType<typeof stampDigests> | undefined;
  let comparison: ReturnType<typeof readChangedPaths> | undefined;
  let record: RunRecord | undefined;
  let fastTests: RunRecord["fastTests"];
  let prepare: typeof prepareNativeArtifacts | undefined;
  const createRecord = (): RunRecord => ({
    startedAt,
    worktree: root,
    base: comparison?.base ?? null,
    ref: comparison?.ref ?? null,
    pathCount: comparison?.files.length ?? 0,
    steps,
    fastTests,
    totalMs: totalMs(),
    idleQueueMs: idleQueueTime(steps),
  });
  try {
    const {
      ref: explicitRef,
      full,
      timeoutMs,
      suiteTimeoutMs,
    } = parseCheckArguments(args, process.env);
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
    write(
      `[check:changed] ${full ? "Full" : "Fast"} check · ${files.length} changed paths since ${base.slice(0, 12)} (${ref})`,
    );
    const present = files.filter((file) =>
      lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
    );
    const presentFiles = new Set(present);
    const focused = findFocusedTests(files, presentFiles, (directory) =>
      presentSiblings(root, directory),
    );
    const resultsRoot = path.dirname(path.dirname(cacheDirectory(root, process.env, "unit")));
    let workspace: ReturnType<typeof workspaceInputs> | undefined;
    const getWorkspace = () => (workspace ??= workspaceInputs(root, resultsRoot));
    const planRun = async () => {
      if (full) return planCheckSteps(files, present, focused);
      write("[check:changed] START test selection");
      const started = performance.now();
      const tests = await planAffectedTests(
        root,
        (await getWorkspace()).files,
        files,
        presentFiles,
        focused,
        signal,
      );
      const rust = readRustChanges(root, files);
      const selectedArtifacts = APP_TEST_SUITES.flatMap((suite) =>
        nativeRequirements(suite, tests[suite].files).filter(isNativeExecutable),
      );
      const current = readPreparedNativeTests(
        { repositoryRoot: root, env: testRuntimeEnvironment(process.env) },
        [...new Set(selectedArtifacts)],
      );
      const canRun = (artifact: NativeExecutableId) =>
        current[artifact] !== undefined || rust.affected.has(nativeArtifactPackage(artifact));
      for (const suite of APP_TEST_SUITES)
        tests[suite] = deferNativeTests(suite, tests[suite], canRun);
      prepare = prepareFastNativeTests(rust.affected);
      const runMs = Math.round(performance.now() - started);
      steps.push({ name: "test selection", outcome: "pass", runMs, queueMs: 0 });
      write(`[check:changed] pass test selection (run ${duration(runMs)}, queue 0.00s)`);
      fastTests = Object.fromEntries(
        Object.entries(tests).map(([suite, { files, ...counts }]) => [
          suite,
          { selected: files.length, ...counts },
        ]),
      );
      return planFastCheckSteps(files, present, tests, rust.touched);
    };
    const { steps: plan, rustEnv } = await planRun();
    const concurrency = validationConcurrency(availableParallelism(), totalmem());
    const semanticReady = deferred();
    const lanes = validationLanes(semanticReady.promise);
    steps.push(
      ...(await runStepQueue(plan, concurrency, signal, async (step, index) => {
        const name = String(index);
        if (step.kind === "cached") {
          return runStep(
            step.name,
            (stepContext) =>
              runCachedSuite(
                step.suite,
                [],
                {
                  ...stepContext,
                  env: { ...stepContext.env, NODEX_TEST_TIER: "default" },
                  repositoryRoot: root,
                  exactFiles: step.exactFiles,
                  prepare,
                  workspace: getWorkspace,
                  digests: () => (digests ??= stampDigests(digestCachePath(root, process.env))),
                  execute: (run) =>
                    lanes.suite(
                      step.suite,
                      stepContext.env,
                      stepContext.signal,
                      run,
                      step.exactFiles,
                    ),
                },
                step.priority,
              ),
            { ...context, timeoutMs: suiteTimeoutMs },
            name,
          );
        }
        if (step.kind === "browser") {
          return runStep(
            step.name,
            ({ env, signal, onStdout, onStderr }) =>
              lanes.suite("browser", env, signal, () =>
                runIsolatedTests(
                  { suites: ["browser"], tier: "default", related: false, args: [] },
                  { repositoryRoot: root, exactFiles: step.files, env, signal, onStdout, onStderr },
                ),
              ),
            { ...context, timeoutMs: suiteTimeoutMs, cacheReport: false },
            name,
          );
        }
        const semantic = step.resource === "semantic";
        const commandLane: StepContext["commandLane"] =
          step.resource === "rust-budget"
            ? (env, signal, run) => lanes.cargo(env, signal, run)
            : undefined;
        try {
          const input = path.join(staging, name + ".json");
          writeFileSync(input, JSON.stringify({ step, rustEnv } satisfies StepWork));
          return await runStep(
            step.name,
            {
              command: process.execPath,
              args: ["--import", "tsx", import.meta.filename, "--step", input],
            },
            { ...context, commandLane },
            name,
            semantic ? semanticReady.resolve : undefined,
          );
        } finally {
          // A task-cache hit, disabled machine budget, or startup error may have no grant.
          if (semantic) semanticReady.resolve();
        }
      })),
    );
    if (signal.aborted) return 130;
    if (steps.some(({ outcome }) => outcome === "FAIL" || outcome === "TIMEOUT")) return 1;

    return 0;
  } catch (error) {
    record = { ...createRecord(), error: message(error) };
    write(`[check:changed] ${record.error}`);
    return signal.aborted ? 130 : 1;
  } finally {
    await digests?.flush();
    record ??= createRecord();
    try {
      write(formatSummary(record));
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
