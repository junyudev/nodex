import {
  defineMessage,
  defineMessages,
  getIntl,
  type IntlShape,
  type MessageDescriptor,
} from "@/lib/i18n";
import type {
  AgentModelOption,
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
import {
  codexSpeedTiers,
  normalizeCodexServiceTier,
  type CodexSpeed,
} from "../../shared/codex-service-tier";

export const THREAD_SETTINGS_STORAGE_KEY = "nodex-codex-thread-settings-v1";
export const DEFAULT_CODEX_THREAD_DETAIL_LEVEL: CodexThreadDetailLevel = "STEPS_COMMANDS";
const DEFAULT_MODEL_LABEL = defineMessage({
  id: "lib.codexThreadSettings.defaultModel",
  defaultMessage: "Default model",
});

const FALLBACK_REASONING_OPTIONS: CodexReasoningEffortOption[] = [
  {
    reasoningEffort: "minimal",
    get description() {
      return getIntl().formatMessage({
        id: "lib.codexThreadSettings.effortDescription.minimal",
        defaultMessage: "Use the lightest reasoning available.",
      });
    },
  },
  {
    reasoningEffort: "low",
    get description() {
      return getIntl().formatMessage({
        id: "lib.codexThreadSettings.effortDescription.low",
        defaultMessage: "Prefer quick answers with limited extra reasoning.",
      });
    },
  },
  {
    reasoningEffort: "medium",
    get description() {
      return getIntl().formatMessage({
        id: "lib.codexThreadSettings.effortDescription.medium",
        defaultMessage: "Balance speed and deeper reasoning.",
      });
    },
  },
  {
    reasoningEffort: "high",
    get description() {
      return getIntl().formatMessage({
        id: "lib.codexThreadSettings.effortDescription.high",
        defaultMessage: "Spend more time reasoning before answering.",
      });
    },
  },
  {
    reasoningEffort: "xhigh",
    get description() {
      return getIntl().formatMessage({
        id: "lib.codexThreadSettings.effortDescription.xhigh",
        defaultMessage: "Use the maximum reasoning budget this model supports.",
      });
    },
  },
];

const REASONING_EFFORT_LABELS: Readonly<Partial<Record<string, MessageDescriptor>>> =
  defineMessages({
    none: { id: "lib.codexThreadSettings.effort.none", defaultMessage: "None" },
    minimal: { id: "lib.codexThreadSettings.effort.minimal", defaultMessage: "Minimal" },
    low: { id: "lib.codexThreadSettings.effort.low", defaultMessage: "Light" },
    medium: { id: "lib.codexThreadSettings.effort.medium", defaultMessage: "Medium" },
    high: { id: "lib.codexThreadSettings.effort.high", defaultMessage: "High" },
    xhigh: { id: "lib.codexThreadSettings.effort.xhigh", defaultMessage: "Extra High" },
    max: { id: "lib.codexThreadSettings.effort.max", defaultMessage: "Max" },
    ultra: { id: "lib.codexThreadSettings.effort.ultra", defaultMessage: "Ultra" },
  });

const THREAD_DETAIL_LEVEL_LABELS = defineMessages({
  STEPS_PROSE: { id: "lib.codexThreadSettings.detail.stepsProse", defaultMessage: "Steps" },
  STEPS_COMMANDS: {
    id: "lib.codexThreadSettings.detail.stepsCommands",
    defaultMessage: "Steps with code commands",
  },
  STEPS_EXECUTION: {
    id: "lib.codexThreadSettings.detail.stepsExecution",
    defaultMessage: "Steps with code output",
  },
});

export interface CodexModelSelection {
  model: string;
  reasoningEffort: CodexReasoningEffort | "";
}

export interface CodexModelSelectionInput {
  model?: string | null;
  reasoningEffort?: string | null;
  models: readonly AgentModelOption[];
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
    return parsed.detailLevel ? parsed : null;
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

export function getVisibleCodexModels<Model extends AgentModelOption>(
  models: readonly Model[],
): Model[] {
  return models.filter((model) => !model.hidden);
}

export function resolveDefaultCodexModel<Model extends AgentModelOption>(
  models: readonly Model[],
): Model | null {
  const visibleModels = getVisibleCodexModels(models);
  if (visibleModels.length === 0) return null;

  return visibleModels.find((model) => model.isDefault) ?? visibleModels[0] ?? null;
}

function normalizeModelId(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function findVisibleCodexModel(
  models: readonly AgentModelOption[],
  modelId: string | null,
): AgentModelOption | null {
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

/** `claude-opus-5-5` reads as `Claude Opus 5.5`; `gpt-6.1-sol` as `GPT-6.1 Sol`. */
export function modelDisplayName(model: string): string {
  const base = model
    .replace(/^[a-z0-9-]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  const words = base.split("-").map((word) => {
    if (word === "gpt") return "GPT";
    return /^[a-z]/.test(word) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
  });
  return words
    .join(" ")
    .replace(/^GPT /, "GPT-")
    .replace(/(\d) (\d)/g, "$1.$2");
}

export function resolveCodexReasoningEffortOptions(
  modelId: string | undefined,
  models: readonly Pick<AgentModelOption, "id" | "hidden" | "supportedReasoningEfforts">[],
): CodexReasoningEffortOption[] {
  if (!modelId) return FALLBACK_REASONING_OPTIONS;

  const selectedModel = models.find((model) => model.id === modelId && !model.hidden);
  if (!selectedModel || selectedModel.supportedReasoningEfforts.length === 0) {
    return FALLBACK_REASONING_OPTIONS;
  }

  return selectedModel.supportedReasoningEfforts;
}

/** A faster speed a Codex model offers, with the name and cost its catalog gives it. */
export interface CodexSpeedTierOption {
  readonly value: CodexSpeed;
  readonly label?: string;
  readonly description?: string;
}

/**
 * The faster speeds a Codex model offers, slowest first. A model the catalog does not describe
 * offers Fast, as every Codex model has.
 */
export function resolveCodexSpeedTiers(
  modelId: string | undefined,
  models: readonly Pick<AgentModelOption, "id" | "serviceTiers">[],
): readonly CodexSpeedTierOption[] {
  const tiers = models.find((model) => model.id === modelId)?.serviceTiers;
  if (!tiers) return [{ value: "fast" }];
  return codexSpeedTiers(tiers.map((tier) => tier.id)).map((value) => {
    const tier = tiers.find((candidate) => normalizeCodexServiceTier(candidate.id) === value);
    return { value, label: tier?.name, description: tier?.description };
  });
}

/** What a native Codex request names when it brings no model of its own. */
export function resolveCodexDefaultThreadSettings(models: readonly AgentModelOption[]): {
  readonly model: string;
  readonly reasoningEffort: CodexReasoningEffort;
} {
  const selection = resolveCodexModelSelection({
    models,
    fallbackReasoningEffort: "high",
    preferHighReasoning: true,
  });
  return { model: selection.model, reasoningEffort: selection.reasoningEffort || "high" };
}

export function formatCodexModelLabel<Model extends Pick<AgentModelOption, "id" | "displayName">>(
  modelId: string | undefined,
  models: readonly Model[],
): string {
  if (!modelId) return getIntl().formatMessage(DEFAULT_MODEL_LABEL);

  const selectedModel = models.find((model) => model.id === modelId);
  const displayName = selectedModel?.displayName.trim();
  return formatAgentModelName(
    displayName && displayName !== modelId ? displayName : modelDisplayName(modelId),
  );
}

/** A GPT name reads as its version and then its variant, such as `GPT-6.1 Sol`. */
export function formatAgentModelName(name: string): string {
  return name.replace(
    /^(GPT-\d[\d.]*)(.*)$/u,
    (_match, family: string, variant: string) => family + variant.replaceAll("-", " "),
  );
}

export function formatCodexReasoningEffortLabel(
  effort: CodexReasoningEffort | undefined,
  intl: IntlShape = getIntl(),
): string {
  const value = effort || "high";
  const knownLabel = Object.hasOwn(REASONING_EFFORT_LABELS, value)
    ? REASONING_EFFORT_LABELS[value]
    : undefined;
  if (knownLabel) return intl.formatMessage(knownLabel);

  return value
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
  return getIntl().formatMessage(
    THREAD_DETAIL_LEVEL_LABELS[resolveCodexThreadDetailLevel(detailLevel)],
  );
}
