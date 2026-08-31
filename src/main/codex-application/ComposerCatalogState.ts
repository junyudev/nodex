import type {
  CodexCollaborationModeKind,
  CodexCollaborationModePreset,
  CodexModelOption,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
} from "../../shared/types";
import * as Predicate from "effect/Predicate";

export const parseReasoningEffort = (value: unknown): CodexReasoningEffort | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 64) return null;
  return /[\u0000-\u001f\u007f-\u009f]/u.test(normalized) ? null : normalized;
};

const parseCollaborationModeKind = (value: unknown): CodexCollaborationModeKind | null =>
  value === "default" || value === "plan" ? value : null;

export const parseCollaborationModePreset = (
  value: unknown,
): CodexCollaborationModePreset | null => {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const mode = parseCollaborationModeKind(
    candidate.mode ?? candidate.mode_kind ?? candidate.modeKind ?? candidate.kind,
  );
  if (mode === null) return null;
  const rawReasoningEffort = Object.hasOwn(candidate, "reasoningEffort")
    ? candidate.reasoningEffort
    : candidate.reasoning_effort;
  return {
    name:
      typeof candidate.name === "string" && candidate.name.trim().length > 0
        ? candidate.name.trim()
        : mode === "plan"
          ? "Plan"
          : "Default",
    mode,
    model:
      typeof candidate.model === "string" && candidate.model.trim().length > 0
        ? candidate.model.trim()
        : null,
    reasoningEffort:
      rawReasoningEffort === null
        ? null
        : rawReasoningEffort === undefined
          ? undefined
          : (parseReasoningEffort(rawReasoningEffort) ?? undefined),
  };
};

const parseReasoningEffortOption = (value: unknown): CodexReasoningEffortOption | null => {
  if (!Predicate.isObject(value)) return null;
  const candidate = value as Record<string, unknown>;
  const reasoningEffort = parseReasoningEffort(
    candidate.reasoningEffort ?? candidate.reasoning_effort,
  );
  if (!reasoningEffort) return null;
  return {
    reasoningEffort,
    description: typeof candidate.description === "string" ? candidate.description : "",
  };
};

export const parseModelOption = (value: unknown): CodexModelOption | null => {
  if (!Predicate.isObject(value)) return null;
  const candidate = value;
  if (typeof candidate.id !== "string" || typeof candidate.model !== "string") return null;
  const rawSupportedReasoningEfforts =
    candidate.supportedReasoningEfforts ?? candidate.supported_reasoning_efforts;
  const supportedReasoningEfforts = Array.isArray(rawSupportedReasoningEfforts)
    ? rawSupportedReasoningEfforts
        .map(parseReasoningEffortOption)
        .filter((option): option is CodexReasoningEffortOption => option !== null)
    : [];
  const defaultReasoningEffort =
    parseReasoningEffort(candidate.defaultReasoningEffort ?? candidate.default_reasoning_effort) ??
    supportedReasoningEfforts[0]?.reasoningEffort;
  if (!defaultReasoningEffort) return null;
  const rawInputModalities = candidate.inputModalities ?? candidate.input_modalities;
  const inputModalities: CodexModelOption["inputModalities"] = Array.isArray(rawInputModalities)
    ? rawInputModalities.filter(
        (entry): entry is CodexModelOption["inputModalities"][number] =>
          entry === "text" || entry === "image" || entry === "audio",
      )
    : [];
  const rawServiceTiers = candidate.serviceTiers ?? candidate.service_tiers;
  const serviceTiers = Array.isArray(rawServiceTiers)
    ? rawServiceTiers.flatMap((entry): CodexModelOption["serviceTiers"] => {
        if (!Predicate.isObject(entry)) return [];
        if (
          typeof entry.id !== "string" ||
          typeof entry.name !== "string" ||
          typeof entry.description !== "string"
        ) {
          return [];
        }
        return [{ id: entry.id, name: entry.name, description: entry.description }];
      })
    : [];
  const rawMultiAgentVersion = candidate.multiAgentVersion ?? candidate.multi_agent_version;
  const multiAgentVersion =
    rawMultiAgentVersion === "disabled" ||
    rawMultiAgentVersion === "v1" ||
    rawMultiAgentVersion === "v2"
      ? rawMultiAgentVersion
      : null;
  const rawDefaultServiceTier = candidate.defaultServiceTier ?? candidate.default_service_tier;
  const defaultServiceTier =
    typeof rawDefaultServiceTier === "string" && rawDefaultServiceTier.trim().length > 0
      ? rawDefaultServiceTier.trim()
      : null;
  return {
    id: candidate.id,
    model: candidate.model,
    displayName:
      typeof candidate.displayName === "string"
        ? candidate.displayName
        : typeof candidate.display_name === "string"
          ? candidate.display_name
          : candidate.id,
    description: typeof candidate.description === "string" ? candidate.description : "",
    hidden: Boolean(candidate.hidden),
    supportedReasoningEfforts,
    defaultReasoningEffort,
    inputModalities,
    multiAgentVersion,
    serviceTiers,
    defaultServiceTier,
    isDefault: Boolean(candidate.isDefault ?? candidate.is_default),
  };
};
