import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import { MainConfig } from "../../app/MainConfig";
import { claudeExecutableCandidates, claudeHostEnvironmentValue } from "./ClaudeExecutable";
import path from "node:path";
import type { TerminalSize } from "../../../shared/types";
import type { TerminalRuntimeConfig } from "../../terminal-runtime/TerminalRuntimeMap";

export interface TerminalEnvironmentInput {
  readonly sessionId: string;
  readonly conversationId?: string | null;
  readonly projectSessionId?: string | null;
  readonly cwd?: string | null;
  readonly size?: TerminalSize | null;
  readonly title?: string | null;
}

export class TerminalEnvironment extends Context.Service<
  TerminalEnvironment,
  {
    readonly resolve: (input: TerminalEnvironmentInput) => Effect.Effect<TerminalRuntimeConfig>;
  }
>()("nodex/main/platform/node/TerminalEnvironment") {}

const directoryExists = (pathname: string): boolean => {
  try {
    return fs.statSync(pathname).isDirectory();
  } catch {
    return false;
  }
};

const resolveCwd = (requested: string | null | undefined, home: string): string => {
  const trimmed = requested?.trim();
  if (trimmed && directoryExists(trimmed)) return trimmed;
  if (home && directoryExists(home)) return home;
  return home;
};

export const terminalShellCandidates = (
  platform: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] => {
  if (platform !== "win32")
    return [environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh")];
  const root = claudeHostEnvironmentValue(environment, "SystemRoot", platform);
  return [
    "pwsh.exe",
    ...(root
      ? [path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]
      : []),
    "powershell.exe",
    claudeHostEnvironmentValue(environment, "COMSPEC", platform) || "cmd.exe",
  ];
};

const resolveShell = (
  platform: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
): string => {
  const candidates = terminalShellCandidates(platform, environment);
  if (platform !== "win32") return candidates[0]!;
  for (const shell of candidates) {
    const found = claudeExecutableCandidates(shell, environment, platform, home).find(
      (candidate) => {
        try {
          return fs.statSync(candidate).isFile();
        } catch {
          return false;
        }
      },
    );
    if (found) return found;
  }
  return candidates.at(-1)!;
};

export const resolveTerminalCommand = (
  shell: string,
  platform: NodeJS.Platform,
): readonly [string, ...string[]] => {
  if (platform === "win32") return [shell];
  const basename = path.basename(shell).toLowerCase();
  if (basename === "bash") return [shell, "--login", "-i"];
  if (basename === "zsh" || basename === "fish") return [shell, "-l", "-i"];
  return [shell, "-i"];
};

const buildEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string,
): Readonly<Record<string, string>> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  if (platform !== "win32") {
    delete env.TERMINFO;
    delete env.TERMINFO_DIRS;
  }
  return env;
};

export const live = Layer.effect(
  TerminalEnvironment,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return TerminalEnvironment.of({
      resolve: (input) =>
        Effect.gen(function* () {
          const shell = resolveShell(config.platform, config.environment, config.homeDirectory);
          const [command, ...args] = resolveTerminalCommand(
            shell,
            config.platform as NodeJS.Platform,
          );
          const size = input.size ?? { cols: 80, rows: 24 };
          return {
            sessionId: input.sessionId,
            conversationId: input.conversationId ?? null,
            projectSessionId: input.projectSessionId ?? null,
            title: input.title ?? null,
            command,
            args,
            cwd: resolveCwd(input.cwd, config.homeDirectory),
            env: buildEnvironment(config.environment, config.platform),
            cols: Math.max(2, Math.floor(size.cols)),
            rows: Math.max(1, Math.floor(size.rows)),
          } satisfies TerminalRuntimeConfig;
        }),
    });
  }),
);
