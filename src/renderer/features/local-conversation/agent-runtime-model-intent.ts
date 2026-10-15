import type { AgentModelSelection } from "../../../shared/agent-model-catalog";
import type { AgentSessionConfigSelectOption } from "../../../shared/agent-conversation";
import { isClaudeEffortLevel, type ClaudeModelSelection } from "../../../shared/claude-models";
import { fitNativeSelection, nativeSelectionsMatch } from "../../lib/native-intelligence-selection";
import type { AgentRuntimeProvider } from "./agent-runtime-conversation-adapter";

type Model = AgentRuntimeProvider["models"][number];
const value = (selection: AgentModelSelection, id: string) =>
  selection.options?.find((option) => option.id === id)?.value;

export function readRuntimeClaudeSelection(selection: AgentModelSelection): ClaudeModelSelection {
  const effort = value(selection, "effort");
  const fast = value(selection, "fastMode");
  const thinking = value(selection, "thinking");
  const context = value(selection, "contextWindow");
  return {
    model: selection.model,
    effort: isClaudeEffortLevel(effort) ? effort : "default",
    ...(typeof fast === "boolean" ? { fast } : {}),
    ...(typeof thinking === "boolean" ? { thinking } : {}),
    ...(typeof context === "string" ? { context } : {}),
  };
}

/** Catalog descriptors are the renderer's capability authority; native execution still validates. */
export function runtimeClaudeModelOption(model: Model): AgentSessionConfigSelectOption {
  const options = model.capabilities?.optionDescriptors ?? [];
  const effort = options.find((option) => option.id === "effort");
  const context = options.find((option) => option.id === "contextWindow");
  return {
    value: model.slug,
    name: model.name,
    description: null,
    reasoningEfforts: effort?.type === "select" ? effort.options.map((choice) => choice.id) : [],
    fastMode: options.some((option) => option.id === "fastMode" && option.type === "boolean"),
    disableThinking: options.some(
      (option) => option.id === "thinking" && option.type === "boolean",
    ),
    contextWindows: context?.type === "select" ? context.options.map((choice) => choice.id) : [],
  };
}

export function applyRuntimeClaudeIntent(
  selection: AgentModelSelection,
  intent: ClaudeModelSelection,
  model: Model | undefined,
): AgentModelSelection {
  const applied = fitNativeSelection(intent, model ? runtimeClaudeModelOption(model) : undefined);
  return {
    ...selection,
    model: applied.model,
    options: [
      ...(selection.options ?? []).filter(
        (option) => !["effort", "fastMode", "thinking", "contextWindow"].includes(option.id),
      ),
      ...(applied.effort === "default" ? [] : [{ id: "effort", value: applied.effort }]),
      ...(applied.fast === undefined ? [] : [{ id: "fastMode", value: applied.fast }]),
      ...(applied.thinking === undefined ? [] : [{ id: "thinking", value: applied.thinking }]),
      ...(applied.context === undefined ? [] : [{ id: "contextWindow", value: applied.context }]),
    ],
  };
}

/** External execution changes supersede intent only when its fitted value no longer explains them. */
export function resolveRuntimeClaudeIntent(
  applied: AgentModelSelection,
  stored: ClaudeModelSelection | undefined,
  model: Model | undefined,
): ClaudeModelSelection {
  if (!stored) return readRuntimeClaudeSelection(applied);
  const fitted = fitNativeSelection(stored, model ? runtimeClaudeModelOption(model) : undefined);
  return nativeSelectionsMatch(fitted, readRuntimeClaudeSelection(applied))
    ? stored
    : readRuntimeClaudeSelection(applied);
}
