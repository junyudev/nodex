import * as Effect from "effect/Effect";
import type { AntigravitySettings } from "../../../../packages/agent-runtime/vendor/contracts/src/settings";
import { antigravityAgent } from "../../../shared/agents/antigravity";
import { hostEnvironmentValue } from "../../platform/node/HostExecutableSearch";
import type { ProfileProviderBuilder } from "../profile-provider-types";

export const antigravityProfileProvider: ProfileProviderBuilder<typeof antigravityAgent.driver> = (
  profile,
  launch,
  host,
) =>
  Effect.succeed({
    driver: profile.driver,
    displayName: profile.displayName,
    enabled: profile.enabled,
    environment: ["PATH", "PATHEXT"].flatMap((name) => {
      const value = hostEnvironmentValue(host.environment, name, host.config.platform);
      return value === undefined ? [] : [{ name, value, sensitive: false }];
    }),
    config: {
      enabled: profile.enabled,
      authMethod: profile.settings.authMethod,
      apiKey: launch?.secrets.apiKey ?? "",
      gcpProject: profile.settings.gcpProject,
      gcpLocation: profile.settings.gcpLocation,
      binaryPath: profile.binaryPath,
      customModels: [],
    } satisfies AntigravitySettings,
  });
