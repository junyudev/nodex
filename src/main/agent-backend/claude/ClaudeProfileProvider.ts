import * as Effect from "effect/Effect";
import type { ClaudeSettings } from "../../../../packages/agent-runtime/vendor/contracts/src/settings";
import type { ClaudeCustomModel } from "../../../shared/claude-models";
import { claudeAgent } from "../../../shared/agents/claude";
import { profileProviderEnvironment, type ProfileProviderBuilder } from "../profile-provider-types";

/** Custom capabilities use the execution catalog's option IDs. */
function runtimeClaudeModels(customModels: readonly ClaudeCustomModel[]) {
  return customModels.map(({ id, displayName, traits }) => ({
    slug: id,
    name: displayName,
    capabilities: {
      optionDescriptors: [
        ...(traits.effortLevels?.length
          ? [
              {
                id: "effort",
                label: "Effort",
                type: "select" as const,
                options: traits.effortLevels.map((effort) => ({ id: effort, label: effort })),
              },
            ]
          : []),
        ...(traits.fastMode ? [{ id: "fastMode", label: "Fast", type: "boolean" as const }] : []),
        ...(traits.adaptiveThinking || traits.disableThinking
          ? [{ id: "thinking", label: "Thinking", type: "boolean" as const }]
          : []),
        ...(traits.contextWindows?.length
          ? [
              {
                id: "contextWindow",
                label: "Context",
                type: "select" as const,
                options: traits.contextWindows.map((window) => ({ id: window, label: window })),
              },
            ]
          : []),
      ],
    },
  }));
}

export const claudeProfileProvider: ProfileProviderBuilder<typeof claudeAgent.driver> = (
  profile,
  launch,
) =>
  Effect.succeed({
    driver: profile.driver,
    displayName: profile.displayName,
    enabled: profile.enabled,
    environment: profileProviderEnvironment(profile, launch?.environment ?? {}),
    config: {
      binaryPath: profile.binaryPath,
      homePath: profile.settings.configDirectory,
      customModels: runtimeClaudeModels(profile.settings.customModels),
      modelTraits: Object.fromEntries(
        profile.settings.customModels.map(({ id, traits }) => [id, traits]),
      ),
    } satisfies Partial<ClaudeSettings>,
  });
