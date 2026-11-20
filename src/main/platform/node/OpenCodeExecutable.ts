import * as Effect from "effect/Effect";
import type { HostShellEnvironment } from "../../host-runtime/HostShellEnvironment";
import {
  hostEnvironmentValue,
  makeHostExecutableSearch,
  type HostExecutableSearchHost,
} from "./HostExecutableSearch";

export const OPEN_CODE_HOME_LOCATIONS = [".opencode/bin/opencode"] as const;

export const resolveOpenCodeLaunch = Effect.fn("OpenCodeExecutable.resolveLaunch")(function* (
  input: Omit<HostExecutableSearchHost, "environment"> & {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly cwd?: string;
    readonly inheritedEnvironment: NodeJS.ProcessEnv;
    readonly environment: Readonly<Record<string, string>>;
  },
  shell: HostShellEnvironment["Service"],
) {
  if (
    input.serverUrl ||
    input.binaryPath !== "opencode" ||
    hostEnvironmentValue(input.environment, "PATH", input.platform) !== undefined
  ) {
    return { binaryPath: input.binaryPath, environment: input.environment };
  }
  const candidate = yield* makeHostExecutableSearch(
    { ...input, environment: input.inheritedEnvironment },
    shell,
  ).first({
    commands: [input.binaryPath],
    homeLocations: OPEN_CODE_HOME_LOCATIONS,
    cwd: input.cwd,
  });
  if (!candidate) return { binaryPath: input.binaryPath, environment: input.environment };
  return {
    binaryPath: candidate.path,
    environment: {
      ...input.environment,
      ...(candidate.environment.PATH === undefined ? {} : { PATH: candidate.environment.PATH }),
    },
  };
});
