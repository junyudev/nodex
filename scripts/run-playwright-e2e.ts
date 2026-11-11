import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { acquireMachineBudget, machineBudgetCapacity } from "./tooling/machine-budget.ts";

/** One Playwright worker drives Electron's main, renderer and GPU processes plus Core. */
const ELECTRON_WORKER_WEIGHT = 3;

const PERFORMANCE_GREP =
  "keeps representative large-content surfaces bounded|keeps Page ready and idle CPU bounded with 14k LocalCommit history|measures high-pressure nested Block transfer into a populated Board|keeps production-scale Database context menus inside the interaction budget";

/** Deterministic product workflows shared by local runs and Nightly CI. */
export const NIGHTLY_E2E_SPECS = [
  "tests/e2e/electron-smoke.spec.ts",
  "tests/e2e/workbench-shell-navigation.spec.ts",
  "tests/e2e/web-content-layering.spec.ts",
  "tests/e2e/new-chat-lifecycle.spec.ts",
  "tests/e2e/scripted-agent-runtime.spec.ts",
  "tests/e2e/side-chat-context.spec.ts",
  "tests/e2e/subagents.spec.ts",
  "tests/e2e/page-files.spec.ts",
  "tests/e2e/library-files.spec.ts",
  "tests/e2e/nfm-editor-lifecycle.spec.ts",
  "tests/e2e/nfm-editor-history.spec.ts",
  "tests/e2e/database-settings.spec.ts",
  "tests/e2e/document-sync-recovery.spec.ts",
  "tests/e2e/document-recovery-review.spec.ts",
  "tests/e2e/inbox-capture.spec.ts",
  "tests/e2e/mobile-gateway.spec.ts",
  "tests/e2e/inbox-composer-layout.spec.ts",
  "tests/e2e/settings-authority.spec.ts",
  "tests/e2e/composer-search.spec.ts",
] as const;

const modes = {
  default: {
    scriptName: "test:e2e",
    config: "config/playwright.e2e.config.ts",
    fixedArguments: [],
    environment: {},
    exclusive: false,
  },
  nightly: {
    scriptName: "test:e2e:nightly",
    config: "config/playwright.e2e.config.ts",
    fixedArguments: [...NIGHTLY_E2E_SPECS, "--workers=1"],
    environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "0" },
    exclusive: false,
  },
  performance: {
    scriptName: "test:e2e:performance",
    config: "config/playwright.e2e.config.ts",
    fixedArguments: ["--grep", PERFORMANCE_GREP],
    environment: { NODEX_E2E_INCLUDE_PERFORMANCE: "1" },
    // Latency budgets are only meaningful when nothing else competes for the computer.
    exclusive: true,
  },
} as const;

type PlaywrightE2eMode = keyof typeof modes;

export interface PlaywrightE2eInvocation {
  readonly scriptName: string;
  readonly config: string;
  readonly fixedArguments: readonly string[];
  readonly additionalArguments: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly exclusive: boolean;
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

const runPlaywrightE2e = async (arguments_: readonly string[]): Promise<void> => {
  const invocation = resolvePlaywrightE2eInvocation(arguments_);
  // The claim also covers the builds, which keep every core busy before the first test starts.
  const capacity = machineBudgetCapacity(process.env);
  const lease = await acquireMachineBudget(
    {
      label: invocation.scriptName,
      weight: invocation.exclusive ? (capacity ?? 0) : ELECTRON_WORKER_WEIGHT,
    },
    { env: process.env, cwd: process.cwd(), capacity: capacity ?? undefined },
  );
  runCommand("vp", ["run", "core:binaries:build:dev"], lease.env);
  if (process.platform === "darwin") {
    runCommand("vp", ["run", "dictation-helper:build:dev"], lease.env);
  }
  runCommand("vp", ["run", "build"], lease.env);
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
    { ...invocation.environment, ...lease.env },
  );
  lease.release();
};

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
  void runPlaywrightE2e(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(String(error) + "\n");
    process.exit(1);
  });
}
