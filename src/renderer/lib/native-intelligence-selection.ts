import type {
  AgentSessionMetadata,
  AgentSessionConfigSelectOption,
} from "../../shared/agent-conversation";
import {
  claudeModelContext,
  isClaudeEffortLevel,
  type ClaudeModelSelection,
  type ClaudeEffortSelection,
} from "../../shared/claude-models";

/** Drafts present unsent choices; live sessions present the native runtime's applied values. */
export function resolveNativeIntelligenceSelection(
  requested: ClaudeModelSelection,
  observed: AgentSessionMetadata["effectiveSelection"],
  drafting: boolean,
) {
  if (!drafting)
    return {
      model: observed?.model ?? "",
      effort: isClaudeEffortLevel(observed?.effort) ? observed.effort : ("default" as const),
      fast: observed?.fast,
      thinking: observed?.thinking,
      context: claudeModelContext(observed?.model),
    };
  const model = requested.model === "default" ? (observed?.model ?? "default") : requested.model;
  const inheritedEffort = model === observed?.model ? observed?.effort : undefined;
  return {
    model,
    effort:
      requested.effort !== "default"
        ? requested.effort
        : isClaudeEffortLevel(inheritedEffort)
          ? inheritedEffort
          : ("default" as const),
    fast: requested.fast ?? observed?.fast,
    thinking: requested.thinking ?? observed?.thinking,
    context: requested.context ?? claudeModelContext(model),
  };
}

/** A model change keeps an explicit context only when the destination advertises it. */
export function selectNativeModel(
  selection: ClaudeModelSelection,
  model: string,
  effort: ClaudeEffortSelection,
  options: readonly AgentSessionConfigSelectOption[],
): ClaudeModelSelection {
  const next = { ...selection, model, effort };
  const target = options.find((option) => option.value === model);
  if (
    model !== selection.model &&
    model !== "default" &&
    next.context &&
    !target?.contextWindows?.includes(next.context)
  )
    delete next.context;
  return next;
}
