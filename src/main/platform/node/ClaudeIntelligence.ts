import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  CLAUDE_EFFORT_LEVELS,
  claudeKnownThinkingTraits,
  type ClaudeCustomModel,
  type ClaudeResolvedIntelligence,
} from "../../../shared/claude-models";

const NativeSettings = z.object({
  applied: z
    .object({
      model: z.string().min(1).max(1024).nullable().optional().catch(null),
      effort: z.enum(CLAUDE_EFFORT_LEVELS).nullable().optional().catch(null),
    })
    .optional()
    .catch(undefined),
  effective: z
    .object({
      fastMode: z.boolean().optional().catch(undefined),
      alwaysThinkingEnabled: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

export const unknownClaudeIntelligence = (): ClaudeResolvedIntelligence => ({
  model: null,
  effort: null,
  fast: null,
  thinking: null,
});

/** Only applied reports model/effort; merged settings describe the native toggles. */
export function resolveClaudeIntelligence(input: {
  readonly settings: unknown;
  readonly models: readonly ModelInfo[];
  readonly customModels: readonly ClaudeCustomModel[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly acknowledged: { readonly fast?: boolean; readonly thinking?: boolean };
  readonly fastState?: "on" | "off" | "cooldown";
}): ClaudeResolvedIntelligence {
  const parsed = NativeSettings.safeParse(input.settings);
  const value = parsed.success ? parsed.data : undefined;
  const model = value?.applied?.model ?? null;
  const row = input.models.find((entry) => entry.value === model || entry.resolvedModel === model);
  const traits = {
    ...claudeKnownThinkingTraits(model ?? ""),
    ...input.customModels.find(({ id }) => id === model)?.traits,
  };
  const supported = Boolean(row?.supportsAdaptiveThinking || traits.disableThinking !== undefined);
  const environmentOverride = input.environment.MAX_THINKING_TOKENS;
  const configuredThinking = environmentOverride
    ? Number.parseInt(environmentOverride, 10) > 0
    : (value?.effective?.alwaysThinkingEnabled ?? input.acknowledged.thinking ?? true);
  const disabledByEnvironment = /^(?:1|true|yes|on)$/iu.test(
    input.environment.CLAUDE_CODE_DISABLE_THINKING ?? "",
  );
  const thinking = disabledByEnvironment
    ? null
    : traits.disableThinking === false
      ? true
      : supported && (configuredThinking || traits.disableThinking === true)
        ? configuredThinking
        : null;
  const reportedEffort = value?.applied?.effort ?? null;
  const nativeOffBounds = claudeKnownThinkingTraits(model ?? "").disabledThinkingEfforts;
  const effort =
    thinking === false &&
    reportedEffort &&
    nativeOffBounds &&
    !nativeOffBounds.includes(reportedEffort)
      ? (CLAUDE_EFFORT_LEVELS.filter((level) => nativeOffBounds.includes(level)).at(-1) ?? null)
      : reportedEffort;
  return {
    model,
    effort,
    fast:
      input.fastState !== undefined
        ? input.fastState === "on"
        : (value?.effective?.fastMode ?? input.acknowledged.fast ?? null),
    thinking,
  };
}
