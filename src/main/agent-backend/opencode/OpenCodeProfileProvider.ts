import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import type { OpenCodeSettings } from "../../../../packages/agent-runtime/vendor/provider-opencode/src/settings";
import { openCodeAgent } from "../../../shared/agents/opencode";
import type { AgentProfile } from "../../../shared/agents/profiles";
import { resolveOpenCodeLaunch } from "../../platform/node/OpenCodeExecutable";
import { profileProviderEnvironment, type ProfileProviderBuilder } from "../profile-provider-types";

export const openCodeProfileDirectory = (
  profile: AgentProfile<typeof openCodeAgent.driver>,
  settingsPath: string,
) =>
  profile.settings.profileDirectory ??
  join(dirname(settingsPath), "agents", openCodeAgent.driver, profile.id);

export const openCodeProfileProvider: ProfileProviderBuilder<typeof openCodeAgent.driver> =
  Effect.fnUntraced(function* (profile, launch, { config, environment, shell }) {
    const directory = launch ? openCodeProfileDirectory(profile, config.profileSettingsPath) : null;
    const resolved = yield* resolveOpenCodeLaunch(
      {
        binaryPath: profile.binaryPath,
        serverUrl: profile.settings.serverUrl,
        inheritedEnvironment: environment,
        environment: launch?.environment ?? {},
        homeDirectory: config.homeDirectory,
        platform: config.platform,
      },
      shell,
    );
    const variables = {
      ...resolved.environment,
      ...(directory
        ? {
            XDG_DATA_HOME: join(directory, "data"),
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_CACHE_HOME: join(directory, "cache"),
            XDG_STATE_HOME: join(directory, "state"),
            OPENCODE_CONFIG_DIR: join(directory, "config", openCodeAgent.driver),
            OPENCODE_TEST_HOME: directory,
          }
        : {}),
    };
    return {
      driver: profile.driver,
      displayName: profile.displayName,
      enabled: profile.enabled,
      environment: profileProviderEnvironment(profile, variables),
      config: {
        // The Runtime selects the command in the launch environment, including the worktree's PATH.
        binaryPath: profile.binaryPath,
        serverUrl: profile.settings.serverUrl ?? "",
        serverPassword: launch?.environment.OPENCODE_SERVER_PASSWORD ?? "",
      } satisfies Partial<OpenCodeSettings>,
    };
  });
