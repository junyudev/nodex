import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "./agent-runtime-api";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type ModelSelection = AgentRuntimeLaunch["modelSelection"];

const LIGHT_EFFORTS = ["minimal", "low"] as const;

/**
 * The economical model of a first-party Agent, for short utility work. Other Agents reach many
 * vendors through one catalog, so a name there says nothing about who is paid or how much.
 */
export const economicalUtilityModel = <Model extends { readonly slug: string }>(provider: {
  readonly driver: string;
  readonly models: readonly Model[];
}): Model | undefined =>
  provider.driver === "codex"
    ? provider.models.find((model) => model.slug === "gpt-6-luna")
    : provider.driver === "claudeAgent"
      ? (provider.models.find((model) => /haiku/i.test(model.slug)) ??
        provider.models.find((model) => /sonnet/i.test(model.slug)))
      : undefined;

/**
 * Keep the chosen model and account while selecting its lightest offered utility effort. OpenCode
 * offers effort as a model variant.
 */
export const lightUtilityModelSelection = (
  selection: ModelSelection,
  providers: Providers,
): ModelSelection => {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const effort = model?.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && /effort|reasoning|variant/i.test(option.id),
  );
  const light =
    effort?.type === "select"
      ? LIGHT_EFFORTS.find((id) => effort.options.some((option) => option.id === id))
      : undefined;
  return {
    instanceId: selection.instanceId,
    model: selection.model,
    ...(effort && light ? { options: [{ id: effort.id, value: light }] } : {}),
  };
};
