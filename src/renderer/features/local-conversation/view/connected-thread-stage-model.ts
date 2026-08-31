import type { CodexExecutionProfile } from "../../../../shared/codex-execution-profile";
import type {
  CodexCollaborationModeKind,
  CodexCollaborationModeState,
  CodexConversationChildMembership,
  CodexConversationThreadSettings,
} from "@/lib/types";
import type { ThreadStageRouteInput } from "../thread-stage-types";

function isKnownCollaborationMode(
  mode: string | null | undefined,
): mode is CodexCollaborationModeKind {
  return mode === "default" || mode === "plan";
}

function normalizeSelectedModel(model: string | null | undefined): string | null {
  const normalized = model?.trim();
  return normalized ? normalized : null;
}

export function resolveChildConversationIds(
  activeThreadId: string | null,
  memberships: readonly CodexConversationChildMembership[],
): string[] {
  return Array.from(
    new Set(
      memberships
        .map((membership) => membership.threadId.trim())
        .filter((threadId) => threadId.length > 0 && threadId !== activeThreadId),
    ),
  );
}

/** Resolves the effective composer settings without coupling the rule to React. */
export function resolveEffectiveThreadStageSettings({
  activeThreadId,
  liveThreadSettings,
  liveMode,
  fallbackMode,
  fallbackModel,
  fallbackReasoningEffort,
  threadExecutionProfile,
  availableModes,
}: {
  activeThreadId: string | null;
  liveThreadSettings: CodexConversationThreadSettings | null;
  liveMode: CodexCollaborationModeState | null;
  fallbackMode: CodexCollaborationModeKind;
  fallbackModel: string;
  fallbackReasoningEffort: ThreadStageRouteInput["selectedReasoningEffort"];
  threadExecutionProfile?: CodexExecutionProfile | null;
  availableModes: readonly ThreadStageRouteInput["collaborationModes"][number][];
}): {
  selectedCollaborationMode: CodexCollaborationModeKind;
  selectedModel: string;
  selectedReasoningEffort: ThreadStageRouteInput["selectedReasoningEffort"];
} {
  const candidateMode = liveThreadSettings?.collaborationMode?.mode ?? liveMode?.mode;
  const fallback = {
    selectedCollaborationMode: fallbackMode,
    selectedModel: threadExecutionProfile?.modelId ?? fallbackModel,
    selectedReasoningEffort: threadExecutionProfile?.reasoningEffort ?? fallbackReasoningEffort,
  };
  if (!activeThreadId || !isKnownCollaborationMode(candidateMode)) {
    return fallback;
  }

  const selectedCollaborationMode =
    availableModes.length === 0 || availableModes.some((mode) => mode.mode === candidateMode)
      ? candidateMode
      : fallbackMode;
  return {
    selectedCollaborationMode,
    selectedModel:
      normalizeSelectedModel(liveThreadSettings?.model) ??
      threadExecutionProfile?.modelId ??
      fallbackModel,
    selectedReasoningEffort:
      liveThreadSettings?.reasoningEffort ??
      threadExecutionProfile?.reasoningEffort ??
      fallbackReasoningEffort,
  };
}
