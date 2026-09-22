import { castDraft, produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "./codex-turn-mutation";
import { areStructurallyEqual } from "../structural-equality";
import type {
  Thread,
  ThreadGoal,
  ThreadSettings,
  ThreadStatus,
  ThreadTokenUsage,
} from "@nodex/codex-app-server-protocol/v2";
import type {
  CodexCanonicalConversationState,
  CodexCanonicalHydratedThreadSettings,
  CodexCanonicalThreadSettings,
} from "./codex-conversation-state";
import { normalizeCodexServiceTier } from "../codex-service-tier";
import { projectCodexMarkdownLabel } from "../codex-markdown-text";
import {
  mutateCanonicalThreadSettingsPatch,
  type CanonicalThreadSettingsPatch,
} from "./codex-thread-settings-update";

export type CodexThreadMetadataEffect = {
  readonly type: "clearCompletedGoal";
  readonly threadId: string;
};
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

export function mutateCodexConversationThreadStarted(
  state: Draft<CodexCanonicalConversationState>,
  thread: Thread,
): void {
  if (state.id !== thread.id) return;
  const fallbackCreatedAt = Number.isFinite(thread.createdAt * 1000)
    ? thread.createdAt * 1000
    : Date.now();
  const updatedAt = Number.isFinite(thread.updatedAt * 1000)
    ? thread.updatedAt * 1000
    : fallbackCreatedAt;
  const recencyAt = thread.recencyAt === null ? null : thread.recencyAt * 1000;
  const retainModel = state.latestThreadSettings != null;
  Object.assign(state, {
    sessionId: thread.sessionId,
    ephemeral: thread.ephemeral,
    rolloutPath: thread.path || state.rolloutPath,
    cwd: thread.cwd || state.cwd,
    source: thread.source,
    agentNickname: thread.agentNickname,
    historyMode: thread.historyMode,
    threadRuntimeStatus: thread.status,
    forkedFromId: thread.forkedFromId,
    modelProvider: thread.modelProvider,
    latestModel: retainModel ? state.latestModel : (thread.model ?? state.latestModel),
    latestReasoningEffort:
      retainModel || thread.reasoningEffort === undefined
        ? state.latestReasoningEffort
        : thread.reasoningEffort,
    gitInfo: thread.gitInfo ?? state.gitInfo,
    resumeState: "resumed",
    updatedAt,
    recencyAt:
      recencyAt !== null && Number.isFinite(recencyAt)
        ? Math.max(state.recencyAt, recencyAt)
        : state.recencyAt,
    title: state.title || projectCodexMarkdownLabel(thread.name),
  });
}

export function reduceCodexConversationThreadStarted(
  state: CodexCanonicalConversationState,
  thread: Thread,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexConversationThreadStarted(draft, thread));
}

export interface ReconcileCodexResumedConversationInput {
  readonly existing: CodexCanonicalConversationState | null;
  readonly resumed: CodexCanonicalConversationState;
  readonly thread: Thread;
  readonly catalogTitle?: string | null;
  readonly settingsPatch?: CanonicalThreadSettingsPatch;
  /** Renderer acceptance reconciles metadata before its separately fetched history is installed. */
  readonly preserveResidentHistory?: boolean;
}

function hydratedThreadSettingsFromCanonical(
  settings: CodexCanonicalThreadSettings | null | undefined,
): CodexCanonicalHydratedThreadSettings | null {
  if (!settings) return null;
  return {
    ...(settings.cwd === undefined ? {} : { cwd: settings.cwd }),
    ...(settings.approvalPolicy == null ? {} : { approvalPolicy: settings.approvalPolicy }),
    ...(settings.approvalsReviewer == null
      ? {}
      : { approvalsReviewer: settings.approvalsReviewer }),
    ...(settings.activePermissionProfile === undefined
      ? {}
      : { activePermissionProfile: settings.activePermissionProfile }),
    ...(settings.sandboxPolicy == null ? {} : { sandboxPolicy: settings.sandboxPolicy }),
    ...(settings.permissions === undefined ? {} : { permissions: settings.permissions }),
    model: settings.model,
    serviceTier: settings.serviceTier,
    effort: settings.effort,
    summary: settings.summary,
    multiAgentMode: settings.multiAgentMode,
    collaborationMode: settings.collaborationMode,
    personality: settings.personality,
  };
}

/**
 * Reconciles a native resume snapshot with app-owned state that may have changed while the
 * resume request was in flight. Native metadata advances only the fields owned by resume;
 * local settings, read state, title edits, token usage, and model-transition bookkeeping stay
 * resident unless the accepted response explicitly updates their corresponding setting.
 */
export function reconcileCodexResumedConversationState(
  input: ReconcileCodexResumedConversationInput,
): CodexCanonicalConversationState {
  const { existing, resumed, thread } = input;
  if (!existing) {
    if (!input.settingsPatch) return resumed;
    return produce(resumed, (draft) =>
      mutateCanonicalThreadSettingsPatch(draft, input.settingsPatch!),
    );
  }

  const rawRecencyAt = thread.recencyAt === null ? null : thread.recencyAt * 1_000;
  const threadRecencyAt =
    rawRecencyAt !== null && Number.isFinite(rawRecencyAt) ? rawRecencyAt : null;
  const currentRecencyAt = existing.recencyAt ?? existing.updatedAt;
  const incomingTitle = projectCodexMarkdownLabel(thread.name) ?? "";
  const mayAcceptIncomingTitle =
    incomingTitle.length > 0 &&
    (!existing.title || existing.title === (input.catalogTitle?.trim() || null));

  return produce(resumed, (draft) => {
    // Resume does not retire app-owned metadata or settings that changed after catalog hydration.
    draft.ephemeral = existing.ephemeral;
    draft.parentThreadId = existing.parentThreadId;
    draft.sideConversation = existing.sideConversation;
    draft.generatedTitle = existing.generatedTitle;
    draft.mode = existing.mode;
    draft.threadStartKind = existing.threadStartKind;
    draft.createdAt = existing.createdAt;
    draft.updatedAt = Math.max(existing.updatedAt, resumed.updatedAt);
    draft.recencyAt =
      threadRecencyAt === null ? currentRecencyAt : Math.max(currentRecencyAt, threadRecencyAt);
    draft.title = mayAcceptIncomingTitle ? incomingTitle : existing.title;
    draft.threadSource = thread.threadSource ?? existing.threadSource ?? null;
    draft.gitInfo = thread.gitInfo ?? existing.gitInfo;
    draft.modelProvider = existing.modelProvider;
    draft.latestModel = existing.latestModel;
    draft.latestReasoningEffort = existing.latestReasoningEffort;
    draft.latestCollaborationMode = existing.latestCollaborationMode;
    draft.latestThreadSettings = existing.latestThreadSettings;
    draft.previousTurnModel = existing.previousTurnModel;
    draft.latestTokenUsageInfo = existing.latestTokenUsageInfo;
    draft.hasUnreadTurn = existing.hasUnreadTurn;
    draft.requests = castDraft(existing.requests);
    draft.connectedEnvironmentIds = castDraft(existing.connectedEnvironmentIds);
    draft.threadGoal = existing.threadGoal;
    draft.completedThreadGoal = existing.completedThreadGoal;
    draft.completedThreadGoalTurnId = existing.completedThreadGoalTurnId;
    draft.threadGoalResumeConfirmation = existing.threadGoalResumeConfirmation;
    draft.unconfirmedTurnSubmissions = castDraft(existing.unconfirmedTurnSubmissions);
    if (input.preserveResidentHistory) {
      draft.turns = castDraft(existing.turns);
      draft.turnHistory = castDraft(existing.turnHistory);
    }

    if (input.settingsPatch) mutateCanonicalThreadSettingsPatch(draft, input.settingsPatch);

    if (draft.hydrationContext) {
      draft.hydrationContext.latestModel = draft.latestModel;
      draft.hydrationContext.latestReasoningEffort = draft.latestReasoningEffort;
      draft.hydrationContext.cwd = draft.cwd;
      draft.hydrationContext.latestThreadSettings = castDraft(
        hydratedThreadSettingsFromCanonical(draft.latestThreadSettings),
      );
    }
  });
}

export function mutateCodexConversationThreadName(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  threadName: string | undefined,
  generated?: boolean,
): void {
  if (state.id !== conversationId) return;
  const name = projectCodexMarkdownLabel(threadName) ?? "";
  if (!name) return;
  if (state.title === name) {
    if (generated === true) state.generatedTitle = name;
    if (generated === false) state.generatedTitle = null;
    return;
  }
  Object.assign(state, {
    title: name,
    generatedTitle:
      generated === true
        ? name
        : generated === false
          ? null
          : state.generatedTitle === name
            ? state.generatedTitle
            : null,
  });
}

export function reduceCodexConversationThreadName(
  state: CodexCanonicalConversationState,
  conversationId: string,
  threadName: string | undefined,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexConversationThreadName(draft, conversationId, threadName),
  );
}

function readLatestCollaborationModel(state: CodexCanonicalConversationState): string {
  return (
    state.latestThreadSettings?.collaborationMode.settings.model ??
    state.hydrationContext?.latestThreadSettings?.collaborationMode?.settings.model ??
    residentConversationTurns(state).at(-1)?.params.collaborationMode?.settings.model ??
    ""
  );
}

export function mutateCodexConversationThreadSettings(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  settings: ThreadSettings,
): void {
  if (state.id !== conversationId) return;
  const canonicalSettings = {
    ...settings,
    serviceTier: normalizeCodexServiceTier(settings.serviceTier),
  };
  const previousModel = readLatestCollaborationModel(state);
  const nextModel = canonicalSettings.collaborationMode.settings.model;
  let previousTurnModel = state.previousTurnModel ?? null;
  if (residentConversationTurns(state).length > 0 && previousModel && nextModel !== previousModel) {
    previousTurnModel =
      previousTurnModel === null
        ? previousModel
        : nextModel === previousTurnModel
          ? null
          : previousTurnModel;
  }
  const hydrationContext = state.hydrationContext;
  Object.assign(state, {
    cwd: canonicalSettings.cwd,
    modelProvider: canonicalSettings.modelProvider,
    latestModel: canonicalSettings.model,
    latestReasoningEffort: canonicalSettings.effort,
    latestCollaborationMode: canonicalSettings.collaborationMode,
    latestThreadSettings: canonicalSettings,
    previousTurnModel,
    hydrationContext: hydrationContext
      ? { ...hydrationContext, latestThreadSettings: canonicalSettings }
      : null,
  });
}

export function reduceCodexConversationThreadSettings(
  state: CodexCanonicalConversationState,
  conversationId: string,
  settings: ThreadSettings,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexConversationThreadSettings(draft, conversationId, settings),
  );
}

export function mutateCodexConversationThreadStatus(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  status: ThreadStatus,
): readonly CodexThreadMetadataEffect[] {
  if (state.id !== conversationId) return [];
  Object.assign(state, { threadRuntimeStatus: status });
  // Native status is an observation. Goal execution remains with the app-server.
  return [];
}
export function reduceCodexConversationThreadStatus(
  state: CodexCanonicalConversationState,
  conversationId: string,
  status: ThreadStatus,
): CodexThreadMetadataResult {
  let effects: readonly CodexThreadMetadataEffect[] = [];
  const next = produce(state, (draft) => {
    effects = mutateCodexConversationThreadStatus(draft, conversationId, status);
  });
  return result(next, effects);
}

function keepsGoalResumeConfirmation(status: ThreadGoal["status"]): boolean {
  return status === "paused" || status === "blocked" || status === "usageLimited";
}

export function mutateCodexConversationThreadGoalUpdated(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
  goal: ThreadGoal,
): readonly CodexThreadMetadataEffect[] {
  if (state.id !== conversationId) return [];
  const shouldClear =
    goal.status === "complete" && state.completedThreadGoal?.updatedAt !== goal.updatedAt;
  Object.assign(state, {
    threadGoal: goal,
    completedThreadGoal: goal.status === "complete" ? goal : null,
    completedThreadGoalTurnId:
      goal.status !== "complete"
        ? null
        : shouldClear
          ? (residentConversationTurns(state).at(-1)?.turnId ?? null)
          : state.completedThreadGoalTurnId,
    ...(keepsGoalResumeConfirmation(goal.status) ? {} : { threadGoalResumeConfirmation: null }),
  });
  return shouldClear ? [{ type: "clearCompletedGoal", threadId: conversationId }] : [];
}
export function reduceCodexConversationThreadGoalUpdated(
  state: CodexCanonicalConversationState,
  conversationId: string,
  goal: ThreadGoal,
): CodexThreadMetadataResult {
  let effects: readonly CodexThreadMetadataEffect[] = [];
  const next = produce(state, (draft) => {
    effects = mutateCodexConversationThreadGoalUpdated(draft, conversationId, goal);
  });
  return result(next, effects);
}

export function mutateCodexConversationThreadGoalCleared(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
): void {
  if (state.id !== conversationId) return;
  Object.assign(state, {
    threadGoal: null,
    threadGoalResumeConfirmation: null,
  });
}

export function reduceCodexConversationThreadGoalCleared(
  state: CodexCanonicalConversationState,
  conversationId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexConversationThreadGoalCleared(draft, conversationId));
}

export function mutateCodexConversationThreadGoalResumeConfirmationDismissed(
  state: Draft<CodexCanonicalConversationState>,
  conversationId: string,
): void {
  if (state.id !== conversationId || state.threadGoalResumeConfirmation === null) return;
  Object.assign(state, {
    threadGoalResumeConfirmation: null,
  });
}

export function reduceCodexConversationThreadGoalResumeConfirmationDismissed(
  state: CodexCanonicalConversationState,
  conversationId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexConversationThreadGoalResumeConfirmationDismissed(draft, conversationId),
  );
}

export interface CodexThreadTokenUsageUpdate {
  readonly conversationId: string;
  readonly tokenUsage: ThreadTokenUsage;
}

export function mutateCodexConversationThreadTokenUsage(
  state: Draft<CodexCanonicalConversationState>,
  update: CodexThreadTokenUsageUpdate,
): void {
  if (state.id !== update.conversationId) return;
  Object.assign(state, {
    latestTokenUsageInfo: update.tokenUsage,
  });
}

export function reduceCodexConversationThreadTokenUsage(
  state: CodexCanonicalConversationState,
  update: CodexThreadTokenUsageUpdate,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexConversationThreadTokenUsage(draft, update));
}

/** Refreshes metadata embeddings without admitting receiver history into the conversation. */
export function mutateCodexConversationThreadMetadata(
  state: Draft<CodexCanonicalConversationState>,
  threadId: string,
  readMetadata: (threadId: string) => Thread | null,
): void {
  const metadata = readMetadata(threadId);
  if (state.id === threadId && metadata !== null) state.agentNickname = metadata.agentNickname;
  for (const { address } of residentConversationTurnEntries(state)) {
    const turn = conversationTurnDraft(state, address);
    if (!turn) continue;
    for (const item of turn.items) {
      if (
        item.type !== "collabAgentToolCall" ||
        !("receiverThreads" in item) ||
        !item.receiverThreadIds.includes(threadId)
      )
        continue;
      const receiverThreads = item.receiverThreadIds.map((receiverId) => ({
        threadId: receiverId,
        thread: readMetadata(receiverId),
      }));
      if (!areStructurallyEqual(item.receiverThreads, receiverThreads))
        Object.assign(item, { receiverThreads });
    }
  }
}
export function refreshCodexConversationThreadMetadata(
  state: CodexCanonicalConversationState,
  threadId: string,
  readMetadata: (threadId: string) => Thread | null,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexConversationThreadMetadata(draft, threadId, readMetadata),
  );
}
