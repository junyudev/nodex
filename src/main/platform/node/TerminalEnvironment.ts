import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import { MainConfig } from "../../app/MainConfig";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import {
  DEFAULT_TERMINAL_SHELL_SETTINGS,
  type WindowsTerminalShell,
} from "../../../shared/terminal-shell-settings";
import {
  discoverWindowsTerminalShells,
  resolveWindowsTerminalShell,
  windowsAutomaticShellCandidates,
} from "./WindowsTerminalShells";
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
    readonly availableShells: Effect.Effect<readonly WindowsTerminalShell[]>;
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
  const { pwsh, powershell, cmd } = windowsAutomaticShellCandidates(environment);
  return [...pwsh, ...powershell, ...new Set(cmd)];
};

export const resolveTerminalCommand = (
  shell: string,
  platform: NodeJS.Platform,
): readonly [string, ...string[]] => {
  if (platform === "win32")
    return path.win32.basename(shell).toLowerCase() === "bash.exe"
      ? [shell, "--login", "-i"]
      : [shell];
  const basename = path.basename(shell).toLowerCase();
  if (basename === "bash") return [shell, "--login", "-i"];
  if (basename === "zsh" || basename === "fish") return [shell, "-l", "-i"];
  return [shell, "-i"];
};

export const buildTerminalEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string,
  shell?: string,
): Readonly<Record<string, string>> => {
  return mergeProcessEnvironments(
    platform,
    Object.fromEntries(
      Object.entries(childProcessEnvironment(environment, platform)).filter(
        ([name]) => platform === "win32" || (name !== "TERMINFO" && name !== "TERMINFO_DIRS"),
      ),
    ),
    { TERM: "xterm-256color" },
    platform === "win32" && shell && path.win32.basename(shell).toLowerCase() === "bash.exe"
      ? {
          CHERE_INVOKING: "1",
          MSYS2_PATH_TYPE: "inherit",
          // Git's login profile must capture the task PATH instead of reusing a parent shell's cache.
          ORIGINAL_PATH: undefined,
        }
      : {},
  );
};

export const live = Layer.effect(
  TerminalEnvironment,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const settings = yield* ApplicationSettings;
    const environment = buildTerminalEnvironment(config.environment, config.platform);
    return TerminalEnvironment.of({
      availableShells: Effect.sync(() =>
        config.platform === "win32"
          ? discoverWindowsTerminalShells(environment, config.homeDirectory).map(
              (shell) => shell.id,
            )
          : [],
      ),
      resolve: (input) =>
        Effect.gen(function* () {
          const preference =
            config.platform === "win32"
              ? yield* settings.snapshot().pipe(
                  Effect.map((snapshot) => snapshot.terminalShell),
                  Effect.catch(() =>
                    Effect.logWarning(
                      "Could not read terminal shell preference; using Automatic",
                    ).pipe(Effect.as(DEFAULT_TERMINAL_SHELL_SETTINGS)),
                  ),
                )
              : DEFAULT_TERMINAL_SHELL_SETTINGS;
          const shell =
            config.platform === "win32"
              ? resolveWindowsTerminalShell(
                  environment,
                  config.homeDirectory,
                  preference.windowsShell,
                )
              : terminalShellCandidates(config.platform, environment)[0]!;
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
            env: buildTerminalEnvironment(environment, config.platform, shell),
            cols: Math.max(2, Math.floor(size.cols)),
            rows: Math.max(1, Math.floor(size.rows)),
          } satisfies TerminalRuntimeConfig;
        }),
    });
  }),
);
