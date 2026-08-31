import type { CollaborationMode as CodexAppServerCollaborationMode } from "@nodex/codex-app-server-protocol";
import type { ThreadSettingsUpdateParams } from "@nodex/codex-app-server-protocol/v2/ThreadSettingsUpdateParams";
import type { CodexExecutionProfile } from "../../shared/codex-execution-profile";
import { normalizeCodexServiceTier } from "../../shared/codex-service-tier";
import type {
  CodexCollaborationModeKind,
  CodexCollaborationModeState,
  CodexConversationThreadSettings,
  CodexConversationThreadSettingsPatch,
  CodexPersonality,
  CodexModelOption,
  CodexReasoningEffort,
} from "../../shared/types";

export { normalizeCodexServiceTier } from "../../shared/codex-service-tier";

export const normalizeThreadSettingsModel = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const hasOwnValue = (record: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const preserveSupportedCodexSetting = (
  current: string | null,
  requestedFallback: string | null,
  supported: readonly { readonly value: string | null }[],
): string | null => {
  if (current === null) return null;
  return supported.some((option) => option.value === current) ? current : requestedFallback;
};

export const mergeCodexModelChange = (
  current: CodexExecutionProfile,
  requested: CodexExecutionProfile,
  model: CodexModelOption | null,
): CodexExecutionProfile => {
  if (!model) return requested;
  return {
    ...current,
    modelId: model.model,
    reasoningEffort: preserveSupportedCodexSetting(
      current.reasoningEffort,
      requested.reasoningEffort,
      model.supportedReasoningEfforts.map((option) => ({ value: option.reasoningEffort })),
    ),
    serviceTier: preserveSupportedCodexSetting(
      current.serviceTier,
      requested.serviceTier,
      model.serviceTiers.map((option) => ({ value: option.id })),
    ),
  };
};

export const buildDefaultCollaborationModeState = (): CodexCollaborationModeState => ({
  mode: "default",
  settings: { model: "", reasoning_effort: null, developer_instructions: null },
});

export const buildCollaborationModeState = (input: {
  readonly collaborationMode?: CodexCollaborationModeKind | null;
  readonly model?: string | null;
  readonly reasoningEffort?: CodexReasoningEffort | null;
  readonly fallback?: CodexCollaborationModeState | null;
}): CodexCollaborationModeState => {
  const fallback = input.fallback ?? buildDefaultCollaborationModeState();
  return {
    mode: input.collaborationMode ?? fallback.mode,
    settings: {
      model:
        normalizeThreadSettingsModel(input.model) ??
        normalizeThreadSettingsModel(fallback.settings.model) ??
        "",
      reasoning_effort:
        input.reasoningEffort !== undefined
          ? input.reasoningEffort
          : fallback.settings.reasoning_effort,
      developer_instructions: null,
    },
  };
};

export const buildConversationThreadSettings = (input: {
  readonly model?: string | null;
  readonly modelProvider?: string | null;
  readonly serviceTier?: string | null;
  readonly reasoningEffort?: CodexReasoningEffort | null;
  readonly summary?: CodexConversationThreadSettings["summary"];
  readonly collaborationMode?: CodexCollaborationModeKind | null;
  readonly personality?: CodexPersonality | null;
  readonly fallback?: CodexConversationThreadSettings | null;
  readonly fallbackCollaborationMode?: CodexCollaborationModeState | null;
}): CodexConversationThreadSettings => {
  const fallbackCollaborationMode =
    input.fallback?.collaborationMode ??
    input.fallbackCollaborationMode ??
    buildDefaultCollaborationModeState();
  const model =
    normalizeThreadSettingsModel(input.model) ??
    normalizeThreadSettingsModel(input.fallback?.model) ??
    normalizeThreadSettingsModel(fallbackCollaborationMode.settings.model) ??
    "";
  const reasoningEffort =
    input.reasoningEffort !== undefined
      ? input.reasoningEffort
      : (input.fallback?.reasoningEffort ?? fallbackCollaborationMode.settings.reasoning_effort);
  const collaborationMode = buildCollaborationModeState({
    collaborationMode: input.collaborationMode ?? fallbackCollaborationMode.mode,
    model,
    reasoningEffort,
    fallback: fallbackCollaborationMode,
  });
  return {
    model,
    modelProvider:
      normalizeThreadSettingsModel(input.modelProvider) ??
      normalizeThreadSettingsModel(input.fallback?.modelProvider) ??
      null,
    serviceTier:
      input.serviceTier !== undefined
        ? normalizeCodexServiceTier(input.serviceTier)
        : (input.fallback?.serviceTier ?? null),
    reasoningEffort: reasoningEffort ?? null,
    summary: input.summary !== undefined ? input.summary : (input.fallback?.summary ?? null),
    collaborationMode,
    personality:
      input.personality !== undefined ? input.personality : (input.fallback?.personality ?? null),
  };
};

export const mergeThreadSettingsPatch = (input: {
  readonly patch: CodexConversationThreadSettingsPatch;
  readonly current: CodexConversationThreadSettings | null;
  readonly currentCollaborationMode: CodexCollaborationModeState | null;
}): CodexConversationThreadSettings => {
  const executionProfile = input.patch.executionProfile;
  return buildConversationThreadSettings({
    model:
      executionProfile?.modelId ??
      (hasOwnValue(input.patch, "model") ? (input.patch.model ?? null) : undefined),
    serviceTier: executionProfile
      ? executionProfile.serviceTier
      : hasOwnValue(input.patch, "serviceTier")
        ? (input.patch.serviceTier ?? null)
        : undefined,
    reasoningEffort: executionProfile
      ? executionProfile.reasoningEffort
      : hasOwnValue(input.patch, "reasoningEffort")
        ? (input.patch.reasoningEffort ?? null)
        : undefined,
    summary: hasOwnValue(input.patch, "summary") ? (input.patch.summary ?? null) : undefined,
    collaborationMode: hasOwnValue(input.patch, "collaborationMode")
      ? (input.patch.collaborationMode ?? "default")
      : undefined,
    personality: hasOwnValue(input.patch, "personality")
      ? (input.patch.personality ?? null)
      : undefined,
    fallback: input.current,
    fallbackCollaborationMode: input.currentCollaborationMode,
  });
};

export const buildCollaborationModePayload = (input: {
  readonly collaborationMode?: CodexCollaborationModeKind;
  readonly model?: string;
  readonly reasoningEffort?: CodexReasoningEffort | null;
}): CodexAppServerCollaborationMode | null => {
  if (!input.collaborationMode) return null;
  const model = normalizeThreadSettingsModel(input.model);
  if (!model) return null;
  return {
    mode: input.collaborationMode,
    settings: {
      model,
      reasoning_effort: input.reasoningEffort ?? null,
      developer_instructions: null,
    },
  };
};

export const buildThreadSettingsUpdateParams = (input: {
  readonly threadId: string;
  readonly patch: CodexConversationThreadSettingsPatch;
  readonly nextSettings: CodexConversationThreadSettings;
}): ThreadSettingsUpdateParams => {
  const params: ThreadSettingsUpdateParams = { threadId: input.threadId };
  const executionProfile = input.patch.executionProfile;
  if (executionProfile || hasOwnValue(input.patch, "model")) {
    params.model = executionProfile?.modelId ?? input.patch.model ?? null;
  }
  if (executionProfile || hasOwnValue(input.patch, "serviceTier")) {
    params.serviceTier = executionProfile
      ? executionProfile.serviceTier
      : (input.patch.serviceTier ?? null);
  }
  if (executionProfile || hasOwnValue(input.patch, "reasoningEffort")) {
    params.effort = executionProfile?.reasoningEffort ?? input.patch.reasoningEffort ?? null;
  }
  if (hasOwnValue(input.patch, "summary")) params.summary = input.patch.summary ?? null;
  if (
    executionProfile ||
    hasOwnValue(input.patch, "model") ||
    hasOwnValue(input.patch, "reasoningEffort") ||
    hasOwnValue(input.patch, "collaborationMode")
  ) {
    params.collaborationMode = buildCollaborationModePayload({
      collaborationMode:
        input.patch.collaborationMode ?? input.nextSettings.collaborationMode?.mode ?? "default",
      model: normalizeThreadSettingsModel(input.nextSettings.model) ?? undefined,
      reasoningEffort: input.nextSettings.reasoningEffort,
    });
  }
  if (hasOwnValue(input.patch, "personality")) {
    params.personality = input.patch.personality ?? null;
  }
  return params;
};
