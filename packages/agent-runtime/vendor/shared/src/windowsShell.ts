const WINDOWS_SHELL_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escapes a single argument for `cmd.exe` shell mode (`spawn(..., { shell: true })`
 * on Windows). Node joins the command and arguments with spaces and hands the
 * resulting string to `cmd.exe` without any quoting, so every dynamic argument
 * must be escaped to survive both cmd.exe parsing and the target program's
 * `CommandLineToArgvW` parsing. Mirrors cross-spawn's argument escaping.
 */
export function escapeWindowsShellArg(arg: string): string {
  // Double up backslashes that precede a double quote, then escape the quote
  // itself so it survives CommandLineToArgvW.
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"');
  // Double up trailing backslashes so the closing quote is not escaped away.
  escaped = escaped.replace(/(\\*)$/, "$1$1");
  // Quote the whole argument so embedded whitespace is preserved.
  escaped = `"${escaped}"`;
  // Escape cmd.exe metacharacters so cmd passes them through verbatim.
  return escaped.replace(WINDOWS_SHELL_META_CHARS, "^$1");
}

/**
 * Escapes arguments for shell-mode spawns: applies {@link escapeWindowsShellArg}
 * when the platform is `win32` (where `shell: true` routes through `cmd.exe`)
 * and returns the arguments untouched everywhere else.
 */
export function sanitizeShellModeArgsForPlatform(
  args: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Array<string> {
  return platform === "win32" ? args.map(escapeWindowsShellArg) : [...args];
}
