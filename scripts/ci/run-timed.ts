import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand, withCommandSignal, type CommandResult } from "../tooling/process";

export interface TimedCommandArguments {
  readonly name: string;
  readonly command: string;
  readonly commandArguments: readonly string[];
}

export interface TimedCommandRecord {
  readonly attempt: number | null;
  readonly job: string | null;
  readonly name: string;
  readonly runId: string | null;
  readonly sha: string | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly resources?: CommandResult["resources"];
  readonly exitCode: number;
}

export interface RunTimedOptions {
  readonly name: string;
  readonly command: string;
  readonly commandArguments: readonly string[];
  readonly timingDirectory?: string;
  readonly summaryPath?: string;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
  readonly logFile?: string;
  readonly onStdout?: (chunk: string) => void;
  readonly measureResources?: boolean;
}

const readOption = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value === "--") throw new Error(`Missing value for ${name}.`);
  return value;
};

export const parseRunTimedArguments = (args: readonly string[]): TimedCommandArguments => {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new Error("Usage: run-timed --name <name> -- <command> [args...].");
  }
  const name = readOption(args.slice(0, separator), "--name");
  const command = args[separator + 1];
  if (!name || !command) {
    throw new Error("Usage: run-timed --name <name> -- <command> [args...].");
  }
  return {
    name,
    command,
    commandArguments: args.slice(separator + 2),
  };
};

const sanitizeJobName = (value: string): string => {
  const sanitized = value.replaceAll(/[^a-zA-Z0-9._-]+/gu, "-");
  return sanitized || "local";
};

const formatDuration = (durationMs: number): string => {
  const seconds = durationMs / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
};

const escapeSummaryCell = (value: string): string => value.replaceAll("|", "\\|");

const optionalText = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const optionalPositiveInteger = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const appendSummary = async (
  summaryPath: string | undefined,
  record: TimedCommandRecord,
): Promise<void> => {
  if (!summaryPath) return;
  let existing = "";
  try {
    existing = await readFile(summaryPath, "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const header = existing.includes("## CI timings")
    ? ""
    : "## CI timings\n\n| Step | Duration | Exit code |\n| --- | ---: | ---: |\n";
  await appendFile(
    summaryPath,
    `${header}| ${escapeSummaryCell(record.name)} | ${formatDuration(record.durationMs)} | ${record.exitCode} |\n`,
    "utf8",
  );
};

export const runTimedCommand = async (options: RunTimedOptions): Promise<TimedCommandRecord> => {
  if (!options.name.trim()) throw new Error("Timed command name must not be empty.");
  const now = options.now ?? (() => new Date());
  const started = now();
  const result = await runCommand({ ...options, args: options.commandArguments });
  const finished = now();
  const environment = options.env ?? process.env;
  const record: TimedCommandRecord = {
    attempt: optionalPositiveInteger(environment.GITHUB_RUN_ATTEMPT),
    job: optionalText(environment.CI_TIMING_JOB ?? environment.GITHUB_JOB),
    name: options.name,
    runId: optionalText(environment.GITHUB_RUN_ID),
    sha: optionalText(environment.CI_SOURCE_SHA ?? environment.GITHUB_SHA),
    startedAt: started.toISOString(),
    finishedAt: finished.toISOString(),
    durationMs: result.durationMs,
    ...(result.resources ? { resources: result.resources } : {}),
    exitCode: result.exitCode,
  };
  const timingDirectory =
    options.timingDirectory ?? path.resolve(process.cwd(), ".generated/ci-timings");
  await mkdir(timingDirectory, { recursive: true });
  const jobName = sanitizeJobName(environment.CI_TIMING_JOB ?? environment.GITHUB_JOB ?? "local");
  await appendFile(
    path.join(timingDirectory, `${jobName}.jsonl`),
    `${JSON.stringify(record)}\n`,
    "utf8",
  );
  await appendSummary(options.summaryPath ?? environment.GITHUB_STEP_SUMMARY, record);
  return record;
};

const main = async (signal: AbortSignal): Promise<number> => {
  const parsed = parseRunTimedArguments(process.argv.slice(2));
  const record = await runTimedCommand({
    signal,
    name: parsed.name,
    command: parsed.command,
    commandArguments: parsed.commandArguments,
  });
  return record.exitCode;
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  withCommandSignal(main).catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
