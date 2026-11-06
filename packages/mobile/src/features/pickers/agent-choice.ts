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

/** A model's own name, as the person picks between them. */
export const agentLabel = (catalog: AgentCatalog | null, choice: AgentChoice): string => {
  const provider = catalog?.providers.find((item) => item.instanceId === choice.providerInstanceId);
  const model = provider?.models.find((item) => item.id === choice.model);
  return model?.label ?? choice.model;
};

/** The Composer chip's words: the model that a chat started now would run on. */
export const agentChipLabel = (
  catalog: AgentCatalog | null,
  chosen: AgentChoice | null,
): string => {
  const choice = effectiveAgentChoice(catalog, chosen);
  return choice ? agentLabel(catalog, choice) : "Agent";
};
