import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import { withoutDesktopToolHostBindings } from "../codex/desktop-tool-environment";
import { mergeProcessEnvironments } from "../platform/node/child-process-environment";
import {
  hostEnvironmentValue,
  hostInstallDirectories,
  type HostExecutableSearchHost,
} from "../platform/node/HostExecutableSearch";

/** The execution process and its local providers see commands available to the desktop and login shell. */
export const agentRuntimeHostEnvironment = Effect.fn("agentRuntimeHostEnvironment")(
  function* (input: {
    readonly host: HostExecutableSearchHost;
    readonly loginEnvironment: NodeJS.ProcessEnv;
    readonly additionalSearchPaths: readonly string[];
    readonly overrides: NodeJS.ProcessEnv;
  }) {
    const { host, loginEnvironment, additionalSearchPaths, overrides } = input;
    const { platform } = host;
    const separator = platform === "win32" ? ";" : ":";
    const path = [
      ...additionalSearchPaths.map((directory) => resolve(directory)),
      ...[host.environment, loginEnvironment].flatMap((environment) =>
        (hostEnvironmentValue(environment, "PATH", platform) ?? "").split(separator),
      ),
      ...(yield* hostInstallDirectories(host)),
    ];
    return withoutDesktopToolHostBindings(
      mergeProcessEnvironments(platform, host.environment, loginEnvironment, {
        ...overrides,
        PATH: [...new Set(path.filter(Boolean))].join(separator),
      }),
      platform,
    );
  },
);
