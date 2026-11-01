import { claudeHostEnvironmentValue } from "./ClaudeExecutable";
import { posix, win32 } from "node:path";

/** Keep official user installs discoverable even before the login shell adds their directory. */
export const openCodeExecutableEnvironment = (input: {
  readonly binaryPath: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
  readonly platform: string;
}): Readonly<Record<string, string>> => {
  const windows = input.platform === "win32";
  const path = windows ? win32 : posix;
  if (
    input.binaryPath !== "opencode" ||
    !path.isAbsolute(input.homeDirectory) ||
    Object.keys(input.environment).some((key) =>
      windows ? key.toUpperCase() === "PATH" : key === "PATH",
    )
  )
    return input.environment;

  const directory = path.join(input.homeDirectory, ".opencode", "bin");
  const searchPath =
    claudeHostEnvironmentValue(input.inheritedEnvironment, "PATH", input.platform) ??
    (windows ? "" : "/usr/bin:/bin");
  if (
    searchPath
      .split(windows ? ";" : ":")
      .some((entry) =>
        windows ? entry.toLowerCase() === directory.toLowerCase() : entry === directory,
      )
  )
    return input.environment;

  return {
    ...input.environment,
    PATH: [searchPath, directory].filter(Boolean).join(windows ? ";" : ":"),
  };
};
