import type { ModelInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentSessionConfigOption,
  AgentSessionConfigSelectOption,
} from "../../../shared/agent-conversation";
import {
  CLAUDE_DEFAULT_MODEL,
  claudeModelName,
  isClaudeEffortLevel,
  type ClaudeEffortSelection,
} from "../../../shared/claude-models";

/** Keep the CLI's concrete identity, including provider-specific IDs and context suffixes. */
export function claudeModelOptions(
  models: readonly ModelInfo[],
  currentModel?: string,
): readonly AgentSessionConfigSelectOption[] {
  const options = new Map<string, AgentSessionConfigSelectOption>([
    ["default", CLAUDE_DEFAULT_MODEL],
  ]);
  for (const model of models) {
    const reasoningEfforts =
      model.supportsEffort === false
        ? []
        : (model.supportedEffortLevels ?? []).filter(isClaudeEffortLevel);
    const capabilities = reasoningEfforts.length ? { reasoningEfforts } : {};
    const suffix = /\[[^\]]+\]$/u.exec(model.value)?.[0];
    const resolved = model.resolvedModel || model.value;
    const value =
      model.value === "opusplan"
        ? model.value
        : suffix && !resolved.endsWith(suffix)
          ? `${resolved}${suffix}`
          : resolved;
    if (model.value === "default") {
      options.set("default", { ...CLAUDE_DEFAULT_MODEL, ...capabilities });
      if (model.resolvedModel)
        options.set("default", {
          ...CLAUDE_DEFAULT_MODEL,
          name: `${claudeModelName(value)} (default)`,
          description: value,
          ...capabilities,
        });
      if (value === "default") continue;
    }
    const name = claudeModelName(value);
    options.set(value, {
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
  if (currentModel && !options.has(currentModel))
    options.set(currentModel, {
      value: currentModel,
      name: claudeModelName(currentModel),
      description: null,
    });
  return [...options.values()];
}

export function claudeSessionConfigOptions(
  models: readonly ModelInfo[],
  model: string,
  effort: ClaudeEffortSelection,
): readonly AgentSessionConfigOption[] {
  const options = claudeModelOptions(models, model);
  const levels = options.find(({ value }) => value === model)?.reasoningEfforts ?? [];
  return [
    {
      id: "model",
      category: "model",
      name: "Model",
      description: null,
      type: "select",
      currentValue: model,
      options,
    },
    {
      id: "effort",
      category: "thought_level",
      name: "Effort",
      description: null,
      type: "select",
      currentValue: levels.includes(effort) ? effort : "default",
      options: [
        { value: "default", name: "Default", description: "Use the model's default effort" },
        ...levels.map((value) => ({
          value,
          name: value === "xhigh" ? "Extra High" : value.charAt(0).toUpperCase() + value.slice(1),
          description: null,
        })),
      ],
    },
  ];
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
