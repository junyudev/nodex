import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import {
  claudeModelName,
  isClaudeEffortLevel,
  claudeKnownThinkingTraits,
  type ClaudeCustomModel,
} from "../../../shared/claude-models";

/** Keep the CLI's concrete identity, including provider-specific IDs and context suffixes. */
export function claudeModelOptions(
  models: readonly ModelInfo[],
  currentModel?: string,
  customModels: readonly ClaudeCustomModel[] = [],
): readonly AgentSessionConfigSelectOption[] {
  const options = new Map<string, AgentSessionConfigSelectOption>();
  for (const model of models) {
    const reasoningEfforts =
      model.supportsEffort === false
        ? []
        : (model.supportedEffortLevels ?? []).filter(isClaudeEffortLevel);
    const capabilities = {
      ...(reasoningEfforts.length || model.supportsEffort === false ? { reasoningEfforts } : {}),
      ...(model.supportsFastMode !== undefined ? { fastMode: model.supportsFastMode } : {}),
      ...(model.supportsAdaptiveThinking !== undefined
        ? { adaptiveThinking: model.supportsAdaptiveThinking }
        : {}),
      ...claudeKnownThinkingTraits(model.resolvedModel ?? model.value),
      ...(/\[(\d+[km])\]$/u.test(model.value)
        ? { contextWindows: [/\[(\d+[km])\]$/u.exec(model.value)![1]!] }
        : {}),
    };
    const suffix = /\[[^\]]+\]$/u.exec(model.value)?.[0];
    const resolved = model.resolvedModel || model.value;
    const value =
      model.value === "opusplan"
        ? model.value
        : suffix && !resolved.endsWith(suffix)
          ? `${resolved}${suffix}`
          : resolved;
    if (value === "default") continue;
    const name = claudeModelName(value);
    options.set(value, {
      ...options.get(value),
      value,
      name:
        model.value === "opusplan"
          ? model.displayName
          : name !== value || model.resolvedModel
            ? name
            : model.displayName || value,
      description: model.description || null,
      ...capabilities,
    });
  }
  for (const custom of customModels)
    options.set(custom.id, {
      ...options.get(custom.id),
      value: custom.id,
      name: custom.displayName,
      description: custom.id,
      ...(custom.traits.effortLevels ? { reasoningEfforts: custom.traits.effortLevels } : {}),
      ...(custom.traits.fastMode !== undefined ? { fastMode: custom.traits.fastMode } : {}),
      ...(custom.traits.adaptiveThinking !== undefined
        ? { adaptiveThinking: custom.traits.adaptiveThinking }
        : {}),
      ...(custom.traits.disableThinking !== undefined
        ? { disableThinking: custom.traits.disableThinking }
        : {}),
      ...(custom.traits.disabledThinkingEfforts
        ? { disabledThinkingEfforts: custom.traits.disabledThinkingEfforts }
        : {}),
      ...(custom.traits.contextWindows ? { contextWindows: custom.traits.contextWindows } : {}),
    });
  if (currentModel && currentModel !== "default" && !options.has(currentModel)) {
    const base = currentModel.replace(/\[(?:\d+[km])\]$/iu, "");
    options.set(currentModel, {
      ...(base !== currentModel ? options.get(base) : {}),
      value: currentModel,
      name: claudeModelName(currentModel),
      description: null,
    });
  }
  return [...options.values()];
}
