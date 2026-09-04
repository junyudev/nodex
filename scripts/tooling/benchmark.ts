import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTimedCommand, type TimedCommandRecord } from "../ci/run-timed";
import { withCommandSignal } from "./process";
import { compareBenchmarks } from "./compare-benchmarks";

const scenarios = [
  "static-cache-hit",
  "semantic-execute",
  "renderer-cohort",
  "tests-warm",
  "tests-cold-native",
] as const;
type Scenario = (typeof scenarios)[number];

export const rendererCohort = [
  "src/renderer/components/workbench/workbench-shell.layout-panel-actions.test.tsx",
  "src/renderer/components/workbench/workbench-shell.pages-shell-navigation.test.tsx",
  "src/renderer/components/workbench/review-diff-panel.test.tsx",
  "src/renderer/components/workbench/workbench-shell.sidebar-core.test.tsx",
  "src/renderer/components/workbench/workbench-shell.automations-conversation.test.tsx",
  "src/renderer/components/workbench/workbench-shell.panel-commands.test.tsx",
  "src/renderer/components/board/canvas-view.test.tsx",
  "src/renderer/features/local-conversation/view/connected-thread-stage.test.tsx",
  "src/renderer/components/board/editor/copy-image-button.test.tsx",
  "src/renderer/components/ui/tooltip.test.tsx",
] as const;

export interface BenchmarkOptions {
  readonly scenario: Scenario;
  readonly label: string;
  readonly samples: number;
  readonly workers?: number;
}

export function parseBenchmarkArguments(args: readonly string[]): BenchmarkOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      !["--scenario", "--label", "--samples", "--workers"].includes(name) ||
      !value ||
      value.startsWith("--")
    ) {
      throw new Error(
        "Expected --scenario <name>, --label <name>, --samples <count>, or --workers <count>.",
      );
    }
    if (values.has(name)) throw new Error("Duplicate benchmark option: " + name);
    values.set(name, value);
  }
  const scenario = values.get("--scenario");
  if (!scenarios.includes(scenario as Scenario))
    throw new Error("Unknown benchmark scenario: " + scenario);
  const samples = Number(values.get("--samples") ?? 1);
  const workers = values.has("--workers") ? Number(values.get("--workers")) : undefined;
  if (!Number.isInteger(samples) || samples < 1 || samples > 10)
    throw new Error("Samples must be an integer from 1 to 10.");
  if (
    workers !== undefined &&
    (!Number.isInteger(workers) || workers < 1 || workers > 32 || scenario !== "renderer-cohort")
  ) {
    throw new Error("Workers must be an integer from 1 to 32, used only with renderer-cohort.");
  }
  const label = values.get("--label") ?? "local";
  if (!/^[a-zA-Z0-9_-]+$/u.test(label))
    throw new Error("Label must contain only letters, numbers, hyphens, or underscores.");
  return { scenario: scenario as Scenario, label, samples, workers };
}

export function benchmarkCommand(options: BenchmarkOptions): readonly string[] {
  switch (options.scenario) {
    case "static-cache-hit":
      return ["run", "typecheck"];
    case "semantic-execute":
      return ["check", "--no-fmt"];
    case "renderer-cohort":
      return [
        "test",
        "run",
        "--config",
        "vitest.renderer.config.ts",
        ...(options.workers ? ["--maxWorkers", String(options.workers)] : []),
        ...rendererCohort,
      ];
    case "tests-warm":
    case "tests-cold-native":
      return ["run", "test"];
  }
}

function summarize(records: readonly TimedCommandRecord[]) {
  const times = records.map((record) => record.durationMs).sort((a, b) => a - b);
  if (times.length === 0) return null;
  const middle = Math.floor(times.length / 2);
  return {
    passed: records.every((record) => record.exitCode === 0),
    samples: times.length,
    minMs: times[0],
    medianMs: times.length % 2 ? times[middle] : (times[middle - 1] + times[middle]) / 2,
    maxMs: times[times.length - 1],
  };
}

export async function benchmark(options: BenchmarkOptions, signal: AbortSignal): Promise<number> {
  const root = path.resolve(import.meta.dirname, "../..");
  const base = path.join(root, "notes.local/tooling-performance");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, options.label + "-" + options.scenario + "-"));
  const command = process.platform === "win32" ? "vp.cmd" : "vp";
  const records: TimedCommandRecord[] = [];
  const diff = execFileSync("git", ["diff", "HEAD", "--binary"], { cwd: root, encoding: "utf8" });
  const fingerprint = createHash("sha256").update(diff);
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .sort();
  for (const file of untracked)
    fingerprint.update(file).update(await readFile(path.join(root, file)));
  const metadata = {
    version: 2,
    changesSha256: fingerprint.digest("hex"),
    dependencyLockSha256: createHash("sha256")
      .update(await readFile(path.join(root, "pnpm-lock.yaml")))
      .digest("hex"),
    options,
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      cpus: os.cpus().length,
      cpuModel: os.cpus()[0]?.model,
      availableParallelism: os.availableParallelism(),
      loadAverage: os.loadavg(),
      freeMemoryBytes: os.freemem(),
      memoryBytes: os.totalmem(),
    },
    versions: {
      node: process.versions.node,
      vitePlus: execFileSync(command, ["--version"], { cwd: root, encoding: "utf8" }).trim(),
      typescript: execFileSync(command, ["exec", "tsc", "--version"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
    },
    command: [command, ...benchmarkCommand(options)],
    rendererCohort: options.scenario === "renderer-cohort" ? rendererCohort : undefined,
  };
  await writeFile(path.join(directory, "metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
  if (options.scenario === "static-cache-hit") {
    const priming = await runTimedCommand({
      name: "cache-prime",
      command,
      commandArguments: benchmarkCommand(options),
      cwd: root,
      signal,
      logFile: path.join(directory, "prime.log"),
      timingDirectory: directory,
    });
    if (priming.exitCode !== 0) return priming.exitCode;
  }
  for (let sample = 1; sample <= options.samples; sample += 1) {
    if (signal.aborted) return 130;
    const sampleDirectory = path.join(directory, String(sample));
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODEX_TEST_TIER: "default",
      NODEX_TEST_TIMINGS: sampleDirectory,
    };
    if (options.scenario === "tests-cold-native") {
      const nativeRoot = path.join(root, ".generated");
      await mkdir(nativeRoot, { recursive: true });
      environment.CARGO_TARGET_DIR = await mkdtemp(path.join(nativeRoot, "tooling-native-"));
    }
    await mkdir(sampleDirectory, { recursive: true });
    await writeFile(
      path.join(sampleDirectory, "environment.json"),
      JSON.stringify(
        {
          startedAt: new Date().toISOString(),
          loadAverage: os.loadavg(),
          freeMemoryBytes: os.freemem(),
          cargoTargetDirectory: environment.CARGO_TARGET_DIR ?? null,
        },
        null,
        2,
      ) + "\n",
    );
    const record = await runTimedCommand({
      name: options.scenario + "-" + sample,
      measureResources: true,
      command,
      commandArguments: benchmarkCommand(options),
      cwd: root,
      env: environment,
      signal,
      logFile: path.join(sampleDirectory, "command.log"),
      timingDirectory: sampleDirectory,
    });
    records.push(record);
    await writeFile(
      path.join(directory, "summary.json"),
      JSON.stringify(
        {
          ...summarize(records),
          records,
          artifacts: await readdir(directory),
        },
        null,
        2,
      ) + "\n",
    );
    process.stdout.write("Benchmark evidence: " + directory + "\n");
    if (record.exitCode !== 0) return record.exitCode;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  withCommandSignal(async (signal) => {
    const args = process.argv.slice(2);
    if (args[0] !== "--compare") return benchmark(parseBenchmarkArguments(args), signal);
    if (args.length !== 3)
      throw new Error("Expected --compare <before-directory> <after-directory>.");
    await compareBenchmarks(args[1], args[2]);
    return 0;
  }).catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  });
}
