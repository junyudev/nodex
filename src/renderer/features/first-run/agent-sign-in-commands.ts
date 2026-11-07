/** Quotes one word for the shell a Terminal runs: POSIX on macOS and Linux, PowerShell on Windows. */
const quote = (value: string, windows: boolean): string =>
  windows ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;

const isPlainWord = (value: string): boolean => /^[\w./-]+$/u.test(value);

export function claudeSignInCommand(input: {
  readonly binaryPath: string;
  readonly configDirectory: string;
  readonly windows: boolean;
}): string {
  const { binaryPath, configDirectory, windows } = input;
  const executable = isPlainWord(binaryPath)
    ? binaryPath
    : `${windows ? "& " : ""}${quote(binaryPath, windows)}`;
  const login = `${executable} auth login`;
  if (!configDirectory) return login;
  // A `~/` path stays unquoted at its start so the shell can expand it.
  const directory = configDirectory.startsWith("~/")
    ? `~/${quote(configDirectory.slice(2), windows)}`
    : quote(configDirectory, windows);
  return windows
    ? `$env:CLAUDE_CONFIG_DIR=${directory}; ${login}`
    : `CLAUDE_CONFIG_DIR=${directory} ${login}`;
}

/** Claude Code's own installer, which keeps its self-update working. */
export const claudeInstallCommand = (windows: boolean): string =>
  windows
    ? "irm https://claude.ai/install.ps1 | iex"
    : "curl -fsSL https://claude.ai/install.sh | bash";
