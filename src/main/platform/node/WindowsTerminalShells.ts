import fs from "node:fs";
import { win32 as path } from "node:path";
import type {
  TerminalShellSettings,
  WindowsTerminalShell,
} from "../../../shared/terminal-shell-settings";
import { claudeExecutableCandidates, claudeHostEnvironmentValue } from "./ClaudeExecutable";

export interface DiscoveredWindowsTerminalShell {
  readonly id: WindowsTerminalShell;
  readonly command: string;
}

export const terminalShellFileExists = (pathname: string): boolean => {
  try {
    return fs.statSync(pathname).isFile();
  } catch {
    return false;
  }
};

const environmentValue = (environment: Readonly<NodeJS.ProcessEnv>, name: string) =>
  claudeHostEnvironmentValue(environment, name, "win32")?.trim() || undefined;

export const windowsAutomaticShellCandidates = (environment: Readonly<NodeJS.ProcessEnv>) => {
  const root = environmentValue(environment, "SystemRoot");
  return {
    pwsh: [
      "pwsh.exe",
      ...["ProgramW6432", "ProgramFiles", "LOCALAPPDATA"].flatMap((name) => {
        const directory = environmentValue(environment, name);
        if (!directory) return [];
        return [
          path.join(
            directory,
            ...(name === "LOCALAPPDATA" ? ["Microsoft", "PowerShell"] : ["PowerShell", "7"]),
            "pwsh.exe",
          ),
        ];
      }),
    ],
    powershell: [
      ...(root ? [path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")] : []),
      "powershell.exe",
    ],
    cmd: [environmentValue(environment, "COMSPEC") || "cmd.exe", "cmd.exe"],
  };
};

/** Discover Git's console wrapper, never its GUI launcher or Windows' WSL bash.exe. */
export function discoverWindowsTerminalShells(
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
  isFile: (pathname: string) => boolean = terminalShellFileExists,
): readonly DiscoveredWindowsTerminalShell[] {
  const executablePaths = (binary: string) =>
    claudeExecutableCandidates(binary, environment, "win32", home);
  const findExecutable = (candidates: readonly string[]) =>
    candidates.flatMap(executablePaths).find(isFile);
  const automatic = windowsAutomaticShellCandidates(environment);
  const shells = (["pwsh", "powershell", "cmd"] as const).flatMap((id) => {
    const command = findExecutable(automatic[id]);
    return command ? [{ id, command }] : [];
  });
  const gitPaths = ["git-bash.exe", "git.exe"].flatMap(executablePaths).filter(isFile);
  const gitBash = findExecutable([
    ...gitPaths.flatMap((executable) => {
      const directory = path.dirname(executable);
      const parent = path.dirname(directory);
      const roots = [directory, parent, path.dirname(parent)];
      return roots
        .filter((root) => !/^(usr|mingw32|mingw64|clangarm64)$/iu.test(path.basename(root)))
        .map((root) => path.join(root, "bin", "bash.exe"));
    }),
    ...["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].flatMap((name) => {
      const directory = environmentValue(environment, name);
      return directory ? [path.join(directory, "Git", "bin", "bash.exe")] : [];
    }),
    ...[environmentValue(environment, "LOCALAPPDATA")].flatMap((directory) =>
      directory
        ? [
            path.join(directory, "Programs", "Git", "bin", "bash.exe"),
            path.join(directory, "Git", "bin", "bash.exe"),
          ]
        : [],
    ),
  ]);
  return gitBash ? [...shells, { id: "git-bash", command: gitBash }] : shells;
}

/** Automatic never selects Git Bash; an unavailable preference keeps the same fallback order. */
export function resolveWindowsTerminalShell(
  environment: Readonly<NodeJS.ProcessEnv>,
  home: string,
  preference: TerminalShellSettings["windowsShell"],
  isFile: (pathname: string) => boolean = terminalShellFileExists,
): string {
  const shells = discoverWindowsTerminalShells(environment, home, isFile);
  return (
    shells.find((shell) => shell.id === preference)?.command ??
    shells.find((shell) => shell.id !== "git-bash")?.command ??
    environmentValue(environment, "COMSPEC") ??
    "cmd.exe"
  );
}
