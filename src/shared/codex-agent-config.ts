import type { CodexExecutionProfile } from "./codex-execution-profile";
import { normalizeCodexServiceTier } from "./codex-service-tier";
import type {
  CodexCollaborationModeKind,
  CodexModelOption,
  CodexPromptAgentConfigInput,
  CodexReasoningEffort,
} from "./types";

const CODEX_PROVIDER_ID = "openai";
const MAX_VALUE_LENGTH = 512;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** Catalog facts required to resolve the document's explicit intelligence choices. */
export type AgentConfigModel = Pick<
  CodexModelOption,
  | "id"
  | "model"
  | "displayName"
  | "hidden"
  | "isDefault"
  | "supportedReasoningEfforts"
  | "serviceTiers"
  | "defaultServiceTier"
> & { readonly defaultReasoningEffort: string | null };

export interface MergedAgentConfig {
  readonly mode?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly reasoning?: string;
  readonly speed?: string;
}

function normalizeExplicitValue(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_VALUE_LENGTH || CONTROL_CHARACTERS.test(normalized)) {
    throw new Error(`Invalid Agent config ${field}: ${JSON.stringify(value)}`);
  }
  return normalized;
}

export function mergeAgentConfigs(
  configs: readonly CodexPromptAgentConfigInput[],
): MergedAgentConfig {
  const merged: Record<string, string> = {};
  for (const config of configs) {
    if ((config.unknownAttributes?.length ?? 0) > 0) {
      throw new Error(
        `Unsupported Agent config attributes: ${config.unknownAttributes?.join(", ")}`,
      );
    }
    for (const field of ["mode", "provider", "model", "reasoning", "speed"] as const) {
      const value = config[field];
      if (value !== undefined) merged[field] = normalizeExplicitValue(field, value);
    }
  }
  return merged;
}

export function parseAgentConfigMode(
  value: string | undefined,
): CodexCollaborationModeKind | undefined {
  if (value === undefined) return undefined;
  if (value === "default" || value === "plan") return value;
  throw new Error(`Unsupported Agent config mode: ${value}`);
}

function visibleModel(
  models: readonly AgentConfigModel[],
  modelId: string,
): AgentConfigModel | null {
  return (
    models.find((model) => !model.hidden && (model.id === modelId || model.model === modelId)) ??
    null
  );
}

function defaultModel(models: readonly AgentConfigModel[]): AgentConfigModel | null {
  return (
    models.find((model) => !model.hidden && model.isDefault) ??
    models.find((model) => !model.hidden) ??
    null
  );
}

function resolveReasoningEffort(
  model: AgentConfigModel,
  requested: string | null | undefined,
): CodexReasoningEffort | null {
  const supported = new Set<string>(
    model.supportedReasoningEfforts.map((option) => option.reasoningEffort),
  );
  if (requested && supported.has(requested)) return requested as CodexReasoningEffort;
  if (requested) throw new Error(`Effort '${requested}' is unavailable for ${model.displayName}`);
  if (model.defaultReasoningEffort && supported.has(model.defaultReasoningEffort)) {
    return model.defaultReasoningEffort;
  }
  return model.supportedReasoningEfforts[0]?.reasoningEffort ?? null;
}

function resolveSpeed(
  model: AgentConfigModel,
  requested: string | null | undefined,
): string | null {
  if (requested === undefined) return model.defaultServiceTier ?? null;
  const normalized = normalizeCodexServiceTier(requested);
  if (normalized === null) return null;
  if (model.serviceTiers.some((option) => option.id === normalized)) return normalized;
  throw new Error(`Speed '${requested}' is unavailable for ${model.displayName}`);
}

export function buildAgentConfigProfile(input: {
  models: readonly AgentConfigModel[];
  merged: MergedAgentConfig;
  base: CodexExecutionProfile | null;
}): CodexExecutionProfile {
  if (input.merged.provider && input.merged.provider !== CODEX_PROVIDER_ID) {
    throw new Error(`Agent provider '${input.merged.provider}' is unavailable`);
  }

  const inheritedModel = input.base ? visibleModel(input.models, input.base.modelId) : null;
  const requestedModel = input.merged.model ? visibleModel(input.models, input.merged.model) : null;
  if (input.merged.model && !requestedModel) {
    throw new Error(`Agent model '${input.merged.model}' is unavailable`);
  }
  const model = requestedModel ?? inheritedModel ?? defaultModel(input.models);
  if (!model) throw new Error("No Codex model is available");

  const sameBaseModel = input.base !== null && visibleModel([model], input.base.modelId) !== null;
  return {
    modelId: model.model,
    reasoningEffort: resolveReasoningEffort(
      model,
      input.merged.reasoning !== undefined
        ? input.merged.reasoning
        : sameBaseModel
          ? input.base?.reasoningEffort
          : undefined,
    ),
    serviceTier: resolveSpeed(
      model,
      input.merged.speed !== undefined
        ? input.merged.speed
        : sameBaseModel
          ? input.base?.serviceTier
          : undefined,
    ),
  };
}

export function hasAgentConfigIntelligenceOverride(config: MergedAgentConfig): boolean {
  return Boolean(config.provider || config.model || config.reasoning || config.speed);
}
