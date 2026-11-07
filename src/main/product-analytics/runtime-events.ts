import { decodeProductEvent, type ProductEvent } from "../../shared/product-analytics/catalog";
import { analyticsModelName, analyticsProviderName } from "../../shared/product-analytics/names";

const asString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const defined = (record: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));

const candidateFromRuntime = (name: string, properties: Readonly<Record<string, unknown>>) => {
  if (name === "thread.created") {
    const thread = {
      provider: analyticsProviderName(asString(properties.driver)),
      model: analyticsModelName(asString(properties.model)),
      source: properties.source,
      actor: properties.actor,
      host: "local",
    };
    return properties.kind === "root"
      ? { name: "thread_started", properties: thread }
      : { name: "thread_branched", properties: { ...thread, kind: properties.kind } };
  }
  if (name === "provider.turn.completed")
    return {
      name: "turn_completed",
      ...(typeof properties.durationMs === "number" ? { value: properties.durationMs } : {}),
      properties: defined({
        provider: analyticsProviderName(asString(properties.provider)),
        model: analyticsModelName(asString(properties.model)),
        status: properties.terminalStatus,
        effort: properties.effort,
        runtime_mode: properties.runtimeMode,
        interaction_mode: properties.interactionMode,
        has_subagents: properties.hasSubagents,
        input_tokens: properties.inputTokens,
        cached_input_tokens: properties.cachedInputTokens,
        output_tokens: properties.outputTokens,
        reasoning_tokens: properties.reasoningTokens,
      }),
    };
  return null;
};

/** The Agent Runtime names execution facts; this is the one place they become product events. */
export const productEventFromRuntime = (
  name: string,
  properties: Readonly<Record<string, unknown>>,
): ProductEvent | null => {
  const candidate = candidateFromRuntime(name, properties);
  return candidate === null ? null : decodeProductEvent(candidate);
};
