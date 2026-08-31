import type {
  Thread,
  ThreadGoal,
  ThreadSettings,
  ThreadStatus,
  ThreadTokenUsage,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalConversationState } from "./codex-conversation-state";
import { normalizeCodexServiceTier } from "../codex-service-tier";

export type CodexThreadMetadataEffect =
  | { readonly type: "clearCompletedGoal"; readonly threadId: string }
  | { readonly type: "continueGoalIfIdle"; readonly threadId: string };

export interface CodexThreadMetadataResult {
  readonly state: CodexCanonicalConversationState;
  readonly effects: readonly CodexThreadMetadataEffect[];
}

function result(
  state: CodexCanonicalConversationState,
  effects: readonly CodexThreadMetadataEffect[] = [],
): CodexThreadMetadataResult {
  return { state, effects };
}

export function reduceCodexConversationThreadStarted(
  state: CodexCanonicalConversationState,
  thread: Thread,
): CodexCanonicalConversationState {
  if (state.protocol.id !== thread.id) return state;
  const { turns: _turns, ...incoming } = thread;
  void _turns;
  const incomingName = incoming.name?.trim() || null;
  return {
    ...state,
    protocol: {
      ...state.protocol,
      ...incoming,
      name: state.protocol.name?.trim() || incomingName,
    },
  };
}

export function reduceCodexConversationThreadName(
  state: CodexCanonicalConversationState,
  conversationId: string,
  threadName: string | undefined,
): CodexCanonicalConversationState {
  if (state.protocol.id !== conversationId) return state;
  const name = threadName?.trim() ?? "";
  if (!name || state.protocol.name === name) return state;
  return { ...state, protocol: { ...state.protocol, name } };
}

function readLatestCollaborationModel(state: CodexCanonicalConversationState): string {
  return (
    state.sidecar.latestThreadSettings?.collaborationMode.settings.model ??
    state.sidecar.hydrationContext?.latestThreadSettings?.collaborationMode?.settings.model ??
    state.turns.at(-1)?.sidecar.params.collaborationMode?.settings.model ??
    ""
  );
}

export function reduceCodexConversationThreadSettings(
  state: CodexCanonicalConversationState,
  conversationId: string,
  settings: ThreadSettings,
): CodexCanonicalConversationState {
  if (state.protocol.id !== conversationId) return state;
  const canonicalSettings = {
    ...settings,
    serviceTier: normalizeCodexServiceTier(settings.serviceTier),
  };
  const previousModel = readLatestCollaborationModel(state);
  const nextModel = canonicalSettings.collaborationMode.settings.model;
  let previousTurnModel = state.sidecar.previousTurnModel ?? null;
  if (state.turns.length > 0 && previousModel && nextModel !== previousModel) {
    previousTurnModel =
      previousTurnModel === null
        ? previousModel
        : nextModel === previousTurnModel
          ? null
          : previousTurnModel;
  }
  const hydrationContext = state.sidecar.hydrationContext;
  return {
    ...state,
    protocol: {
      ...state.protocol,
      cwd: canonicalSettings.cwd,
      modelProvider: canonicalSettings.modelProvider,
    },
    sidecar: {
      ...state.sidecar,
      latestThreadSettings: canonicalSettings,
      previousTurnModel,
      hydrationContext: hydrationContext
        ? { ...hydrationContext, latestThreadSettings: canonicalSettings }
        : null,
    },
  };
}

export function reduceCodexConversationThreadStatus(
  state: CodexCanonicalConversationState,
  conversationId: string,
  status: ThreadStatus,
): CodexThreadMetadataResult {
  if (state.protocol.id !== conversationId) return result(state);
  return result(
    { ...state, protocol: { ...state.protocol, status } },
    status.type === "idle" ? [{ type: "continueGoalIfIdle", threadId: conversationId }] : [],
  );
}

function keepsGoalResumeConfirmation(status: ThreadGoal["status"]): boolean {
  return status === "paused" || status === "blocked" || status === "usageLimited";
}

export function reduceCodexConversationThreadGoalUpdated(
  state: CodexCanonicalConversationState,
  conversationId: string,
  goal: ThreadGoal,
): CodexThreadMetadataResult {
  if (state.protocol.id !== conversationId) return result(state);
  const shouldClear =
    goal.status === "complete" && state.sidecar.completedThreadGoal?.updatedAt !== goal.updatedAt;
  return result(
    {
      ...state,
      sidecar: {
        ...state.sidecar,
        threadGoal: goal,
        completedThreadGoal: goal.status === "complete" ? goal : null,
        threadGoalResumeConfirmation: keepsGoalResumeConfirmation(goal.status)
          ? (state.sidecar.threadGoalResumeConfirmation ?? null)
          : null,
      },
    },
    shouldClear ? [{ type: "clearCompletedGoal", threadId: conversationId }] : [],
  );
}

export function reduceCodexConversationThreadGoalCleared(
  state: CodexCanonicalConversationState,
  conversationId: string,
): CodexCanonicalConversationState {
  if (state.protocol.id !== conversationId) return state;
  return {
    ...state,
    sidecar: {
      ...state.sidecar,
      threadGoal: null,
      threadGoalResumeConfirmation: null,
    },
  };
}

export function reduceCodexConversationThreadGoalResumeConfirmationDismissed(
  state: CodexCanonicalConversationState,
  conversationId: string,
): CodexCanonicalConversationState {
  if (state.protocol.id !== conversationId || state.sidecar.threadGoalResumeConfirmation === null)
    return state;
  return {
    ...state,
    sidecar: {
      ...state.sidecar,
      threadGoalResumeConfirmation: null,
    },
  };
}

export interface CodexThreadTokenUsageUpdate {
  readonly conversationId: string;
  readonly tokenUsage: ThreadTokenUsage;
}

export function reduceCodexConversationThreadTokenUsage(
  state: CodexCanonicalConversationState,
  update: CodexThreadTokenUsageUpdate,
): CodexCanonicalConversationState {
  if (state.protocol.id !== update.conversationId) return state;
  return {
    ...state,
    sidecar: {
      ...state.sidecar,
      latestTokenUsageInfo: update.tokenUsage,
    },
  };
}
