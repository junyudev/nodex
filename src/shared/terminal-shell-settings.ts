import { z } from "zod";

export const WindowsTerminalShellSchema = z.enum(["pwsh", "powershell", "cmd", "git-bash"]);
export type WindowsTerminalShell = z.infer<typeof WindowsTerminalShellSchema>;
export const TerminalShellSettingsSchema = z
  .object({ windowsShell: z.union([z.literal("automatic"), WindowsTerminalShellSchema]) })
  .strict();
export type TerminalShellSettings = z.infer<typeof TerminalShellSettingsSchema>;
export const DEFAULT_TERMINAL_SHELL_SETTINGS: TerminalShellSettings = { windowsShell: "automatic" };
export const TERMINAL_SHELL_SETTINGS_CHANGED_CHANNEL = "terminal-shell-settings-changed";
export const WINDOWS_TERMINAL_SHELL_LABELS: Readonly<Record<WindowsTerminalShell, string>> = {
  pwsh: "PowerShell 7",
  powershell: "Windows PowerShell",
  cmd: "Command Prompt",
  "git-bash": "Git Bash",
};
