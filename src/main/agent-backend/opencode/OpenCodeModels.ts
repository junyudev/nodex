import type { Model } from "@opencode-ai/sdk/v2";
import type { AgentModelCatalog } from "../../../shared/agent-model-catalog";
import type {
  AgentSessionConfigOption,
  AgentSessionModeState,
} from "../../../shared/agent-conversation";
import type { OpenCodeInventory } from "../../platform/node/OpenCodeSdk";

export interface OpenCodeSelection {
  readonly model: string;
  readonly variant: string;
  readonly agent: string;
}
export const splitOpenCodeModel = (
  model: string,
): { providerID: string; modelID: string } | null => {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
};
export const openCodeConnectedModels = (inventory: OpenCodeInventory): readonly Model[] => {
  const connected = new Set(inventory.providers.connected);
  return inventory.providers.all
    .filter((provider) => connected.has(provider.id))
    .flatMap((provider) => Object.values(provider.models));
};
export const openCodeModes = (
  inventory: OpenCodeInventory,
  current?: string,
): AgentSessionModeState | null => {
  const agents = inventory.agents.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  if (!agents.length) return null;
  return {
    currentModeId: agents.some((agent) => agent.name === current)
      ? current!
      : (agents.find((agent) => agent.name === inventory.config.default_agent)?.name ??
        agents.find((agent) => agent.name === "build")?.name ??
        agents[0]!.name),
    availableModes: agents.map((agent) => ({
      id: agent.name,
      name: agent.name,
      description: agent.description ?? null,
    })),
  };
};
export const openCodeDefaultModel = (inventory: OpenCodeInventory): string | null => {
  const models = openCodeConnectedModels(inventory);
  const configured = inventory.config.model;
  if (configured && models.some((model) => `${model.providerID}/${model.id}` === configured))
    return configured;
  for (const provider of inventory.providers.connected) {
    const modelId = inventory.providers.default[provider];
    if (modelId && models.some((model) => model.providerID === provider && model.id === modelId))
      return `${provider}/${modelId}`;
  }
  const first = models[0];
  return first ? `${first.providerID}/${first.id}` : null;
};
export const openCodeVariantOptions = (
  inventory: OpenCodeInventory,
  model: string,
  variant = "",
): readonly AgentSessionConfigOption[] => {
  const native = openCodeConnectedModels(inventory).find(
    (candidate) => `${candidate.providerID}/${candidate.id}` === model,
  );
  const variants = Object.keys(native?.variants ?? {});
  if (!variants.length) return [];
  return [
    {
      id: "variant",
      name: "Variant",
      description: null,
      category: "variant",
      type: "select",
      currentValue: variant,
      options: [
        { value: "", name: "Default", description: null },
        ...variants.map((value) => ({ value, name: value, description: null })),
      ],
    },
  ];
};
export const openCodeConfigOptions = (
  inventory: OpenCodeInventory,
  selection: OpenCodeSelection,
): readonly AgentSessionConfigOption[] => {
  const connected = new Set(inventory.providers.connected);
  const groups = inventory.providers.all
    .filter((provider) => connected.has(provider.id))
    .map((provider) => ({
      group: provider.id,
      name: provider.name,
      options: Object.values(provider.models).map((model) => ({
        value: `${provider.id}/${model.id}`,
        name: model.name,
        description: null,
        reasoningEfforts: Object.keys(model.variants ?? {}),
      })),
    }));
  return [
    {
      id: "model",
      name: "Model",
      description: null,
      category: "model",
      type: "select",
      currentValue: selection.model,
      options: groups,
    },
    ...openCodeVariantOptions(inventory, selection.model, selection.variant),
  ];
};
export const openCodeCatalog = (
  instanceConfigId: string,
  inventory: OpenCodeInventory,
): AgentModelCatalog => {
  const defaultModel = openCodeDefaultModel(inventory);
  const modes = openCodeModes(inventory);
  const models = openCodeConnectedModels(inventory)
    .map((model) => {
      const id = `${model.providerID}/${model.id}`;
      const provider = inventory.providers.all.find(
        (candidate) => candidate.id === model.providerID,
      );
      return {
        id,
        model: id,
        displayName: model.name,
        description: provider?.name ?? model.providerID,
        hidden: false,
        supportedReasoningEfforts: Object.keys(model.variants ?? {}).map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
        defaultReasoningEffort: "",
        inputModalities: Object.entries(model.capabilities.input)
          .filter(([, supported]) => supported)
          .map(([name]) => name),
        isDefault: id === defaultModel,
      };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return {
    binding: { kind: "opencode", instanceConfigId },
    models,
    configOptions: defaultModel
      ? openCodeConfigOptions(inventory, {
          model: defaultModel,
          variant: "",
          agent: modes?.currentModeId ?? "",
        })
      : [],
    modelConfigOptions: Object.fromEntries(
      models.map((model) => [model.model, openCodeVariantOptions(inventory, model.model)]),
    ),
    modes,
    health: { status: "ready", error: null },
    defaultModel,
  };
};
