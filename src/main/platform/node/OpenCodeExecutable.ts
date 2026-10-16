import { posix } from "node:path";

/** Keep official user installs discoverable even before the login shell adds their directory. */
export const openCodeExecutableEnvironment = (input: {
  readonly binaryPath: string;
  readonly inheritedEnvironment: Readonly<Record<string, string | undefined>>;
  readonly environment: Readonly<Record<string, string>>;
  readonly homeDirectory: string;
  readonly platform: string;
}): Readonly<Record<string, string>> => {
  if (
    input.binaryPath !== "opencode" ||
    input.platform === "win32" ||
    !posix.isAbsolute(input.homeDirectory) ||
    Object.hasOwn(input.environment, "PATH")
  )
    return input.environment;

  const directory = posix.join(input.homeDirectory, ".opencode", "bin");
  const searchPath = input.inheritedEnvironment.PATH ?? "/usr/bin:/bin";
  if (searchPath.split(":").includes(directory)) return input.environment;

  return { ...input.environment, PATH: `${searchPath}:${directory}` };
};
