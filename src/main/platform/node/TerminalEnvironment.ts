import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import fs from "node:fs";
import os from "node:os";
import { MainConfig } from "../../app/MainConfig";
import {
  applyCodexWorktreeShellEnvironment,
  type CodexStoredShellEnvironment,
} from "../../codex/codex-worktree-shell-environment";
import {
  desktopToolHostBindingNames,
  withoutDesktopToolHostBindings,
} from "../../codex/desktop-tool-environment";
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

const TERMINAL_TYPE = "xterm-256color";

const accountShell = (): string | null => {
  try {
    return os.userInfo().shell || null;
  } catch {
    return null;
  }
};

export const terminalShellCandidates = (
  platform: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] => {
  if (platform !== "win32")
    return [
      accountShell() || environment.SHELL || (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
    ];
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
  return [shell];
};

const shellProbeVariables = {
  CODEX_SHELL: undefined,
  DISABLE_AUTO_UPDATE: undefined,
  ZSH_TMUX_AUTOSTART: undefined,
  ZSH_TMUX_AUTOSTARTED: undefined,
};

/**
 * A terminal describes itself. Nodex can be launched from another terminal or from an Agent's tool
 * shell, and these variables describe that launcher rather than this terminal or its user: an
 * Agent's `NO_COLOR=1` alone would strip every colour from full-screen programs here. They are
 * removed before the login shell probe, so startup files that set one of them still win.
 */
const terminalLaunchRemovals = {
  // Colour policy of the launcher.
  NO_COLOR: undefined,
  FORCE_COLOR: undefined,
  CLICOLOR_FORCE: undefined,
  COLORTERM: undefined,
  // Identity and dimensions of the launcher's terminal.
  TERM_PROGRAM: undefined,
  TERM_PROGRAM_VERSION: undefined,
  TERM_SESSION_ID: undefined,
  TERMCAP: undefined,
  COLUMNS: undefined,
  LINES: undefined,
  // Multiplexer membership of the launcher.
  TMUX: undefined,
  TMUX_PANE: undefined,
  STY: undefined,
  WINDOW: undefined,
  WINDOWID: undefined,
  // Non-interactive tool shell and login probe settings.
  PAGER: undefined,
  GIT_PAGER: undefined,
  GH_PAGER: undefined,
  AGENT: undefined,
  ...shellProbeVariables,
  // Identity of the Agent run that launched Nodex.
  CODEX_CI: undefined,
  CODEX_THREAD_ID: undefined,
  CODEX_SESSION_ID: undefined,
  CODEX_TOOL_CALL_ID: undefined,
  CODEX_PERMISSION_PROFILE: undefined,
  CODEX_INTERNAL_ORIGINATOR_OVERRIDE: undefined,
  CLAUDECODE: undefined,
};

const terminalLaunchEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string,
): Record<string, string> => {
  const launch = withoutDesktopToolHostBindings(
    // Startup files branch on TERM, so the login probe must see the terminal it is configuring.
    mergeProcessEnvironments(platform, environment, terminalLaunchRemovals, {
      TERM: TERMINAL_TYPE,
    }),
  );
  if (platform !== "win32") return launch;
  const normalized = Object.fromEntries(
    Object.entries(launch).map(([key, value]) => [key.toUpperCase(), value]),
  );
  const bindings = Object.fromEntries(
    desktopToolHostBindingNames(normalized).map((key) => [key, undefined]),
  );
  return mergeProcessEnvironments(platform, launch, bindings);
};

interface TerminalEnvironmentLayers {
  readonly login?: Readonly<NodeJS.ProcessEnv>;
  readonly worktree?: CodexStoredShellEnvironment | null;
}

export const buildTerminalEnvironment = (
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: string,
  shell?: string,
  layers: TerminalEnvironmentLayers = {},
): Readonly<Record<string, string>> => {
  const base = mergeProcessEnvironments(
    platform,
    terminalLaunchEnvironment(environment, platform),
    layers.login ?? {},
  );
  const worktree = applyCodexWorktreeShellEnvironment(base, layers.worktree, platform);
  return childProcessEnvironment(
    mergeProcessEnvironments(
      platform,
      worktree,
      { TERM: TERMINAL_TYPE },
      platform === "win32" ? {} : { TERMINFO: undefined, TERMINFO_DIRS: undefined },
      platform === "win32" && shell && path.win32.basename(shell).toLowerCase() === "bash.exe"
        ? {
            CHERE_INVOKING: "1",
            MSYS2_PATH_TYPE: "inherit",
            // Git's login profile must capture the task PATH instead of reusing a parent shell's cache.
            ORIGINAL_PATH: undefined,
          }
        : {},
    ),
    platform,
  );
};

interface TerminalEnvironmentDiscovery {
  readonly login: (
    base: Readonly<NodeJS.ProcessEnv>,
    platform: NodeJS.Platform,
  ) => Effect.Effect<NodeJS.ProcessEnv, unknown>;
  readonly worktree: (
    cwd: string,
    base: Readonly<NodeJS.ProcessEnv>,
  ) => Effect.Effect<CodexStoredShellEnvironment | null, unknown>;
}

export const live = (discovery: TerminalEnvironmentDiscovery) =>
  Layer.effect(
    TerminalEnvironment,
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const settings = yield* ApplicationSettings;
      const platform = config.platform as NodeJS.Platform;
      const base = terminalLaunchEnvironment(config.environment, platform);
      const windowsEnvironment = buildTerminalEnvironment(base, platform);
      const posixShell = platform === "win32" ? null : terminalShellCandidates(platform, base)[0]!;
      const login =
        platform === "win32"
          ? null
          : yield* discovery.login(base, platform).pipe(
              Effect.timeout("5 seconds"),
              // Settings injected for the probe itself should never become PTY defaults.
              Effect.map((environment) =>
                mergeProcessEnvironments(platform, environment, shellProbeVariables),
              ),
              Effect.catch((error) =>
                Effect.logWarning(
                  "Could not load the terminal login shell environment",
                  error,
                ).pipe(Effect.as(base)),
              ),
              Effect.forkScoped,
            );
      return TerminalEnvironment.of({
        availableShells: Effect.sync(() =>
          platform === "win32"
            ? discoverWindowsTerminalShells(windowsEnvironment, config.homeDirectory).map(
                (shell) => shell.id,
              )
            : [],
        ),
        resolve: (input) =>
          Effect.gen(function* () {
            const preference =
              platform === "win32"
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
              posixShell ??
              resolveWindowsTerminalShell(
                windowsEnvironment,
                config.homeDirectory,
                preference.windowsShell,
              );
            const [command, ...args] = resolveTerminalCommand(shell, platform);
            const cwd = resolveCwd(input.cwd, config.homeDirectory);
            const loginEnvironment = login ? yield* Fiber.join(login) : undefined;
            const worktree = loginEnvironment
              ? yield* discovery
                  .worktree(cwd, loginEnvironment)
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning(
                        "Could not load the terminal worktree environment",
                        error,
                      ).pipe(Effect.as(null)),
                    ),
                  )
              : null;
            const size = input.size ?? { cols: 80, rows: 24 };
            return {
              sessionId: input.sessionId,
              conversationId: input.conversationId ?? null,
              projectSessionId: input.projectSessionId ?? null,
              title: input.title ?? null,
              command,
              args,
              cwd,
              env: buildTerminalEnvironment(base, platform, shell, {
                login: loginEnvironment,
                worktree,
              }),
              cols: Math.max(1, Math.floor(size.cols)),
              rows: Math.max(1, Math.floor(size.rows)),
            } satisfies TerminalRuntimeConfig;
          }),
      });
    }),
  );
