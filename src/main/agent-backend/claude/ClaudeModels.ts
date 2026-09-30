import type { ModelInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentSessionConfigOption,
  AgentSessionConfigSelectOption,
} from "../../../shared/agent-conversation";
import {
  claudeModelName,
  isClaudeEffortLevel,
  CLAUDE_EFFORT_LEVELS,
  claudeKnownThinkingTraits,
  type ClaudeCustomModel,
  type ClaudeModelSelection,
  type ClaudeResolvedIntelligence,
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

export function claudeSessionConfigOptions(
  models: readonly ModelInfo[],
  intelligence: ClaudeResolvedIntelligence,
  customModels: readonly ClaudeCustomModel[] = [],
): readonly AgentSessionConfigOption[] {
  const options = claudeModelOptions(models, intelligence.model ?? undefined, customModels);
  const selected = options.find(({ value }) => value === intelligence.model);
  const levels = selected?.reasoningEfforts ?? [];
  const config: AgentSessionConfigOption[] = [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      type: "select",
      currentValue: intelligence.model ?? "",
      options,
    },
  ];
  if (levels.length || selected?.disableThinking)
    config.push({
      id: "effort",
      category: "thought_level",
      name: "Effort",
      description: null,
      type: "select",
      currentValue:
        intelligence.thinking === false && selected?.disableThinking
          ? "off"
          : (intelligence.effort ?? ""),
      options: [
        ...(selected?.disableThinking ? [{ value: "off", name: "Off", description: null }] : []),
        ...levels.map((value) => ({
          value,
          name: value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
          description: null,
        })),
      ],
    });
  return config;
}

/** Off may lower effort on models that cannot combine disabled thinking with higher effort. */
export function normalizeClaudeSelection(
  selection: ClaudeModelSelection,
  models: readonly ModelInfo[],
  customModels: readonly ClaudeCustomModel[] = [],
  intelligence?: ClaudeResolvedIntelligence,
): ClaudeModelSelection {
  if (selection.thinking !== false) return selection;
  const modelId = selection.model === "default" ? intelligence?.model : selection.model;
  const model = claudeModelOptions(models, modelId ?? undefined, customModels).find(
    ({ value }) => value === modelId,
  );
  const permitted = model?.disabledThinkingEfforts;
  if (!permitted?.length) return selection;
  const effort = selection.effort === "default" ? intelligence?.effort : selection.effort;
  if (effort && permitted.includes(effort)) return selection;
  const levels = CLAUDE_EFFORT_LEVELS.filter(
    (level) => permitted.includes(level) && model?.reasoningEfforts?.includes(level),
  );
  const bounded = levels.at(-1);
  return bounded ? { ...selection, effort: bounded } : selection;
}

/** Full selection validation happens before the single native mutation. */
export function validateClaudeSelection(
  selection: ClaudeModelSelection,
  models: readonly ModelInfo[],
  customModels: readonly ClaudeCustomModel[] = [],
  retainedModel?: string,
): string | null {
  if (
    selection.model === "default" &&
    selection.effort === "default" &&
    selection.fast === undefined &&
    selection.thinking === undefined &&
    selection.context === undefined
  )
    return null;
  const modelId =
    selection.model === "default"
      ? (retainedModel ?? models.find(({ value }) => value === "default")?.resolvedModel)
      : selection.model;
  const model = claudeModelOptions(models, retainedModel, customModels).find(
    ({ value }) => value === modelId,
  );
  if (!model) return "Choose an advertised or configured Claude model.";
  if (selection.effort !== "default" && !model.reasoningEfforts?.includes(selection.effort))
    return "This Claude model does not advertise that effort level.";
  if (selection.fast === true && !model.fastMode)
    return "This Claude model does not advertise fast mode.";
  if (selection.thinking === false && !model.disableThinking)
    return "This Claude model does not support turning thinking off.";
  if (selection.thinking === true && !model.adaptiveThinking && model.disableThinking === undefined)
    return "This Claude model does not advertise thinking control.";
  if (selection.context !== undefined && !model.contextWindows?.includes(selection.context))
    return "This Claude model does not advertise that context window.";
  return null;
}

/** Resume the last main-thread model, never a subagent's or a synthetic error response. */
export function claudeHistoryModel(messages: readonly SessionMessage[]): string | undefined {
  for (const entry of messages.toReversed()) {
    if (entry.type !== "assistant" || entry.parent_tool_use_id || entry.parent_agent_id) continue;
    const message = entry.message as { model?: unknown } | null;
    if (typeof message?.model !== "string" || !message.model || message.model === "<synthetic>")
      continue;
    return message.model;
  }
  return undefined;
}
