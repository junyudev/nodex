import type {
  AgentSessionMetadata,
  AgentSessionConfigSelectOption,
} from "../../shared/agent-conversation";
import {
  CLAUDE_EFFORT_LEVELS,
  claudeModelContext,
  isClaudeEffortLevel,
  type ClaudeEffortLevel,
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

const fitEffort = (
  effort: ClaudeEffortLevel,
  advertised: readonly string[] | undefined,
): ClaudeEffortSelection => {
  const supported = CLAUDE_EFFORT_LEVELS.filter((level) => advertised?.includes(level));
  if (supported.includes(effort)) return effort;
  const rank = CLAUDE_EFFORT_LEVELS.indexOf(effort);
  return (
    supported.findLast((level) => CLAUDE_EFFORT_LEVELS.indexOf(level) < rank) ??
    supported[0] ??
    "default"
  );
};

/**
 * Applies durable intent to one model. Intent is never rewritten by a model change, so a
 * preference the current model cannot honor returns when the user switches back to a model that
 * can. An unknown target keeps the intent unchanged for the runtime to resolve.
 */
export function fitNativeSelection(
  intent: ClaudeModelSelection,
  target: AgentSessionConfigSelectOption | undefined,
): ClaudeModelSelection {
  if (!target) return intent;
  const { fast, ultracode, thinking, context, ...rest } = intent;
  let effort =
    rest.effort === "default" ? rest.effort : fitEffort(rest.effort, target.reasoningEfforts);
  const appliedThinking =
    thinking === false
      ? target.disableThinking
        ? false
        : undefined
      : thinking === true && !target.adaptiveThinking && target.disableThinking === undefined
        ? undefined
        : thinking;
  const permitted = target.disabledThinkingEfforts ?? [];
  if (
    appliedThinking === false &&
    permitted.length &&
    effort !== "default" &&
    !permitted.includes(effort)
  ) {
    const bounded = CLAUDE_EFFORT_LEVELS.filter(
      (level) => permitted.includes(level) && target.reasoningEfforts?.includes(level),
    ).at(-1);
    if (bounded) effort = bounded;
  }
  return {
    ...rest,
    effort,
    ...(fast === undefined ? {} : { fast: fast && target.fastMode === true }),
    ...(ultracode === undefined ? {} : { ultracode: ultracode && target.ultracode === true }),
    ...(appliedThinking === undefined ? {} : { thinking: appliedThinking }),
    ...(context && target.contextWindows?.includes(context) ? { context } : {}),
  };
}

/** `false` and an absent override both mean Fast and Ultracode are off. */
export const nativeSelectionsMatch = (
  left: ClaudeModelSelection,
  right: ClaudeModelSelection,
): boolean =>
  left.model === right.model &&
  left.effort === right.effort &&
  (left.fast === true) === (right.fast === true) &&
  (left.ultracode === true) === (right.ultracode === true) &&
  left.thinking === right.thinking &&
  left.context === right.context;
