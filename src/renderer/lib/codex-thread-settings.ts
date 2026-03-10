import type {
  CodexModelOption,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexThreadSettings,
} from "./types";

const THREAD_SETTINGS_STORAGE_KEY = "nodex-codex-thread-settings-v1";
const FALLBACK_MODEL_ID = "gpt-5.3-codex";

const FALLBACK_REASONING_OPTIONS: CodexReasoningEffortOption[] = [
  { reasoningEffort: "minimal", description: "Use the lightest reasoning available." },
  { reasoningEffort: "low", description: "Prefer quick answers with limited extra reasoning." },
  { reasoningEffort: "medium", description: "Balance speed and deeper reasoning." },
  { reasoningEffort: "high", description: "Spend more time reasoning before answering." },
  { reasoningEffort: "xhigh", description: "Use the maximum reasoning budget this model supports." },
];

const REASONING_EFFORT_LABELS: Record<CodexReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

function isCodexReasoningEffort(value: unknown): value is CodexReasoningEffort {
  return (
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
  );
}

function sanitizeThreadSettingsValue(
  value: unknown,
): CodexThreadSettings | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;
  const next: CodexThreadSettings = {};

  if (typeof candidate.model === "string" && candidate.model.trim()) {
    next.model = candidate.model.trim();
  }

  if (isCodexReasoningEffort(candidate.reasoningEffort)) {
    next.reasoningEffort = candidate.reasoningEffort;
  }

  return next.model || next.reasoningEffort ? next : null;
}

export function readCodexThreadSettings(): CodexThreadSettings | null {
  try {
    const raw = localStorage.getItem(THREAD_SETTINGS_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as unknown;
    return sanitizeThreadSettingsValue(parsed);
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

function resolveDefaultModel(models: CodexModelOption[]): CodexModelOption | null {
  const visibleModels = models.filter((model) => !model.hidden);
  if (visibleModels.length === 0) return null;

  return (
    visibleModels.find((model) => model.isDefault) ??
    visibleModels.find((model) => model.id === FALLBACK_MODEL_ID) ??
    visibleModels[0] ??
    null
  );
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
  models: CodexModelOption[],
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
  const defaultModel = resolveDefaultModel(models);
  const visibleModelIds = new Set(models.filter((model) => !model.hidden).map((model) => model.id));

  const model =
    stored?.model && (models.length === 0 || visibleModelIds.has(stored.model))
      ? stored.model
      : defaultModel?.id ?? stored?.model ?? FALLBACK_MODEL_ID;

  const selectedModel = models.find((candidate) => candidate.id === model && !candidate.hidden) ?? null;
  const reasoningOptions = resolveCodexReasoningEffortOptions(model, models);
  const supportedEfforts = new Set(reasoningOptions.map((option) => option.reasoningEffort));
  const defaultReasoningEffort =
    reasoningOptions.find((option) => option.reasoningEffort === "high")?.reasoningEffort ??
    selectedModel?.defaultReasoningEffort ??
    defaultModel?.defaultReasoningEffort ??
    reasoningOptions[0]?.reasoningEffort ??
    "high";

  const reasoningEffort =
    stored?.reasoningEffort && supportedEfforts.has(stored.reasoningEffort)
      ? stored.reasoningEffort
      : defaultReasoningEffort;

  return {
    model,
    reasoningEffort,
  };
}

export function formatCodexModelLabel(modelId: string | undefined, models: CodexModelOption[]): string {
  if (!modelId) return formatCodexModelLabelFromId(FALLBACK_MODEL_ID);

  const selectedModel = models.find((model) => model.id === modelId);
  const displayName = selectedModel?.displayName.trim();
  if (displayName && displayName !== modelId) return displayName;

  return formatCodexModelLabelFromId(modelId);
}

export function formatCodexReasoningEffortLabel(effort: CodexReasoningEffort | undefined): string {
  if (!effort) return "High";
  return REASONING_EFFORT_LABELS[effort];
}
