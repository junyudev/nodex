import type { AgentCatalog, AgentChoice, AgentEffort, AgentModel } from "@nodex/mobile-protocol";

const NO_EFFORTS: readonly AgentEffort[] = [];

const modelOf = (catalog: AgentCatalog | null, choice: AgentChoice): AgentModel | undefined =>
  catalog?.providers
    .find((provider) => provider.instanceId === choice.providerInstanceId)
    ?.models.find((model) => model.id === choice.model);

/** The reasoning efforts a choice's model offers; none when it offers no choice or isn't known. */
export const offeredEfforts = (
  catalog: AgentCatalog | null,
  choice: AgentChoice | null,
): readonly AgentEffort[] => (choice && modelOf(catalog, choice)?.efforts) || NO_EFFORTS;

/**
 * A choice at the effort it would really run at: `picked` or else its own while its model offers
 * that one, else the model's own. Until the catalog names the model, the choice stands as it is.
 */
export const atOfferedEffort = (
  catalog: AgentCatalog | null,
  choice: AgentChoice,
  picked: string | null = null,
): AgentChoice => {
  const model = modelOf(catalog, choice);
  if (!model) return choice;
  const offers = (effort: string | null | undefined) =>
    model.efforts.some((offered) => offered.id === effort);
  const reasoningEffort = offers(picked)
    ? picked
    : offers(choice.reasoningEffort)
      ? choice.reasoningEffort
      : model.defaultEffort;
  return reasoningEffort === choice.reasoningEffort ? choice : { ...choice, reasoningEffort };
};

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
  const choice = stillOffered ? chosen : catalog.defaultChoice;
  return choice && atOfferedEffort(catalog, choice);
};

/** A choice as the person reads it: its model's own name, then its effort where it has one. */
export const agentLabel = (catalog: AgentCatalog | null, choice: AgentChoice): string => {
  const model = modelOf(catalog, choice);
  const effort = model?.efforts.find((offered) => offered.id === choice.reasoningEffort);
  return [model?.label ?? choice.model, effort?.label].filter(Boolean).join(" · ");
};

/** The Composer chip's words: what a chat started now would run on. */
export const agentChipLabel = (
  catalog: AgentCatalog | null,
  chosen: AgentChoice | null,
): string => {
  const choice = effectiveAgentChoice(catalog, chosen);
  return choice ? agentLabel(catalog, choice) : "Agent";
};
