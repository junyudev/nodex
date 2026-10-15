import type { AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import type { AgentRuntimeMessage } from "../../shared/agent-runtime-api";
import {
  buildAgentConfigProfile,
  mergeAgentConfigs,
  parseAgentConfigMode,
  type AgentConfigModel,
} from "../../shared/codex-agent-config";
import { splitCodexPromptAgentConfigLines } from "../../shared/codex-prompt-preparation";

type Selection = NonNullable<AgentRuntimeMessage["modelSelection"]>;
type Mode = "default" | "plan";
type Provider = AgentRuntimeOperations["providers.read"]["output"][number];

/** Resolve document preferences using the execution process's current catalog, without a settings writer. */
export function resolveAgentRuntimeAgentConfig(input: {
  readonly message: AgentRuntimeMessage;
  readonly modelSelection: Selection;
  readonly interactionMode: Mode;
  readonly providers: readonly Provider[];
}): { readonly message: AgentRuntimeMessage; readonly hasConfig: boolean } {
  const parsed =
    input.message.agentConfigs === undefined
      ? splitCodexPromptAgentConfigLines(input.message.text)
      : { text: input.message.text, agentConfigs: input.message.agentConfigs };
  if (parsed.agentConfigs.length === 0) return { message: input.message, hasConfig: false };
  const provider = input.providers.find(
    (value) => value.instanceId === input.modelSelection.instanceId,
  );
  if (
    !provider ||
    provider.driver !== "codex" ||
    !provider.enabled ||
    !provider.installed ||
    provider.status === "error" ||
    provider.status === "disabled"
  )
    throw new Error("Agent config requires an available native Codex connection");
  const merged = mergeAgentConfigs(parsed.agentConfigs);
  if (
    merged.model === undefined &&
    !provider.models.some((model) => model.slug === input.modelSelection.model)
  )
    throw new Error(`Agent model '${input.modelSelection.model}' is unavailable`);
  const interactionMode = parseAgentConfigMode(merged.mode) ?? input.interactionMode;
  const optionValue = (id: string) =>
    input.modelSelection.options?.find((entry) => entry.id === id)?.value;
  const reasoningEffort = optionValue("reasoningEffort");
  const serviceTier = optionValue("serviceTier");
  const inheritedSpeed = provider.models
    .find((model) => model.slug === input.modelSelection.model)
    ?.capabilities?.optionDescriptors?.find(
      (entry) => entry.id === "serviceTier" && entry.type === "select",
    );
  const base = {
    modelId: input.modelSelection.model,
    reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : null,
    serviceTier:
      typeof serviceTier === "string"
        ? serviceTier
        : inheritedSpeed?.type === "select"
          ? (inheritedSpeed.currentValue ??
            inheritedSpeed.options.find((entry) => entry.isDefault)?.id ??
            null)
          : null,
  };
  const profile = buildAgentConfigProfile({
    base,
    merged,
    models: provider.models.map((model): AgentConfigModel => {
      const descriptors = model.capabilities?.optionDescriptors ?? [];
      const reasoning = descriptors.find(
        (entry) => entry.id === "reasoningEffort" && entry.type === "select",
      );
      const speed = descriptors.find(
        (entry) => entry.id === "serviceTier" && entry.type === "select",
      );
      return {
        id: model.slug,
        model: model.slug,
        displayName: model.name,
        hidden: false,
        isDefault: model.isDefault ?? false,
        supportedReasoningEfforts:
          reasoning?.type === "select"
            ? reasoning.options.map((entry) => ({
                reasoningEffort: entry.id,
                description: entry.description ?? entry.label,
              }))
            : [],
        defaultReasoningEffort:
          reasoning?.type === "select"
            ? (reasoning.options.find((entry) => entry.isDefault)?.id ??
              reasoning.currentValue ??
              null)
            : null,
        serviceTiers:
          speed?.type === "select"
            ? speed.options.map((entry) => ({
                id: entry.id,
                name: entry.label,
                description: entry.description ?? "",
              }))
            : [],
        defaultServiceTier:
          speed?.type === "select"
            ? (speed.options.find((entry) => entry.isDefault)?.id ?? speed.currentValue ?? null)
            : null,
      };
    }),
  });
  const supportsSpeed =
    provider.models
      .find((model) => model.slug === profile.modelId)
      ?.capabilities?.optionDescriptors?.some(
        (entry) => entry.id === "serviceTier" && entry.type === "select",
      ) ?? false;
  const modelSelection = {
    ...input.modelSelection,
    model: profile.modelId,
    options: [
      ...(input.modelSelection.options ?? []).filter(
        (entry) => entry.id !== "reasoningEffort" && entry.id !== "serviceTier",
      ),
      ...(profile.reasoningEffort
        ? [{ id: "reasoningEffort", value: profile.reasoningEffort }]
        : []),
      ...(supportsSpeed ? [{ id: "serviceTier", value: profile.serviceTier ?? "default" }] : []),
    ],
  };
  return {
    hasConfig: true,
    message: { ...input.message, text: parsed.text, modelSelection, interactionMode },
  };
}
