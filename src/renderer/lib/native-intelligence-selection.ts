import type { AgentSessionMetadata } from "../../shared/agent-conversation";
import { isClaudeEffortLevel, type ClaudeModelSelection } from "../../shared/claude-models";

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
  };
}
