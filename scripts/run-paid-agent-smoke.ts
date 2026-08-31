import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  PAID_AGENT_SMOKE_DEFINITIONS,
  requirePaidAgentSmokeCase,
  type PaidAgentSmokeCase,
} from "./paid-agent-smoke-contract";

export interface PaidAgentSmokeInvocation {
  readonly caseId: PaidAgentSmokeCase;
  readonly artifactRoot: string;
  readonly sourceAuthPath: string;
  readonly sourceCodexHome: string;
}

const parseCaseArgument = (arguments_: readonly string[]): PaidAgentSmokeCase => {
  if (arguments_.includes("--")) {
    throw new Error(
      "Do not pass a standalone `--`. Use: vp run agent:smoke:paid --case file|browser|subagent",
    );
  }
  if (arguments_.length !== 2 || arguments_[0] !== "--case") {
    throw new Error(
      "Paid Agent smoke requires exactly one case: vp run agent:smoke:paid --case file|browser|subagent",
    );
  }
  return requirePaidAgentSmokeCase(arguments_[1]);
};

const artifactTimestamp = (now: Date): string =>
  now
    .toISOString()
    .replaceAll(/[-:]/gu, "")
    .replace(/\.(\d{3})Z$/u, "$1Z");

export const resolvePaidAgentSmokeInvocation = (
  arguments_: readonly string[],
  input: {
    readonly cwd?: string;
    readonly codexHome?: string;
    readonly homeDirectory?: string;
    readonly now?: Date;
  } = {},
): PaidAgentSmokeInvocation => {
  const caseId = parseCaseArgument(arguments_);
  const cwd = path.resolve(input.cwd ?? process.cwd());
  const configuredCodexHome = input.codexHome ?? process.env.CODEX_HOME;
  const sourceCodexHome = path.resolve(
    configuredCodexHome?.trim() || path.join(input.homeDirectory ?? os.homedir(), ".codex"),
  );
  const authPath = path.join(sourceCodexHome, "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`Paid Agent smoke requires Codex authentication at ${authPath}.`);
  }
  const authStats = statSync(realpathSync(authPath));
  if (!authStats.isFile()) {
    throw new Error(`Paid Agent smoke authentication must be a regular file: ${authPath}.`);
  }
  return {
    caseId,
    artifactRoot: path.join(
      cwd,
      "runs.local",
      "paid-agent-smoke",
      `${artifactTimestamp(input.now ?? new Date())}-${caseId}`,
    ),
    sourceAuthPath: authPath,
    sourceCodexHome,
  };
};

export const formatPaidAgentSmokeBanner = (invocation: PaidAgentSmokeInvocation): string => {
  const definition = PAID_AGENT_SMOKE_DEFINITIONS[invocation.caseId];
  return [
    "Paid Agent smoke authorized by explicit command.",
    `Case: ${definition.id}`,
    `Execution profile: ${definition.modelId} / ${definition.reasoningEffort}`,
    `Expected logical Agent executions: ${definition.expectedLogicalExecutions}`,
    `Authentication source: ${invocation.sourceAuthPath}`,
    `Artifacts: ${invocation.artifactRoot}`,
    "",
  ].join("\n");
};

const runCommand = (
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): void => {
  const result = spawnSync(command, [...arguments_], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  process.exit(result.status ?? 1);
};

const runPaidAgentSmoke = (arguments_: readonly string[]): void => {
  if (process.env.CI) {
    throw new Error("Paid Agent smoke is local-only and must never run in CI.");
  }
  if (process.platform !== "darwin") {
    throw new Error("Paid Agent smoke currently requires the staged macOS Agent runtime.");
  }

  // The explicit `paid` command is the quota authorization. Argument and auth
  // validation happen before runtime staging or application builds.
  const invocation = resolvePaidAgentSmokeInvocation(arguments_);
  const definition = PAID_AGENT_SMOKE_DEFINITIONS[invocation.caseId];
  mkdirSync(invocation.artifactRoot, { recursive: true });
  process.stdout.write(formatPaidAgentSmokeBanner(invocation));

  runCommand("vp", ["run", "stage:codex-runtime:mac:cached"]);
  runCommand("vp", ["run", "core:binaries:build:dev"]);
  runCommand("vp", ["run", "build"]);
  runCommand(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.paid-agent-smoke.config.ts",
      "--grep",
      definition.grep,
      "--output",
      invocation.artifactRoot,
    ],
    {
      NODEX_PAID_AGENT_SMOKE_CASE: invocation.caseId,
      NODEX_PAID_AGENT_SMOKE_SOURCE_CODEX_HOME: invocation.sourceCodexHome,
    },
  );
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  runPaidAgentSmoke(process.argv.slice(2));
}
