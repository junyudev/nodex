import type { AgentCatalog, AgentChoice } from "@nodex/mobile-protocol";

/** The choice that takes effect: the person's own while it still exists, else the Host's default. */
export const effectiveAgentChoice = (
  catalog: AgentCatalog | null,
  chosen: AgentChoice | null,
): AgentChoice | null => {
  if (!catalog) return chosen;
  const stillOffered =
    chosen !== null &&
    catalog.providers.some(
      (provider) =>
        provider.instanceId === chosen.providerInstanceId &&
        provider.unavailableReason === null &&
        provider.models.some((model) => model.id === chosen.model),
    );
  return stillOffered ? chosen : catalog.defaultChoice;
};

/** The Composer chip's words: the model, since that is what the person picks between. */
export const agentChipLabel = (
  catalog: AgentCatalog | null,
  chosen: AgentChoice | null,
): string => {
  const choice = effectiveAgentChoice(catalog, chosen);
  if (!choice) return "Agent";
  const provider = catalog?.providers.find((item) => item.instanceId === choice.providerInstanceId);
  const model = provider?.models.find((item) => item.id === choice.model);
  return model?.label ?? choice.model;
};
