import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeLaunch } from "./agent-runtime-api";

type Providers = AgentRuntimeOperations["providers.read"]["output"];
type ModelSelection = AgentRuntimeLaunch["modelSelection"];

const LIGHT_EFFORTS = ["minimal", "low"] as const;

/** Keep the chosen model and account while selecting its lightest offered utility effort. */
export const lightUtilityModelSelection = (
  selection: ModelSelection,
  providers: Providers,
): ModelSelection => {
  const model = providers
    .find((provider) => provider.instanceId === selection.instanceId)
    ?.models.find((candidate) => candidate.slug === selection.model);
  const effort = model?.capabilities?.optionDescriptors?.find(
    (option) => option.type === "select" && /effort|reasoning/i.test(option.id),
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
