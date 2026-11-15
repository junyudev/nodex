import type {
  AgentRuntimeOperations,
  AgentWire,
  ModelSelection,
} from "@nodex/agent-runtime/contracts";
import { isAgentRuntimeEffortOption } from "../../shared/agent-runtime-provider";
import { inboxModelEffort } from "../../shared/inbox";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type Model = Providers[number]["models"][number];

/** Looks up the exact Agent instance's model, including models already used by older chats. */
export const mobileAgentModel = (
  providers: Providers,
  instanceId: string | undefined,
  slug: string | undefined,
) =>
  providers
    .find((provider) => provider.instanceId === instanceId)
    ?.models.find((model) => model.slug === slug);

/** A model's offered efforts and the effort it runs at when a choice is absent or unavailable. */
export const mobileModelEffort = (
  model: Model | undefined,
  chosen: string | AgentWire<ModelSelection>["options"] | null = null,
) => {
  const descriptor = model?.capabilities?.optionDescriptors?.find(isAgentRuntimeEffortOption);
  if (!model || descriptor?.type !== "select" || descriptor.options.length === 0)
    return { efforts: [], defaultEffort: null, reasoningEffort: null };
  const selected =
    typeof chosen === "string"
      ? chosen
      : chosen?.find((option) => option.id === descriptor.id)?.value;
  return {
    efforts: descriptor.options.map(({ id, label }) => ({ id, label })),
    defaultEffort: inboxModelEffort(model, null),
    reasoningEffort: inboxModelEffort(model, typeof selected === "string" ? selected : null),
  };
};
