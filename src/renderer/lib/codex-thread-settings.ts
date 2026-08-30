import type {
  CodexModelOption,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexThreadDetailLevel,
  CodexThreadSettings,
} from "./types";
import {
  CodexReasoningEffortSchema,
  CodexThreadDetailLevelSchema,
  CodexThreadSettingsSchema,
} from "../../shared/schemas/codex";
import { parseJsonStringWithSchema } from "../../shared/schemas/storage";

export const THREAD_SETTINGS_STORAGE_KEY = "nodex-codex-thread-settings-v1";
export const DEFAULT_CODEX_THREAD_DETAIL_LEVEL: CodexThreadDetailLevel = "STEPS_COMMANDS";
const DEFAULT_MODEL_LABEL = "Default model";

const FALLBACK_REASONING_OPTIONS: CodexReasoningEffortOption[] = [
  { reasoningEffort: "minimal", description: "Use the lightest reasoning available." },
  { reasoningEffort: "low", description: "Prefer quick answers with limited extra reasoning." },
  { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
  { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
  {
    reasoningEffort: "xhigh",
    description: "Use the maximum reasoning budget this model supports.",
  },
];

const REASONING_EFFORT_LABELS: Partial<Record<CodexReasoningEffort, string>> = {
  none: "None",
  minimal: "Minimal",
  low: "Light",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum",
  ultra: "Ultra",
};

const THREAD_DETAIL_LEVEL_LABELS: Record<CodexThreadDetailLevel, string> = {
  STEPS_PROSE: "Steps",
  STEPS_COMMANDS: "Steps with code commands",
  STEPS_EXECUTION: "Steps with code output",
};

export interface CodexModelSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort | "";
}

export interface CodexModelSelectionInput {
  model?: string | null;
  reasoningEffort?: string | null;
  models: readonly CodexModelOption[];
  fallbackReasoningEffort?: CodexReasoningEffort | "";
  preferHighReasoning?: boolean;
}

export function isCodexThreadDetailLevel(value: unknown): value is CodexThreadDetailLevel {
  return CodexThreadDetailLevelSchema.safeParse(value).success;
}

export function readCodexThreadSettings(): CodexThreadSettings | null {
  try {
    const raw = localStorage.getItem(THREAD_SETTINGS_STORAGE_KEY);
    const parsed = parseJsonStringWithSchema(raw, CodexThreadSettingsSchema, {});
    return parsed.model || parsed.reasoningEffort || parsed.detailLevel ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCodexThreadSettings(value: CodexThreadSettings): void {
  try {
    localStorage.setItem(THREAD_SETTINGS_STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Ignore localStorage failures.
  }
}

export function getVisibleCodexModels(models: readonly CodexModelOption[]): CodexModelOption[] {
  return models.filter((model) => !model.hidden);
}

export function resolveDefaultCodexModel(
  models: readonly CodexModelOption[],
): CodexModelOption | null {
  const visibleModels = getVisibleCodexModels(models);
  if (visibleModels.length === 0) return null;

  return visibleModels.find((model) => model.isDefault) ?? visibleModels[0] ?? null;
}

function normalizeModelId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function findVisibleCodexModel(
  models: readonly CodexModelOption[],
  modelId: string | null,
): CodexModelOption | null {
  if (!modelId) return null;
  return (
    models.find((model) => !model.hidden && (model.id === modelId || model.model === modelId)) ??
    null
  );
}

function isSupportedReasoningEffort(
  value: string | null | undefined,
): value is CodexReasoningEffort {
  if (!value) return false;
  return CodexReasoningEffortSchema.safeParse(value).success;
}

export function resolveCodexModelSelection(input: CodexModelSelectionInput): CodexModelSelection {
  const requestedModelId = normalizeModelId(input.model);
  const selectedModel = findVisibleCodexModel(input.models, requestedModelId);
  const defaultModel = resolveDefaultCodexModel(input.models);
  const resolvedModel = selectedModel ?? defaultModel;

  if (!resolvedModel) {
    return {
      model: "",
      reasoningEffort: isSupportedReasoningEffort(input.reasoningEffort)
        ? input.reasoningEffort
        : (input.fallbackReasoningEffort ?? ""),
    };
  }

  const model = resolvedModel.id;
  const reasoningOptions = resolveCodexReasoningEffortOptions(model, input.models);
  const supportedEfforts = new Set(reasoningOptions.map((option) => option.reasoningEffort));

  if (
    isSupportedReasoningEffort(input.reasoningEffort) &&
    supportedEfforts.has(input.reasoningEffort)
  ) {
    return {
      model,
      reasoningEffort: input.reasoningEffort,
    };
  }

  const preferredEfforts: Array<CodexReasoningEffort | "" | null | undefined> = [
    input.preferHighReasoning && supportedEfforts.has("high") ? "high" : null,
    resolvedModel.defaultReasoningEffort,
    defaultModel?.defaultReasoningEffort,
    reasoningOptions[0]?.reasoningEffort,
    input.fallbackReasoningEffort,
  ];

  for (const effort of preferredEfforts) {
    if (effort && supportedEfforts.has(effort)) {
      return {
        model,
        reasoningEffort: effort,
      };
    }
  }

  return {
    model,
    reasoningEffort: input.fallbackReasoningEffort ?? "",
  };
}

function formatCodexModelLabelFromId(modelId: string): string {
  return modelId
    .split("-")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      if (segment === "gpt") return "GPT";
      if (/^[a-z][0-9].*$/.test(segment)) {
        return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`;
      }
      if (/^[a-z]+$/.test(segment)) {
        return `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`;
      }
      return segment;
    })
    .join("-");
}

export function resolveCodexReasoningEffortOptions(
  modelId: string | undefined,
  models: readonly CodexModelOption[],
): CodexReasoningEffortOption[] {
  if (!modelId) return FALLBACK_REASONING_OPTIONS;

  const selectedModel = models.find((model) => model.id === modelId && !model.hidden);
  if (!selectedModel || selectedModel.supportedReasoningEfforts.length === 0) {
    return FALLBACK_REASONING_OPTIONS;
  }

  return selectedModel.supportedReasoningEfforts;
}

export function resolveCodexThreadSettings(
  stored: CodexThreadSettings | null | undefined,
  models: CodexModelOption[],
): Required<CodexThreadSettings> {
  const selection = resolveCodexModelSelection({
    model: stored?.model,
    reasoningEffort: stored?.reasoningEffort,
    models,
    fallbackReasoningEffort: "high",
    preferHighReasoning: true,
  });
  const detailLevel = isCodexThreadDetailLevel(stored?.detailLevel)
    ? stored.detailLevel
    : DEFAULT_CODEX_THREAD_DETAIL_LEVEL;

  return {
    model: selection.model,
    reasoningEffort: selection.reasoningEffort || "high",
    detailLevel,
  };
}

export function formatCodexModelLabel(
  modelId: string | undefined,
  models: readonly CodexModelOption[],
): string {
  if (!modelId) return DEFAULT_MODEL_LABEL;

  const selectedModel = models.find((model) => model.id === modelId);
  const displayName = selectedModel?.displayName.trim();
  if (displayName && displayName !== modelId) return displayName;

  return formatCodexModelLabelFromId(modelId);
}

export function formatCodexReasoningEffortLabel(effort: CodexReasoningEffort | undefined): string {
  if (!effort) return "High";
  const knownLabel = REASONING_EFFORT_LABELS[effort];
  if (knownLabel) return knownLabel;

  return effort
    .split(/[-_\s]+/u)
    .filter(Boolean)
    .map((segment) => `${segment[0]?.toUpperCase() ?? ""}${segment.slice(1)}`)
    .join(" ");
}

export function resolveCodexThreadDetailLevel(
  detailLevel: CodexThreadDetailLevel | null | undefined,
): CodexThreadDetailLevel {
  return isCodexThreadDetailLevel(detailLevel) ? detailLevel : DEFAULT_CODEX_THREAD_DETAIL_LEVEL;
}

export function formatCodexThreadDetailLevelLabel(
  detailLevel: CodexThreadDetailLevel | null | undefined,
): string {
  return THREAD_DETAIL_LEVEL_LABELS[resolveCodexThreadDetailLevel(detailLevel)];
}
