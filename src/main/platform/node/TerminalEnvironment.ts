import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import { MainConfig } from "../../app/MainConfig";
import { claudeExecutableCandidates, claudeHostEnvironmentValue } from "./ClaudeExecutable";
import path from "node:path";
import type { TerminalSize } from "../../../shared/types";
import type { TerminalRuntimeConfig } from "../../terminal-runtime/TerminalRuntimeMap";
import { childProcessEnvironment, mergeProcessEnvironments } from "./child-process-environment";

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
    ...["ProgramW6432", "ProgramFiles", "LOCALAPPDATA"].flatMap((name) => {
      const directory = claudeHostEnvironmentValue(environment, name, platform);
      if (!directory) return [];
      return [
        path.win32.join(
          directory,
          ...(name === "LOCALAPPDATA" ? ["Microsoft", "PowerShell"] : ["PowerShell", "7"]),
          "pwsh.exe",
        ),
      ];
    }),
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

export const buildTerminalEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string,
): Readonly<Record<string, string>> => {
  return mergeProcessEnvironments(
    platform,
    Object.fromEntries(
      Object.entries(childProcessEnvironment(environment, platform)).filter(
        ([name]) => platform === "win32" || (name !== "TERMINFO" && name !== "TERMINFO_DIRS"),
      ),
    ),
    { TERM: "xterm-256color" },
  );
};

export const live = Layer.effect(
  TerminalEnvironment,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return TerminalEnvironment.of({
      resolve: (input) =>
        Effect.sync(() => {
          const environment = buildTerminalEnvironment(config.environment, config.platform);
          const shell = resolveShell(config.platform, environment, config.homeDirectory);
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
            env: environment,
            cols: Math.max(2, Math.floor(size.cols)),
            rows: Math.max(1, Math.floor(size.rows)),
          } satisfies TerminalRuntimeConfig;
        }),
    });
  }),
);
