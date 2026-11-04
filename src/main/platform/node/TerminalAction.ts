import { posix, win32 } from "node:path";
import { shellQuote } from "./NodexCliShell";

/** Send the action from the replacement shell's resolved working directory. */
export function formatTerminalAction(
  shell: string,
  cwd: string,
  command: string,
  platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  const directory = paths.isAbsolute(cwd) ? cwd : paths.resolve(cwd);
  const executable = win32
    .basename(shell)
    .toLowerCase()
    .replace(/\.exe$/, "");
  const newline = /\r\n|\r|\n/g;
  if (executable === "pwsh" || executable === "powershell") {
    return `Set-Location -LiteralPath '${directory.replaceAll("'", "''")}'; if ($?) {\r\n${command.replace(newline, "\r\n")}\r\n}\r\n`;
  }
  if (executable === "cmd") {
    return `cd /d "${directory.replaceAll('"', '""')}" && ${command.replace(newline, "\r\n")}\r\n`;
  }
  const escaped = /^[\w@%+=:,./-]+$/.test(directory) ? directory : shellQuote(directory);
  return `cd ${escaped} && ${command.replace(newline, "\n")}\n`;
}
