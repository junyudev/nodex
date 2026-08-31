import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PERFORMANCE_GREP =
  "keeps representative large-content surfaces bounded|keeps Page ready and idle CPU bounded with 14k LocalCommit history|measures high-pressure nested Block transfer into a populated Board|keeps production-scale Database context menus inside the interaction budget";

const modes = {
  default: {
    scriptName: "test:e2e",
    config: "playwright.e2e.config.ts",
    fixedArguments: [],
    environment: {},
  },
  performance: {
    scriptName: "test:e2e:performance",
    config: "playwright.e2e.config.ts",
    fixedArguments: ["--grep", PERFORMANCE_GREP],
    environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "1" },
  },
} as const;

type PlaywrightE2eMode = keyof typeof modes;

export interface PlaywrightE2eInvocation {
  readonly scriptName: string;
  readonly config: string;
  readonly fixedArguments: readonly string[];
  readonly additionalArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}

const isPlaywrightE2eMode = (value: string): value is PlaywrightE2eMode =>
  Object.hasOwn(modes, value);

/** Validate Vite+ forwarded arguments before any expensive E2E preparation starts. */
export const resolvePlaywrightE2eInvocation = (
  arguments_: readonly string[],
): PlaywrightE2eInvocation => {
  const [rawMode, ...additionalArguments] = arguments_;
  if (!rawMode || !isPlaywrightE2eMode(rawMode)) {
    throw new Error(`Unsupported Playwright E2E mode: ${JSON.stringify(rawMode)}.`);
  }
  const mode = modes[rawMode];
  if (additionalArguments.includes("--")) {
    throw new Error(
      `Do not pass a standalone \`--\` to \`vp run ${mode.scriptName}\`. ` +
        `Use: vp run ${mode.scriptName} tests/e2e/<spec>.spec.ts`,
    );
  }
  return {
    ...mode,
    additionalArguments,
  };
};

const runCommand = (
  command: string,
  arguments_: readonly string[],
  environment: Readonly<Record<string, string>> = {},
): void => {
  const result = spawnSync(command, arguments_, {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status === 0) return;
  process.exit(result.status ?? 1);
};

const runPlaywrightE2e = (arguments_: readonly string[]): void => {
  const invocation = resolvePlaywrightE2eInvocation(arguments_);
  runCommand("vp", ["run", "core:binaries:build:dev"]);
  runCommand("vp", ["run", "build"]);
  runCommand(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      invocation.config,
      ...invocation.fixedArguments,
      ...invocation.additionalArguments,
    ],
    invocation.environment,
  );
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  runPlaywrightE2e(process.argv.slice(2));
}
