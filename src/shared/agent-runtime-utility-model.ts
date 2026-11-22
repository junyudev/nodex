import { agentDefinition } from "./agents/registry";
import type { AgentCommand, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import { isModelOn, modelIsOn, spendsNodexCredit, type ModelPolicy } from "./model-policy";

// The Agent Runtime imports this module, so it reaches only the Runtime's own contracts and the
// model policy: a wider import would pull the desktop's shared types into that package.
type Providers = AgentRuntimeOperations["providers.read"]["output"];
type ModelSelection = Extract<AgentCommand, { readonly type: "thread.create" }>["modelSelection"];
/** The saved choice of who writes: one Agent Instance and one of its models. */
interface AgentRuntimeWritingModel {
  readonly instanceId: string;
  readonly model: string;
}

const LIGHT_EFFORTS = ["minimal", "low"] as const;

export const isWritingProviderUsable = (provider: Providers[number]): boolean =>
  provider.enabled &&
  provider.installed &&
  provider.status !== "error" &&
  provider.status !== "disabled" &&
  provider.availability !== "unavailable" &&
  provider.auth.status !== "unauthenticated" &&
  provider.supportsTextGeneration !== false;

/** The exact preference wins, then the originating chat's Agent, then the default usable Agent. */
export function selectWritingModel(
  providers: Providers,
  policy: ModelPolicy,
  writingModel: AgentRuntimeWritingModel | null,
  chatModel?: AgentRuntimeWritingModel | null,
): ModelSelection | null {
  const usable = providers
    .filter(isWritingProviderUsable)
    .map((provider) => ({
      ...provider,
      models: provider.models.filter(
        (model) => modelIsOn(model) && isModelOn(policy, provider, model.slug),
      ),
    }))
    .filter((provider) => provider.models.length > 0);

  const explicit = usable.find((provider) => provider.instanceId === writingModel?.instanceId);
  if (writingModel && explicit?.models.some((model) => model.slug === writingModel.model))
    return lightUtilityModelSelection(writingModel, providers);

  const chat = usable.find((provider) => provider.instanceId === chatModel?.instanceId);
  const original = chat?.models.find((model) => model.slug === chatModel?.model);
  // A credit-backed chat can use the model the person selected for it.
  if (chat && original && spendsNodexCredit(chat))
    return lightUtilityModelSelection(
      { instanceId: chat.instanceId, model: original.slug },
      providers,
    );

  const defaults = usable.filter((provider) => !spendsNodexCredit(provider));
  const provider =
    defaults.find((candidate) => candidate.instanceId === chat?.instanceId) ??
    defaults.find((candidate) => candidate.instanceId === "codex") ??
    defaults[0];
  if (!provider) return null;
  const model =
    economicalUtilityModel(provider) ??
    original ??
    provider.models.find((candidate) => candidate.isDefault) ??
    provider.models[0];
  return model
    ? lightUtilityModelSelection({ instanceId: provider.instanceId, model: model.slug }, providers)
    : null;
}

/**
 * The economical model of a first-party Agent, for short utility work. Other Agents reach many
 * vendors through one catalog, so a name there says nothing about who is paid or how much.
 */
export const economicalUtilityModel = <Model extends { readonly slug: string }>(provider: {
  readonly driver: string;
  readonly models: readonly Model[];
}): Model | undefined =>
  agentDefinition(provider.driver).capabilities.utilityModels === "codex"
    ? provider.models.find((model) => model.slug === "gpt-6-luna")
    : agentDefinition(provider.driver).capabilities.utilityModels === "claude"
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
