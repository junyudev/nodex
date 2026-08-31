import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import {
  NODEX_AGENT_AUTHORIZATION_RENDERER_METHOD,
  NODEX_AGENT_AUTHORIZATION_TIMEOUT_MS,
} from "../../../shared/nodex-agent-tools";
import type {
  FeedbackUploadParams,
  ThreadBackgroundTerminal,
  ThreadBackgroundTerminalsListResponse,
  ThreadBackgroundTerminalsTerminateResponse,
  ThreadGoal,
  ThreadGoalSetParams,
  Thread,
  ThreadItem,
  ThreadSettings,
  ThreadStatus,
  ThreadSource,
  Turn,
  TurnStartResponse,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import { parseAssetSource } from "../../../shared/assets";
import type {
  CodexPersistedHistoryOccurrenceHydrateInput,
  CodexPersistedHistoryOccurrenceHydrateRequest,
  CodexPersistedHistoryOccurrenceHydrateResult,
  CodexPersistedHistoryOccurrenceResolution,
  CodexThreadOwnerPersistedHistoryHydrationResult,
} from "../../../shared/codex-persisted-history-search";
import {
  createEmptyCodexPreparedPrompt,
  prepareCodexPrompt,
} from "../../../shared/codex-prompt-preparation";
import { resolveCodexReasoningSummary } from "../../../shared/codex-reasoning-summary-policy";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";
import type {
  CodexAccountSnapshot,
  CodexApprovalRequest,
  CodexApprovalKind,
  CodexApprovalResponse,
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewWindow,
  CodexSelectedSubagentHydrateInput,
  CodexSelectedSubagentHydrateResult,
  CodexBackgroundTerminalRow,
  PageRunInTarget,
  CodexCanonicalOptionPickerResponse,
  CodexCanonicalSetupContextPickerResponse,
  CodexCanonicalSetupCodexStepResponse,
  CodexConversationSource,
  CodexConversationCapabilityFlags,
  CodexConversationChildMembership,
  CodexConversationResumeState,
  CodexCollaborationModeKind,
  CodexCollaborationModeState,
  CodexCollaborationModePreset,
  CodexComposerIntent,
  CodexConnectionState,
  CodexConversationItem,
  CodexItemStatus,
  CodexConversationServerRequest,
  CodexConversationSnapshot,
  CodexConversationThreadSettings,
  CodexConversationThreadSettingsPatch,
  CodexConversationTurn,
  CodexDictationStateSnapshot,
  CodexConversationLiveRequest,
  CodexItemView,
  CodexMcpServerElicitationAction,
  CodexMcpServerElicitationRequest,
  CodexMcpServerElicitationResponse,
  CodexModelOption,
  CodexOwnerAppServerRequestInput,
  CodexPendingSteer,
  CodexPreparedPrompt,
  CodexPermissionMode,
  CodexPermissionRequest,
  CodexPermissionRequestResponse,
  CodexPersonality,
  CodexPermissionState,
  CodexProtocolRequestId,
  CodexQueuedFollowUp,
  CodexQueuedFollowUpProjection,
  CodexQueueOwnerTranscriptDirective,
  CodexQueueOwnerUpdateRequest,
  CodexQueueOwnerUpdateResult,
  CodexUserInputRequest,
  CodexRendererClientRequestMessage,
  CodexRendererClientResponseMessage,
  CodexRendererThreadRole,
  CodexRendererThreadRoleRequest,
  NodexAgentAuthorizationRequest,
  NodexAgentAuthorizationResponse,
  CodexSafetyBufferingState,
  CodexSideChatStartInput,
  CodexSideChatStartResult,
  CodexSteerTurnInput,
  CodexThreadActionResult,
  CodexThreadGoalSetActionInput,
  CodexThreadOwnerHistoryMutationResult,
  CodexThreadOwnerActionRequest,
  CodexPromptInput,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexServiceTier,
  CodexSharedObject,
  CodexThreadSettings,
  CodexThreadStartForSessionInput,
  CodexThreadStartForSessionResult,
  CodexThreadSummary,
  CodexThreadSummaryWindow,
  CodexTurnStartOptions,
} from "../../lib/types";
import {
  CODEX_QUEUE_OWNER_UPDATE_METHOD,
  EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
} from "../../../shared/codex-queued-follow-up-state";
import {
  isCodexCanonicalProtocolItem,
  type CodexCanonicalConversationState,
  type CodexCanonicalLiveTurnParams,
  type CodexCanonicalSteeringUserMessageItem,
  type CodexCanonicalTurnState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  appendCodexCanonicalOptimisticTurn,
  bindCodexCanonicalOptimisticTurn,
  failCodexCanonicalOptimisticTurn,
  removeCodexCanonicalOptimisticTurn,
} from "../../../shared/codex-conversation-state/codex-optimistic-turn";
import { buildCodexSteeringCompareKey } from "../../../shared/codex-conversation-state/codex-steering-compare";
import {
  removeCodexCanonicalSteeringItem,
  retargetCodexCanonicalSteeringItem,
  upsertCodexCanonicalSteeringItem,
} from "../../../shared/codex-conversation-state/codex-steering-state";
import { replaceCodexCanonicalRollbackThread } from "../../../shared/codex-conversation-state/codex-rollback-state";
import { reduceCodexBackgroundTerminalCleanup } from "../../../shared/codex-conversation-state/codex-background-terminal-cleanup";
import {
  normalizeCodexMcpServerElicitationMode,
  normalizeCodexMcpServerElicitationResponse,
} from "../../../shared/codex-mcp-elicitation";
import { completeCodexMcpToolCallForTurn } from "../../../shared/codex-mcp-tool-call";
import type {
  CodexBackgroundProcessRow,
  CodexBackgroundProcessRunActionInput,
  CodexThreadActiveFlag,
  CodexThreadHistoryEditResult,
  CodexThreadOwnerStreamStatePublishResult,
  CodexThreadRuntimeStatus,
  CodexThreadStreamCheckpoint,
  CodexThreadStreamResyncRequestInput,
  CodexTurnStatus,
} from "../../../shared/types";
import { getCodexThreadOwnerNotificationThreadId } from "../../../shared/types";
import { applyTerminalTextDelta } from "../../../shared/terminal-text";
import { WORKTREE_OUTPUT_TAIL_MAX_CHARS } from "../../../shared/worktree-output";
import {
  IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE,
  areLocalConversationAttachmentStatesEqual,
  makeLocalConversationAttachmentFailure,
  type LocalConversationAttachmentState,
} from "./conversation-attachment-state";
import {
  applyCodexConversationStateUpdates,
  buildCodexConversationStateUpdates,
} from "../../../shared/codex-conversation-patches";
import {
  applyCodexConversationHistoryMutation,
  codexConversationHistoryPageRequestKey,
  type CodexConversationHistoryMutation,
  type CodexConversationHistoryPageRequest,
  type CodexConversationHistoryPageResult,
} from "../../../shared/codex-conversation-history-page";
import type {
  CodexHistoryResidencyPinsInput,
  CodexHistoryResidencyPinsResult,
} from "../../../shared/codex-history-residency-pins";
import {
  buildCodexThreadStreamCheckpoint,
  hashCodexConversationReplica,
} from "../../../shared/codex-owner-follower-replication";
import {
  reduceCodexConversationEventWithEffects,
  type CodexItemLifecycleNotification,
} from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  applyCodexLifecycleProjectionDiff,
  collectCodexLifecycleStatusChangedItemIds,
} from "../../../shared/codex-conversation-state/codex-lifecycle-projection-diff";
import { areCodexCanonicalTurnParamsEqual } from "../../../shared/codex-canonical-item-projector";
import { buildCodexTurnOccurrenceKey } from "../../../shared/codex-turn-identity";
import {
  groupCodexFrameTextDeltasByConversation,
  isCodexFrameTextDeltaNotification,
  reduceCodexConversationFrameTextDeltas,
  toCodexFrameTextDelta,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta";
import {
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaUpdate,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import { CodexFrameTextDeltaSequenceTracker } from "../../../shared/codex-conversation-state/codex-frame-text-delta-sequence-tracker";
import { boundChangedCodexLiveTurns } from "../../../shared/codex-conversation-state/codex-live-turn-residency";
import {
  groupCodexCommandOutputUpdatesByConversation,
  reduceCodexConversationCommandOutput,
  reduceCodexConversationTerminalCommands,
  type CodexTerminalCommandUpdate,
} from "../../../shared/codex-conversation-state/codex-command-execution-stream";
import {
  CodexCommandOutputQueue,
  type CodexCommandOutputUpdate,
} from "../../../shared/codex-conversation-state/codex-command-output-queue";
import {
  isCodexFileChangePatchUpdatedNotification,
  isCodexMcpToolCallProgressNotification,
  reduceCodexConversationFileChangePatch,
  reduceCodexConversationMcpToolCallProgress,
  toCodexFileChangePatchUpdate,
  toCodexMcpToolCallProgressUpdate,
} from "../../../shared/codex-conversation-state/codex-file-change-stream";
import {
  completeCodexCanonicalPlanImplementationState,
  reduceCodexConversationApprovalResponse,
  reduceCodexConversationMcpElicitationResponse,
  reduceCodexConversationOnboardingInputResponse,
  reduceCodexConversationOptionPickerResponse,
  reduceCodexConversationPermissionResponse,
  reduceCodexConversationServerRequest,
  reduceCodexConversationServerRequestResolved,
  reduceCodexConversationSetupCodexStepResponse,
  reduceCodexConversationSetupContextPickerResponse,
  reduceCodexConversationUserInputResponse,
  type CodexServerRequestLifecycleResult,
} from "../../../shared/codex-conversation-state/codex-server-request-lifecycle";
import { reduceCodexConversationTurnLifecycle } from "../../../shared/codex-conversation-state/codex-turn-lifecycle";
import {
  reduceCodexConversationThreadGoalCleared,
  reduceCodexConversationThreadGoalResumeConfirmationDismissed,
  reduceCodexConversationThreadGoalUpdated,
  reduceCodexConversationThreadName,
  reduceCodexConversationThreadSettings,
  reduceCodexConversationThreadStarted,
  reduceCodexConversationThreadStatus,
  reduceCodexConversationThreadTokenUsage,
  type CodexThreadMetadataEffect,
} from "../../../shared/codex-conversation-state/codex-thread-metadata";
import { appendCodexCanonicalThreadGoalTranscriptTurn } from "../../../shared/codex-conversation-state/codex-thread-goal-transcript";
import {
  reduceCodexConversationAutomaticApprovalReview,
  reduceCodexConversationError,
  reduceCodexConversationGuardianWarning,
  reduceCodexConversationHookRun,
  reduceCodexConversationModelRerouted,
  reduceCodexConversationSafetyBuffering,
  reduceCodexConversationTurnDiff,
  reduceCodexConversationTurnPlan,
  type CodexTurnMetadataEffect,
  type CodexTurnMetadataResult,
} from "../../../shared/codex-conversation-state/codex-turn-metadata";
import {
  getCodexApprovalKindForRequestMethod,
  getCodexApprovalRequestMethod,
} from "../../../shared/codex-approval";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import { normalizeCodexManualThreadTitle } from "../../../shared/codex-thread-title";
import { isCodexNotificationChildConversation } from "../../../shared/codex-thread-notification";
import { shouldShowAutoReviewInterruptionWarning } from "../../../shared/codex-transcript-special-items";
import { extractCodexThreadSubagentMetadata } from "../../../shared/codex-subagent-metadata";
import { CodexTerminalInteractionAccumulator } from "../../../shared/codex-terminal-interaction";
import {
  resolveCodexReasoningEffortOptions,
  resolveCodexThreadSettings,
} from "../../lib/codex-thread-settings";
import {
  buildCodexServiceTierRequestOverride,
  readCodexServiceTier,
  resolveCodexRequestServiceTier,
} from "../../lib/codex-service-tier-settings";
import { useCodexThreadSettings } from "../../lib/use-codex-thread-settings";
import { terminalSessionStore } from "../../lib/terminal-session-store";
import { useCodexServiceTierSettings } from "../../lib/use-codex-service-tier-settings";
import {
  logAssistantStreamingDebug,
  logAssistantStreamingDebugSampled,
} from "../../lib/assistant-streaming-debug";
import {
  runConversationOperation,
  subscribeCodexEvents,
  subscribeCodexRendererClientRequests,
} from "./local-conversation-deps";
import {
  subscribeCodexAppServerMessage,
  type CodexClientStatusChangedEvent,
  type CodexErrorEvent,
  type CodexMcpNotificationEvent,
  type CodexSharedObjectUpdatedEvent,
  type CodexThreadDeletedEvent,
  type CodexThreadTitleUpdatedEvent,
  type CodexThreadOwnerNotificationEvent,
  type CodexThreadOwnerRequestEvent,
  type CodexThreadOwnerUnavailableEvent,
  type CodexThreadStreamStateChangedEvent,
  type CodexThreadStreamFollowersChangedEvent,
  type CodexThreadStreamFollowingStatusRequestedEvent,
  type CodexThreadStreamTransportResetEvent,
  __resetCodexAppServerMessageBusForTests,
} from "./app-server-message-bus";
import {
  __resetLocalConversationHostBridgeForTests,
  startLocalConversationHostBridge,
} from "./local-conversation-host-bridge";
import {
  areConversationLiveRequestsEqual,
  selectPrimaryConversationRequest,
} from "./conversation-request-helpers";
import {
  LocalConversationStreamState,
  type LocalConversationStreamRole,
} from "./local-conversation-stream-state";

const INITIAL_CONNECTION: CodexConnectionState = {
  status: "disconnected",
  retries: 0,
};

const EMPTY_THREADS: CodexThreadSummary[] = [];
const EMPTY_CONVERSATION_MAP: Record<string, CodexConversationSnapshot> = {};
const EMPTY_THREAD_SUMMARY_MAP: Record<string, CodexThreadSummary> = {};
const EMPTY_MODELS: CodexModelOption[] = [];
const EMPTY_TURNS: CodexConversationTurn[] = [];
const EMPTY_REQUESTS: CodexConversationServerRequest[] = [];
const EMPTY_PENDING_STEERS: CodexPendingSteer[] = [];
const EMPTY_QUEUED_FOLLOW_UPS: CodexQueuedFollowUp[] = [];
const EMPTY_BACKGROUND_TERMINAL_ROWS: CodexBackgroundTerminalRow[] = [];
const EMPTY_CHILD_MEMBERSHIPS: CodexConversationChildMembership[] = [];
const EMPTY_STATUS_ACTIVE_FLAGS: CodexConversationSnapshot["statusActiveFlags"] = [];
const ACTIVE_THREAD_GOAL_CONTINUATION_DELAY_MS = 250;
const DEFAULT_PERMISSION_STATE: CodexPermissionState = {
  mode: "custom",
  effectivePreset: "custom",
  availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
  approvalPolicy: null,
  approvalsReviewer: "user",
  sandboxMode: null,
  sandbox: null,
  autoReviewAvailable: false,
  configTarget: {
    source: "none",
    filePath: null,
  },
};
const EMPTY_CONVERSATION_SUMMARY_FIELDS = {
  threadId: null,
  projectId: null,
  threadName: null,
  threadPreview: "",
  cwd: null,
  managedWorktreePath: null,
  projectlessOutputDirectory: null,
  projectlessWorkspaceBrowserRoot: null,
  archived: false,
  hasUnreadTurn: false,
  createdAt: 0,
  updatedAt: 0,
  linkedAt: "",
};
const EMPTY_CONVERSATION_CAPABILITY_FLAGS: CodexConversationCapabilityFlags = {
  canEditLastUserTurn: false,
  canForkFromTurn: false,
  canSearch: false,
  canCollapseTurns: false,
};
const DEFAULT_COLLABORATION_MODE_STATE: CodexCollaborationModeState = {
  mode: "default",
  settings: {
    model: "",
    reasoning_effort: null,
    developer_instructions: null,
  },
};

function copyQueuedFollowUpProjection(
  projection: CodexQueuedFollowUpProjection,
): CodexQueuedFollowUpProjection {
  return { ...projection, entries: [...projection.entries] };
}

function normalizeThreadGoalSetParams(input: ThreadGoalSetParams): ThreadGoalSetParams {
  const params: ThreadGoalSetParams = { threadId: input.threadId };
  if (input.objective !== undefined) params.objective = input.objective;
  if (input.status !== undefined) params.status = input.status;
  if (input.tokenBudget !== undefined) params.tokenBudget = input.tokenBudget;

  if (typeof params.objective === "string" && params.status === undefined) {
    params.status = "active";
  }

  return params;
}

function normalizeThreadGoalSetActionInput(
  input: CodexThreadGoalSetActionInput,
): CodexThreadGoalSetActionInput {
  const params = normalizeThreadGoalSetParams(input);
  return {
    ...params,
    ...(input.appendTranscriptItem !== undefined
      ? { appendTranscriptItem: input.appendTranscriptItem }
      : {}),
    ...(input.threadSettings ? { threadSettings: input.threadSettings } : {}),
  };
}

interface SetThreadGoalAsOwnerOptions {
  clearResumeConfirmation?: boolean;
}

function hasPendingSteeringUserMessage(conversation: CodexConversationSnapshot): boolean {
  if (conversation.pendingSteers.length > 0) return true;
  return conversation.turns.some((turn) =>
    turn.items.some((item) => {
      if (item.steeringStatus === "pending") return true;
      const rawItem = asRecord(item.rawItem);
      return rawItem?.type === "steeringUserMessage" && rawItem.status === "pending";
    }),
  );
}

function hasRunningAgentState(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  if (record.status === "running") return true;

  const agentStates = asRecord(record.agentsStates);
  if (agentStates && Object.values(agentStates).some(hasRunningAgentState)) {
    return true;
  }

  return hasRunningAgentState(record.action);
}

function hasRunningCollabAgentWork(conversation: CodexConversationSnapshot): boolean {
  return conversation.turns.some((turn) =>
    turn.items.some((item) => {
      const toolArgs = asRecord(item.toolCall?.args);
      if (hasRunningAgentState(toolArgs)) return true;
      const rawItem = asRecord(item.rawItem);
      if (rawItem?.type !== "collabAgentToolCall" && rawItem?.type !== "collab_agent_tool_call") {
        return false;
      }
      return hasRunningAgentState(rawItem);
    }),
  );
}

function hasInProgressGoalContinuationWork(conversation: CodexConversationSnapshot): boolean {
  if (conversation.statusType === "active") return true;
  if (conversation.statusActiveFlags.length > 0) return true;
  if (conversation.turns.some((turn) => turn.status === "inProgress")) return true;
  return hasRunningCollabAgentWork(conversation);
}

function normalizeThreadSettingsModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function createOwnerPendingSteer(
  threadId: string,
  turnId: string,
  prompt: string,
  steerId = `steer:${threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
): CodexPendingSteer {
  const createdAt = Date.now();
  return {
    steerId,
    threadId,
    turnId,
    prompt,
    createdAt,
  };
}

function getLatestInProgressTurnId(conversation: CodexConversationSnapshot): string | null {
  for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
    const turn = conversation.turns[index];
    if (turn?.status === "inProgress") return turn.turnId;
  }
  return null;
}

function resolveCodexDraftRequestSettings(
  input: {
    model?: string;
    reasoningEffort?: CodexReasoningEffort;
  },
  resolvedSettings: Required<CodexThreadSettings>,
): {
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
} {
  const model =
    normalizeThreadSettingsModel(input.model) ??
    normalizeThreadSettingsModel(resolvedSettings.model) ??
    undefined;
  const reasoningEffort =
    input.reasoningEffort ?? (model ? resolvedSettings.reasoningEffort : undefined);

  return {
    model,
    reasoningEffort,
  };
}

const DEFAULT_CODEX_DICTATION_STATE: CodexDictationStateSnapshot = {
  isEnabled: false,
  authMethod: null,
  shortcutLabel: "Ctrl+M",
  capabilities: {
    composer: false,
    global: false,
    history: true,
    streaming: "unavailable",
    semanticCleanup: false,
    microphoneOwner: "none",
    auth: "unsupported",
  },
};
const areDictationCapabilitiesEqual = (
  left: CodexDictationStateSnapshot["capabilities"],
  right: CodexDictationStateSnapshot["capabilities"],
): boolean =>
  left.composer === right.composer &&
  left.global === right.global &&
  left.history === right.history &&
  left.streaming === right.streaming &&
  left.semanticCleanup === right.semanticCleanup &&
  left.microphoneOwner === right.microphoneOwner &&
  left.auth === right.auth;
const COMPLETE_HISTORY_WAIT_TIMEOUT_MS = 30_000;

interface OwnerStreamRevisionResult {
  streamRevision?: number;
}

interface OwnerBooleanActionResult extends OwnerStreamRevisionResult {
  accepted: boolean;
}

type StoreListener = () => void;
type ConversationListener = (conversation: CodexConversationSnapshot) => void;
type AnyConversationListener = (conversations: CodexConversationSnapshot[]) => void;
type ControlListener = () => void;
interface CodexThreadStartProgressState {
  projectId: string | null;
  sessionId: string | null;
  runInTarget: PageRunInTarget;
  threadId?: string | null;
  phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
  message: string;
  outputText: string;
  outputCarriageReturnPending: boolean;
  outputTruncated: boolean;
  rendererLaunchPending: boolean;
  updatedAt: number;
}

interface CodexHostErrorState {
  message: string;
  detail?: string;
  updatedAt: number;
}

interface OutputDeltaUpdate extends CodexCommandOutputUpdate {
  readonly ownerNotificationSequence?: number;
  readonly ownerNotificationSequences?: readonly number[];
}

interface OwnerFrameTextDeltaUpdate extends CodexFrameTextDeltaUpdate {
  readonly ownerNotificationSequence: number;
}

type ConversationNotifyMode = "default" | "sync";

interface OwnerFrameTextDeltaFlushOptions {
  notifyMode?: ConversationNotifyMode;
  completedSequencesByConversationId?: ReadonlyMap<string, readonly number[]>;
}

type OwnerStreamPublishPatches = ReturnType<typeof buildCodexConversationStateUpdates>;

interface OwnerStreamPublishCursor {
  acceptedCheckpoint: CodexThreadStreamCheckpoint;
  acceptedDocument: CodexConversationSnapshot;
  inFlight: boolean;
  dirty: boolean;
  standaloneUnreadStateOverride?: boolean;
}

type OwnerSnapshotPublishOutcome =
  | {
      readonly accepted: true;
      readonly checkpoint: CodexThreadStreamCheckpoint;
      readonly conversation: CodexConversationSnapshot;
    }
  | {
      readonly accepted: false;
      readonly reason: Exclude<
        CodexThreadOwnerStreamStatePublishResult,
        { accepted: true }
      >["reason"];
    };

function applyStandaloneUnreadStateToSnapshot(
  conversation: CodexConversationSnapshot,
  hasUnreadTurn: boolean,
): CodexConversationSnapshot {
  return {
    ...conversation,
    hasUnreadTurn,
    ...(!hasUnreadTurn ? { unreadMessageCount: 0 } : {}),
  };
}

interface OwnerServerRequestReplyResult {
  readonly accepted: boolean;
  readonly streamRevision?: number;
}

interface OwnerNotificationCompletionState {
  nextSequenceToAck: number;
  readonly completedSequences: Set<number>;
  reservedAckThrough: number | null;
}

export const CODEX_OWNER_NOTIFICATION_MAX_TRACKED_CONVERSATIONS = 32;
export const CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES_PER_CONVERSATION = 1_024;
export const CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES = 4_096;
export const CODEX_OWNER_RECOVERY_MAX_CONVERSATIONS = 32;
export const CODEX_OWNER_RECOVERY_MAX_DEFERRED_MESSAGES_PER_CONVERSATION = 256;
export const CODEX_OWNER_RECOVERY_MAX_DEFERRED_MESSAGES = 1_024;
export const CODEX_OWNER_RECOVERY_MAX_DEFERRED_BYTES_PER_CONVERSATION = 4 * 1_024 * 1_024;
export const CODEX_OWNER_RECOVERY_MAX_DEFERRED_BYTES = 16 * 1_024 * 1_024;
export const CODEX_OWNER_STREAM_MAX_IDLE_WAITERS_PER_CONVERSATION = 256;
export const CODEX_OWNER_STREAM_MAX_IDLE_WAITERS = 1_024;
export const CODEX_OWNER_STREAM_IPC_DEADLINE_MS = 30_000;

interface DeferredOwnerRecoveryMessage {
  readonly apply: () => void;
  readonly approximateBytes: number;
}

interface DeferredOwnerRecoveryQueue {
  readonly messages: DeferredOwnerRecoveryMessage[];
  approximateBytes: number;
}

type OwnerNotificationSequenceInput = number | readonly number[];

interface OwnerStreamPublishIdleWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
}

function runWithOwnerStreamDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} exceeded the owner-stream IPC deadline`));
    }, CODEX_OWNER_STREAM_IPC_DEADLINE_MS);
    void operation.then(resolve, reject).finally(() => clearTimeout(timeout));
  });
}

function shouldWarnForMissingOutputDeltaTarget(): boolean {
  const meta = import.meta as ImportMeta & {
    env?: {
      MODE?: string;
      DEV?: boolean;
    };
  };
  return meta.env?.DEV === true || meta.env?.MODE === "development";
}

function warnMissingOutputDeltaTarget(message: string, update: OutputDeltaUpdate): void {
  if (!shouldWarnForMissingOutputDeltaTarget()) {
    return;
  }

  console.warn("[local-conversation-output-delta]", message, {
    conversationId: update.conversationId,
    turnId: update.turnId,
    itemId: update.itemId,
    deltaPreview: update.delta.slice(0, 80),
  });
}

function mergeOutputDeltaQueueUpdate(
  existing: OutputDeltaUpdate | undefined,
  incoming: OutputDeltaUpdate,
  delta: string,
): OutputDeltaUpdate {
  const incomingSequences =
    incoming.ownerNotificationSequences ??
    (typeof incoming.ownerNotificationSequence === "number"
      ? [incoming.ownerNotificationSequence]
      : []);
  const ownerNotificationSequences = [
    ...(existing?.ownerNotificationSequences ?? []),
    ...incomingSequences,
  ];
  const ownerNotificationSequence =
    Math.max(existing?.ownerNotificationSequence ?? 0, incoming.ownerNotificationSequence ?? 0) ||
    undefined;
  return {
    ...incoming,
    delta,
    ...(ownerNotificationSequence === undefined ? {} : { ownerNotificationSequence }),
    ...(ownerNotificationSequences.length === 0 ? {} : { ownerNotificationSequences }),
  };
}

interface RendererOwnerAppServerRequestClient {
  sendRequest<TResult>(
    conversationId: string,
    request: CodexOwnerAppServerRequestInput["request"],
  ): Promise<TResult>;
  revertThreadForEdit(
    conversationId: string,
    params: { threadId: string; beforeTurnId: string },
  ): Promise<CodexThreadHistoryEditResult>;
  forkConversationFromTurn(
    conversationId: string,
    params: { threadId: string; turnId: string; message: string },
  ): Promise<CodexThreadActionResult>;
  startTurn(
    conversationId: string,
    params: {
      threadId: string;
      prompt: string;
      opts?: CodexTurnStartOptions;
      clientUserMessageId: string;
      preparedPrompt: CodexPreparedPrompt;
    },
  ): Promise<TurnStartResponse | unknown>;
  resumeInterruptedTurn(
    conversationId: string,
    params: {
      threadId: string;
      opts?: CodexTurnStartOptions;
      clientUserMessageId: string;
    },
  ): Promise<TurnStartResponse | unknown>;
  startSessionFirstTurn(
    conversationId: string,
    params: {
      threadId: string;
      launchId: string;
    },
  ): Promise<TurnStartResponse | unknown>;
  interruptTurn(
    conversationId: string,
    params: { threadId: string; turnId?: string },
  ): Promise<boolean>;
  updateThreadSettings(
    conversationId: string,
    params: { threadId: string; patch: CodexConversationThreadSettingsPatch },
  ): Promise<CodexConversationThreadSettings>;
  setThreadGoal(conversationId: string, params: ThreadGoalSetParams): Promise<ThreadGoal | null>;
  clearThreadGoal(conversationId: string, params: { threadId: string }): Promise<void>;
  setThreadMemoryMode(
    conversationId: string,
    params: { threadId: string; mode: ThreadMemoryMode },
  ): Promise<void>;
  compactThread(conversationId: string, params: { threadId: string }): Promise<void>;
  listBackgroundTerminals(
    conversationId: string,
    params: { threadId: string; cursor?: string | null; limit?: number | null },
  ): Promise<ThreadBackgroundTerminalsListResponse>;
  terminateBackgroundTerminal(
    conversationId: string,
    params: { threadId: string; processId: string },
  ): Promise<ThreadBackgroundTerminalsTerminateResponse>;
}

class IpcRendererOwnerAppServerRequestClient implements RendererOwnerAppServerRequestClient {
  async sendRequest<TResult>(
    conversationId: string,
    request: CodexOwnerAppServerRequestInput["request"],
  ): Promise<TResult> {
    return (await runConversationOperation("codex:thread-owner:app-server-request", {
      conversationId,
      request,
    } satisfies CodexOwnerAppServerRequestInput)) as TResult;
  }

  async revertThreadForEdit(
    conversationId: string,
    params: { threadId: string; beforeTurnId: string },
  ): Promise<CodexThreadHistoryEditResult> {
    return await this.sendRequest(conversationId, {
      method: "thread/revert",
      params,
    });
  }

  async forkConversationFromTurn(
    conversationId: string,
    params: { threadId: string; turnId: string; message: string },
  ): Promise<CodexThreadActionResult> {
    return await this.sendRequest(conversationId, {
      method: "thread/fork",
      params,
    });
  }

  async startTurn(
    conversationId: string,
    params: {
      threadId: string;
      prompt: string;
      opts?: CodexTurnStartOptions;
      clientUserMessageId: string;
      preparedPrompt: CodexPreparedPrompt;
    },
  ): Promise<TurnStartResponse | unknown> {
    return await this.sendRequest(conversationId, {
      method: "turn/start",
      params,
    });
  }

  async resumeInterruptedTurn(
    conversationId: string,
    params: {
      threadId: string;
      opts?: CodexTurnStartOptions;
      clientUserMessageId: string;
    },
  ): Promise<TurnStartResponse | unknown> {
    return await this.sendRequest(conversationId, {
      method: "turn/resume-interrupted",
      params,
    });
  }

  async startSessionFirstTurn(
    conversationId: string,
    params: {
      threadId: string;
      launchId: string;
    },
  ): Promise<TurnStartResponse | unknown> {
    return await this.sendRequest(conversationId, {
      method: "thread/session-first-turn/start",
      params,
    });
  }

  async interruptTurn(
    conversationId: string,
    params: { threadId: string; turnId?: string },
  ): Promise<boolean> {
    return await this.sendRequest(conversationId, {
      method: "turn/interrupt",
      params,
    });
  }

  async updateThreadSettings(
    conversationId: string,
    params: { threadId: string; patch: CodexConversationThreadSettingsPatch },
  ): Promise<CodexConversationThreadSettings> {
    return await this.sendRequest(conversationId, {
      method: "thread/settings/update",
      params,
    });
  }

  async setThreadGoal(
    conversationId: string,
    params: ThreadGoalSetParams,
  ): Promise<ThreadGoal | null> {
    return await this.sendRequest(conversationId, {
      method: "thread/goal/set",
      params,
    });
  }

  async clearThreadGoal(conversationId: string, params: { threadId: string }): Promise<void> {
    await this.sendRequest(conversationId, {
      method: "thread/goal/clear",
      params,
    });
  }

  async setThreadMemoryMode(
    conversationId: string,
    params: { threadId: string; mode: ThreadMemoryMode },
  ): Promise<void> {
    await this.sendRequest(conversationId, {
      method: "thread/memoryMode/set",
      params,
    });
  }

  async compactThread(conversationId: string, params: { threadId: string }): Promise<void> {
    await this.sendRequest(conversationId, {
      method: "thread/compact/start",
      params,
    });
  }

  async listBackgroundTerminals(
    conversationId: string,
    params: { threadId: string; cursor?: string | null; limit?: number | null },
  ): Promise<ThreadBackgroundTerminalsListResponse> {
    return await this.sendRequest(conversationId, {
      method: "thread/backgroundTerminals/list",
      params,
    });
  }

  async terminateBackgroundTerminal(
    conversationId: string,
    params: { threadId: string; processId: string },
  ): Promise<ThreadBackgroundTerminalsTerminateResponse> {
    return await this.sendRequest(conversationId, {
      method: "thread/backgroundTerminals/terminate",
      params,
    });
  }
}

function sortThreadSummaries(threads: CodexThreadSummary[]): CodexThreadSummary[] {
  return [...threads].sort((left, right) => right.updatedAt - left.updatedAt);
}

function upsertThreadSummary(
  threads: CodexThreadSummary[],
  thread: CodexThreadSummary,
): CodexThreadSummary[] {
  const existing = threads.find((candidate) => candidate.threadId === thread.threadId);
  if (!existing) {
    return sortThreadSummaries([thread, ...threads]);
  }

  return sortThreadSummaries(
    threads.map((candidate) => (candidate.threadId === thread.threadId ? thread : candidate)),
  );
}

function areThreadSummariesEqual(left: CodexThreadSummary[], right: CodexThreadSummary[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (!areThreadSummariesStructurallyEqual(left[index], right[index])) {
      return false;
    }
  }
  return true;
}

function areThreadSummariesStructurallyEqual(
  left: CodexThreadSummary,
  right: CodexThreadSummary,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.source?.parentThreadId === right.source?.parentThreadId &&
    left.source?.sideConversation === right.source?.sideConversation &&
    left.source?.sideConversationParentNavigationPath ===
      right.source?.sideConversationParentNavigationPath &&
    left.ephemeral === right.ephemeral &&
    left.threadSource === right.threadSource &&
    left.agentNickname === right.agentNickname &&
    left.agentRole === right.agentRole &&
    left.agentPath === right.agentPath &&
    left.threadName === right.threadName &&
    left.threadPreview === right.threadPreview &&
    left.cwd === right.cwd &&
    left.statusType === right.statusType &&
    left.statusActiveFlags.join("|") === right.statusActiveFlags.join("|") &&
    areThreadRuntimeStatusesEqual(left.threadRuntimeStatus, right.threadRuntimeStatus) &&
    left.archived === right.archived &&
    left.hasUnreadTurn === right.hasUnreadTurn &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.linkedAt === right.linkedAt
  );
}

function areConversationChildThreadMetadataEqual(
  left: CodexConversationChildMembership["thread"] | undefined,
  right: CodexConversationChildMembership["thread"] | undefined,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === normalizedRight) return true;
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.nickname === normalizedRight.nickname &&
    normalizedLeft.displayName === normalizedRight.displayName &&
    normalizedLeft.name === normalizedRight.name &&
    normalizedLeft.model === normalizedRight.model &&
    normalizedLeft.agentRole === normalizedRight.agentRole
  );
}

function areConversationChildMembershipsEqual(
  left: readonly CodexConversationChildMembership[] | undefined,
  right: readonly CodexConversationChildMembership[],
): boolean {
  const normalizedLeft = left ?? [];
  if (normalizedLeft.length !== right.length) return false;
  for (let index = 0; index < normalizedLeft.length; index += 1) {
    const leftEntry = normalizedLeft[index];
    const rightEntry = right[index];
    if (!leftEntry || !rightEntry) return false;
    if (
      leftEntry.threadId !== rightEntry.threadId ||
      leftEntry.parentThreadId !== rightEntry.parentThreadId ||
      leftEntry.role !== rightEntry.role ||
      leftEntry.actorName !== rightEntry.actorName ||
      leftEntry.displayName !== rightEntry.displayName ||
      leftEntry.agentRole !== rightEntry.agentRole ||
      leftEntry.agentPath !== rightEntry.agentPath ||
      leftEntry.createdAtMs !== rightEntry.createdAtMs ||
      leftEntry.updatedAtMs !== rightEntry.updatedAtMs ||
      leftEntry.statusType !== rightEntry.statusType ||
      leftEntry.showInlineActivity !== rightEntry.showInlineActivity ||
      !areConversationChildThreadMetadataEqual(leftEntry.thread, rightEntry.thread)
    ) {
      return false;
    }
  }
  return true;
}

function areConversationMapSelectionsEqual(
  left: Record<string, CodexConversationSnapshot>,
  right: Record<string, CodexConversationSnapshot>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  for (const key of leftKeys) {
    if (left[key] !== right[key]) {
      return false;
    }
  }

  return true;
}

function areThreadSummaryMapSelectionsEqual(
  left: Record<string, CodexThreadSummary>,
  right: Record<string, CodexThreadSummary>,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => {
    const leftSummary = left[key];
    const rightSummary = right[key];
    return Boolean(
      leftSummary && rightSummary && areThreadSummariesStructurallyEqual(leftSummary, rightSummary),
    );
  });
}

function subscribeSet<T>(listeners: Set<T>, listener: T): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getOrCreateListenerSet<T>(callbacksByKey: Map<string, Set<T>>, key: string): Set<T> {
  const existing = callbacksByKey.get(key);
  if (existing) {
    return existing;
  }

  const listeners = new Set<T>();
  callbacksByKey.set(key, listeners);
  return listeners;
}

function cleanupListenerSet<T>(callbacksByKey: Map<string, Set<T>>, key: string): void {
  const listeners = callbacksByKey.get(key);
  if (listeners && listeners.size === 0) {
    callbacksByKey.delete(key);
  }
}

function getThreadStartProgressTargetKey(
  projectId: string | null,
  sessionId: string | null,
): string {
  return `${projectId ?? "projectless"}:${sessionId ?? "sessionless"}`;
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function areThreadRuntimeStatusesEqual(
  left: CodexThreadRuntimeStatus | null | undefined,
  right: CodexThreadRuntimeStatus | null | undefined,
): boolean {
  if (left === right) return true;
  if (left?.type !== right?.type) return false;
  if (left?.type !== "active" || right?.type !== "active") return true;
  return areStringArraysEqual(left.activeFlags, right.activeFlags);
}

interface ConversationAnyProjection {
  id: string;
  requestsRef: readonly unknown[];
  turnsLength: number;
  lastTurnId: string | null;
  lastTurnStatus: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  title: string | null;
  resumeState: CodexConversationSnapshot["resumeState"];
  statusType: CodexConversationSnapshot["statusType"];
  statusActiveFlags: readonly CodexThreadActiveFlag[];
  cwd: string | null;
  hasUnreadTurn: boolean;
}

interface ConversationMetaProjection {
  id: string;
  projectId: string | null;
  archived: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  title: string | null;
  threadPreview: string;
  resumeState: CodexConversationSnapshot["resumeState"];
  statusType: CodexConversationSnapshot["statusType"];
  statusActiveFlags: readonly CodexThreadActiveFlag[];
  hasUnreadTurn: boolean;
}

interface ConversationSummaryFields {
  threadId: string | null;
  projectId: string | null;
  threadName: string | null;
  threadPreview: string;
  cwd: string | null;
  managedWorktreePath: string | null;
  projectlessOutputDirectory: string | null;
  projectlessWorkspaceBrowserRoot: string | null;
  archived: boolean;
  hasUnreadTurn: boolean;
  createdAt: number;
  updatedAt: number;
  linkedAt: string;
}

function buildConversationAnyProjection(
  conversation: CodexConversationSnapshot,
): ConversationAnyProjection {
  const lastTurn = conversation.turns[conversation.turns.length - 1] ?? null;
  return {
    id: conversation.threadId,
    requestsRef: conversation.requests,
    turnsLength: conversation.turns.length,
    lastTurnId: lastTurn?.turnId ?? null,
    lastTurnStatus: lastTurn?.status ?? null,
    createdAtMs: conversation.createdAt,
    updatedAtMs: conversation.updatedAt,
    title: conversation.threadName?.trim() || conversation.threadPreview?.trim() || null,
    resumeState: conversation.resumeState,
    statusType: conversation.statusType,
    statusActiveFlags: conversation.statusActiveFlags,
    cwd: conversation.cwd,
    hasUnreadTurn: conversation.hasUnreadTurn ?? false,
  };
}

function buildConversationMetaProjection(
  conversation: CodexConversationSnapshot,
): ConversationMetaProjection {
  return {
    id: conversation.threadId,
    projectId: conversation.projectId,
    archived: conversation.archived,
    createdAtMs: conversation.createdAt,
    updatedAtMs: conversation.updatedAt,
    title: conversation.threadName?.trim() || null,
    threadPreview: conversation.threadPreview,
    resumeState: conversation.resumeState,
    statusType: conversation.statusType,
    statusActiveFlags: conversation.statusActiveFlags,
    hasUnreadTurn: conversation.hasUnreadTurn ?? false,
  };
}

function areConversationAnyProjectionsEqual(
  left: ConversationAnyProjection,
  right: ConversationAnyProjection,
): boolean {
  return (
    left.id === right.id &&
    left.requestsRef === right.requestsRef &&
    left.turnsLength === right.turnsLength &&
    left.lastTurnId === right.lastTurnId &&
    left.lastTurnStatus === right.lastTurnStatus &&
    left.createdAtMs === right.createdAtMs &&
    left.updatedAtMs === right.updatedAtMs &&
    left.title === right.title &&
    left.resumeState === right.resumeState &&
    left.statusType === right.statusType &&
    areStringArraysEqual(left.statusActiveFlags, right.statusActiveFlags) &&
    left.cwd === right.cwd &&
    left.hasUnreadTurn === right.hasUnreadTurn
  );
}

function areConversationMetaProjectionsEqual(
  left: ConversationMetaProjection,
  right: ConversationMetaProjection,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.archived === right.archived &&
    left.hasUnreadTurn === right.hasUnreadTurn &&
    left.createdAtMs === right.createdAtMs &&
    left.updatedAtMs === right.updatedAtMs &&
    left.title === right.title &&
    left.threadPreview === right.threadPreview &&
    left.resumeState === right.resumeState &&
    left.statusType === right.statusType &&
    areStringArraysEqual(left.statusActiveFlags, right.statusActiveFlags) &&
    left.hasUnreadTurn === right.hasUnreadTurn
  );
}

function areConversationSummaryFieldsEqual(
  left: ConversationSummaryFields,
  right: ConversationSummaryFields,
): boolean {
  return (
    left.threadId === right.threadId &&
    left.projectId === right.projectId &&
    left.threadName === right.threadName &&
    left.threadPreview === right.threadPreview &&
    left.cwd === right.cwd &&
    left.managedWorktreePath === right.managedWorktreePath &&
    left.projectlessOutputDirectory === right.projectlessOutputDirectory &&
    left.projectlessWorkspaceBrowserRoot === right.projectlessWorkspaceBrowserRoot &&
    left.archived === right.archived &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    left.linkedAt === right.linkedAt
  );
}

function isConversationUserMessageItem(item: CodexConversationItem): boolean {
  return item.kind === "userMessage" || item.semanticKind === "userMessage";
}

function conversationTurnHasUserMessage(turn: CodexConversationTurn): boolean {
  return turn.items.some(isConversationUserMessageItem);
}

function resolveLatestEditableUserTurnId(conversation: CodexConversationSnapshot): string | null {
  const latestTurn = conversation.turns.at(-1) ?? null;
  if (!latestTurn || latestTurn.status === "inProgress") return null;
  if (!conversationTurnHasUserMessage(latestTurn)) return null;

  const hasPendingRequest = conversation.requests.some(
    (request) => request.turnId === latestTurn.turnId,
  );
  if (hasPendingRequest) return null;

  return latestTurn.turnId;
}

function areConversationCapabilityFlagsEqual(
  left: CodexConversationCapabilityFlags | undefined,
  right: CodexConversationCapabilityFlags,
): boolean {
  return Boolean(
    left &&
    left.canEditLastUserTurn === right.canEditLastUserTurn &&
    left.canForkFromTurn === right.canForkFromTurn &&
    left.canSearch === right.canSearch &&
    left.canCollapseTurns === right.canCollapseTurns,
  );
}

function deriveConversationCapabilityFlags(
  conversation: CodexConversationSnapshot,
): CodexConversationCapabilityFlags {
  if (conversation.source?.sideConversation === true) {
    return {
      canEditLastUserTurn: false,
      canForkFromTurn: false,
      canSearch: true,
      canCollapseTurns: true,
    };
  }

  const isConversationActionable =
    !conversation.archived && conversation.statusType !== "systemError";
  return {
    canEditLastUserTurn: Boolean(
      isConversationActionable && resolveLatestEditableUserTurnId(conversation),
    ),
    canForkFromTurn: Boolean(isConversationActionable && conversation.turns.length > 0),
    canSearch: true,
    canCollapseTurns: true,
  };
}

function normalizeConversationSnapshot(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot {
  const nextTurns = Array.isArray(conversation.turns) ? conversation.turns : [];
  const nextRequests = Array.isArray(conversation.requests) ? conversation.requests : [];
  const nextPendingSteers = Array.isArray(conversation.pendingSteers)
    ? conversation.pendingSteers
    : [];
  const nextQueuedFollowUps =
    conversation.queuedFollowUps &&
    typeof conversation.queuedFollowUps === "object" &&
    Array.isArray(conversation.queuedFollowUps.entries)
      ? conversation.queuedFollowUps
      : EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION;
  const nextBackgroundTerminalRows = Array.isArray(conversation.backgroundTerminalRows)
    ? conversation.backgroundTerminalRows
    : [];
  const nextStatusActiveFlags = Array.isArray(conversation.statusActiveFlags)
    ? conversation.statusActiveFlags
    : [];
  const nextThreadName = typeof conversation.threadName === "string" ? conversation.threadName : "";
  const nextThreadPreview =
    typeof conversation.threadPreview === "string" ? conversation.threadPreview : "";
  const nextCreatedAt = Number.isFinite(conversation.createdAt) ? conversation.createdAt : 0;
  const nextUpdatedAt = Number.isFinite(conversation.updatedAt)
    ? conversation.updatedAt
    : nextCreatedAt;
  const nextHasUnreadTurn = conversation.hasUnreadTurn === true;
  const nextSource: CodexConversationSource | null =
    typeof conversation.source === "object" && conversation.source !== null
      ? {
          parentThreadId:
            typeof conversation.source.parentThreadId === "string" &&
            conversation.source.parentThreadId.trim().length > 0
              ? conversation.source.parentThreadId
              : null,
          ...(conversation.source.sideConversation === true ? { sideConversation: true } : {}),
          ...(typeof conversation.source.sideConversationParentNavigationPath === "string"
            ? {
                sideConversationParentNavigationPath:
                  conversation.source.sideConversationParentNavigationPath,
              }
            : conversation.source.sideConversation === true
              ? { sideConversationParentNavigationPath: null }
              : {}),
        }
      : null;

  const didChange =
    nextTurns !== conversation.turns ||
    nextRequests !== conversation.requests ||
    nextPendingSteers !== conversation.pendingSteers ||
    nextQueuedFollowUps !== conversation.queuedFollowUps ||
    nextBackgroundTerminalRows !== conversation.backgroundTerminalRows ||
    nextStatusActiveFlags !== conversation.statusActiveFlags ||
    nextSource?.parentThreadId !== conversation.source?.parentThreadId ||
    nextSource?.sideConversation !== conversation.source?.sideConversation ||
    nextSource?.sideConversationParentNavigationPath !==
      conversation.source?.sideConversationParentNavigationPath ||
    nextThreadName !== conversation.threadName ||
    nextThreadPreview !== conversation.threadPreview ||
    nextCreatedAt !== conversation.createdAt ||
    nextUpdatedAt !== conversation.updatedAt ||
    nextHasUnreadTurn !== conversation.hasUnreadTurn;

  const normalizedConversation = didChange
    ? {
        ...conversation,
        source: nextSource,
        threadName: nextThreadName,
        threadPreview: nextThreadPreview,
        createdAt: nextCreatedAt,
        updatedAt: nextUpdatedAt,
        hasUnreadTurn: nextHasUnreadTurn,
        turns: nextTurns,
        requests: nextRequests,
        pendingSteers: nextPendingSteers,
        queuedFollowUps: nextQueuedFollowUps,
        backgroundTerminalRows: nextBackgroundTerminalRows,
        statusActiveFlags: nextStatusActiveFlags,
      }
    : conversation;
  const nextCapabilityFlags = deriveConversationCapabilityFlags(normalizedConversation);

  if (
    areConversationCapabilityFlagsEqual(normalizedConversation.capabilityFlags, nextCapabilityFlags)
  ) {
    return normalizedConversation;
  }

  return {
    ...normalizedConversation,
    capabilityFlags: nextCapabilityFlags,
  };
}

function applyOwnerBackgroundTerminalCleanupToConversation(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot | null {
  const canonicalBefore = conversation.canonicalState;
  if (!canonicalBefore) return null;
  const canonicalState = reduceCodexBackgroundTerminalCleanup(canonicalBefore);
  const nextTurns = conversation.turns.map((turn) => {
    const canonicalTurn = canonicalState.turns.find(
      (candidate) => candidate.protocol.id === turn.turnId,
    );
    const interrupted = canonicalTurn?.sidecar.interruptedCommandExecutionItemIds;
    if (interrupted === undefined) return turn;
    return {
      ...turn,
      interruptedCommandExecutionItemIds: [...interrupted],
    };
  });

  const hadBackgroundRows = conversation.backgroundTerminalRows.length > 0;
  const didChangeTurns = nextTurns.some((turn, index) => turn !== conversation.turns[index]);
  if (!didChangeTurns && !hadBackgroundRows) {
    return null;
  }

  return {
    ...conversation,
    canonicalState,
    turns: nextTurns,
    backgroundTerminalRows: hadBackgroundRows ? [] : conversation.backgroundTerminalRows,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCodexQueueOwnerUpdateRequest(value: unknown): value is CodexQueueOwnerUpdateRequest {
  const input = asRecord(value);
  const projection = asRecord(input?.projection);
  const transcript = asRecord(input?.transcript);
  if (!input || !projection || !transcript) return false;
  if (typeof input.threadId !== "string" || !input.threadId.trim()) return false;
  if (
    !isNonNegativeInteger(input.threadGeneration) ||
    !isNonNegativeInteger(input.ownerEpoch) ||
    !isNonNegativeInteger(input.projectionRevision)
  ) {
    return false;
  }
  if (
    projection.status !== "loading" &&
    projection.status !== "ready" &&
    projection.status !== "error"
  ) {
    return false;
  }
  if (
    !isNonNegativeInteger(projection.ledgerRevision) ||
    projection.projectionRevision !== input.projectionRevision ||
    !Array.isArray(projection.entries) ||
    !projection.entries.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { threadId?: unknown }).threadId === input.threadId &&
        typeof (entry as { followUpId?: unknown }).followUpId === "string",
    ) ||
    (projection.inFlightFollowUpId !== null && typeof projection.inFlightFollowUpId !== "string") ||
    (projection.editingFollowUpId !== null && typeof projection.editingFollowUpId !== "string") ||
    (projection.error !== null && typeof projection.error !== "string")
  ) {
    return false;
  }

  switch (transcript.kind) {
    case "none":
      return true;
    case "stageSteer":
      return (
        isNonNegativeInteger(transcript.observedAtMs) &&
        typeof transcript.item === "object" &&
        transcript.item !== null &&
        (transcript.item as { type?: unknown }).type === "steeringUserMessage"
      );
    case "retargetSteer":
      return (
        typeof transcript.clientUserMessageId === "string" &&
        Boolean(transcript.clientUserMessageId.trim()) &&
        typeof transcript.targetTurnId === "string" &&
        Boolean(transcript.targetTurnId.trim())
      );
    case "rejectSteer":
      return (
        typeof transcript.clientUserMessageId === "string" &&
        Boolean(transcript.clientUserMessageId.trim())
      );
    default:
      return false;
  }
}

function findPendingCanonicalSteer(
  state: CodexCanonicalConversationState,
  clientUserMessageId: string,
): { readonly turnId: string; readonly item: CodexCanonicalSteeringUserMessageItem } | null {
  for (const turn of state.turns) {
    const turnId = turn.protocol.id;
    if (!turnId) continue;
    const item = turn.items.find(
      (candidate): candidate is CodexCanonicalSteeringUserMessageItem =>
        candidate.type === "steeringUserMessage" &&
        candidate.status === "pending" &&
        candidate.clientUserMessageId === clientUserMessageId,
    );
    if (item) return { turnId, item };
  }
  return null;
}

function applyQueueOwnerTranscriptDirective(
  conversation: CodexConversationSnapshot,
  directive: CodexQueueOwnerTranscriptDirective,
): Pick<CodexConversationSnapshot, "canonicalState" | "pendingSteers"> | null {
  if (directive.kind === "none") {
    return {
      canonicalState: conversation.canonicalState ?? null,
      pendingSteers: conversation.pendingSteers,
    };
  }

  const canonical = conversation.canonicalState;
  if (!canonical) return null;

  if (directive.kind === "stageSteer") {
    const targetTurnId = directive.item.targetTurnId;
    if (!targetTurnId) return null;
    const restore = asRecord(directive.item.restoreMessage);
    const queueRow = asRecord(restore?.queueRow);
    const pendingSteer: CodexPendingSteer = {
      steerId: directive.item.id,
      threadId: conversation.threadId,
      turnId: targetTurnId,
      prompt: typeof queueRow?.prompt === "string" ? queueRow.prompt : "",
      createdAt: directive.observedAtMs,
    };
    return {
      canonicalState: upsertCodexCanonicalSteeringItem(canonical, targetTurnId, directive.item),
      pendingSteers: [
        ...conversation.pendingSteers.filter((entry) => entry.steerId !== pendingSteer.steerId),
        pendingSteer,
      ],
    };
  }

  const pending = findPendingCanonicalSteer(canonical, directive.clientUserMessageId);
  if (!pending) {
    return { canonicalState: canonical, pendingSteers: conversation.pendingSteers };
  }

  if (directive.kind === "retargetSteer") {
    return {
      canonicalState: retargetCodexCanonicalSteeringItem(
        canonical,
        pending.turnId,
        directive.targetTurnId,
        pending.item.id,
      ),
      pendingSteers: conversation.pendingSteers.map((entry) =>
        entry.steerId === pending.item.id ? { ...entry, turnId: directive.targetTurnId } : entry,
      ),
    };
  }

  return {
    canonicalState: removeCodexCanonicalSteeringItem(canonical, pending.turnId, pending.item.id),
    pendingSteers: conversation.pendingSteers.filter((entry) => entry.steerId !== pending.item.id),
  };
}

function isProseRecord(record: Record<string, unknown>): boolean {
  return (
    record.role === "assistant" ||
    record.kind === "assistantMessage" ||
    record.kind === "plan" ||
    record.kind === "reasoning" ||
    record.semanticKind === "assistantMessage" ||
    record.semanticKind === "proposedPlan" ||
    record.semanticKind === "reasoning"
  );
}

function isInProgressProsePatchValue(value: unknown): boolean {
  const record = asRecord(value);
  return Boolean(
    record &&
    record.status === "inProgress" &&
    typeof record.markdownText === "string" &&
    isProseRecord(record),
  );
}

function patchValueContainsInProgressProse(value: unknown): boolean {
  if (isInProgressProsePatchValue(value)) return true;
  if (!Array.isArray(value)) return false;

  return value.some((entry) => patchValueContainsInProgressProse(entry));
}

function conversationHasInProgressProseItem(conversation: CodexConversationSnapshot): boolean {
  for (const turn of conversation.turns) {
    for (const item of turn.items) {
      if (
        item.status === "inProgress" &&
        typeof item.markdownText === "string" &&
        isProseRecord(item as unknown as Record<string, unknown>)
      ) {
        return true;
      }
    }
  }

  return false;
}

function shouldSynchronouslyNotifyStreamingProsePatch(
  nextConversation: CodexConversationSnapshot,
  patches: OwnerStreamPublishPatches,
): boolean {
  for (const patch of patches) {
    if (
      patch.path.includes("markdownText") &&
      conversationHasInProgressProseItem(nextConversation)
    ) {
      return true;
    }

    if (patch.op !== "remove" && patchValueContainsInProgressProse(patch.value)) {
      return true;
    }
  }

  return false;
}

function getString(candidate: Record<string, unknown>, key: string): string | null {
  const value = candidate[key];
  return typeof value === "string" ? value : null;
}

function getOwnerTurnId(turn: CodexConversationTurn): string | null {
  const value = (turn as { turnId?: unknown }).turnId;
  return typeof value === "string" && value.length > 0 ? value : null;
}

function replaceOwnerTurnAt(
  conversation: CodexConversationSnapshot,
  turnIndex: number,
  turn: CodexConversationTurn,
): CodexConversationSnapshot {
  const turns = [...conversation.turns];
  turns[turnIndex] = turn;
  return {
    ...conversation,
    turns,
  };
}

function insertOwnerTurnAt(
  conversation: CodexConversationSnapshot,
  turnIndex: number,
  turn: CodexConversationTurn,
): {
  conversation: CodexConversationSnapshot;
  turnIndex: number;
} {
  const turns = [...conversation.turns];
  const insertionIndex = Math.min(turnIndex, turns.length);
  turns.splice(insertionIndex, 0, turn);
  return {
    conversation: { ...conversation, turns },
    turnIndex: insertionIndex,
  };
}

function findOwnerTurnItemByItemId(
  conversation: CodexConversationSnapshot,
  itemId: string,
): {
  turnIndex: number;
  itemIndex: number;
  turn: CodexConversationTurn;
  item: CodexConversationItem;
} | null {
  for (let turnIndex = conversation.turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = conversation.turns[turnIndex];
    if (!turn) continue;

    const itemIndex = turn.items.findIndex((candidate) => candidate.itemId === itemId);
    const item = itemIndex >= 0 ? turn.items[itemIndex] : null;
    if (item) {
      return {
        turnIndex,
        itemIndex,
        turn,
        item,
      };
    }
  }

  return null;
}

function readOwnerStreamingDebugItemState(
  conversation: CodexConversationSnapshot,
  itemId: string,
): Record<string, unknown> {
  const target = findOwnerTurnItemByItemId(conversation, itemId);
  if (!target) {
    return { found: false };
  }

  return {
    found: true,
    turnId: target.turn.turnId ?? null,
    turnStatus: target.turn.status,
    itemStatus: target.item.status ?? null,
    itemKind: target.item.kind,
    itemSemanticKind: target.item.semanticKind ?? null,
    markdownLength: target.item.markdownText?.length ?? 0,
  };
}

function buildRecentConversationOrderKey(
  conversations: readonly CodexConversationSnapshot[],
): string {
  return conversations
    .map(
      (conversation) =>
        `${conversation.threadId}:${conversation.updatedAt}:${conversation.resumeState}:${conversation.statusType}`,
    )
    .join("|");
}

interface OwnerItemLifecyclePayload {
  threadId: string;
  turnId: string | null;
  item: ThreadItem;
  observedAtMs: number;
  notification: CodexItemLifecycleNotification;
}

function toOwnerItemLifecyclePayload(
  notification: CodexItemLifecycleNotification,
): OwnerItemLifecyclePayload {
  const { threadId, turnId, item } = notification.params;
  const observedAtMs =
    notification.method === "item/started"
      ? notification.params.startedAtMs
      : notification.params.completedAtMs;

  return {
    threadId,
    turnId,
    item,
    observedAtMs,
    notification,
  };
}

function projectConversationItemToIdentityView(item: CodexConversationItem): CodexItemView {
  return {
    ...item,
    normalizedKind: item.kind,
  } as CodexItemView;
}

interface OwnerCanonicalLifecycleHiddenTurn {
  readonly sourceTurnKey: string;
  readonly targetTurnKey: string;
  readonly itemTypes: ReadonlyMap<string, string>;
}

interface OwnerCanonicalLifecycleProjectionResult {
  readonly conversation: CodexConversationSnapshot;
  readonly hiddenTurns: readonly OwnerCanonicalLifecycleHiddenTurn[];
}

interface OwnerCanonicalProjectionOptions {
  readonly observedAtMs: number;
  readonly lifecycleStatus?: CodexItemStatus;
  readonly preserveExistingUpdatedAt?: boolean;
}

function applyOwnerCanonicalTurnProjection(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  after: CodexCanonicalConversationState,
  options: OwnerCanonicalProjectionOptions,
): OwnerCanonicalLifecycleProjectionResult {
  let nextConversation = conversation;
  let didProjectChange = false;
  const hiddenTurns: OwnerCanonicalLifecycleHiddenTurn[] = [];

  for (const [turnIndex, afterTurn] of after.turns.entries()) {
    const beforeTurn = before.turns[turnIndex] ?? null;
    if (afterTurn === beforeTurn) continue;

    const targetTurnId = afterTurn.protocol.id;
    const sourceTurnId = beforeTurn ? beforeTurn.protocol.id : targetTurnId;
    const sourceTurnKey = buildCodexTurnOccurrenceKey(sourceTurnId, turnIndex);
    const targetTurnKey = buildCodexTurnOccurrenceKey(targetTurnId, turnIndex);
    const indexedOwnerTurn = nextConversation.turns[turnIndex];
    let ownerTurnIndex = indexedOwnerTurn ? turnIndex : -1;
    if (ownerTurnIndex < 0) {
      const boundIds = new Set(
        [targetTurnId, sourceTurnId].filter((turnId): turnId is string => turnId !== null),
      );
      if (boundIds.size > 0) {
        ownerTurnIndex = nextConversation.turns.findIndex((turn) => {
          const turnId = getOwnerTurnId(turn);
          return turnId !== null && boundIds.has(turnId);
        });
      }
      if (ownerTurnIndex < 0) {
        const inserted = insertOwnerTurnAt(
          nextConversation,
          turnIndex,
          buildOwnerCanonicalTurnPlaceholder(conversation.threadId, afterTurn),
        );
        nextConversation = inserted.conversation;
        ownerTurnIndex = inserted.turnIndex;
      }
    }

    const currentTurn = nextConversation.turns[ownerTurnIndex];
    if (!currentTurn) continue;
    const currentViews = currentTurn.items.map(projectConversationItemToIdentityView);
    const projection = applyCodexLifecycleProjectionDiff({
      threadId: conversation.threadId,
      turnKey: targetTurnKey,
      beforeTurn,
      afterTurn,
      currentViews,
      currentTranscript: currentTurn.items,
      observedAtMs: options.observedAtMs,
      lifecycleStatus: options.lifecycleStatus,
      isBackgroundSubagentsEnabled: true,
      preserveExistingUpdatedAt: options.preserveExistingUpdatedAt,
    });
    const lifecycleStatusChangedItemIds = collectCodexLifecycleStatusChangedItemIds(
      beforeTurn,
      afterTurn,
    );
    const canonicalItemsUnchanged = Boolean(
      beforeTurn &&
      beforeTurn.items.length === afterTurn.items.length &&
      beforeTurn.items.every((item, index) => item === afterTurn.items[index]),
    );
    const didItemProjectionChange =
      sourceTurnId !== targetTurnId ||
      beforeTurn === null ||
      !canonicalItemsUnchanged ||
      beforeTurn.protocol.status !== afterTurn.protocol.status ||
      !areCodexCanonicalTurnParamsEqual(beforeTurn.sidecar.params, afterTurn.sidecar.params) ||
      lifecycleStatusChangedItemIds.size > 0 ||
      beforeTurn.sidecar.commandExecutionStartedAtMsById !==
        afterTurn.sidecar.commandExecutionStartedAtMsById ||
      beforeTurn.sidecar.interruptedCommandExecutionItemIds !==
        afterTurn.sidecar.interruptedCommandExecutionItemIds;
    const didTurnProjectionChange =
      didItemProjectionChange ||
      sourceTurnId !== targetTurnId ||
      beforeTurn === null ||
      beforeTurn.protocol.status !== afterTurn.protocol.status ||
      beforeTurn.protocol.error !== afterTurn.protocol.error ||
      beforeTurn.protocol.durationMs !== afterTurn.protocol.durationMs ||
      !areCodexCanonicalTurnParamsEqual(beforeTurn.sidecar.params, afterTurn.sidecar.params) ||
      beforeTurn.sidecar.turnStartedAtMs !== afterTurn.sidecar.turnStartedAtMs ||
      beforeTurn.sidecar.completedAtMs !== afterTurn.sidecar.completedAtMs ||
      beforeTurn.sidecar.firstTurnWorkItemStartedAtMs !==
        afterTurn.sidecar.firstTurnWorkItemStartedAtMs ||
      beforeTurn.sidecar.finalAssistantStartedAtMs !==
        afterTurn.sidecar.finalAssistantStartedAtMs ||
      beforeTurn.sidecar.commandExecutionStartedAtMsById !==
        afterTurn.sidecar.commandExecutionStartedAtMsById ||
      beforeTurn.sidecar.interruptedCommandExecutionItemIds !==
        afterTurn.sidecar.interruptedCommandExecutionItemIds ||
      beforeTurn.sidecar.hookRuns !== afterTurn.sidecar.hookRuns ||
      beforeTurn.sidecar.diff !== afterTurn.sidecar.diff ||
      beforeTurn.sidecar.safetyBuffering !== afterTurn.sidecar.safetyBuffering;
    if (!didTurnProjectionChange) continue;
    didProjectChange = true;
    const visibleOwnerIds = new Set(
      projection.views.flatMap((view) => (view.rawItemId ? [view.rawItemId] : [])),
    );
    const hiddenItemTypes = new Map<string, string>();
    for (const item of afterTurn.items) {
      if (visibleOwnerIds.has(item.id)) continue;
      hiddenItemTypes.set(item.id, item.type);
    }
    hiddenTurns.push({ sourceTurnKey, targetTurnKey, itemTypes: hiddenItemTypes });

    const projectedTurnItems = didItemProjectionChange
      ? projection.transcript.map((entry) => {
          const item = entry as CodexConversationItem;
          if (!item.mcpToolCall) return item;
          const mcpToolCall = completeCodexMcpToolCallForTurn(
            item.mcpToolCall,
            afterTurn.protocol.status,
          );
          return mcpToolCall === item.mcpToolCall ? item : { ...item, mcpToolCall };
        })
      : currentTurn.items;
    const nextTurn: CodexConversationTurn = {
      ...currentTurn,
      turnId: targetTurnId,
      status: afterTurn.protocol.status,
      errorMessage: afterTurn.protocol.error?.message ?? undefined,
      diff: afterTurn.sidecar.diff ?? undefined,
      durationMs: afterTurn.protocol.durationMs,
      itemIds:
        targetTurnId === null
          ? [...new Set(projection.transcript.map((entry) => entry.itemId))]
          : [...projection.itemIds],
      turnStartedAtMs: afterTurn.sidecar.turnStartedAtMs,
      firstTurnWorkItemStartedAtMs: afterTurn.sidecar.firstTurnWorkItemStartedAtMs,
      finalAssistantStartedAtMs: afterTurn.sidecar.finalAssistantStartedAtMs,
      startedAt: afterTurn.sidecar.turnStartedAtMs,
      completedAt: afterTurn.sidecar.completedAtMs ?? null,
      commandExecutionStartedAtMsById:
        afterTurn.sidecar.commandExecutionStartedAtMsById === undefined
          ? undefined
          : { ...afterTurn.sidecar.commandExecutionStartedAtMsById },
      interruptedCommandExecutionItemIds:
        afterTurn.sidecar.interruptedCommandExecutionItemIds === undefined
          ? undefined
          : [...afterTurn.sidecar.interruptedCommandExecutionItemIds],
      hookRuns:
        afterTurn.sidecar.hookRuns === undefined ? undefined : [...afterTurn.sidecar.hookRuns],
      safetyBuffering:
        afterTurn.sidecar.safetyBuffering === undefined
          ? undefined
          : {
              ...afterTurn.sidecar.safetyBuffering,
              useCases: [...afterTurn.sidecar.safetyBuffering.useCases],
              reasons: [...afterTurn.sidecar.safetyBuffering.reasons],
            },
      items: projectedTurnItems,
    };
    nextConversation = replaceOwnerTurnAt(nextConversation, ownerTurnIndex, nextTurn);
  }

  return {
    conversation: didProjectChange
      ? {
          ...nextConversation,
          updatedAt:
            options.preserveExistingUpdatedAt !== true
              ? Math.max(nextConversation.updatedAt, options.observedAtMs)
              : nextConversation.updatedAt,
        }
      : nextConversation,
    hiddenTurns,
  };
}

function projectOwnerCanonicalTurnMetadataResult(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  result: CodexTurnMetadataResult,
  observedAtMs: number,
): CodexConversationSnapshot {
  if (result.state === before) return conversation;
  const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
    observedAtMs,
    preserveExistingUpdatedAt: true,
  });
  const touchedAtMs = result.effects.find(
    (effect) => effect.type === "touchConversationUpdatedAt",
  )?.observedAtMs;
  return {
    ...projection.conversation,
    canonicalState: result.state,
    updatedAt:
      touchedAtMs === undefined
        ? projection.conversation.updatedAt
        : Math.max(projection.conversation.updatedAt, touchedAtMs),
  };
}

function toSharedConversationDocument(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot {
  const requests = conversation.requests.filter(
    (request) => request.type !== "nodexAgentAuthorization",
  );
  return requests.length === conversation.requests.length
    ? conversation
    : { ...conversation, requests };
}

function resolveAcceptedConversationReplica(input: {
  conversation: CodexConversationSnapshot;
  revision: number;
  checkpoint: CodexThreadStreamCheckpoint;
  context: string;
}): CodexConversationSnapshot {
  if (input.checkpoint.revision !== input.revision) {
    throw new Error(
      `${input.context} revision ${input.revision} does not match checkpoint revision ${input.checkpoint.revision}`,
    );
  }

  const replica = toSharedConversationDocument(input.conversation);
  if (hashCodexConversationReplica(replica) !== input.checkpoint.canonicalHash) {
    throw new Error(`${input.context} checkpoint diverged`);
  }
  return replica;
}

type OwnerTurnLifecycleMethod = "turn/started" | "turn/completed";
type OwnerTurnLifecycleNotification = Extract<
  CodexThreadOwnerNotificationEvent["notification"],
  { method: OwnerTurnLifecycleMethod }
>;

interface OwnerTurnLifecyclePayload {
  threadId: string;
  turnId: string;
  status: CodexTurnStatus;
  errorMessage?: string;
  startedAt?: number | null;
  completedAt?: number | null;
  turnStartedAtMs?: number | null;
  durationMs?: number | null;
  observedAtMs: number;
}

function normalizeOwnerTurnStatus(value: unknown, fallback: CodexTurnStatus): CodexTurnStatus {
  if (
    value === "completed" ||
    value === "interrupted" ||
    value === "failed" ||
    value === "inProgress"
  ) {
    return value;
  }
  if (value === "in_progress") return "inProgress";
  return fallback;
}

function normalizeOwnerTimestamp(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value > 0 && value < 10_000_000_000) return value * 1000;
  return value;
}

function parseOwnerTurnErrorMessage(value: unknown): string | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  const message = getString(candidate, "message");
  return message ?? undefined;
}

function buildOwnerTextUserInput(text: string): UserInput {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function isLikelyLocalImageSource(source: string): boolean {
  return source.startsWith("/") || source.startsWith("file://") || /^[A-Za-z]:[\\/]/u.test(source);
}

async function resolveOwnerPromptImageInput(source: string): Promise<UserInput> {
  const normalizedSource = source.trim();
  if (
    normalizedSource.startsWith("http://") ||
    normalizedSource.startsWith("https://") ||
    normalizedSource.startsWith("data:image/")
  ) {
    return { type: "image", url: normalizedSource };
  }

  if (parseAssetSource(normalizedSource)) {
    const resolvedPath = await runConversationOperation("asset:resolve-path", normalizedSource);
    if (typeof resolvedPath !== "string" || !resolvedPath.trim()) {
      throw new Error(`Could not resolve image asset: ${normalizedSource}`);
    }
    return { type: "localImage", path: resolvedPath };
  }

  if (isLikelyLocalImageSource(normalizedSource)) {
    return {
      type: "localImage",
      path: normalizedSource.replace(/^file:\/\//u, ""),
    };
  }

  throw new Error(`Unsupported image source: ${normalizedSource}`);
}

function buildOwnerPromptInputFromUserInputItems(
  items: readonly UserInput[],
  fallbackText: string,
): CodexPromptInput {
  const promptInput: CodexPromptInput = { text: fallbackText };
  const textAttachments: CodexPromptInput["textAttachments"] = [];
  const images: CodexPromptInput["images"] = [];
  const mentions: CodexPromptInput["mentions"] = [];
  const skills: CodexPromptInput["skills"] = [];
  let didUsePrimaryText = false;

  for (const item of items) {
    if (item.type === "text") {
      const text = item.text.trim();
      if (!text) continue;
      if (!didUsePrimaryText) {
        promptInput.text = text;
        didUsePrimaryText = true;
      } else {
        textAttachments.push({ text });
      }
      continue;
    }

    if (item.type === "image") {
      images.push({ source: item.url });
      continue;
    }

    if (item.type === "localImage") {
      images.push({ source: item.path });
      continue;
    }

    if (item.type === "mention") {
      mentions.push({ name: item.name, path: item.path });
      continue;
    }

    if (item.type === "skill") {
      skills.push({ name: item.name, path: item.path });
    }
  }

  if (!didUsePrimaryText) {
    promptInput.text = fallbackText;
  }
  if (textAttachments.length > 0) promptInput.textAttachments = textAttachments;
  if (images.length > 0) promptInput.images = images;
  if (mentions.length > 0) promptInput.mentions = mentions;
  if (skills.length > 0) promptInput.skills = skills;
  return promptInput;
}

function readOwnerUserInputItemsFromItem(item: CodexConversationItem): UserInput[] {
  const rawItem = asRecord(item.rawItem);
  const content = Array.isArray(rawItem?.content) ? rawItem.content : [];
  const items: UserInput[] = [];

  for (const entry of content) {
    const input = asRecord(entry);
    if (!input) continue;
    const type = typeof input?.type === "string" ? input.type : "";
    if (type === "text") {
      const text = typeof input.text === "string" ? input.text : "";
      items.push(buildOwnerTextUserInput(text));
      continue;
    }
    if (type === "image") {
      const url =
        typeof input.url === "string"
          ? input.url
          : typeof input.source === "string"
            ? input.source
            : "";
      if (url) items.push({ type: "image", url });
      continue;
    }
    if (type === "localImage") {
      const path =
        typeof input.path === "string"
          ? input.path
          : typeof input.source === "string"
            ? input.source
            : "";
      if (path) items.push({ type: "localImage", path });
      continue;
    }
    if (type === "mention") {
      const name = typeof input.name === "string" ? input.name : "";
      const path = typeof input.path === "string" ? input.path : "";
      if (name && path) items.push({ type: "mention", name, path });
      continue;
    }
    if (type === "skill") {
      const name = typeof input.name === "string" ? input.name : "";
      const path = typeof input.path === "string" ? input.path : "";
      if (name && path) items.push({ type: "skill", name, path });
    }
  }

  if (items.length > 0) return items;

  const fallbackText = item.markdownText?.trim() ?? "";
  return fallbackText ? [buildOwnerTextUserInput(fallbackText)] : [];
}

function buildOwnerEditReplacementPromptInput(
  turn: CodexConversationTurn,
  replacementText: string,
): CodexPromptInput {
  const userItem = turn.items.find(isConversationUserMessageItem) ?? null;
  if (!userItem) return { text: replacementText };

  const inputItems = readOwnerUserInputItemsFromItem(userItem);
  if (inputItems.length === 0) return { text: replacementText };

  let didReplaceText = false;
  const replacementItems = inputItems.map((item) => {
    if (item.type !== "text" || didReplaceText) return item;
    didReplaceText = true;
    return buildOwnerTextUserInput(replacementText);
  });
  if (!didReplaceText) {
    replacementItems.unshift(buildOwnerTextUserInput(replacementText));
  }

  return buildOwnerPromptInputFromUserInputItems(replacementItems, replacementText);
}

function createOwnerClientUserMessageId(): string {
  const cryptoWithRandomUuid = globalThis.crypto as Crypto | undefined;
  const randomId = cryptoWithRandomUuid?.randomUUID?.();
  if (randomId) return randomId;

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function appendOwnerOptimisticTurn(
  conversation: CodexConversationSnapshot,
  params: CodexCanonicalLiveTurnParams,
  observedAtMs: number,
  optimisticRuntimeStatus: CodexThreadRuntimeStatus | null,
): CodexConversationSnapshot {
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return conversation;
  const nextCanonicalState = appendCodexCanonicalOptimisticTurn(canonicalState, {
    params,
    currentCollaborationModel: conversation.latestCollaborationMode?.settings.model,
    startedAtMs: observedAtMs,
  });
  return {
    ...conversation,
    canonicalState: nextCanonicalState,
    ...(optimisticRuntimeStatus
      ? {
          statusType: "active" as const,
          statusActiveFlags: [],
          threadRuntimeStatus: optimisticRuntimeStatus,
        }
      : {}),
    updatedAt: Math.max(conversation.updatedAt, observedAtMs),
  };
}

function buildOwnerCanonicalOptimisticParams(
  conversation: CodexConversationSnapshot,
  input: {
    clientUserMessageId: string;
    opts?: CodexTurnStartOptions;
    preparedPrompt: CodexPreparedPrompt;
  },
): CodexCanonicalLiveTurnParams | null {
  const canonical = conversation.canonicalState;
  const hydration = canonical?.sidecar.hydrationContext;
  if (!canonical || !hydration) return null;
  const settings = hydration.latestThreadSettings;
  const permissions = hydration.currentPermissions;
  const collaborationMode = input.opts?.collaborationMode
    ? {
        mode: input.opts.collaborationMode,
        settings: {
          model: input.opts.model ?? hydration.latestModel,
          reasoning_effort: input.opts.reasoningEffort ?? hydration.latestReasoningEffort,
          developer_instructions: null,
        },
      }
    : (settings?.collaborationMode ??
      canonical.turns.at(-1)?.sidecar.params.collaborationMode ??
      null);
  return {
    threadId: conversation.threadId,
    clientUserMessageId: input.clientUserMessageId,
    input: [...input.preparedPrompt.inputItems],
    cwd: settings?.cwd ?? hydration.cwd,
    approvalPolicy: settings?.approvalPolicy ?? permissions.approvalPolicy,
    approvalsReviewer: settings?.approvalsReviewer ?? permissions.approvalsReviewer,
    sandboxPolicy: settings?.sandboxPolicy ?? permissions.sandboxPolicy,
    permissions: settings?.permissions ?? permissions.activePermissionProfile?.id ?? null,
    runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
    useAppServerPermissionDefault: false,
    model: collaborationMode ? null : (input.opts?.model ?? hydration.latestModel),
    serviceTier: input.opts?.serviceTier ?? settings?.serviceTier ?? null,
    effort: collaborationMode
      ? null
      : (input.opts?.reasoningEffort ?? hydration.latestReasoningEffort),
    multiAgentMode: settings?.multiAgentMode ?? "explicitRequestOnly",
    summary: resolveCodexReasoningSummary({
      configuredSummary: settings?.summary,
      explicitSummary: input.opts?.summary,
    }),
    personality: settings?.personality ?? null,
    outputSchema: null,
    collaborationMode,
    attachments: [...input.preparedPrompt.fileAttachments, ...input.preparedPrompt.addedFiles],
    commentAttachments: [...input.preparedPrompt.commentAttachments],
  };
}

function buildOwnerTurnSummaryFromProtocolTurn(
  threadId: string,
  turn: Turn,
): Omit<CodexConversationTurn, "items"> {
  const startedAt = normalizeOwnerTimestamp(turn.startedAt);
  const completedAt = normalizeOwnerTimestamp(turn.completedAt);
  return {
    threadId,
    turnId: turn.id,
    status: normalizeOwnerTurnStatus(turn.status, "inProgress"),
    errorMessage: parseOwnerTurnErrorMessage(turn.error),
    itemIds: turn.items
      .map((item) => {
        const itemRecord = asRecord(item);
        return getString(itemRecord ?? {}, "id") ?? "";
      })
      .filter((itemId) => itemId.length > 0),
    turnStartedAtMs: startedAt,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    startedAt,
    completedAt,
    durationMs: typeof turn.durationMs === "number" ? turn.durationMs : null,
  };
}

function materializeOwnerCanonicalTurn(
  currentTurn: CodexConversationTurn,
  previousCanonicalTurn: CodexCanonicalTurnState | null,
  canonicalTurn: CodexCanonicalTurnState,
  observedAtMs: number,
  turnIndex: number,
): CodexConversationTurn {
  const turnId = canonicalTurn.protocol.id;

  const projection = applyCodexLifecycleProjectionDiff({
    threadId: currentTurn.threadId,
    turnKey: buildCodexTurnOccurrenceKey(turnId, turnIndex),
    beforeTurn: previousCanonicalTurn,
    afterTurn: canonicalTurn,
    currentViews: currentTurn.items.map(projectConversationItemToIdentityView),
    currentTranscript: currentTurn.items,
    observedAtMs,
    isBackgroundSubagentsEnabled: true,
    preserveExistingUpdatedAt: true,
  });
  const items = projection.transcript.map((entry): CodexConversationItem => {
    if (!entry.mcpToolCall) return entry as CodexConversationItem;
    const mcpToolCall = completeCodexMcpToolCallForTurn(
      entry.mcpToolCall,
      canonicalTurn.protocol.status,
    );
    return mcpToolCall === entry.mcpToolCall
      ? (entry as CodexConversationItem)
      : ({ ...entry, mcpToolCall } as CodexConversationItem);
  });

  return {
    ...currentTurn,
    turnId,
    status: canonicalTurn.protocol.status,
    errorMessage: canonicalTurn.protocol.error?.message ?? undefined,
    diff: canonicalTurn.sidecar.diff ?? undefined,
    durationMs: canonicalTurn.protocol.durationMs,
    turnStartedAtMs: canonicalTurn.sidecar.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: canonicalTurn.sidecar.firstTurnWorkItemStartedAtMs ?? null,
    finalAssistantStartedAtMs: canonicalTurn.sidecar.finalAssistantStartedAtMs,
    commandExecutionStartedAtMsById:
      canonicalTurn.sidecar.commandExecutionStartedAtMsById === undefined
        ? undefined
        : { ...canonicalTurn.sidecar.commandExecutionStartedAtMsById },
    interruptedCommandExecutionItemIds:
      canonicalTurn.sidecar.interruptedCommandExecutionItemIds === undefined
        ? undefined
        : [...canonicalTurn.sidecar.interruptedCommandExecutionItemIds],
    hookRuns:
      canonicalTurn.sidecar.hookRuns === undefined
        ? undefined
        : [...canonicalTurn.sidecar.hookRuns],
    safetyBuffering:
      canonicalTurn.sidecar.safetyBuffering === undefined
        ? undefined
        : {
            useCases: [...canonicalTurn.sidecar.safetyBuffering.useCases],
            reasons: [...canonicalTurn.sidecar.safetyBuffering.reasons],
            showBufferingUi: canonicalTurn.sidecar.safetyBuffering.showBufferingUi,
            fasterModel: canonicalTurn.sidecar.safetyBuffering.fasterModel,
          },
    startedAt: canonicalTurn.sidecar.turnStartedAtMs,
    completedAt: canonicalTurn.sidecar.completedAtMs ?? null,
    itemIds:
      turnId === null
        ? [...new Set(projection.transcript.map((entry) => entry.itemId))]
        : [...projection.itemIds],
    items,
  };
}

function buildOwnerCanonicalTurnPlaceholder(
  threadId: string,
  canonicalTurn: CodexCanonicalTurnState,
): CodexConversationTurn {
  return {
    threadId,
    turnId: canonicalTurn.protocol.id,
    status: canonicalTurn.protocol.status,
    errorMessage: canonicalTurn.protocol.error?.message ?? undefined,
    itemIds: [],
    turnStartedAtMs: canonicalTurn.sidecar.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: canonicalTurn.sidecar.firstTurnWorkItemStartedAtMs ?? null,
    finalAssistantStartedAtMs: canonicalTurn.sidecar.finalAssistantStartedAtMs,
    startedAt: canonicalTurn.sidecar.turnStartedAtMs,
    completedAt: canonicalTurn.sidecar.completedAtMs ?? null,
    durationMs: canonicalTurn.protocol.durationMs,
    items: [],
  };
}

function materializeOwnerCanonicalConversationSnapshot(
  conversation: CodexConversationSnapshot,
  previousCanonicalState: CodexCanonicalConversationState | null = null,
): CodexConversationSnapshot {
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return conversation;

  const turns = canonicalState.turns.map((canonicalTurn, turnIndex) => {
    const currentTurn =
      conversation.turns[turnIndex] ??
      buildOwnerCanonicalTurnPlaceholder(conversation.threadId, canonicalTurn);
    const observedAtMs =
      canonicalTurn.sidecar.turnStartedAtMs ?? currentTurn.startedAt ?? conversation.updatedAt;
    const indexedPrevious = previousCanonicalState?.turns[turnIndex] ?? null;
    const previousCanonicalTurn =
      indexedPrevious?.protocol.id === canonicalTurn.protocol.id
        ? indexedPrevious
        : canonicalTurn.protocol.id === null
          ? null
          : (previousCanonicalState?.turns.findLast(
              (turn) => turn.protocol.id === canonicalTurn.protocol.id,
            ) ?? null);
    return materializeOwnerCanonicalTurn(
      currentTurn,
      previousCanonicalTurn,
      canonicalTurn,
      observedAtMs,
      turnIndex,
    );
  });

  return {
    ...conversation,
    turns,
    canonicalRequests: [...canonicalState.requests],
    hasUnreadTurn: canonicalState.sidecar.hasUnreadTurn,
  };
}

function finalizeOwnerConversationMutation(
  previous: CodexConversationSnapshot,
  candidate: CodexConversationSnapshot,
): CodexConversationSnapshot {
  const previousCanonical = previous.canonicalState;
  const candidateCanonical = candidate.canonicalState;
  if (!previousCanonical || !candidateCanonical || candidateCanonical === previousCanonical) {
    return candidate;
  }
  const boundedCanonical = boundChangedCodexLiveTurns(previousCanonical, candidateCanonical);
  const materialized = materializeOwnerCanonicalConversationSnapshot(
    boundedCanonical === candidateCanonical
      ? candidate
      : { ...candidate, canonicalState: boundedCanonical },
    previousCanonical,
  );
  // Read/unread is a standalone local state plane and is intentionally excluded from owner stream
  // hashes. Reprojecting canonical Turn metadata must not resurrect an older unread bit.
  return applyStandaloneUnreadStateToSnapshot(
    materialized,
    candidate.hasUnreadTurn ?? previous.hasUnreadTurn ?? false,
  );
}

function materializeOwnerRollbackConversation(
  currentConversation: CodexConversationSnapshot,
  rollbackResponse: CodexThreadHistoryEditResult,
): CodexConversationSnapshot {
  const thread = rollbackResponse.thread;
  const now = Date.now();
  const createdAt = normalizeOwnerThreadTimestamp(thread.createdAt, currentConversation.createdAt);
  const updatedAt = normalizeOwnerThreadTimestamp(thread.updatedAt, now);
  const statusPayload = toOwnerThreadStatusPayload(thread.id, thread.status);
  const subagentMetadata = extractCodexThreadSubagentMetadata(thread);
  const threadTurns = Array.isArray(thread.turns) ? thread.turns : [];
  const canonicalState = currentConversation.canonicalState
    ? replaceCodexCanonicalRollbackThread(currentConversation.canonicalState, thread)
    : null;
  if (!canonicalState) {
    throw new Error(`Canonical rollback state unavailable for '${thread.id}'`);
  }
  const canonicalTurnsById = new Map(
    canonicalState.turns.map((turn) => [turn.protocol.id, turn] as const),
  );
  const currentTurnsById = new Map(
    currentConversation.turns.map((turn) => [getOwnerTurnId(turn), turn] as const),
  );
  const turns = threadTurns.map((turn, turnIndex) => {
    const canonicalTurn = canonicalTurnsById.get(turn.id);
    if (!canonicalTurn) {
      throw new Error(`Canonical rollback turn unavailable for '${turn.id}'`);
    }
    const summary = buildOwnerTurnSummaryFromProtocolTurn(thread.id, turn);
    const currentTurn = currentTurnsById.get(turn.id);
    return materializeOwnerCanonicalTurn(
      {
        ...summary,
        items: currentTurn?.items ?? [],
      },
      currentConversation.canonicalState?.turns.findLast(
        (candidate) => candidate.protocol.id === canonicalTurn.protocol.id,
      ) ?? null,
      canonicalTurn,
      canonicalTurn.sidecar.turnStartedAtMs ?? now,
      turnIndex,
    );
  });

  return normalizeConversationSnapshot({
    ...currentConversation,
    canonicalState,
    threadId: thread.id,
    source: {
      ...currentConversation.source,
      parentThreadId:
        subagentMetadata.parentThreadId ?? currentConversation.source?.parentThreadId ?? null,
    },
    ephemeral: thread.ephemeral,
    threadSource: thread.threadSource ?? currentConversation.threadSource ?? null,
    agentNickname: subagentMetadata.agentNickname ?? currentConversation.agentNickname ?? null,
    agentRole: subagentMetadata.agentRole ?? currentConversation.agentRole ?? null,
    agentPath: subagentMetadata.agentPath ?? currentConversation.agentPath ?? null,
    threadPreview: thread.preview,
    cwd: thread.cwd,
    statusType: statusPayload.statusType,
    statusActiveFlags: statusPayload.statusActiveFlags,
    createdAt,
    updatedAt,
    resumeState: "resumed",
    turnPagination: rollbackResponse.turnPagination,
    turnItemsPaginationById: rollbackResponse.turnItemsPaginationById,
    historyRows: undefined,
    turns,
    requests: [],
    canonicalRequests: [],
    hasUnreadTurn: false,
  });
}

function parseOwnerTurnStartResult(
  threadId: string,
  result: unknown,
): { protocol: Turn; summary: Omit<CodexConversationTurn, "items"> } | null {
  const record = asRecord(result);
  if (!record) return null;
  const turnRecord = asRecord(record?.turn);
  if (turnRecord) {
    const turn = record.turn as Turn;
    return { protocol: turn, summary: buildOwnerTurnSummaryFromProtocolTurn(threadId, turn) };
  }

  const turnId =
    typeof record?.turnId === "string"
      ? record.turnId
      : typeof record?.id === "string"
        ? record.id
        : null;
  if (!turnId) return null;

  const status = normalizeOwnerTurnStatus(record?.status, "inProgress");
  const summary: Omit<CodexConversationTurn, "items"> = {
    threadId,
    turnId,
    status,
    errorMessage: parseOwnerTurnErrorMessage(record?.error),
    itemIds: [],
    turnStartedAtMs:
      normalizeOwnerTimestamp(record?.turnStartedAtMs ?? record?.startedAt) ?? Date.now(),
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    startedAt: normalizeOwnerTimestamp(record?.startedAt),
    completedAt: normalizeOwnerTimestamp(record?.completedAt),
    durationMs: typeof record?.durationMs === "number" ? record.durationMs : null,
  };
  return {
    summary,
    protocol: {
      id: turnId,
      itemsView: "full",
      status,
      error: null,
      durationMs: summary.durationMs ?? null,
      startedAt: summary.startedAt == null ? null : summary.startedAt / 1_000,
      completedAt: summary.completedAt == null ? null : summary.completedAt / 1_000,
      items: [],
    },
  };
}

function rebindOwnerOptimisticTurn(
  conversation: CodexConversationSnapshot,
  clientUserMessageId: string,
  startedTurn: { protocol: Turn; summary: Omit<CodexConversationTurn, "items"> } | null,
): CodexConversationSnapshot | null {
  if (!startedTurn) return null;
  const { protocol } = startedTurn;
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return null;
  const nextCanonicalState = bindCodexCanonicalOptimisticTurn(
    canonicalState,
    clientUserMessageId,
    protocol,
  );
  if (nextCanonicalState === canonicalState) return null;

  return {
    ...conversation,
    canonicalState: nextCanonicalState,
  };
}

function applyOwnerStartFailureToConversation(
  conversation: CodexConversationSnapshot,
  clientUserMessageId: string,
  previousRuntimeStatus: CodexThreadRuntimeStatus,
  optimisticRuntimeStatus: CodexThreadRuntimeStatus | null,
): CodexConversationSnapshot | null {
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return null;
  const nextCanonicalState = failCodexCanonicalOptimisticTurn(canonicalState, clientUserMessageId);
  if (nextCanonicalState === canonicalState) return null;

  const shouldRestoreRuntimeStatus =
    optimisticRuntimeStatus !== null &&
    conversation.threadRuntimeStatus === optimisticRuntimeStatus;

  return {
    ...conversation,
    canonicalState: nextCanonicalState,
    ...(shouldRestoreRuntimeStatus
      ? {
          statusType: previousRuntimeStatus.type,
          statusActiveFlags:
            previousRuntimeStatus.type === "active" ? [...previousRuntimeStatus.activeFlags] : [],
          threadRuntimeStatus: previousRuntimeStatus,
        }
      : {}),
  };
}

function removeOwnerResumePlaceholderFromConversation(
  conversation: CodexConversationSnapshot,
  clientUserMessageId: string,
  previousRuntimeStatus: CodexThreadRuntimeStatus,
  optimisticRuntimeStatus: CodexThreadRuntimeStatus | null,
  previousTurnModel: string | null,
): CodexConversationSnapshot | null {
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return null;
  const nextCanonicalState = removeCodexCanonicalOptimisticTurn(
    canonicalState,
    clientUserMessageId,
    { previousTurnModel },
  );
  if (nextCanonicalState === canonicalState) return null;

  const shouldRestoreRuntimeStatus =
    optimisticRuntimeStatus !== null &&
    conversation.threadRuntimeStatus === optimisticRuntimeStatus;

  return {
    ...conversation,
    canonicalState: nextCanonicalState,
    ...(shouldRestoreRuntimeStatus
      ? {
          statusType: previousRuntimeStatus.type,
          statusActiveFlags:
            previousRuntimeStatus.type === "active" ? [...previousRuntimeStatus.activeFlags] : [],
          threadRuntimeStatus: previousRuntimeStatus,
        }
      : {}),
  };
}

function toOwnerTurnLifecyclePayload(
  notification: OwnerTurnLifecycleNotification,
): OwnerTurnLifecyclePayload {
  const { threadId, turn } = notification.params;
  const startedAt = normalizeOwnerTimestamp(turn.startedAt);
  const completedAt = normalizeOwnerTimestamp(turn.completedAt);
  const observedAtMs =
    notification.method === "turn/started"
      ? (startedAt ?? Date.now())
      : (completedAt ?? Date.now());

  return {
    threadId,
    turnId: turn.id,
    status: turn.status,
    errorMessage: turn.error?.message,
    startedAt,
    completedAt,
    turnStartedAtMs: startedAt,
    durationMs: turn.durationMs,
    observedAtMs,
  };
}

function projectOwnerCanonicalPlanRequests(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
  observedAtMs: number,
): CodexConversationServerRequest[] {
  const nonPlanRequests = conversation.requests.filter(
    (request) => request.type !== "implementPlan",
  );
  const planRequests = state.requests.flatMap((request): CodexConversationServerRequest[] => {
    if (request.method !== "item/plan/requestImplementation" || typeof request.id !== "string")
      return [];
    const turn = conversation.turns.find((candidate) => candidate.turnId === request.params.turnId);
    const item = turn?.items.find((candidate) => candidate.itemId === request.id);
    return [
      {
        type: "implementPlan",
        requestId: request.id,
        projectId: conversation.projectId,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.id,
        planContent: request.params.planContent,
        createdAt: item?.createdAt ?? observedAtMs,
      },
    ];
  });
  return [...nonPlanRequests, ...planRequests];
}

function inheritOwnerPlanImplementationTimestamps(
  before: CodexConversationSnapshot,
  projected: CodexConversationSnapshot,
  turnId: string,
): CodexConversationSnapshot {
  const turnIndex = projected.turns.findIndex((turn) => turn.turnId === turnId);
  const projectedTurn = projected.turns[turnIndex];
  if (!projectedTurn) return projected;
  const implementationIndex = projectedTurn.items.findIndex(
    (item) => item.type === "planImplementation",
  );
  const implementation = projectedTurn.items[implementationIndex];
  if (!implementation) return projected;

  const beforeTurn = before.turns.find((turn) => turn.turnId === turnId);
  const existing = beforeTurn?.items.find((item) => item.itemId === implementation.itemId);
  const plan = beforeTurn?.items.findLast((item) => item.type === "plan");
  const createdAt = existing?.createdAt ?? plan?.createdAt;
  const updatedAt = existing?.updatedAt ?? plan?.updatedAt;
  if (createdAt === undefined || updatedAt === undefined) return projected;

  const items = [...projectedTurn.items];
  items[implementationIndex] = { ...implementation, createdAt, updatedAt };
  return replaceOwnerTurnAt(projected, turnIndex, { ...projectedTurn, items });
}

function applyOwnerTurnLifecycleToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  method: OwnerTurnLifecycleMethod,
  payload: OwnerTurnLifecyclePayload,
): OwnerCanonicalLifecycleProjectionResult {
  const result = reduceCodexConversationTurnLifecycle(before, {
    conversationId: payload.threadId,
    method,
    turn: {
      id: payload.turnId,
      status: payload.status,
      error: payload.errorMessage
        ? {
            message: payload.errorMessage,
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null,
          }
        : null,
      startedAt:
        payload.startedAt === null || payload.startedAt === undefined
          ? null
          : payload.startedAt / 1_000,
      completedAt:
        payload.completedAt === null || payload.completedAt === undefined
          ? null
          : payload.completedAt / 1_000,
      durationMs: payload.durationMs ?? null,
    },
    observedAtMs: payload.observedAtMs,
  });
  if (!result.stateChanged) return { conversation, hiddenTurns: [] };
  const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
    observedAtMs: payload.observedAtMs,
  });
  const projectedConversation = inheritOwnerPlanImplementationTimestamps(
    conversation,
    projection.conversation,
    payload.turnId,
  );
  const requests = projectOwnerCanonicalPlanRequests(
    projectedConversation,
    result.state,
    payload.observedAtMs,
  );
  const hasInProgressTurn = projectedConversation.turns.some(
    (turn) => turn.status === "inProgress",
  );
  return {
    ...projection,
    conversation: {
      ...projectedConversation,
      canonicalState: result.state,
      canonicalRequests: [...result.state.requests],
      hasUnreadTurn: result.state.sidecar.hasUnreadTurn,
      requests,
      statusType: hasInProgressTurn ? "active" : "idle",
      statusActiveFlags: hasInProgressTurn ? conversation.statusActiveFlags : [],
    },
  };
}

function normalizeOwnerThreadTimestamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (value > 10_000_000_000) return Math.floor(value);
  return Math.floor(value * 1000);
}

function getOwnerNotificationConversationId(
  notification: CodexThreadOwnerNotificationEvent["notification"],
): string | null {
  return getCodexThreadOwnerNotificationThreadId(notification);
}

type OwnerThreadStartedPayload = {
  threadId: string;
  parentThreadId: string | null;
  threadSource: ThreadSource | null;
  agentNickname: string | null;
  agentRole: string | null;
  agentPath: string | null;
  threadName: string | null;
  threadPreview: string | null;
  modelProvider: string | null;
  cwd: string | null;
  statusType: CodexConversationSnapshot["statusType"] | null;
  statusActiveFlags: CodexThreadActiveFlag[];
  threadRuntimeStatus: CodexThreadRuntimeStatus | null;
  ephemeral: boolean | null;
  createdAt: number | null;
  updatedAt: number | null;
};

function toOwnerThreadStartedPayload(
  notification: Extract<
    CodexThreadOwnerNotificationEvent["notification"],
    { method: "thread/started" }
  >,
): OwnerThreadStartedPayload {
  const { thread } = notification.params;
  const parsedStatus = toOwnerThreadStatusPayload(thread.id, thread.status);
  const subagentMetadata = extractCodexThreadSubagentMetadata(thread);

  return {
    threadId: thread.id,
    parentThreadId: subagentMetadata.parentThreadId,
    threadSource: thread.threadSource,
    agentNickname: subagentMetadata.agentNickname,
    agentRole: subagentMetadata.agentRole,
    agentPath: subagentMetadata.agentPath,
    threadName: thread.name?.trim() || null,
    threadPreview: thread.preview,
    modelProvider: thread.modelProvider,
    cwd: thread.cwd,
    statusType: parsedStatus.statusType,
    statusActiveFlags: parsedStatus.statusActiveFlags,
    threadRuntimeStatus: parsedStatus.threadRuntimeStatus,
    ephemeral: thread.ephemeral,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

function applyOwnerThreadStartedToConversation(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
): CodexConversationSnapshot {
  const thread = state.protocol;
  const parsedStatus = toOwnerThreadStatusPayload(thread.id, thread.status);
  const source: CodexConversationSource | null = thread.parentThreadId
    ? { parentThreadId: thread.parentThreadId }
    : conversation.source;

  return {
    ...conversation,
    canonicalState: state,
    source,
    ephemeral: thread.ephemeral,
    threadSource: thread.threadSource,
    agentNickname: thread.agentNickname,
    agentRole: thread.agentRole,
    threadName: thread.name?.trim() || conversation.threadName,
    threadPreview: thread.preview,
    modelProvider: thread.modelProvider,
    cwd: thread.cwd,
    statusType: parsedStatus.statusType,
    statusActiveFlags: parsedStatus.statusActiveFlags,
    threadRuntimeStatus: parsedStatus.threadRuntimeStatus,
    createdAt: normalizeOwnerThreadTimestamp(thread.createdAt, conversation.createdAt),
    updatedAt: normalizeOwnerThreadTimestamp(thread.updatedAt, conversation.updatedAt),
    resumeState: "resumed",
  };
}

function buildOwnerCanonicalStartedThread(
  before: CodexCanonicalConversationState,
  payload: OwnerThreadStartedPayload,
): Thread {
  return {
    ...before.protocol,
    id: payload.threadId,
    parentThreadId: payload.parentThreadId,
    preview: payload.threadPreview ?? before.protocol.preview,
    ephemeral: payload.ephemeral ?? before.protocol.ephemeral,
    modelProvider: payload.modelProvider ?? before.protocol.modelProvider,
    createdAt: payload.createdAt ?? before.protocol.createdAt,
    updatedAt: payload.updatedAt ?? before.protocol.updatedAt,
    status: payload.threadRuntimeStatus ?? before.protocol.status,
    cwd: payload.cwd ?? before.protocol.cwd,
    threadSource: payload.threadSource ?? before.protocol.threadSource,
    agentNickname: payload.agentNickname ?? before.protocol.agentNickname,
    agentRole: payload.agentRole ?? before.protocol.agentRole,
    name: payload.threadName,
    turns: [],
  };
}

function buildOwnerThreadRuntimeStatus(
  statusType: CodexConversationSnapshot["statusType"],
  statusActiveFlags: CodexThreadActiveFlag[],
): CodexThreadRuntimeStatus {
  if (statusType === "active") {
    return {
      type: "active",
      activeFlags: [...statusActiveFlags],
    };
  }

  return { type: statusType };
}

function toOwnerThreadStatusPayload(
  threadId: string,
  status: ThreadStatus,
): {
  threadId: string;
  statusType: CodexConversationSnapshot["statusType"];
  statusActiveFlags: CodexThreadActiveFlag[];
  threadRuntimeStatus: CodexThreadRuntimeStatus;
} {
  const statusType = status.type;
  const statusActiveFlags = status.type === "active" ? [...status.activeFlags] : [];

  return {
    threadId,
    statusType,
    statusActiveFlags,
    threadRuntimeStatus: buildOwnerThreadRuntimeStatus(statusType, statusActiveFlags),
  };
}

function projectOwnerThreadStatusToConversation(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
): CodexConversationSnapshot {
  const payload = toOwnerThreadStatusPayload(state.protocol.id, state.protocol.status);
  if (
    conversation.statusType === payload.statusType &&
    areStringArraysEqual(conversation.statusActiveFlags, payload.statusActiveFlags) &&
    areThreadRuntimeStatusesEqual(conversation.threadRuntimeStatus, payload.threadRuntimeStatus)
  ) {
    return { ...conversation, canonicalState: state };
  }

  return {
    ...conversation,
    canonicalState: state,
    statusType: payload.statusType,
    statusActiveFlags: payload.statusActiveFlags,
    threadRuntimeStatus: payload.threadRuntimeStatus,
  };
}

function projectOwnerThreadGoalToConversation(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
): CodexConversationSnapshot {
  return {
    ...conversation,
    canonicalState: state,
    threadGoal: state.sidecar.threadGoal ?? null,
    completedThreadGoal: state.sidecar.completedThreadGoal ?? null,
    threadGoalResumeConfirmation: state.sidecar.threadGoalResumeConfirmation ?? null,
  };
}

function applyOwnerThreadGoalResumeConfirmationDismissedToConversation(
  conversation: CodexConversationSnapshot,
): CodexConversationSnapshot | null {
  if (!conversation.threadGoalResumeConfirmation) return null;

  return {
    ...conversation,
    threadGoalResumeConfirmation: null,
    updatedAt: Math.max(conversation.updatedAt, Date.now()),
  };
}

function projectOwnerThreadNameToConversation(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
): CodexConversationSnapshot {
  const threadName = state.protocol.name?.trim() || conversation.threadName;
  if (conversation.threadName === threadName) return { ...conversation, canonicalState: state };

  return {
    ...conversation,
    canonicalState: state,
    threadName,
  };
}

function buildOwnerConversationThreadSettings(
  conversation: CodexConversationSnapshot,
  threadSettings: ThreadSettings,
): CodexConversationThreadSettings {
  const fallbackMode =
    conversation.latestThreadSettings?.collaborationMode ??
    conversation.latestCollaborationMode ??
    DEFAULT_COLLABORATION_MODE_STATE;
  const model =
    normalizeThreadSettingsModel(threadSettings.model) ??
    normalizeThreadSettingsModel(conversation.latestThreadSettings?.model) ??
    normalizeThreadSettingsModel(fallbackMode.settings.model) ??
    "";
  const reasoningEffort =
    threadSettings.effort ??
    conversation.latestThreadSettings?.reasoningEffort ??
    fallbackMode.settings.reasoning_effort ??
    null;
  const collaborationMode = threadSettings.collaborationMode;
  const collaborationSettings = collaborationMode.settings;
  const mode = collaborationMode.mode;
  const collaborationModel = normalizeThreadSettingsModel(collaborationSettings.model) ?? model;
  const collaborationReasoningEffort =
    collaborationSettings.reasoning_effort ?? reasoningEffort ?? null;

  return {
    model,
    modelProvider: threadSettings.modelProvider,
    serviceTier: normalizeCodexServiceTier(threadSettings.serviceTier),
    reasoningEffort,
    summary: threadSettings.summary,
    collaborationMode: {
      mode,
      settings: {
        model: collaborationModel,
        reasoning_effort: collaborationReasoningEffort,
        developer_instructions: collaborationSettings.developer_instructions,
      },
    },
    personality: threadSettings.personality,
  };
}

function areOwnerThreadSettingsEqual(
  left: CodexConversationThreadSettings | null | undefined,
  right: CodexConversationThreadSettings,
): boolean {
  if (!left || !right.collaborationMode) return false;

  return (
    Boolean(left) &&
    left?.model === right.model &&
    left.modelProvider === right.modelProvider &&
    left.serviceTier === right.serviceTier &&
    left.reasoningEffort === right.reasoningEffort &&
    left.summary === right.summary &&
    left.personality === right.personality &&
    left.collaborationMode?.mode === right.collaborationMode.mode &&
    left.collaborationMode?.settings.model === right.collaborationMode.settings.model &&
    left.collaborationMode?.settings.reasoning_effort ===
      right.collaborationMode.settings.reasoning_effort
  );
}

function projectOwnerThreadSettingsToConversation(
  conversation: CodexConversationSnapshot,
  state: CodexCanonicalConversationState,
): CodexConversationSnapshot {
  const settings = state.sidecar.latestThreadSettings;
  if (!settings) return { ...conversation, canonicalState: state };
  const latestThreadSettings = buildOwnerConversationThreadSettings(conversation, settings);
  if (areOwnerThreadSettingsEqual(conversation.latestThreadSettings, latestThreadSettings)) {
    return {
      ...conversation,
      canonicalState: state,
      modelProvider: state.protocol.modelProvider,
      cwd: state.protocol.cwd,
    };
  }

  return {
    ...conversation,
    canonicalState: state,
    latestThreadSettings,
    latestCollaborationMode:
      latestThreadSettings.collaborationMode ?? DEFAULT_COLLABORATION_MODE_STATE,
    modelProvider: state.protocol.modelProvider,
    cwd: state.protocol.cwd,
  };
}

function createOwnerGeneratedItemId(prefix: string): string {
  return `${prefix}:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
}

function clearOwnerApprovalAttachments(
  conversation: CodexConversationSnapshot,
  requestIds: ReadonlySet<CodexProtocolRequestId>,
): CodexConversationSnapshot {
  if (requestIds.size === 0) return conversation;
  let didChange = false;
  const turns = conversation.turns.map((turn) => {
    let turnChanged = false;
    const items = turn.items.map((item) => {
      if (
        item.approvalRequestId === undefined ||
        item.approvalRequestId === null ||
        !requestIds.has(item.approvalRequestId)
      )
        return item;
      didChange = true;
      turnChanged = true;
      return {
        ...item,
        approvalRequestId: null,
        networkApprovalContext: null,
        proposedExecpolicyAmendment: null,
        grantRoot: null,
      };
    });
    return turnChanged ? { ...turn, items } : turn;
  });
  return didChange ? { ...conversation, turns } : conversation;
}

function applyOwnerServerRequestResolvedToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  payload: Extract<
    CodexThreadOwnerNotificationEvent["notification"],
    { method: "serverRequest/resolved" }
  >["params"],
): OwnerCanonicalServerRequestMutationResult {
  const observedAtMs = Date.now();
  const lifecycle = reduceCodexConversationServerRequestResolved(
    before,
    {
      method: "serverRequest/resolved",
      params: payload,
    },
    { now: () => observedAtMs },
  );
  const projection = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    observedAtMs,
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  const nextConversation = clearOwnerApprovalAttachments(projection.conversation, selectedIds);

  return {
    conversation: {
      ...nextConversation,
      requests:
        lifecycle.selectedRequests.length === 0
          ? nextConversation.requests
          : nextConversation.requests.filter(
              (candidate) => candidate.requestId !== payload.requestId,
            ),
    },
    hiddenTurns: projection.hiddenTurns,
  };
}

function normalizeOwnerApprovalAvailableDecisions(
  value: readonly unknown[] | null | undefined,
): string[] | null {
  if (!value || value.length === 0) return null;

  const decisions = value
    .map((decision) => {
      if (typeof decision === "string") return decision;
      const record = asRecord(decision);
      return record ? (Object.keys(record)[0] ?? "") : "";
    })
    .filter((decision) => decision.length > 0);

  return decisions.length > 0 ? decisions : null;
}

function buildOwnerCommandApprovalRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexThreadOwnerRequestEvent["request"],
    { method: "item/commandExecution/requestApproval" }
  >["params"],
): CodexApprovalRequest {
  const command = params.command ?? "";
  const commandActions = params.commandActions ?? null;
  const commandActionCommands =
    commandActions
      ?.map((action) => action.command)
      .filter(
        (command): command is string => typeof command === "string" && command.trim().length > 0,
      ) ?? [];

  return {
    type: "approval",
    requestId,
    kind: "command",
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    approvalId: params.approvalId ?? null,
    approvalRequestId: requestId,
    callId: params.itemId,
    reason: params.reason ?? undefined,
    command: command || undefined,
    cwd: params.cwd ?? undefined,
    approvalReason: params.reason ?? undefined,
    cmd:
      commandActionCommands.length > 0
        ? commandActionCommands
        : command.trim().length > 0
          ? command.split(" ").filter((segment) => segment.trim().length > 0)
          : undefined,
    networkApprovalContext: params.networkApprovalContext
      ? {
          host: params.networkApprovalContext.host,
          protocol: params.networkApprovalContext.protocol,
        }
      : null,
    proposedExecpolicyAmendment: params.proposedExecpolicyAmendment ?? null,
    proposedNetworkPolicyAmendments:
      params.proposedNetworkPolicyAmendments?.map((amendment) => ({
        host: amendment.host,
        action: amendment.action,
      })) ?? null,
    availableDecisions: normalizeOwnerApprovalAvailableDecisions(params.availableDecisions),
    grantRoot: null,
    commandActions,
    createdAt: params.startedAtMs,
  };
}

function buildOwnerFileApprovalRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexThreadOwnerRequestEvent["request"],
    { method: "item/fileChange/requestApproval" }
  >["params"],
): CodexApprovalRequest {
  return {
    type: "approval",
    requestId,
    kind: "file",
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    approvalRequestId: requestId,
    callId: params.itemId,
    reason: params.reason ?? undefined,
    approvalReason: params.reason ?? undefined,
    networkApprovalContext: null,
    proposedExecpolicyAmendment: null,
    proposedNetworkPolicyAmendments: null,
    availableDecisions: null,
    grantRoot: params.grantRoot ?? null,
    commandActions: null,
    createdAt: params.startedAtMs,
  };
}

function buildOwnerUserInputRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexThreadOwnerRequestEvent["request"],
    { method: "item/tool/requestUserInput" }
  >["params"],
): CodexUserInputRequest {
  return {
    type: "userInput",
    requestId,
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    questions: params.questions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      isOther: question.isOther,
      isSecret: question.isSecret,
      options: question.options?.map((option) => ({
        label: option.label,
        description: option.description,
      })),
    })),
    isBlocking: params.isBlocking,
    autoResolutionMs: params.autoResolutionMs,
    createdAt: Date.now(),
  };
}

function buildOwnerMcpElicitationRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexThreadOwnerRequestEvent["request"],
    { method: "mcpServer/elicitation/request" }
  >["params"],
): CodexMcpServerElicitationRequest {
  return {
    type: "mcpServerElicitation",
    requestId,
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId ?? "",
    itemId: `mcp-server-elicitation-${requestId}`,
    kind: params.mode === "url" ? "toolSuggestion" : "generic",
    mode: normalizeCodexMcpServerElicitationMode(params.mode),
    serverName: params.serverName,
    message: params.message,
    url: params.mode === "url" ? params.url : undefined,
    elicitationId: params.mode === "url" ? params.elicitationId : undefined,
    requestedSchema: params.mode !== "url" ? params.requestedSchema : undefined,
    meta: params._meta,
    createdAt: Date.now(),
  };
}

function buildOwnerPermissionRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexThreadOwnerRequestEvent["request"],
    { method: "item/permissions/requestApproval" }
  >["params"],
): CodexPermissionRequest {
  return {
    type: "permissionRequest",
    requestId,
    projectId: conversation.projectId,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
    cwd: params.cwd,
    reason: params.reason,
    permissions: params.permissions,
    response: null,
    completed: false,
    createdAt: params.startedAtMs,
  };
}

function upsertOwnerConversationRequest<TRequest extends CodexConversationServerRequest>(
  conversation: CodexConversationSnapshot,
  request: TRequest,
): CodexConversationSnapshot {
  return {
    ...conversation,
    requests: [...conversation.requests, request],
  };
}

function updateOwnerTurnItem(
  conversation: CodexConversationSnapshot,
  turnId: string,
  itemId: string,
  buildItem: (item: CodexConversationItem) => CodexConversationItem,
): CodexConversationSnapshot | null {
  const turnIndex = conversation.turns.findIndex((turn) => turn.turnId === turnId);
  if (turnIndex < 0) return conversation;

  const turn = conversation.turns[turnIndex]!;
  const itemIndex = turn.items.findIndex((item) => item.itemId === itemId);
  if (itemIndex < 0) return conversation;

  const nextItems = [...turn.items];
  nextItems[itemIndex] = buildItem(turn.items[itemIndex]!);
  const nextTurns = [...conversation.turns];
  nextTurns[turnIndex] = {
    ...turn,
    items: nextItems,
  };

  return {
    ...conversation,
    turns: nextTurns,
  };
}

function attachOwnerApprovalRequestToItem(
  conversation: CodexConversationSnapshot,
  request: CodexApprovalRequest,
): CodexConversationSnapshot {
  const attached = updateOwnerTurnItem(conversation, request.turnId, request.itemId, (item) => ({
    ...item,
    approvalRequestId: request.requestId,
    networkApprovalContext: request.networkApprovalContext ?? item.networkApprovalContext ?? null,
    proposedExecpolicyAmendment:
      request.proposedExecpolicyAmendment ?? item.proposedExecpolicyAmendment ?? null,
    grantRoot: request.grantRoot ?? item.grantRoot ?? null,
  }));

  return attached ?? conversation;
}

interface OwnerCanonicalServerRequestMutationResult {
  readonly conversation: CodexConversationSnapshot;
  readonly hiddenTurns: readonly OwnerCanonicalLifecycleHiddenTurn[];
}

function applyOwnerCanonicalServerRequestLifecycleResult(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  result: CodexServerRequestLifecycleResult,
  observedAtMs: number,
): OwnerCanonicalServerRequestMutationResult {
  if (!result.stateChanged) {
    return { conversation, hiddenTurns: [] };
  }

  const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
    observedAtMs,
    preserveExistingUpdatedAt: true,
  });
  return {
    conversation: {
      ...projection.conversation,
      canonicalState: result.state,
      canonicalRequests: [...result.state.requests],
      hasUnreadTurn: result.state.sidecar.hasUnreadTurn,
    },
    hiddenTurns: projection.hiddenTurns,
  };
}

function applyOwnerApprovalResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  kind: CodexApprovalKind,
): OwnerCanonicalServerRequestMutationResult {
  const lifecycle = reduceCodexConversationApprovalResponse(
    before,
    requestId,
    getCodexApprovalRequestMethod(kind),
  );
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    Date.now(),
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  const nextConversation = clearOwnerApprovalAttachments(applied.conversation, selectedIds);
  return {
    conversation: {
      ...nextConversation,
      requests: nextConversation.requests.filter(
        (candidate) => !selectedIds.has(candidate.requestId),
      ),
    },
    hiddenTurns: applied.hiddenTurns,
  };
}

function applyOwnerUserInputResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  answers: Record<string, string[]>,
): OwnerCanonicalServerRequestMutationResult {
  const firstRequest = before.requests.find((candidate) => candidate.id === requestId);
  const lifecycle =
    firstRequest?.method === "item/tool/call" &&
    firstRequest.params.tool === "request_onboarding_input"
      ? reduceCodexConversationOnboardingInputResponse(before, requestId)
      : reduceCodexConversationUserInputResponse(before, requestId, answers, {
          now: () => Date.now(),
        });
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    Date.now(),
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  return {
    conversation: {
      ...applied.conversation,
      requests: applied.conversation.requests.filter(
        (candidate) => !selectedIds.has(candidate.requestId),
      ),
    },
    hiddenTurns: applied.hiddenTurns,
  };
}

function applyOwnerMcpElicitationResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  response: CodexMcpServerElicitationResponse,
): OwnerCanonicalServerRequestMutationResult {
  const observedAtMs = Date.now();
  const lifecycle = reduceCodexConversationMcpElicitationResponse(before, requestId, response, {
    now: () => observedAtMs,
  });
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    observedAtMs,
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  return {
    conversation: {
      ...applied.conversation,
      requests: applied.conversation.requests.filter(
        (candidate) => !selectedIds.has(candidate.requestId),
      ),
    },
    hiddenTurns: applied.hiddenTurns,
  };
}

function applyOwnerPermissionRequestResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  response: CodexPermissionRequestResponse,
): OwnerCanonicalServerRequestMutationResult {
  const observedAtMs = Date.now();
  const lifecycle = reduceCodexConversationPermissionResponse(before, requestId, response, {
    now: () => observedAtMs,
  });
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    observedAtMs,
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  return {
    conversation: {
      ...applied.conversation,
      requests: applied.conversation.requests.filter(
        (candidate) => !selectedIds.has(candidate.requestId),
      ),
    },
    hiddenTurns: applied.hiddenTurns,
  };
}

function applyOwnerStoredInteractiveResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  kind: "optionPicker" | "setupContextPicker",
): OwnerCanonicalServerRequestMutationResult {
  const lifecycle =
    kind === "optionPicker"
      ? reduceCodexConversationOptionPickerResponse(before, requestId)
      : reduceCodexConversationSetupContextPickerResponse(before, requestId);
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    Date.now(),
  );
  const selectedIds = new Set(lifecycle.selectedRequestIds);
  return {
    conversation: {
      ...applied.conversation,
      requests: applied.conversation.requests.filter(
        (request) => !selectedIds.has(request.requestId),
      ),
    },
    hiddenTurns: applied.hiddenTurns,
  };
}

function hasOwnerStoredInteractiveResponseTarget(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  kind: "optionPicker" | "setupContextPicker",
): boolean {
  const state = conversation.canonicalState;
  if (!state || state.protocol.id !== conversation.threadId) return false;
  const lifecycle =
    kind === "optionPicker"
      ? reduceCodexConversationOptionPickerResponse(state, requestId)
      : reduceCodexConversationSetupContextPickerResponse(state, requestId);
  return lifecycle.selectedRequests.length > 0;
}

function applyOwnerSetupCodexStepResponseToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  requestId: CodexProtocolRequestId,
  response: CodexCanonicalSetupCodexStepResponse,
): OwnerCanonicalServerRequestMutationResult {
  const lifecycle = reduceCodexConversationSetupCodexStepResponse(before, requestId, response);
  return applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    Date.now(),
  );
}

interface OwnerServerRequestApplication {
  readonly conversation: CodexConversationSnapshot;
  readonly lifecycle: CodexServerRequestLifecycleResult;
  readonly hiddenTurns: readonly OwnerCanonicalLifecycleHiddenTurn[];
}

function applyOwnerServerRequestToConversation(
  conversation: CodexConversationSnapshot,
  before: CodexCanonicalConversationState,
  request: CodexThreadOwnerRequestEvent["request"],
  isOpenAIFormElicitationsEnabled: boolean,
): OwnerServerRequestApplication {
  const viewRequestId = request.id;
  const observedAtMs = Date.now();
  const lifecycle = reduceCodexConversationServerRequest(before, request, {
    now: () => observedAtMs,
    isOpenAIFormElicitationsEnabled,
  });
  const applied = applyOwnerCanonicalServerRequestLifecycleResult(
    conversation,
    before,
    lifecycle,
    observedAtMs,
  );
  const withCanonicalState = applied.conversation;
  let nextConversation = withCanonicalState;

  if (lifecycle.disposition !== "stored") {
    return {
      conversation: nextConversation,
      lifecycle,
      hiddenTurns: applied.hiddenTurns,
    };
  }

  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const approvalRequest = buildOwnerCommandApprovalRequest(
        withCanonicalState,
        viewRequestId,
        request.params,
      );
      nextConversation = attachOwnerApprovalRequestToItem(
        upsertOwnerConversationRequest(withCanonicalState, approvalRequest),
        approvalRequest,
      );
      break;
    }
    case "item/fileChange/requestApproval": {
      const approvalRequest = buildOwnerFileApprovalRequest(
        withCanonicalState,
        viewRequestId,
        request.params,
      );
      nextConversation = attachOwnerApprovalRequestToItem(
        upsertOwnerConversationRequest(withCanonicalState, approvalRequest),
        approvalRequest,
      );
      break;
    }
    case "item/tool/requestUserInput": {
      const userInputRequest = buildOwnerUserInputRequest(
        withCanonicalState,
        viewRequestId,
        request.params,
      );
      nextConversation = upsertOwnerConversationRequest(withCanonicalState, userInputRequest);
      break;
    }
    case "item/tool/call":
      break;
    case "mcpServer/elicitation/request": {
      const elicitationRequest = buildOwnerMcpElicitationRequest(
        withCanonicalState,
        viewRequestId,
        request.params,
      );
      nextConversation = upsertOwnerConversationRequest(withCanonicalState, elicitationRequest);
      break;
    }
    case "item/permissions/requestApproval": {
      const permissionRequest = buildOwnerPermissionRequest(
        withCanonicalState,
        viewRequestId,
        request.params,
      );
      nextConversation = upsertOwnerConversationRequest(withCanonicalState, permissionRequest);
      break;
    }
    case "item/tool/requestOptionPicker":
    case "item/tool/requestSetupCodexContextPicker":
      break;
  }

  return {
    conversation: nextConversation,
    lifecycle,
    hiddenTurns: applied.hiddenTurns,
  };
}

function isConversationStreaming(conversation: CodexConversationSnapshot): boolean {
  return conversation.turns.some((turn) => turn.status === "inProgress");
}

function resolveProjectPermissionMode(
  permissionStateByScope: ReadonlyMap<string | null, CodexPermissionState>,
  projectId: string | null,
): CodexPermissionMode {
  return permissionStateByScope.get(projectId)?.mode ?? DEFAULT_PERMISSION_STATE.mode;
}

function resolveProjectPermissionState(
  permissionStateByScope: ReadonlyMap<string | null, CodexPermissionState>,
  projectId: string | null,
): CodexPermissionState {
  return permissionStateByScope.get(projectId) ?? DEFAULT_PERMISSION_STATE;
}

function arePermissionStatesEqual(
  left: CodexPermissionState,
  right: CodexPermissionState,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeSelectedSubagentInput(
  input: CodexSelectedSubagentHydrateInput,
): CodexSelectedSubagentHydrateInput {
  return {
    rootThreadId: input.rootThreadId.trim(),
    threadId: input.threadId.trim(),
  };
}

function selectedSubagentHydrationFailure(
  input: CodexSelectedSubagentHydrateInput,
  errorMessage: string,
  basis?: CodexSelectedSubagentHydrateResult,
): CodexSelectedSubagentHydrateResult {
  const normalized = normalizeSelectedSubagentInput(input);
  return {
    rootThreadId: normalized.rootThreadId,
    threadId: normalized.threadId,
    revision: basis?.revision ?? 0,
    fidelity: basis?.fidelity ?? "metadata",
    checkpoint: null,
    canInteract: false,
    outcome: "failed",
    errorMessage,
  };
}

function selectedSubagentErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

export class CodexAppServerManager {
  private connection: CodexConnectionState = INITIAL_CONNECTION;
  private account: CodexAccountSnapshot | null = null;
  private dictationState: CodexDictationStateSnapshot = DEFAULT_CODEX_DICTATION_STATE;
  private availableModels: CodexModelOption[] = EMPTY_MODELS;
  private readonly threadSummariesByProject = new Map<string, CodexThreadSummary[]>();
  private readonly threadSummariesById = new Map<string, CodexThreadSummary>();
  private readonly loadedThreadSummariesByProject = new Set<string>();
  private readonly threadSummaryLoadsInFlightByProject = new Map<
    string,
    Promise<CodexThreadSummary[]>
  >();
  private readonly conversationsById = new Map<string, CodexConversationSnapshot>();
  private readonly childMembershipsByParentThreadId = new Map<
    string,
    CodexConversationChildMembership[]
  >();
  private readonly followerAcceptedReplicasByConversationId = new Map<
    string,
    CodexConversationSnapshot
  >();
  private readonly ownerHiddenLifecycleItemTypesByConversationId = new Map<
    string,
    Map<string, Map<string, string>>
  >();
  private readonly resumeInFlightByThreadId = new Map<
    string,
    Promise<CodexConversationSnapshot | null>
  >();
  private readonly attachmentStateByThreadId = new Map<string, LocalConversationAttachmentState>();
  private readonly interruptedTurnResumesInFlightByThreadId = new Map<string, Promise<unknown>>();
  private readonly historyPageLoadsInFlightByTarget = new Map<
    string,
    Promise<CodexConversationHistoryPageResult>
  >();
  private readonly primaryConversationRequestByThread = new Map<
    string,
    CodexConversationLiveRequest | null
  >();
  private readonly conversationVersionById = new Map<string, number>();
  private readonly streamState = new LocalConversationStreamState();
  private readonly followerMembershipByConversationId = new Map<
    string,
    { ownerClientId: string; followerClientIds: readonly string[]; membershipEpoch: number }
  >();
  private readonly composerIntentsByThread = new Map<string, CodexComposerIntent>();
  private readonly permissionStateByScope = new Map<string | null, CodexPermissionState>();
  private readonly permissionStateLoadsInFlightByScope = new Map<
    string | null,
    Promise<CodexPermissionState>
  >();
  private readonly threadStartProgressByTarget = new Map<string, CodexThreadStartProgressState>();
  private readonly threadTitlesById = new Map<string, string>();
  private readonly recentConversationIds: string[] = [];
  private readonly activeGoalContinuationPromises = new Map<string, Promise<void>>();
  private readonly activeGoalContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ownerTextDeltaSequenceTracker = new CodexFrameTextDeltaSequenceTracker();
  private readonly ownerTextDeltaQueue = new CodexFrameTextDeltaQueue<OwnerFrameTextDeltaUpdate>({
    onFlush: (updates, context) => {
      const completedSequencesByConversationId =
        this.ownerTextDeltaSequenceTracker.consume(updates);
      this.applyOwnerTextDeltas(updates, {
        notifyMode: context.terminalDrainCommit ? "sync" : "default",
        completedSequencesByConversationId,
      });
    },
  });
  private readonly outputDeltaQueue = new CodexCommandOutputQueue<OutputDeltaUpdate>({
    mergeUpdate: mergeOutputDeltaQueueUpdate,
    onFlush: (updates) => {
      this.applyOutputDeltas(updates);
    },
  });
  private readonly ownerRollbackTombstonesByConversationId = new Map<string, Set<string>>();
  private readonly ownerNotificationCompletionByConversationId = new Map<
    string,
    OwnerNotificationCompletionState
  >();
  private readonly unclaimedOwnerNotificationSequencesByConversationId = new Map<
    string,
    Set<number>
  >();
  private readonly ownerStreamPublishCursorsByConversationId = new Map<
    string,
    OwnerStreamPublishCursor
  >();
  private readonly ownerStreamPublishIdleWaitersByConversationId = new Map<
    string,
    Set<OwnerStreamPublishIdleWaiter>
  >();
  private readonly queueOwnerProjectionFenceByConversationId = new Map<
    string,
    {
      readonly threadGeneration: number;
      readonly ownerEpoch: number;
      readonly projectionRevision: number;
      readonly publication: Promise<number> | null;
      readonly streamRevision: number | null;
    }
  >();
  private readonly terminalInputBuffers = new CodexTerminalInteractionAccumulator();
  private readonly ownerAppServerRequestClient = new IpcRendererOwnerAppServerRequestClient();
  private readonly pendingNodexAgentAuthorizations = new Map<
    string,
    {
      readonly threadId: string;
      readonly turnId: string;
      readonly request: NodexAgentAuthorizationRequest;
      readonly timeout: ReturnType<typeof setTimeout>;
      readonly resolve: (response: NodexAgentAuthorizationResponse) => void;
    }
  >();

  private readonly connectionCallbacks = new Set<StoreListener>();
  private readonly accountCallbacks = new Set<StoreListener>();
  private readonly controlCallbacks = new Set<ControlListener>();
  private readonly projectSummaryCallbacksByProject = new Map<string, Set<StoreListener>>();
  private readonly conversationCallbacks = new Map<string, Set<ConversationListener>>();
  private readonly attachmentCallbacks = new Map<string, Set<StoreListener>>();
  private readonly relationshipCallbacks = new Map<string, Set<StoreListener>>();
  private anyConversationCallbacks = new Set<AnyConversationListener>();
  private anyConversationMetaCallbacks = new Set<AnyConversationListener>();
  private readonly deferredOwnerMessagesByRequestRecovery = new Map<
    string,
    DeferredOwnerRecoveryQueue
  >();
  private readonly lastAnySnapshotById = new Map<string, ConversationAnyProjection>();
  private readonly lastMetaSnapshotById = new Map<string, ConversationMetaProjection>();
  private lastAnyOrderKey: string | null = null;
  private lastMetaOrderKey: string | null = null;

  private readonly busUnsubscribers: Array<() => void> = [];
  private bootstrapStarted = false;
  private readonly resyncInFlight = new Set<string>();
  private lastHostError: CodexHostErrorState | null = null;
  private readonly isOpenAIFormElicitationsEnabled: () => boolean;

  constructor(
    private readonly hostId: string,
    options: { isOpenAIFormElicitationsEnabled?: () => boolean } = {},
  ) {
    this.isOpenAIFormElicitationsEnabled = options.isOpenAIFormElicitationsEnabled ?? (() => true);
    this.busUnsubscribers.push(
      subscribeCodexEvents((event) => {
        if (event.type === "dictationState") {
          this.setDictationState(event.state);
          return;
        }
        if (event.type === "threadDeleted") {
          this.handleThreadDeleted({ hostId: this.hostId, threadId: event.threadId });
        }
      }),
      subscribeCodexAppServerMessage("shared-object-updated", (event) => {
        this.handleSharedObjectUpdated(event);
      }),
      subscribeCodexAppServerMessage("thread-stream-state-changed", (event) => {
        this.handleThreadStreamStateChanged(event);
      }),
      subscribeCodexAppServerMessage("thread-stream-followers-changed", (event) => {
        this.handleThreadStreamFollowersChanged(event);
      }),
      subscribeCodexAppServerMessage("thread-stream-following-status-requested", (event) => {
        this.handleThreadStreamFollowingStatusRequested(event);
      }),
      subscribeCodexAppServerMessage("thread-stream-transport-reset", (event) => {
        this.handleThreadStreamTransportReset(event);
      }),
      subscribeCodexAppServerMessage("client-status-changed", (event) => {
        this.handleClientStatusChanged(event);
      }),
      subscribeCodexAppServerMessage("thread-title-updated", (event) => {
        this.handleThreadTitleUpdated(event);
      }),
      subscribeCodexAppServerMessage("thread-read-state-changed", (event) => {
        if (event.hostId !== this.hostId) return;
        this.applyConversationUnreadState(event.conversationId, event.hasUnreadTurn);
      }),
      subscribeCodexAppServerMessage("thread-archived", (event) => {
        if (event.hostId !== this.hostId) return;
        this.removeThreadLocalState(event.conversationId);
      }),
      subscribeCodexAppServerMessage("thread-deleted", (event) => {
        this.handleThreadDeleted(event);
      }),
      subscribeCodexAppServerMessage("thread-owner-notification", (event) => {
        this.handleThreadOwnerNotification(event);
      }),
      subscribeCodexAppServerMessage("thread-owner-request", (event) => {
        this.handleThreadOwnerRequest(event);
      }),
      subscribeCodexAppServerMessage("thread-owner-unavailable", (event) => {
        this.handleThreadOwnerUnavailable(event);
      }),
      subscribeCodexAppServerMessage("mcp-notification", (event) => {
        this.handleMcpNotification(event);
      }),
      subscribeCodexAppServerMessage("error", (event) => {
        this.handleHostError(event);
      }),
    );
  }

  getHostId(): string {
    return this.hostId;
  }

  start(): void {
    if (this.bootstrapStarted) {
      return;
    }

    this.bootstrapStarted = true;
    void this.bootstrapAccountAndConnection();
    void this.bootstrapDictationState();
    void this.bootstrapAvailableModels();
    void this.bootstrapPermissionModes();
  }

  stop(): void {
    // Host bridge lifecycle is provider-owned; manager subscriptions stay attached
    // for the lifetime of the manager instance, mirroring the upstream manager graph.
  }

  destroy(): void {
    this.cancelPendingNodexAgentAuthorizations();
    this.ownerTextDeltaQueue.dispose();
    this.ownerTextDeltaSequenceTracker.clear();
    this.ownerNotificationCompletionByConversationId.clear();
    this.unclaimedOwnerNotificationSequencesByConversationId.clear();
    this.outputDeltaQueue.dispose();
    this.resumeInFlightByThreadId.clear();
    this.attachmentStateByThreadId.clear();
    this.attachmentCallbacks.clear();
    this.interruptedTurnResumesInFlightByThreadId.clear();
    this.deferredOwnerMessagesByRequestRecovery.clear();
    this.ownerHiddenLifecycleItemTypesByConversationId.clear();
    this.ownerRollbackTombstonesByConversationId.clear();
    this.queueOwnerProjectionFenceByConversationId.clear();
    this.cancelOwnerStreamPublishQueues();
    for (const timer of this.activeGoalContinuationTimers.values()) {
      clearTimeout(timer);
    }
    this.activeGoalContinuationTimers.clear();
    this.activeGoalContinuationPromises.clear();
    this.terminalInputBuffers.clear();
    this.childMembershipsByParentThreadId.clear();
    this.relationshipCallbacks.clear();
    while (this.busUnsubscribers.length > 0) {
      this.busUnsubscribers.pop()?.();
    }
  }

  readConnection(): CodexConnectionState {
    return this.connection;
  }

  readAccount(): CodexAccountSnapshot | null {
    return this.account;
  }

  readAvailableModels(): CodexModelOption[] {
    return this.availableModels;
  }

  readDictationState(): CodexDictationStateSnapshot {
    return this.dictationState;
  }

  readProjectThreadSummaries(projectId: string): CodexThreadSummary[] {
    return this.threadSummariesByProject.get(projectId) ?? EMPTY_THREADS;
  }

  readThreadSummary(threadId: string): CodexThreadSummary | null {
    return this.threadSummariesById.get(threadId) ?? null;
  }

  readConversation(threadId: string): CodexConversationSnapshot | null {
    return this.conversationsById.get(threadId) ?? null;
  }

  readConversationChildMemberships(threadId: string): CodexConversationChildMembership[] {
    return this.childMembershipsByParentThreadId.get(threadId) ?? EMPTY_CHILD_MEMBERSHIPS;
  }

  readConversationStreamRole(threadId: string): LocalConversationStreamRole["role"] | null {
    return this.streamState.getRole(threadId)?.role ?? null;
  }

  readPrimaryConversationRequest(threadId: string): CodexConversationLiveRequest | null {
    return this.primaryConversationRequestByThread.get(threadId) ?? null;
  }

  readConversationCollaborationMode(threadId: string): CodexCollaborationModeState | null {
    return this.conversationsById.get(threadId)?.latestCollaborationMode ?? null;
  }

  readConversationThreadSettings(threadId: string): CodexConversationThreadSettings | null {
    return this.conversationsById.get(threadId)?.latestThreadSettings ?? null;
  }

  readComposerIntent(threadId: string): CodexComposerIntent | null {
    return this.composerIntentsByThread.get(threadId) ?? null;
  }

  readPermissionMode(projectId: string | null): CodexPermissionMode {
    return resolveProjectPermissionMode(this.permissionStateByScope, projectId);
  }

  readPermissionState(projectId: string | null): CodexPermissionState {
    return resolveProjectPermissionState(this.permissionStateByScope, projectId);
  }

  readThreadStartProgress(
    projectId: string | null,
    sessionId: string,
  ): CodexThreadStartProgressState | null {
    return (
      this.threadStartProgressByTarget.get(getThreadStartProgressTargetKey(projectId, sessionId)) ??
      null
    );
  }

  readLastHostError(): CodexHostErrorState | null {
    return this.lastHostError;
  }

  readRecentConversations(): CodexConversationSnapshot[] {
    const conversations: CodexConversationSnapshot[] = [];
    for (const threadId of this.recentConversationIds) {
      const conversation = this.conversationsById.get(threadId);
      if (conversation) {
        conversations.push(conversation);
      }
    }
    return conversations.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  subscribeConnection(listener: StoreListener): () => void {
    this.start();
    return subscribeSet(this.connectionCallbacks, listener);
  }

  subscribeAccount(listener: StoreListener): () => void {
    this.start();
    return subscribeSet(this.accountCallbacks, listener);
  }

  subscribeControl(listener: ControlListener): () => void {
    this.start();
    return subscribeSet(this.controlCallbacks, listener);
  }

  subscribeProjectThreadSummaries(projectId: string, listener: StoreListener): () => void {
    this.start();
    const listeners = getOrCreateListenerSet(this.projectSummaryCallbacksByProject, projectId);
    this.ensureProjectThreadSummariesLoaded(projectId);
    const unsubscribe = subscribeSet(listeners, listener);
    return () => {
      unsubscribe();
      cleanupListenerSet(this.projectSummaryCallbacksByProject, projectId);
    };
  }

  addConversationCallback(threadId: string, listener: ConversationListener): () => void {
    this.start();
    const listeners = getOrCreateListenerSet(this.conversationCallbacks, threadId);
    const unsubscribe = subscribeSet(listeners, listener);
    return () => {
      unsubscribe();
      cleanupListenerSet(this.conversationCallbacks, threadId);
    };
  }

  subscribeConversationAttachment(threadId: string, listener: StoreListener): () => void {
    this.start();
    const listeners = getOrCreateListenerSet(this.attachmentCallbacks, threadId);
    const unsubscribe = subscribeSet(listeners, listener);
    return () => {
      unsubscribe();
      cleanupListenerSet(this.attachmentCallbacks, threadId);
    };
  }

  readConversationAttachmentState(threadId: string): LocalConversationAttachmentState {
    return this.attachmentStateByThreadId.get(threadId) ?? IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE;
  }

  private setConversationAttachmentState(
    threadId: string,
    state: LocalConversationAttachmentState,
  ): void {
    const current = this.readConversationAttachmentState(threadId);
    if (areLocalConversationAttachmentStatesEqual(current, state)) return;
    if (state.status === "idle") {
      this.attachmentStateByThreadId.delete(threadId);
    } else {
      this.attachmentStateByThreadId.set(threadId, state);
    }
    for (const listener of this.attachmentCallbacks.get(threadId) ?? []) listener();
  }

  removeConversationCallback(threadId: string, listener: ConversationListener): void {
    const listeners = this.conversationCallbacks.get(threadId);
    if (!listeners) {
      return;
    }

    listeners.delete(listener);
    cleanupListenerSet(this.conversationCallbacks, threadId);
  }

  subscribeConversationChildMemberships(threadId: string, listener: StoreListener): () => void {
    this.start();
    const listeners = getOrCreateListenerSet(this.relationshipCallbacks, threadId);
    const unsubscribe = subscribeSet(listeners, listener);
    return () => {
      unsubscribe();
      cleanupListenerSet(this.relationshipCallbacks, threadId);
    };
  }

  addAnyConversationCallback(listener: AnyConversationListener): () => void {
    this.start();
    return subscribeSet(this.anyConversationCallbacks, listener);
  }

  removeAnyConversationCallback(listener: AnyConversationListener): void {
    this.anyConversationCallbacks.delete(listener);
  }

  addAnyConversationMetaCallback(listener: AnyConversationListener): () => void {
    this.start();
    return subscribeSet(this.anyConversationMetaCallbacks, listener);
  }

  removeAnyConversationMetaCallback(listener: AnyConversationListener): void {
    this.anyConversationMetaCallbacks.delete(listener);
  }

  hydrateThreadSummaries(projectId: string, threads: CodexThreadSummary[]): void {
    const normalizedThreads = threads.map((thread) => {
      const nextThread = this.withCachedThreadTitle(thread);
      if (nextThread.threadName?.trim()) {
        this.threadTitlesById.set(nextThread.threadId, nextThread.threadName);
      }
      return nextThread;
    });
    const sortedThreads = sortThreadSummaries(normalizedThreads);
    this.loadedThreadSummariesByProject.add(projectId);
    const current = this.threadSummariesByProject.get(projectId) ?? EMPTY_THREADS;
    if (areThreadSummariesEqual(current, sortedThreads)) {
      return;
    }

    this.threadSummariesByProject.set(projectId, sortedThreads);
    for (const thread of sortedThreads) {
      this.threadSummariesById.set(thread.threadId, thread);
      this.ensureRecentConversationId(thread.threadId);
    }
    this.notifyProjectThreadSummaries(projectId);
    this.notifyAnyConversationCallbacks({ forceMeta: true });
  }

  async loadThreads(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<CodexThreadSummary[]> {
    if (!opts && this.threadSummaryLoadsInFlightByProject.has(projectId)) {
      return this.threadSummaryLoadsInFlightByProject.get(projectId)!;
    }

    const loadPromise = this.loadThreadsFromHost(projectId, opts);
    if (!opts) {
      this.threadSummaryLoadsInFlightByProject.set(projectId, loadPromise);
    }

    try {
      return await loadPromise;
    } finally {
      if (!opts) {
        this.threadSummaryLoadsInFlightByProject.delete(projectId);
      }
    }
  }

  private async loadThreadsFromHost(
    projectId: string,
    opts?: { includeArchived?: boolean },
  ): Promise<CodexThreadSummary[]> {
    const threads: CodexThreadSummary[] = [];
    let after: string | null = null;
    do {
      const window: CodexThreadSummaryWindow = await runConversationOperation(
        "codex:threads:list",
        projectId,
        {
          ...opts,
          after,
          first: 200,
        },
      );
      threads.push(...window.items);
      after = window.nextCursor;
    } while (after !== null);
    this.hydrateThreadSummaries(projectId, threads);
    return threads;
  }

  async loadAvailableModels(): Promise<CodexModelOption[]> {
    const models = (await runConversationOperation("codex:model:list")) as CodexModelOption[];
    this.setAvailableModels(models);
    return models;
  }

  async loadDictationState(): Promise<CodexDictationStateSnapshot> {
    const nextState = (await runConversationOperation(
      "codex:dictation:state:read",
    )) as CodexDictationStateSnapshot;
    this.setDictationState(nextState);
    return nextState;
  }

  async listCollaborationModes(): Promise<CodexCollaborationModePreset[]> {
    return (await runConversationOperation(
      "codex:collaboration-mode:list",
    )) as CodexCollaborationModePreset[];
  }

  async requestThreadStreamSnapshot(threadId: string): Promise<CodexConversationSnapshot | null> {
    const conversation = (await runConversationOperation(
      "codex:thread:snapshot:request",
      threadId,
    )) as CodexConversationSnapshot | null;
    if (conversation && !this.isFollowerForConversation(threadId)) {
      const materialized = materializeOwnerCanonicalConversationSnapshot(conversation);
      this.applyConversationSnapshot(threadId, materialized);
      return materialized;
    }
    return conversation;
  }

  async requestThreadStreamResume(threadId: string): Promise<CodexConversationSnapshot | null> {
    const existing = this.resumeInFlightByThreadId.get(threadId);
    if (existing) return await existing;

    const resumePromise = this.runThreadStreamResume(threadId);
    this.resumeInFlightByThreadId.set(threadId, resumePromise);
    try {
      return await resumePromise;
    } finally {
      if (this.resumeInFlightByThreadId.get(threadId) === resumePromise) {
        this.resumeInFlightByThreadId.delete(threadId);
      }
    }
  }

  private async runThreadStreamResume(threadId: string): Promise<CodexConversationSnapshot | null> {
    this.setConversationAttachmentState(threadId, {
      status: "attaching",
    });
    this.markConversationResumeState(threadId, "resuming");
    let adoptedRenderer = false;

    try {
      const result = await runConversationOperation("codex:thread:resume:request", threadId);
      if (result) {
        const acceptedReplica = resolveAcceptedConversationReplica({
          conversation: result.conversation,
          revision: result.revision,
          checkpoint: result.checkpoint,
          context: `Thread resume for ${threadId}`,
        });
        const materialized = materializeOwnerCanonicalConversationSnapshot(result.conversation);
        if (result.role === "follower") {
          const checkpoint = result.checkpoint;
          await this.waitForOwnerStreamPublishIdle(threadId);
          this.ownerStreamPublishCursorsByConversationId.delete(threadId);
          this.queueOwnerProjectionFenceByConversationId.delete(threadId);
          this.followerAcceptedReplicasByConversationId.set(threadId, acceptedReplica);
          this.streamState.adoptFollowerBaseline({
            conversationId: threadId,
            checkpoint,
            sourceClientId: result.ownerClientId,
          });
          this.applyConversationSnapshot(threadId, materialized);
          this.setConversationAttachmentState(threadId, {
            status: "attached",
          });
          return this.conversationsById.get(threadId) ?? materialized;
        }

        await this.waitForOwnerStreamPublishIdle(threadId);
        this.followerAcceptedReplicasByConversationId.delete(threadId);
        const checkpoint = result.checkpoint;
        this.streamState.markOwner(threadId, checkpoint);
        this.recordQueueOwnerProjectionFence({
          threadId,
          threadGeneration: result.threadGeneration,
          ownerEpoch: checkpoint.ownerEpoch,
          projectionRevision: result.conversation.queuedFollowUps.projectionRevision,
        });
        this.seedOwnerStreamPublishCursor(threadId, checkpoint, acceptedReplica);
        adoptedRenderer = true;
        this.applyConversationSnapshot(threadId, materialized);
        await runConversationOperation("codex:thread:resume-buffer:release", threadId);
        const latestConversation = this.conversationsById.get(threadId) ?? materialized;
        await this.publishOwnerSnapshotTransaction(threadId, latestConversation, "owner resume");
        await runConversationOperation("codex:thread-owner:pending-requests:replay", threadId);
        this.setConversationAttachmentState(threadId, {
          status: "attached",
        });
        return this.conversationsById.get(threadId) ?? latestConversation;
      }
      this.markConversationResumeState(threadId, "needs_resume");
      this.setConversationAttachmentState(
        threadId,
        makeLocalConversationAttachmentFailure(
          new Error("The thread is no longer available to restore."),
        ),
      );
      return null;
    } catch (error) {
      await this.releaseResumeBufferAfterFailedResume(threadId);
      if (adoptedRenderer) {
        this.markOwnerStreamPublishUnavailable(threadId);
      } else {
        this.markConversationResumeState(threadId, "needs_resume");
      }
      this.setConversationAttachmentState(threadId, makeLocalConversationAttachmentFailure(error));
      throw error;
    }
  }

  private markConversationResumeState(
    threadId: string,
    resumeState: CodexConversationSnapshot["resumeState"],
  ): void {
    const conversation = this.conversationsById.get(threadId);
    if (!conversation || conversation.resumeState === resumeState) {
      return;
    }

    this.applyConversationSnapshot(threadId, {
      ...conversation,
      resumeState,
    });
  }

  private async releaseResumeBufferAfterFailedResume(threadId: string): Promise<void> {
    try {
      await runConversationOperation("codex:thread:resume-buffer:release", threadId);
    } catch {}
  }

  async setThreadViewActive(threadId: string, active: boolean): Promise<boolean> {
    this.streamState.setConversationFollowing(threadId, active);
    return (await runConversationOperation("codex:thread:view-active:set", {
      threadId,
      active,
    })) as boolean;
  }

  async setThreadStreamFollowing(threadId: string, following: boolean): Promise<boolean> {
    return this.setThreadStreamFollowingWithOptions(threadId, following);
  }

  private async setThreadStreamFollowingWithOptions(
    threadId: string,
    following: boolean,
    options: { reannounce?: boolean } = {},
  ): Promise<boolean> {
    this.streamState.setConversationFollowing(threadId, following);
    return (await runConversationOperation("codex:thread:stream-following:set", {
      threadId,
      following,
      ...(options.reannounce === true ? { reannounce: true } : {}),
    })) as boolean;
  }

  async setThreadPresented(
    threadId: string,
    surfaceId: string,
    presented: boolean,
  ): Promise<boolean> {
    return (await runConversationOperation("codex:thread:presentation:set", {
      threadId,
      surfaceId,
      presented,
    })) as boolean;
  }

  async readSubagentOverview(
    input: CodexSubagentOverviewReadInput,
  ): Promise<CodexSubagentOverviewWindow> {
    return (await runConversationOperation(
      "codex:subagents:overview:read",
      input,
    )) as CodexSubagentOverviewWindow;
  }

  private async requestSelectedSubagentAuthority(
    input: CodexSelectedSubagentHydrateInput,
  ): Promise<CodexSelectedSubagentHydrateResult> {
    const normalized = normalizeSelectedSubagentInput(input);
    if (!normalized.rootThreadId || !normalized.threadId) {
      return selectedSubagentHydrationFailure(normalized, "Subagent identity is required");
    }

    const result = (await runConversationOperation(
      "codex:subagents:selected:hydrate",
      normalized,
    )) as CodexSelectedSubagentHydrateResult;
    if (
      result.rootThreadId.trim() !== normalized.rootThreadId ||
      result.threadId.trim() !== normalized.threadId
    ) {
      return selectedSubagentHydrationFailure(
        normalized,
        "Selected subagent identity changed while opening",
        result,
      );
    }
    return {
      ...result,
      rootThreadId: normalized.rootThreadId,
      threadId: normalized.threadId,
    };
  }

  /** Reads current Main-owned selection authority without attaching or resuming the child. */
  async refreshSelectedSubagentAuthority(
    input: CodexSelectedSubagentHydrateInput,
  ): Promise<CodexSelectedSubagentHydrateResult> {
    try {
      return await this.requestSelectedSubagentAuthority(input);
    } catch (cause) {
      return selectedSubagentHydrationFailure(
        input,
        selectedSubagentErrorMessage(cause, "Could not refresh selected subagent authority"),
      );
    }
  }

  async hydrateSelectedSubagent(
    input: CodexSelectedSubagentHydrateInput,
  ): Promise<CodexSelectedSubagentHydrateResult> {
    const normalized = normalizeSelectedSubagentInput(input);
    const hydrated = await this.refreshSelectedSubagentAuthority(normalized);
    if (hydrated.outcome !== "ready") return hydrated;

    try {
      const attached = await this.requestThreadStreamResume(normalized.threadId);
      const applied = this.readConversation(normalized.threadId);
      const role = this.readConversationStreamRole(normalized.threadId);
      const attachment = this.readConversationAttachmentState(normalized.threadId);
      if (
        !attached ||
        attached.threadId !== normalized.threadId ||
        !applied ||
        applied.threadId !== normalized.threadId ||
        role === null ||
        attachment.status !== "attached"
      ) {
        return {
          ...hydrated,
          canInteract: false,
          outcome: "unavailable",
          errorMessage: "This subagent could not attach to this window.",
        };
      }

      const revalidated = await this.refreshSelectedSubagentAuthority(normalized);
      if (revalidated.outcome !== "ready") {
        return { ...revalidated, canInteract: false };
      }
      const revalidatedConversation = this.readConversation(normalized.threadId);
      const revalidatedRole = this.readConversationStreamRole(normalized.threadId);
      const revalidatedAttachment = this.readConversationAttachmentState(normalized.threadId);
      if (
        !revalidatedConversation ||
        revalidatedConversation.threadId !== normalized.threadId ||
        revalidatedRole === null ||
        revalidatedAttachment.status !== "attached"
      ) {
        return {
          ...revalidated,
          canInteract: false,
          outcome: "unavailable",
          errorMessage: "This subagent detached before it was ready.",
        };
      }
      return revalidated;
    } catch (cause) {
      return selectedSubagentHydrationFailure(
        normalized,
        selectedSubagentErrorMessage(cause, "Could not attach the selected subagent"),
        hydrated,
      );
    }
  }

  requestHistoryPage(
    request: CodexConversationHistoryPageRequest,
  ): Promise<CodexConversationHistoryPageResult> {
    const key = codexConversationHistoryPageRequestKey(request);
    const existing = this.historyPageLoadsInFlightByTarget.get(key);
    if (existing) return existing;

    const loadPromise = (async () => {
      if (this.isFollowerForConversation(request.threadId)) {
        return await this.waitForHistoryPageFromOwner(request);
      }
      return (await this.loadHistoryPageAsOwner(request)).page;
    })();

    this.historyPageLoadsInFlightByTarget.set(key, loadPromise);
    void loadPromise.finally(() => {
      if (this.historyPageLoadsInFlightByTarget.get(key) === loadPromise) {
        this.historyPageLoadsInFlightByTarget.delete(key);
      }
    });
    return loadPromise;
  }

  /** Publishes a Main-authored bounded history mutation through the current owner authority. */
  async publishLocalConversationHistoryMutation(
    threadId: string,
    mutation: CodexConversationHistoryMutation,
  ): Promise<number> {
    if (this.isFollowerForConversation(threadId)) {
      const result = await this.runFollowerActionThroughOwner<{ revision: number }>(threadId, {
        type: "publishHistoryMutation",
        threadId,
        mutation,
      });
      await this.waitForOwnerPublishedRevision(threadId, result.revision);
      return result.revision;
    }
    await this.ensureOwnerForConversationAction(threadId, "publish bounded history");
    return await this.publishOwnerHistoryMutation(threadId, mutation);
  }

  async setHistoryResidencyPins(
    pins: CodexHistoryResidencyPinsInput,
  ): Promise<CodexHistoryResidencyPinsResult> {
    const result = (await runConversationOperation(
      "codex:thread:history-residency-pins:set",
      pins,
    )) as CodexHistoryResidencyPinsResult;
    if (result.status !== "applied" || !result.mutation) return result;
    const role = this.streamState.getRole(pins.threadId);
    if (role?.role === "follower") {
      const publication = await this.runFollowerActionThroughOwner<{ revision: number }>(
        pins.threadId,
        {
          type: "publishHistoryMutation",
          threadId: pins.threadId,
          mutation: result.mutation,
        },
      );
      await this.waitForOwnerPublishedRevision(pins.threadId, publication.revision);
      return result;
    }
    await this.ensureOwnerForConversationAction(pins.threadId, "publish history eviction");
    await this.publishOwnerHistoryMutation(pins.threadId, result.mutation);
    return result;
  }

  private async loadHistoryPageAsOwner(
    request: CodexConversationHistoryPageRequest,
  ): Promise<CodexThreadOwnerHistoryMutationResult> {
    await this.ensureOwnerForConversationAction(request.threadId, "load history page");
    const page = (await runConversationOperation(
      "codex:thread:history-page:load",
      request,
    )) as CodexConversationHistoryPageResult;
    return {
      revision: await this.publishOwnerHistoryMutation(request.threadId, page.mutation),
      page,
    };
  }

  async hydratePersistedHistoryOccurrence(
    input: CodexPersistedHistoryOccurrenceHydrateInput,
  ): Promise<CodexPersistedHistoryOccurrenceResolution> {
    const request: CodexPersistedHistoryOccurrenceHydrateRequest = {
      ...input,
      requestId: createOwnerGeneratedItemId("persisted-history-hydration"),
    };
    const role = this.streamState.getRole(input.threadId);
    if (role?.role === "follower") {
      const result =
        await this.runFollowerActionThroughOwner<CodexThreadOwnerPersistedHistoryHydrationResult>(
          input.threadId,
          { type: "hydratePersistedHistoryOccurrence", input: request },
          { fallback: () => this.hydratePersistedHistoryOccurrenceAsOwner(request) },
        );
      await this.waitForOwnerPublishedRevision(input.threadId, result.revision);
      return result.hydration;
    }

    await this.ensureOwnerForConversationAction(
      input.threadId,
      "hydrate persisted history occurrence",
    );
    return (await this.hydratePersistedHistoryOccurrenceAsOwner(request)).hydration;
  }

  private async hydratePersistedHistoryOccurrenceAsOwner(
    input: CodexPersistedHistoryOccurrenceHydrateRequest,
  ): Promise<CodexThreadOwnerPersistedHistoryHydrationResult> {
    await this.ensureOwnerForConversationAction(
      input.threadId,
      "hydrate persisted history occurrence",
    );
    const result = (await runConversationOperation(
      "codex:thread:history-search:hydrate",
      input,
    )) as CodexPersistedHistoryOccurrenceHydrateResult;
    const { mutation, ...hydration } = result;
    return {
      revision:
        mutation === null
          ? (this.streamState.getRevision(input.threadId) ?? 0)
          : await this.publishOwnerHistoryMutation(input.threadId, mutation),
      hydration,
    };
  }

  private async publishOwnerSnapshotTransaction(
    threadId: string,
    conversation: CodexConversationSnapshot,
    label: string,
    options: { notifyMode?: ConversationNotifyMode } = {},
  ): Promise<number> {
    await this.waitForOwnerStreamPublishIdle(threadId);
    return await this.publishOwnerSnapshotFromIdle(threadId, conversation, label, options);
  }

  private async publishOwnerSnapshotFromIdle(
    threadId: string,
    conversation: CodexConversationSnapshot,
    label: string,
    options: { notifyMode?: ConversationNotifyMode } = {},
  ): Promise<number> {
    const role = this.streamState.getRole(threadId);
    const currentCheckpoint = this.streamState.getCheckpoint(threadId);
    const currentConversation = this.conversationsById.get(threadId) ?? conversation;
    if (!role || role.role !== "owner" || !currentCheckpoint) {
      throw new Error(
        `Cannot publish ${label} snapshot because renderer is not owner for ${threadId}`,
      );
    }

    const cursor = this.ensureOwnerStreamPublishCursor(
      threadId,
      currentCheckpoint,
      currentConversation,
    );
    if (cursor.inFlight || cursor.dirty) {
      throw new Error(
        `Cannot publish ${label} snapshot because owner stream cursor is still busy for ${threadId}`,
      );
    }

    cursor.inFlight = true;
    this.applyConversationSnapshot(
      threadId,
      conversation,
      undefined,
      options.notifyMode ?? "default",
    );
    const latestConversation = this.conversationsById.get(threadId) ?? conversation;
    const sharedConversation = toSharedConversationDocument(latestConversation);
    const result = await this.publishOwnerSnapshotFromCursor(threadId, cursor, sharedConversation);
    if (!result.accepted) {
      cursor.inFlight = false;
      this.markOwnerStreamPublishUnavailable(threadId);
      throw new Error(`Could not publish ${label} snapshot for ${threadId}: ${result.reason}`);
    }

    cursor.acceptedCheckpoint = result.checkpoint;
    cursor.acceptedDocument = this.consumeOwnerStandaloneUnreadStateOverride(
      cursor,
      result.conversation,
    );
    cursor.inFlight = false;
    this.streamState.recordOwnerCheckpoint(threadId, result.checkpoint);
    this.processOwnerStreamPublishCursor(threadId);
    this.resolveOwnerStreamPublishIdleWaiters(threadId);
    return result.checkpoint.revision;
  }

  private async publishOwnerActionSnapshotMutation(
    threadId: string,
    label: string,
    buildNextConversation: (
      conversation: CodexConversationSnapshot,
    ) => CodexConversationSnapshot | null,
    options: { notifyMode?: ConversationNotifyMode } = {},
  ): Promise<number> {
    const currentConversation = this.conversationsById.get(threadId);
    if (!currentConversation) {
      throw new Error(`Cannot publish ${label} because conversation ${threadId} is unavailable`);
    }

    // Local commit is deliberately synchronous. Publication belongs to the
    // existing owner outbox and must never gate owner-visible interaction.
    const expectedRevision = this.publishOwnerActionConversationMutation(
      threadId,
      buildNextConversation,
      options,
    );
    if (expectedRevision === null) {
      return this.streamState.getRevision(threadId) ?? 0;
    }

    await this.waitForOwnerStreamPublishIdle(threadId);
    return this.streamState.getRevision(threadId) ?? expectedRevision;
  }

  /** Publishes the exact bounded history delta without recursively diffing the resident graph. */
  private async publishOwnerHistoryMutation(
    threadId: string,
    mutation: CodexConversationHistoryMutation,
  ): Promise<number> {
    await this.waitForOwnerStreamPublishIdle(threadId);
    const role = this.streamState.getRole(threadId);
    const checkpoint = this.streamState.getCheckpoint(threadId);
    const currentConversation = this.conversationsById.get(threadId);
    if (!role || role.role !== "owner" || !checkpoint || !currentConversation) {
      throw new Error(`Cannot publish history mutation without owner authority for ${threadId}`);
    }
    const cursor = this.ensureOwnerStreamPublishCursor(threadId, checkpoint, currentConversation);
    if (cursor.inFlight || cursor.dirty) {
      throw new Error(`Cannot publish history mutation while owner stream is busy for ${threadId}`);
    }
    const accepted = applyCodexConversationHistoryMutation(cursor.acceptedDocument, mutation);
    const presented = applyCodexConversationHistoryMutation(currentConversation, mutation);
    if (!accepted.ok) {
      throw new Error(`Could not apply history mutation for ${threadId}: ${accepted.reason}`);
    }
    if (!presented.ok) {
      throw new Error(`Could not apply history mutation for ${threadId}: ${presented.reason}`);
    }

    const baseCheckpoint = cursor.acceptedCheckpoint;
    const nextCheckpoint = buildCodexThreadStreamCheckpoint({
      ownerEpoch: baseCheckpoint.ownerEpoch,
      revision: baseCheckpoint.revision + 1,
      conversation: accepted.conversation,
    });
    cursor.inFlight = true;
    this.applyConversationSnapshot(threadId, presented.conversation);
    const result = await this.dispatchOwnerStreamHistoryMutation(
      threadId,
      baseCheckpoint,
      nextCheckpoint,
      mutation,
    );
    if (this.ownerStreamPublishCursorsByConversationId.get(threadId) !== cursor) {
      throw new Error(`Owner authority changed while publishing history for ${threadId}`);
    }
    if (!result.accepted) {
      cursor.inFlight = false;
      if (result.recovery) {
        this.adoptOwnerSnapshotRecovery(threadId, cursor, result.recovery);
      } else {
        this.markOwnerStreamPublishUnavailable(threadId);
      }
      throw new Error(`Could not publish history mutation for ${threadId}: ${result.reason}`);
    }
    cursor.acceptedCheckpoint = result.checkpoint;
    cursor.acceptedDocument = this.consumeOwnerStandaloneUnreadStateOverride(
      cursor,
      accepted.conversation,
    );
    cursor.inFlight = false;
    this.streamState.recordOwnerCheckpoint(threadId, result.checkpoint);
    this.processOwnerStreamPublishCursor(threadId);
    this.resolveOwnerStreamPublishIdleWaiters(threadId);
    return result.checkpoint.revision;
  }

  /**
   * A failed owner command normally publishes its terminal projection through the owner outbox.
   * Endpoint loss revokes that role first, so the same semantic failure must still settle the
   * visible optimistic turn locally while the replacement generation rehydrates canonical state.
   */
  private async settleOwnerActionFailure(
    threadId: string,
    label: string,
    buildNextConversation: (
      conversation: CodexConversationSnapshot,
    ) => CodexConversationSnapshot | null,
  ): Promise<number> {
    if (this.streamState.getRole(threadId)?.role === "owner") {
      return await this.publishOwnerActionSnapshotMutation(threadId, label, buildNextConversation);
    }

    const currentConversation = this.conversationsById.get(threadId);
    if (!currentConversation) return 0;
    const candidateConversation = buildNextConversation(currentConversation);
    if (!candidateConversation || candidateConversation === currentConversation) {
      return this.streamState.getRevision(threadId) ?? 0;
    }

    const nextConversation = finalizeOwnerConversationMutation(
      currentConversation,
      candidateConversation,
    );
    this.applyConversationSnapshot(threadId, {
      ...nextConversation,
      resumeState: "needs_resume",
    });
    return this.streamState.getRevision(threadId) ?? 0;
  }

  async startThreadForSession(
    input: CodexThreadStartForSessionInput & {
      collaborationMode?: CodexCollaborationModeKind;
      model?: string;
      reasoningEffort?: CodexThreadSettings["reasoningEffort"];
    },
  ): Promise<CodexThreadStartForSessionResult> {
    const runInTarget = input.runInTarget ?? "localProject";
    const reportsDirectThreadProgress = runInTarget !== "newWorktree";
    const progressTargetKey = getThreadStartProgressTargetKey(input.projectId, input.sessionId);
    if (reportsDirectThreadProgress) {
      this.applyThreadStartProgress({
        projectId: input.projectId,
        sessionId: input.sessionId,
        runInTarget,
        threadId: null,
        phase: "startingThread",
        message: "Sending message…",
        clearOutput: true,
        updatedAt: Date.now(),
      });
      this.setRendererFreshLaunchPending(input.projectId, input.sessionId, true);
    }

    try {
      await this.loadPermissionState(input.projectId);
      const result = (await runConversationOperation("codex:thread:start-for-session", {
        ...input,
        permissionMode: this.readPermissionMode(input.projectId),
      })) as CodexThreadStartForSessionResult;

      if (result.kind === "started") {
        if (result.freshLaunch) {
          await this.adoptFreshThreadLaunch(input.projectId, input.sessionId, result.freshLaunch);
        } else {
          await this.requestThreadStreamSnapshot(result.detail.threadId).catch(() => null);
          this.setRendererFreshLaunchPending(input.projectId, input.sessionId, false);
        }
      }
      return result;
    } catch (error) {
      if (!reportsDirectThreadProgress) throw error;
      this.setRendererFreshLaunchPending(input.projectId, input.sessionId, false);
      const currentProgress = this.threadStartProgressByTarget.get(progressTargetKey);
      if (currentProgress?.phase !== "failed") {
        this.applyThreadStartProgress({
          projectId: input.projectId,
          sessionId: input.sessionId,
          runInTarget,
          threadId: currentProgress?.threadId ?? null,
          phase: "failed",
          message: "Message could not be sent.",
          updatedAt: Date.now(),
        });
      }
      throw error;
    }
  }

  private async adoptFreshThreadLaunch(
    projectId: string | null,
    sessionId: string,
    launch: NonNullable<
      Extract<CodexThreadStartForSessionResult, { kind: "started" }>["freshLaunch"]
    >,
  ): Promise<void> {
    this.setConversationAttachmentState(launch.threadId, {
      status: "attaching",
    });
    try {
      const result = await runConversationOperation(
        "codex:thread:fresh-owner:adopt",
        launch.threadId,
        launch.launchId,
      );
      const acceptedReplica = resolveAcceptedConversationReplica({
        conversation: result.conversation,
        revision: result.revision,
        checkpoint: result.checkpoint,
        context: `Fresh owner adoption for ${launch.threadId}`,
      });
      const conversation = materializeOwnerCanonicalConversationSnapshot(result.conversation);
      this.followerAcceptedReplicasByConversationId.delete(launch.threadId);
      const checkpoint = result.checkpoint;
      this.streamState.markOwner(launch.threadId, checkpoint);
      this.recordQueueOwnerProjectionFence({
        threadId: launch.threadId,
        threadGeneration: result.threadGeneration,
        ownerEpoch: checkpoint.ownerEpoch,
        projectionRevision: result.conversation.queuedFollowUps.projectionRevision,
      });
      this.seedOwnerStreamPublishCursor(launch.threadId, checkpoint, acceptedReplica);
      this.applyConversationSnapshot(launch.threadId, conversation);
      await runConversationOperation("codex:thread:resume-buffer:release", launch.threadId);
      await runConversationOperation("codex:thread-owner:pending-requests:replay", launch.threadId);
      this.setConversationAttachmentState(launch.threadId, {
        status: "attached",
      });
    } catch (error) {
      await this.releaseResumeBufferAfterFailedResume(launch.threadId);
      this.markOwnerStreamPublishUnavailable(launch.threadId);
      this.setConversationAttachmentState(
        launch.threadId,
        makeLocalConversationAttachmentFailure(error),
      );
      throw error;
    }

    // The transaction commits and synchronously notifies the optimistic turn
    // before returning this transport-completion promise.
    const firstTurnCompletion = this.executeOwnerOptimisticTurnTransaction({
      threadId: launch.threadId,
      clientUserMessageId: launch.clientUserMessageId,
      canonicalParams: launch.canonicalParams,
      request: () =>
        this.ownerAppServerRequestClient.startSessionFirstTurn(launch.threadId, {
          threadId: launch.threadId,
          launchId: launch.launchId,
        }),
      onOptimisticCommitted: () => {
        this.commitRendererFreshLaunchVisible(projectId, sessionId, launch.threadId);
      },
      optimisticNotifyMode: "sync",
    });
    void firstTurnCompletion.catch(() => {
      this.setRendererFreshLaunchPending(projectId, sessionId, false);
      const current = this.readThreadStartProgress(projectId, sessionId);
      if (current?.phase === "failed") return;

      this.applyThreadStartProgress({
        projectId,
        sessionId,
        runInTarget: current?.runInTarget ?? "localProject",
        threadId: launch.threadId,
        phase: "failed",
        message: "Message could not be sent.",
        updatedAt: Date.now(),
      });
    });
  }

  async startSideChat(input: CodexSideChatStartInput): Promise<CodexSideChatStartResult> {
    const parent =
      this.readConversation(input.parentThreadId) ?? this.readThreadSummary(input.parentThreadId);
    const projectId = parent?.projectId ?? null;
    await this.loadPermissionState(projectId);
    const result = (await runConversationOperation("codex:thread:side-chat:start", {
      ...input,
      permissionMode: input.permissionMode ?? this.readPermissionMode(projectId),
    })) as CodexSideChatStartResult;
    const conversation = materializeOwnerCanonicalConversationSnapshot(result.conversation);
    this.applyConversationSnapshot(result.threadId, conversation);
    try {
      const attachedConversation = await this.requestThreadStreamResume(result.threadId);
      if (!attachedConversation) {
        throw new Error("The side chat was created but could not attach to this window.");
      }
      return { ...result, conversation: attachedConversation };
    } catch (error) {
      await runConversationOperation("codex:thread:side-chat:discard", result.threadId).catch(
        () => false,
      );
      this.removeThreadLocalState(result.threadId);
      throw error;
    }
  }

  async discardSideChat(threadId: string): Promise<boolean> {
    const result = (await runConversationOperation(
      "codex:thread:side-chat:discard",
      threadId,
    )) as boolean;
    if (result) {
      this.removeThreadLocalState(threadId);
    }
    return result;
  }

  async setThreadName(threadId: string, name: string, projectId: string | null): Promise<boolean> {
    const normalizedName = normalizeCodexManualThreadTitle(name);
    if (!normalizedName) {
      return false;
    }

    this.applyThreadTitleUpdate(threadId, normalizedName);
    try {
      const result = (await runConversationOperation(
        "codex:thread:name:set",
        threadId,
        normalizedName,
      )) as boolean;
      if (!result) {
        if (projectId) void this.loadThreads(projectId).catch(() => {});
      }
      return result;
    } catch (error) {
      if (projectId) void this.loadThreads(projectId).catch(() => {});
      throw error;
    }
  }

  async archiveThread(threadId: string, projectId: string | null): Promise<boolean> {
    const result = (await runConversationOperation("codex:thread:archive", threadId)) as boolean;
    if (result && projectId !== null) await this.loadThreads(projectId);
    return result;
  }

  async unarchiveThread(
    threadId: string,
    projectId: string | null,
  ): Promise<CodexThreadSummary | null> {
    const result = (await runConversationOperation(
      "codex:thread:unarchive",
      threadId,
    )) as CodexThreadSummary | null;
    if (projectId !== null) await this.loadThreads(projectId, { includeArchived: true });
    return result;
  }

  private isFollowerForConversation(conversationId: string): boolean {
    return this.streamState.getRole(conversationId)?.role === "follower";
  }

  private assertOwnerForConversation(conversationId: string): void {
    if (this.streamState.getRole(conversationId)?.role === "owner") return;
    throw new Error(`Renderer is not owner for conversation ${conversationId}`);
  }

  private async ensureOwnerForConversationAction(
    conversationId: string,
    label: string,
  ): Promise<void> {
    const role = this.streamState.getRole(conversationId);
    if (role?.role === "owner") {
      return;
    }
    if (role?.role === "follower") {
      throw new Error(
        `Cannot run ${label} locally while following another owner for ${conversationId}`,
      );
    }

    const conversation = await this.requestThreadStreamResume(conversationId);
    if (!conversation || this.streamState.getRole(conversationId)?.role !== "owner") {
      throw new Error(
        `Cannot run ${label} because conversation ${conversationId} could not become renderer-owned`,
      );
    }
  }

  getThreadRoleForRendererClientRequest(conversationId: string): CodexRendererThreadRole {
    return this.streamState.getRole(conversationId)?.role === "owner" ? "owner" : "follower";
  }

  private conversationHasRequest(
    conversationId: string,
    requestId: CodexProtocolRequestId,
  ): boolean {
    const conversation = this.conversationsById.get(conversationId);
    if (!conversation) return false;
    return (
      conversation.canonicalRequests?.some((request) => request.id === requestId) === true ||
      conversation.requests.some((request) => request.requestId === requestId)
    );
  }

  private findConversationIdForRequest(
    requestId: CodexProtocolRequestId,
    conversationId?: string | null,
  ): string | null {
    const explicitConversationId = conversationId?.trim() || null;
    if (explicitConversationId) {
      return this.conversationHasRequest(explicitConversationId, requestId)
        ? explicitConversationId
        : null;
    }
    for (const conversation of this.conversationsById.values()) {
      if (this.conversationHasRequest(conversation.threadId, requestId)) {
        return conversation.threadId;
      }
    }
    return null;
  }

  private findFollowerConversationIdForRequest(requestId: CodexProtocolRequestId): string | null {
    const conversationId = this.findConversationIdForRequest(requestId);
    if (!conversationId || !this.isFollowerForConversation(conversationId)) return null;
    return conversationId;
  }

  private findOwnerRoutedConversationIdForRequestResponse(
    requestId: CodexProtocolRequestId,
    conversationId?: string | null,
  ): string | null {
    const explicitConversationId = conversationId?.trim() || null;
    if (explicitConversationId) {
      if (this.isFollowerForConversation(explicitConversationId)) {
        return explicitConversationId;
      }

      const conversation = this.conversationsById.get(explicitConversationId);
      const requestStillVisible =
        conversation?.requests.some((request) => request.requestId === requestId) === true;
      return requestStillVisible && conversation?.resumeState === "needs_resume"
        ? explicitConversationId
        : null;
    }

    return this.findFollowerConversationIdForRequest(requestId);
  }

  private async runFollowerActionThroughOwner<TResult>(
    conversationId: string,
    action: CodexThreadOwnerActionRequest,
    options: {
      fallback?: () => Promise<TResult>;
      fallbackOnTimeout?: boolean;
    } = {},
  ): Promise<TResult> {
    try {
      return (await runConversationOperation("codex:thread-follower:action", {
        conversationId,
        action,
      })) as TResult;
    } catch (error) {
      if (!this.isUnavailableOwnerActionError(error, options.fallbackOnTimeout === true)) {
        throw error;
      }
      this.markConversationNeedsResumeAfterUnavailableOwner(conversationId);
      if (!options.fallback) {
        throw error;
      }

      await this.requestThreadStreamResume(conversationId);
      return await options.fallback();
    }
  }

  private async executeConversationAction<TResult>(input: {
    conversationId: string;
    label: string;
    action: CodexThreadOwnerActionRequest;
    executeAsOwner: () => Promise<TResult>;
    waitForStreamRevision?: boolean;
  }): Promise<TResult> {
    const role = this.streamState.getRole(input.conversationId);
    if (role?.role === "follower") {
      const result = await this.runFollowerActionThroughOwner<TResult>(
        input.conversationId,
        input.action,
        { fallback: input.executeAsOwner },
      );
      if (input.waitForStreamRevision === true) {
        await this.waitForFollowerActionStreamRevision(input.conversationId, result);
      }
      return result;
    }

    await this.ensureOwnerForConversationAction(input.conversationId, input.label);
    return await input.executeAsOwner();
  }

  private isUnavailableOwnerActionError(error: unknown, includeTimeout: boolean): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("no-client-found") ||
      message.includes("No renderer owner") ||
      (includeTimeout && (message.includes("timeout") || message.includes("timed out")))
    );
  }

  private markConversationNeedsResumeAfterUnavailableOwner(conversationId: string): void {
    const role = this.streamState.getRole(conversationId);
    if (role?.role === "follower") {
      this.streamState.markOwnerUnavailable(role.ownerClientId);
    }
    const conversation = this.conversationsById.get(conversationId);
    if (conversation && conversation.resumeState !== "needs_resume") {
      this.applyConversationSnapshot(conversationId, {
        ...conversation,
        resumeState: "needs_resume",
      });
    }
    this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
  }

  private async runFollowerRequestResponseThroughOwner(
    conversationId: string,
    action: CodexThreadOwnerActionRequest,
  ): Promise<boolean> {
    try {
      const result = await this.runFollowerActionThroughOwner<unknown>(conversationId, action);
      const accepted = this.readOwnerBooleanActionResult(result);
      if (accepted) await this.waitForFollowerActionStreamRevision(conversationId, result);
      return accepted;
    } catch (error) {
      if (this.isUnavailableOwnerActionError(error, false)) {
        return false;
      }
      throw error;
    }
  }

  private async waitForHistoryPageFromOwner(
    request: CodexConversationHistoryPageRequest,
  ): Promise<CodexConversationHistoryPageResult> {
    const role = this.streamState.getRole(request.threadId);
    if (role?.role !== "follower" || !role.ownerClientId) {
      throw new Error(`Cannot route history page without a follower owner for ${request.threadId}`);
    }
    const result = await this.runFollowerActionThroughOwner<CodexThreadOwnerHistoryMutationResult>(
      request.threadId,
      { type: "loadHistoryPage", request },
    );
    await this.waitForOwnerPublishedRevision(request.threadId, result.revision);
    return result.page;
  }

  private async waitForOwnerPublishedRevision(threadId: string, revision: number): Promise<void> {
    const role = this.streamState.getRole(threadId);
    if (role?.role !== "follower" || !role.ownerClientId) return;
    await this.streamState.waitForRevision({
      conversationId: threadId,
      ownerClientId: role.ownerClientId,
      revision,
      timeoutMs: COMPLETE_HISTORY_WAIT_TIMEOUT_MS,
    });
  }

  private async waitForFollowerActionStreamRevision(
    threadId: string,
    result: unknown,
  ): Promise<void> {
    const streamRevision = this.readOwnerStreamRevision(result);
    if (streamRevision === null) return;

    const role = this.streamState.getRole(threadId);
    if (role?.role !== "follower" || !role.ownerClientId) return;

    await this.streamState.waitForRevision({
      conversationId: threadId,
      ownerClientId: role.ownerClientId,
      revision: streamRevision,
      timeoutMs: COMPLETE_HISTORY_WAIT_TIMEOUT_MS,
    });
  }

  private withOwnerStreamRevision<TResult>(result: TResult, streamRevision: number): TResult {
    if (typeof result === "object" && result !== null && !Array.isArray(result)) {
      return {
        ...result,
        streamRevision,
      };
    }

    return result;
  }

  private buildOwnerStreamRevisionResult(streamRevision: number): OwnerStreamRevisionResult {
    return { streamRevision };
  }

  private readOwnerStreamRevision(result: unknown): number | null {
    const resultRecord = asRecord(result);
    return typeof resultRecord?.streamRevision === "number" ? resultRecord.streamRevision : null;
  }

  private readOwnerBooleanActionResult(result: unknown): boolean {
    const resultRecord = asRecord(result);
    if (typeof resultRecord?.accepted === "boolean") return resultRecord.accepted;
    if (typeof resultRecord?.ok === "boolean") return resultRecord.ok;
    return result === true;
  }

  private markOwnerServerRequestActionHandled(
    result: OwnerServerRequestReplyResult,
  ): OwnerServerRequestReplyResult {
    return {
      accepted: true,
      ...(result.streamRevision !== undefined ? { streamRevision: result.streamRevision } : {}),
    };
  }

  private recordQueueOwnerProjectionFence(input: {
    readonly threadId: string;
    readonly threadGeneration: number;
    readonly ownerEpoch: number;
    readonly projectionRevision: number;
    readonly publication?: Promise<number> | null;
    readonly streamRevision?: number | null;
  }): void {
    this.queueOwnerProjectionFenceByConversationId.set(input.threadId, {
      threadGeneration: input.threadGeneration,
      ownerEpoch: input.ownerEpoch,
      projectionRevision: input.projectionRevision,
      publication: input.publication ?? null,
      streamRevision: input.streamRevision ?? null,
    });
  }

  async applyQueueOwnerUpdate(
    input: CodexQueueOwnerUpdateRequest,
  ): Promise<CodexQueueOwnerUpdateResult> {
    const currentFence = () =>
      this.queueOwnerProjectionFenceByConversationId.get(input.threadId) ?? null;
    const reject = (
      reason: Extract<CodexQueueOwnerUpdateResult, { kind: "rejected" }>["reason"],
    ): CodexQueueOwnerUpdateResult => ({
      kind: "rejected",
      reason,
      currentProjectionRevision: currentFence()?.projectionRevision ?? null,
    });

    const conversation = this.conversationsById.get(input.threadId);
    if (!conversation) return reject("conversation-unavailable");
    if (this.streamState.getRole(input.threadId)?.role !== "owner") {
      return reject("not-owner");
    }

    const checkpoint = this.streamState.getCheckpoint(input.threadId);
    if (!checkpoint || checkpoint.ownerEpoch !== input.ownerEpoch) {
      return reject("owner-epoch-mismatch");
    }

    const fence = currentFence();
    if (!fence || fence.threadGeneration !== input.threadGeneration) {
      return reject("thread-generation-mismatch");
    }
    if (fence.ownerEpoch !== input.ownerEpoch) return reject("owner-epoch-mismatch");
    if (input.projectionRevision < fence.projectionRevision) {
      return reject("newer-projection-applied");
    }
    if (input.projectionRevision === fence.projectionRevision) {
      const streamRevision =
        fence.streamRevision ??
        (fence.publication
          ? await fence.publication
          : (this.streamState.getRevision(input.threadId) ?? 0));
      return {
        kind: "already-applied",
        projectionRevision: fence.projectionRevision,
        streamRevision,
      };
    }
    if (input.transcript.kind !== "none" && !conversation.canonicalState) {
      return reject("canonical-state-unavailable");
    }

    const publication = this.publishOwnerActionSnapshotMutation(
      input.threadId,
      "Main queue owner projection",
      (currentConversation) => {
        const transcript = applyQueueOwnerTranscriptDirective(
          currentConversation,
          input.transcript,
        );
        if (!transcript) return null;
        return {
          ...currentConversation,
          ...transcript,
          queuedFollowUps: copyQueuedFollowUpProjection(input.projection),
        };
      },
    );
    this.recordQueueOwnerProjectionFence({
      threadId: input.threadId,
      threadGeneration: input.threadGeneration,
      ownerEpoch: input.ownerEpoch,
      projectionRevision: input.projectionRevision,
      publication,
    });
    const streamRevision = await publication;
    const appliedFence = currentFence();
    if (
      appliedFence?.threadGeneration === input.threadGeneration &&
      appliedFence.ownerEpoch === input.ownerEpoch &&
      appliedFence.projectionRevision === input.projectionRevision
    ) {
      this.recordQueueOwnerProjectionFence({
        threadId: input.threadId,
        threadGeneration: input.threadGeneration,
        ownerEpoch: input.ownerEpoch,
        projectionRevision: input.projectionRevision,
        streamRevision,
      });
    }
    return {
      kind: "applied",
      projectionRevision: input.projectionRevision,
      streamRevision,
    };
  }

  async handleThreadOwnerActionRequest(action: CodexThreadOwnerActionRequest): Promise<unknown> {
    switch (action.type) {
      case "startTurn":
        this.assertOwnerForConversation(action.threadId);
        return await this.startTurnAsOwner(action.threadId, action.prompt, action.opts);
      case "resumeInterruptedTurn":
        this.assertOwnerForConversation(action.threadId);
        return await this.resumeInterruptedTurnAsOwner(action.threadId, action.opts);
      case "steerTurn":
        this.assertOwnerForConversation(action.input.threadId);
        return await this.steerTurnAsOwner(action.input);
      case "interruptTurn":
        this.assertOwnerForConversation(action.threadId);
        return await this.interruptTurnAsOwner(action.threadId, action.turnId);
      case "updateThreadSettings":
        this.assertOwnerForConversation(action.threadId);
        return await this.setThreadSettingsForConversationAsOwner(action.threadId, action.patch);
      case "compactThread":
        this.assertOwnerForConversation(action.threadId);
        await this.compactThreadAsOwner(action.threadId);
        return null;
      case "setThreadGoal":
        this.assertOwnerForConversation(action.threadId);
        return await this.setThreadGoalAsOwner(normalizeThreadGoalSetActionInput(action));
      case "clearThreadGoal":
        this.assertOwnerForConversation(action.threadId);
        return await this.clearThreadGoalAsOwner(action.threadId);
      case "dismissThreadGoalResumeConfirmation":
        this.assertOwnerForConversation(action.threadId);
        return await this.dismissThreadGoalResumeConfirmationAsOwner(action.threadId);
      case "setThreadMemoryMode":
        this.assertOwnerForConversation(action.threadId);
        await this.setThreadMemoryModeAsOwner({
          threadId: action.threadId,
          mode: action.mode,
        });
        return null;
      case "editLastUserTurn":
        this.assertOwnerForConversation(action.threadId);
        return await this.editLastUserTurnAsOwner(
          action.threadId,
          action.turnId,
          action.message,
          action.opts,
        );
      case "forkConversationFromTurn":
        this.assertOwnerForConversation(action.threadId);
        return await this.forkConversationFromTurnAsOwner(
          action.threadId,
          action.turnId,
          action.message,
        );
      case "loadHistoryPage":
        this.assertOwnerForConversation(action.request.threadId);
        return await this.loadHistoryPageAsOwner(action.request);
      case "publishHistoryMutation":
        this.assertOwnerForConversation(action.threadId);
        return {
          revision: await this.publishOwnerHistoryMutation(action.threadId, action.mutation),
        };
      case "hydratePersistedHistoryOccurrence":
        this.assertOwnerForConversation(action.input.threadId);
        return await this.hydratePersistedHistoryOccurrenceAsOwner(action.input);
      case "enqueueQueuedFollowUp":
        this.assertOwnerForConversation(action.threadId);
        return await this.enqueueQueuedFollowUpAsOwner(action.threadId, action.prompt, action.opts);
      case "removeQueuedFollowUp":
        this.assertOwnerForConversation(action.threadId);
        return await this.removeQueuedFollowUpAsOwner(action.threadId, action.followUpId);
      case "replaceQueuedFollowUp":
        this.assertOwnerForConversation(action.threadId);
        return await this.replaceQueuedFollowUpAsOwner(
          action.threadId,
          action.followUpId,
          action.expectedLedgerRevision,
          action.prompt,
          action.opts,
        );
      case "reorderQueuedFollowUps":
        this.assertOwnerForConversation(action.threadId);
        return await this.reorderQueuedFollowUpsAsOwner(action.threadId, action.orderedFollowUpIds);
      case "resumeQueuedFollowUps":
        this.assertOwnerForConversation(action.threadId);
        return await this.resumeQueuedFollowUpsAsOwner(action.threadId);
      case "resolveQueuedFollowUpsAfterFreshStart":
        this.assertOwnerForConversation(action.threadId);
        return await this.resolveQueuedFollowUpsAfterFreshStartAsOwner(
          action.threadId,
          action.expectedLedgerRevision,
          action.resolution,
        );
      case "sendQueuedFollowUpNow":
        this.assertOwnerForConversation(action.threadId);
        return await this.sendQueuedFollowUpNowAsOwner(action.threadId, action.followUpId);
      case "respondApproval":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondApprovalAsOwner(
            action.requestId,
            action.response,
            action.conversationId,
          ),
        );
      case "respondUserInput":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondUserInputAsOwner(
            action.requestId,
            action.answers,
            action.conversationId,
          ),
        );
      case "respondMcpElicitation":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondMcpElicitationAsOwner(
            action.requestId,
            action.response,
            action.conversationId,
          ),
        );
      case "respondPermissionRequest":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondPermissionRequestAsOwner(
            action.requestId,
            action.response,
            action.conversationId,
          ),
        );
      case "respondOptionPicker":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondOptionPickerAsOwner(
            action.conversationId,
            action.requestId,
            action.response,
          ),
        );
      case "respondSetupCodexStep":
        this.assertOwnerForConversation(action.conversationId);
        return this.markOwnerServerRequestActionHandled(
          await this.respondSetupCodexStepAsOwner(
            action.conversationId,
            action.requestId,
            action.response,
          ),
        );
      case "removePlanImplementationRequest":
        this.assertOwnerForConversation(action.threadId);
        return await this.removePlanImplementationRequestAsOwner(action.threadId, action.turnId);
    }
  }

  async startTurn(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<unknown> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "start turn",
      action: {
        type: "startTurn",
        threadId,
        prompt,
        opts,
      },
      executeAsOwner: () => this.startTurnAsOwner(threadId, prompt, opts),
      waitForStreamRevision: true,
    });
  }

  async resumeInterruptedTurn(threadId: string, opts?: CodexTurnStartOptions): Promise<unknown> {
    const existing = this.interruptedTurnResumesInFlightByThreadId.get(threadId);
    if (existing) return await existing;

    const operation = this.executeConversationAction({
      conversationId: threadId,
      label: "resume interrupted turn",
      action: {
        type: "resumeInterruptedTurn",
        threadId,
        opts,
      },
      executeAsOwner: () => this.resumeInterruptedTurnAsOwner(threadId, opts),
      waitForStreamRevision: true,
    });
    this.interruptedTurnResumesInFlightByThreadId.set(threadId, operation);
    try {
      return await operation;
    } finally {
      if (this.interruptedTurnResumesInFlightByThreadId.get(threadId) === operation) {
        this.interruptedTurnResumesInFlightByThreadId.delete(threadId);
      }
    }
  }

  private async resumeInterruptedTurnAsOwner(
    threadId: string,
    opts?: CodexTurnStartOptions,
  ): Promise<unknown> {
    await this.ensureOwnerForConversationAction(threadId, "resume interrupted turn");
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }
    if (conversation.threadGoal) {
      throw new Error("Thread goals must be resumed from their goal controls");
    }
    if (
      conversation.statusType === "active" ||
      conversation.statusActiveFlags.length > 0 ||
      conversation.turns.some((turn) => turn.status === "inProgress")
    ) {
      throw new Error("Nodex is already running");
    }
    if (
      conversation.requests.length > 0 ||
      (conversation.canonicalRequests?.length ?? 0) > 0 ||
      conversation.pendingSteers.length > 0
    ) {
      throw new Error("Resolve the pending thread action before resuming Nodex");
    }
    if (conversation.turns.at(-1)?.status !== "interrupted") {
      throw new Error("Only the latest interrupted turn can be resumed");
    }

    const preparedPrompt = createEmptyCodexPreparedPrompt();
    const clientUserMessageId = createOwnerClientUserMessageId();
    const canonicalParams = buildOwnerCanonicalOptimisticParams(conversation, {
      clientUserMessageId,
      opts,
      preparedPrompt,
    });
    if (!canonicalParams) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }

    return await this.executeOwnerOptimisticTurnTransaction({
      threadId,
      clientUserMessageId,
      canonicalParams,
      failureMode: "remove",
      request: () =>
        this.ownerAppServerRequestClient.resumeInterruptedTurn(threadId, {
          threadId,
          opts,
          clientUserMessageId,
        }),
    });
  }

  private async startTurnAsOwner(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<unknown> {
    await this.ensureOwnerForConversationAction(threadId, "start turn");
    return await this.startTurnAsOwnerLocalTransaction(threadId, prompt, opts);
  }

  private async startTurnAsOwnerLocalTransaction(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<unknown> {
    const promptInput = opts?.promptInput;
    const preparedPrompt = await prepareCodexPrompt(prompt, promptInput, {
      resolveImageInput: resolveOwnerPromptImageInput,
    });
    const clientUserMessageId = createOwnerClientUserMessageId();
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }
    const canonicalParams = buildOwnerCanonicalOptimisticParams(conversation, {
      clientUserMessageId,
      opts,
      preparedPrompt,
    });
    if (!canonicalParams) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }
    return await this.executeOwnerOptimisticTurnTransaction({
      threadId,
      clientUserMessageId,
      canonicalParams,
      request: () =>
        this.ownerAppServerRequestClient.startTurn(threadId, {
          threadId,
          prompt,
          opts,
          clientUserMessageId,
          preparedPrompt,
        }),
    });
  }

  private async executeOwnerOptimisticTurnTransaction(input: {
    readonly threadId: string;
    readonly clientUserMessageId: string;
    readonly canonicalParams: CodexCanonicalLiveTurnParams;
    readonly request: () => Promise<TurnStartResponse | unknown>;
    readonly onOptimisticCommitted?: () => void;
    readonly optimisticNotifyMode?: ConversationNotifyMode;
    readonly failureMode?: "fail" | "remove";
  }): Promise<unknown> {
    const { threadId, clientUserMessageId, canonicalParams } = input;
    const observedAtMs = Date.now();
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }
    const previousRuntimeStatus =
      conversation.threadRuntimeStatus ??
      buildOwnerThreadRuntimeStatus(conversation.statusType, conversation.statusActiveFlags);
    const optimisticRuntimeStatus: CodexThreadRuntimeStatus | null =
      previousRuntimeStatus.type === "active" ? null : { type: "active", activeFlags: [] };
    const previousTurnModel = conversation.canonicalState?.sidecar.previousTurnModel ?? null;

    const optimisticPublication = this.publishOwnerActionSnapshotMutation(
      threadId,
      "turn start optimistic",
      (conversation) =>
        appendOwnerOptimisticTurn(
          conversation,
          canonicalParams,
          observedAtMs,
          optimisticRuntimeStatus,
        ),
      { notifyMode: input.optimisticNotifyMode },
    );
    input.onOptimisticCommitted?.();

    try {
      const startResult = await input.request();
      const startedTurn = parseOwnerTurnStartResult(threadId, startResult);
      const rebindPublication = this.publishOwnerActionSnapshotMutation(
        threadId,
        "turn start rebind",
        (conversation) => rebindOwnerOptimisticTurn(conversation, clientUserMessageId, startedTurn),
      );
      const [optimisticRevision, streamRevision] = await Promise.all([
        optimisticPublication,
        rebindPublication,
      ]);

      return this.withOwnerStreamRevision(
        startedTurn?.summary ?? null,
        streamRevision || optimisticRevision,
      );
    } catch (error) {
      const failurePublication = this.settleOwnerActionFailure(
        threadId,
        "turn start failure",
        (conversation) =>
          input.failureMode === "remove"
            ? removeOwnerResumePlaceholderFromConversation(
                conversation,
                clientUserMessageId,
                previousRuntimeStatus,
                optimisticRuntimeStatus,
                previousTurnModel,
              )
            : applyOwnerStartFailureToConversation(
                conversation,
                clientUserMessageId,
                previousRuntimeStatus,
                optimisticRuntimeStatus,
              ),
      );
      await Promise.all([optimisticPublication, failurePublication]);
      throw error;
    }
  }

  async setThreadSettingsForConversation(
    threadId: string,
    patch: CodexConversationThreadSettingsPatch,
  ): Promise<CodexConversationThreadSettings> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "update thread settings",
      action: {
        type: "updateThreadSettings",
        threadId,
        patch,
      },
      executeAsOwner: () => this.setThreadSettingsForConversationAsOwner(threadId, patch),
      waitForStreamRevision: true,
    });
  }

  private async setThreadSettingsForConversationAsOwner(
    threadId: string,
    patch: CodexConversationThreadSettingsPatch,
  ): Promise<CodexConversationThreadSettings> {
    await this.ensureOwnerForConversationAction(threadId, "update thread settings");

    const persistedSettings = await this.ownerAppServerRequestClient.updateThreadSettings(
      threadId,
      {
        threadId,
        patch,
      },
    );
    const streamRevision = await this.publishOwnerActionSnapshotMutation(
      threadId,
      "thread settings update",
      (conversation) => {
        const before = conversation.canonicalState;
        const previous = before?.sidecar.latestThreadSettings;
        if (!before || !previous) return null;
        const protocolSettings: Parameters<typeof reduceCodexConversationThreadSettings>[2] = {
          ...previous,
          model: persistedSettings.model ?? previous.model,
          modelProvider: persistedSettings.modelProvider ?? previous.modelProvider,
          serviceTier:
            persistedSettings.serviceTier === undefined
              ? previous.serviceTier
              : persistedSettings.serviceTier,
          effort: persistedSettings.reasoningEffort,
          summary:
            persistedSettings.summary === undefined ? previous.summary : persistedSettings.summary,
          collaborationMode: persistedSettings.collaborationMode ?? previous.collaborationMode,
          personality: persistedSettings.personality,
        };
        const state = reduceCodexConversationThreadSettings(before, threadId, protocolSettings);
        return projectOwnerThreadSettingsToConversation(conversation, state);
      },
    );
    return this.withOwnerStreamRevision(persistedSettings, streamRevision);
  }

  async setLatestCollaborationModeForConversation(
    threadId: string,
    mode: CodexCollaborationModeKind,
  ): Promise<CodexCollaborationModeState> {
    const persistedSettings = await this.setThreadSettingsForConversation(threadId, {
      collaborationMode: mode,
    });
    return persistedSettings.collaborationMode ?? DEFAULT_COLLABORATION_MODE_STATE;
  }

  async enqueueQueuedFollowUp(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "enqueue follow-up",
      action: {
        type: "enqueueQueuedFollowUp",
        threadId,
        prompt,
        opts,
      },
      executeAsOwner: () => this.enqueueQueuedFollowUpAsOwner(threadId, prompt, opts),
      waitForStreamRevision: true,
    });
  }

  private async enqueueQueuedFollowUpAsOwner(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(threadId, "enqueue follow-up");
    await runConversationOperation("codex:thread:follow-up:enqueue", threadId, prompt, opts);
  }

  async removeQueuedFollowUp(threadId: string, followUpId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "remove queued follow-up",
      action: {
        type: "removeQueuedFollowUp",
        threadId,
        followUpId,
      },
      executeAsOwner: () => this.removeQueuedFollowUpAsOwner(threadId, followUpId),
      waitForStreamRevision: true,
    });
  }

  private async removeQueuedFollowUpAsOwner(
    threadId: string,
    followUpId: string,
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(threadId, "remove queued follow-up");
    await runConversationOperation("codex:thread:follow-up:remove", threadId, followUpId);
  }

  async replaceQueuedFollowUp(
    threadId: string,
    followUpId: string,
    expectedLedgerRevision: number,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<boolean> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "replace queued follow-up",
      action: {
        type: "replaceQueuedFollowUp",
        threadId,
        followUpId,
        expectedLedgerRevision,
        prompt,
        opts,
      },
      executeAsOwner: () =>
        this.replaceQueuedFollowUpAsOwner(
          threadId,
          followUpId,
          expectedLedgerRevision,
          prompt,
          opts,
        ),
      waitForStreamRevision: true,
    });
  }

  private async replaceQueuedFollowUpAsOwner(
    threadId: string,
    followUpId: string,
    expectedLedgerRevision: number,
    prompt: string,
    opts?: CodexTurnStartOptions,
  ): Promise<boolean> {
    await this.ensureOwnerForConversationAction(threadId, "replace queued follow-up");
    return await runConversationOperation(
      "codex:thread:follow-up:replace",
      threadId,
      followUpId,
      expectedLedgerRevision,
      prompt,
      opts,
    );
  }

  async reorderQueuedFollowUps(threadId: string, orderedFollowUpIds: string[]): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "reorder queued follow-ups",
      action: {
        type: "reorderQueuedFollowUps",
        threadId,
        orderedFollowUpIds,
      },
      executeAsOwner: () => this.reorderQueuedFollowUpsAsOwner(threadId, orderedFollowUpIds),
      waitForStreamRevision: true,
    });
  }

  private async reorderQueuedFollowUpsAsOwner(
    threadId: string,
    orderedFollowUpIds: string[],
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(threadId, "reorder queued follow-ups");
    await runConversationOperation("codex:thread:follow-up:reorder", threadId, orderedFollowUpIds);
  }

  async resumeQueuedFollowUps(threadId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "resume queued follow-ups",
      action: { type: "resumeQueuedFollowUps", threadId },
      executeAsOwner: () => this.resumeQueuedFollowUpsAsOwner(threadId),
      waitForStreamRevision: true,
    });
  }

  private async resumeQueuedFollowUpsAsOwner(threadId: string): Promise<void> {
    await this.ensureOwnerForConversationAction(threadId, "resume queued follow-ups");
    await runConversationOperation("codex:thread:follow-up:resume", threadId);
  }

  async resolveQueuedFollowUpsAfterFreshStart(
    threadId: string,
    expectedLedgerRevision: number,
    resolution: "resume" | "clear",
  ): Promise<boolean> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "resolve queued follow-ups after fresh message",
      action: {
        type: "resolveQueuedFollowUpsAfterFreshStart",
        threadId,
        expectedLedgerRevision,
        resolution,
      },
      executeAsOwner: () =>
        this.resolveQueuedFollowUpsAfterFreshStartAsOwner(
          threadId,
          expectedLedgerRevision,
          resolution,
        ),
      waitForStreamRevision: true,
    });
  }

  private async resolveQueuedFollowUpsAfterFreshStartAsOwner(
    threadId: string,
    expectedLedgerRevision: number,
    resolution: "resume" | "clear",
  ): Promise<boolean> {
    await this.ensureOwnerForConversationAction(
      threadId,
      "resolve queued follow-ups after fresh message",
    );
    return await runConversationOperation(
      "codex:thread:follow-up:resolve-after-fresh-start",
      threadId,
      expectedLedgerRevision,
      resolution,
    );
  }

  async sendQueuedFollowUpNow(threadId: string, followUpId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "send queued follow-up",
      action: {
        type: "sendQueuedFollowUpNow",
        threadId,
        followUpId,
      },
      executeAsOwner: () => this.sendQueuedFollowUpNowAsOwner(threadId, followUpId),
      waitForStreamRevision: true,
    });
  }

  private async sendQueuedFollowUpNowAsOwner(
    threadId: string,
    followUpId: string,
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(threadId, "send queued follow-up");
    await runConversationOperation("codex:thread:follow-up:send-now", threadId, followUpId);
  }

  async editLastUserTurn(
    threadId: string,
    turnId: string,
    message: string,
    opts?: { serviceTier?: CodexServiceTier },
  ): Promise<CodexThreadActionResult> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "edit last user turn",
      action: {
        type: "editLastUserTurn",
        threadId,
        turnId,
        message,
        opts,
      },
      executeAsOwner: () => this.editLastUserTurnAsOwner(threadId, turnId, message, opts),
      waitForStreamRevision: true,
    });
  }

  private async editLastUserTurnAsOwner(
    threadId: string,
    turnId: string,
    message: string,
    opts?: { serviceTier?: CodexServiceTier },
  ): Promise<CodexThreadActionResult> {
    const role = this.streamState.getRole(threadId);
    if (role?.role !== "owner") {
      await this.ensureOwnerForConversationAction(threadId, "edit last user turn");
    }

    await this.waitForOwnerStreamPublishIdle(threadId);

    const conversationBeforeRollback = this.conversationsById.get(threadId);
    if (!conversationBeforeRollback) {
      throw new Error(`Thread '${threadId}' was not found`);
    }

    if (resolveLatestEditableUserTurnId(conversationBeforeRollback) !== turnId) {
      throw new Error("Only the latest completed user turn can be edited");
    }

    const targetTurn = conversationBeforeRollback.turns.find((turn) => turn.turnId === turnId);
    if (!targetTurn) {
      throw new Error("Only the latest completed user turn can be edited");
    }
    const replacementPromptInput = buildOwnerEditReplacementPromptInput(targetTurn, message);
    const rollbackResult = await this.ownerAppServerRequestClient.revertThreadForEdit(threadId, {
      threadId,
      beforeTurnId: turnId,
    });
    const conversationAtRollback = this.conversationsById.get(threadId);
    if (!conversationAtRollback) {
      throw new Error(`Thread '${threadId}' was not found`);
    }
    const rollbackConversation = materializeOwnerRollbackConversation(
      conversationAtRollback,
      rollbackResult,
    );
    this.rememberOwnerRollbackTombstones(threadId, conversationAtRollback, rollbackConversation);
    const streamRevision = await this.publishOwnerSnapshotTransaction(
      threadId,
      rollbackConversation,
      "edit rollback",
      { notifyMode: "sync" },
    );

    const startResult = await this.startTurnAsOwnerLocalTransaction(threadId, message, {
      ...opts,
      promptInput: replacementPromptInput,
    });
    const startRevision = asRecord(startResult)?.streamRevision;

    return {
      threadId,
      streamRevision: typeof startRevision === "number" ? startRevision : streamRevision,
    };
  }

  async forkConversationFromTurn(
    threadId: string,
    turnId: string,
    message: string,
  ): Promise<CodexThreadActionResult> {
    return await this.executeConversationAction({
      conversationId: threadId,
      label: "fork conversation from turn",
      action: {
        type: "forkConversationFromTurn",
        threadId,
        turnId,
        message,
      },
      executeAsOwner: () => this.forkConversationFromTurnAsOwner(threadId, turnId, message),
    });
  }

  private async forkConversationFromTurnAsOwner(
    threadId: string,
    turnId: string,
    message: string,
  ): Promise<CodexThreadActionResult> {
    const role = this.streamState.getRole(threadId);
    if (role?.role !== "owner") {
      await this.ensureOwnerForConversationAction(threadId, "fork conversation from turn");
    }

    return await this.ownerAppServerRequestClient.forkConversationFromTurn(threadId, {
      threadId,
      turnId,
      message,
    });
  }

  async compactThread(threadId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "compact thread",
      action: {
        type: "compactThread",
        threadId,
      },
      executeAsOwner: () => this.compactThreadAsOwner(threadId),
    });
  }

  private async compactThreadAsOwner(threadId: string): Promise<void> {
    await this.ensureOwnerForConversationAction(threadId, "compact thread");
    await this.ownerAppServerRequestClient.compactThread(threadId, { threadId });
  }

  async getThreadGoal(threadId: string): Promise<ThreadGoal | null> {
    return (await runConversationOperation("codex:thread:goal:get", threadId)) as ThreadGoal | null;
  }

  async setThreadGoal(input: CodexThreadGoalSetActionInput): Promise<ThreadGoal | null> {
    const action = normalizeThreadGoalSetActionInput(input);
    return await this.executeConversationAction({
      conversationId: input.threadId,
      label: "set thread goal",
      action: {
        type: "setThreadGoal",
        ...action,
      },
      executeAsOwner: () => this.setThreadGoalAsOwner(action),
      waitForStreamRevision: true,
    });
  }

  private async setThreadGoalAsOwner(
    input: CodexThreadGoalSetActionInput,
    options: SetThreadGoalAsOwnerOptions = {},
  ): Promise<ThreadGoal | null> {
    const action = normalizeThreadGoalSetActionInput(input);
    const params = normalizeThreadGoalSetParams(action);
    await this.ensureOwnerForConversationAction(input.threadId, "set thread goal");
    if (action.threadSettings) {
      await this.setThreadSettingsForConversationAsOwner(input.threadId, action.threadSettings);
    }
    const goal = await this.ownerAppServerRequestClient.setThreadGoal(input.threadId, params);
    const streamRevision = await this.publishOwnerActionSnapshotMutation(
      input.threadId,
      "thread goal set",
      (conversation) => {
        const before = conversation.canonicalState;
        if (!before || !goal) return null;
        const result = reduceCodexConversationThreadGoalUpdated(before, input.threadId, goal);
        const state = options.clearResumeConfirmation
          ? reduceCodexConversationThreadGoalResumeConfirmationDismissed(
              result.state,
              input.threadId,
            )
          : result.state;
        if (
          !goal ||
          action.appendTranscriptItem === false ||
          typeof action.objective !== "string"
        ) {
          return projectOwnerThreadGoalToConversation(conversation, state);
        }
        const withTranscript = appendCodexCanonicalThreadGoalTranscriptTurn(state, goal);
        return materializeOwnerCanonicalConversationSnapshot(
          projectOwnerThreadGoalToConversation(conversation, withTranscript),
        );
      },
    );
    return goal ? this.withOwnerStreamRevision(goal, streamRevision) : goal;
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "clear thread goal",
      action: {
        type: "clearThreadGoal",
        threadId,
      },
      executeAsOwner: () => this.clearThreadGoalAsOwner(threadId),
      waitForStreamRevision: true,
    });
  }

  private async clearThreadGoalAsOwner(
    threadId: string,
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(threadId, "clear thread goal");
    await this.ownerAppServerRequestClient.clearThreadGoal(threadId, { threadId });
    const streamRevision = await this.publishOwnerActionSnapshotMutation(
      threadId,
      "thread goal clear",
      (conversation) => {
        const before = conversation.canonicalState;
        if (!before) return null;
        return projectOwnerThreadGoalToConversation(
          conversation,
          reduceCodexConversationThreadGoalCleared(before, threadId),
        );
      },
    );
    return this.buildOwnerStreamRevisionResult(streamRevision);
  }

  async dismissThreadGoalResumeConfirmation(threadId: string): Promise<void> {
    await this.executeConversationAction({
      conversationId: threadId,
      label: "dismiss thread goal resume confirmation",
      action: {
        type: "dismissThreadGoalResumeConfirmation",
        threadId,
      },
      executeAsOwner: () => this.dismissThreadGoalResumeConfirmationAsOwner(threadId),
      waitForStreamRevision: true,
    });
  }

  private async dismissThreadGoalResumeConfirmationAsOwner(
    threadId: string,
  ): Promise<OwnerStreamRevisionResult | void> {
    await this.ensureOwnerForConversationAction(
      threadId,
      "dismiss thread goal resume confirmation",
    );

    const streamRevision = await this.publishOwnerActionSnapshotMutation(
      threadId,
      "thread goal resume confirmation dismissed",
      (conversation) => {
        const before = conversation.canonicalState;
        if (!before) return null;
        const projected = projectOwnerThreadGoalToConversation(
          conversation,
          reduceCodexConversationThreadGoalResumeConfirmationDismissed(before, threadId),
        );
        return (
          applyOwnerThreadGoalResumeConfirmationDismissedToConversation(projected) ?? projected
        );
      },
    );
    return this.buildOwnerStreamRevisionResult(streamRevision);
  }

  async setThreadMemoryMode(input: { threadId: string; mode: ThreadMemoryMode }): Promise<void> {
    await this.executeConversationAction({
      conversationId: input.threadId,
      label: "set thread memory mode",
      action: {
        type: "setThreadMemoryMode",
        threadId: input.threadId,
        mode: input.mode,
      },
      executeAsOwner: () => this.setThreadMemoryModeAsOwner(input),
    });
  }

  private async setThreadMemoryModeAsOwner(input: {
    threadId: string;
    mode: ThreadMemoryMode;
  }): Promise<void> {
    await this.ensureOwnerForConversationAction(input.threadId, "set thread memory mode");
    await this.ownerAppServerRequestClient.setThreadMemoryMode(input.threadId, {
      threadId: input.threadId,
      mode: input.mode,
    });
  }

  async uploadFeedback(params: FeedbackUploadParams): Promise<void> {
    await runConversationOperation("codex:feedback:upload", params);
  }

  async cleanBackgroundTerminals(threadId: string): Promise<boolean> {
    if (this.isFollowerForConversation(threadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    if (this.streamState.getRole(threadId)?.role === "owner") {
      const cleaned = (await runConversationOperation(
        "codex:thread:background-terminals:clean-silent",
        threadId,
      )) as boolean;
      if (cleaned) {
        this.publishOwnerActionConversationMutation(
          threadId,
          applyOwnerBackgroundTerminalCleanupToConversation,
        );
      }
      return cleaned;
    }

    return (await runConversationOperation(
      "codex:thread:background-terminals:clean",
      threadId,
    )) as boolean;
  }

  async listBackgroundTerminals(threadId: string): Promise<ThreadBackgroundTerminal[]> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      return [];
    }

    if (this.isFollowerForConversation(trimmedThreadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    if (this.streamState.getRole(trimmedThreadId)?.role !== "owner") {
      return (await runConversationOperation(
        "codex:thread:background-terminals:list",
        trimmedThreadId,
      )) as ThreadBackgroundTerminal[];
    }

    const rows: ThreadBackgroundTerminal[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.ownerAppServerRequestClient.listBackgroundTerminals(
        trimmedThreadId,
        {
          threadId: trimmedThreadId,
          cursor,
          limit: 100,
        },
      );
      rows.push(...response.data);
      cursor = response.nextCursor;
    } while (cursor);

    return rows;
  }

  async listBackgroundProcesses(threadId: string): Promise<CodexBackgroundProcessRow[]> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) {
      return [];
    }

    if (this.isFollowerForConversation(trimmedThreadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    if (this.streamState.getRole(trimmedThreadId)?.role !== "owner") {
      return (await runConversationOperation("codex:thread:background-processes:list", {
        threadId: trimmedThreadId,
      })) as CodexBackgroundProcessRow[];
    }

    const observedTerminals = await this.listBackgroundTerminals(trimmedThreadId);
    return (await runConversationOperation("codex:thread:background-processes:list", {
      threadId: trimmedThreadId,
      observedTerminals,
    })) as CodexBackgroundProcessRow[];
  }

  async runBackgroundProcess(
    input: CodexBackgroundProcessRunActionInput,
  ): Promise<CodexBackgroundProcessRow[]> {
    const threadId = input.threadId.trim();
    if (!threadId) {
      return [];
    }

    if (this.isFollowerForConversation(threadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    return (await runConversationOperation("codex:thread:background-processes:run-action", {
      ...input,
      threadId,
    })) as CodexBackgroundProcessRow[];
  }

  async stopBackgroundProcess(input: {
    threadId: string;
    processId: string | null;
    terminalSessionId: string | null;
  }): Promise<boolean> {
    const threadId = input.threadId.trim();
    if (!threadId) {
      return false;
    }

    if (this.isFollowerForConversation(threadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    const processId = input.processId?.trim() || null;
    if (processId) {
      return await this.terminateBackgroundTerminal({ threadId, processId });
    }

    const terminalSessionId = input.terminalSessionId?.trim() || null;
    if (!terminalSessionId) {
      return false;
    }

    terminalSessionStore.kill(terminalSessionId);
    return true;
  }

  async terminateBackgroundTerminal(input: {
    threadId: string;
    processId: string;
  }): Promise<boolean> {
    const threadId = input.threadId.trim();
    const processId = input.processId.trim();
    if (!threadId || !processId) {
      return false;
    }

    if (this.isFollowerForConversation(threadId)) {
      throw new Error("Please continue this conversation on the window where it was started.");
    }

    if (this.streamState.getRole(threadId)?.role !== "owner") {
      return (await runConversationOperation("codex:thread:background-terminals:terminate", {
        threadId,
        processId,
      })) as boolean;
    }

    const response = await this.ownerAppServerRequestClient.terminateBackgroundTerminal(threadId, {
      threadId,
      processId,
    });
    return response.terminated;
  }

  async steerTurn(input: CodexSteerTurnInput): Promise<{ turnId: string } | null> {
    const promptText = input.prompt.trim();
    if (!promptText) {
      throw new Error("Turn steer requires a non-empty prompt");
    }
    const normalizedInput = {
      ...input,
      prompt: promptText,
    };

    return await this.executeConversationAction({
      conversationId: input.threadId,
      label: "steer turn",
      action: {
        type: "steerTurn",
        input: normalizedInput,
      },
      executeAsOwner: () => this.steerTurnAsOwner(normalizedInput),
      waitForStreamRevision: true,
    });
  }

  private async steerTurnAsOwner(input: CodexSteerTurnInput): Promise<{ turnId: string } | null> {
    await this.ensureOwnerForConversationAction(input.threadId, "steer turn");

    const conversation = this.conversationsById.get(input.threadId);
    if (!conversation) {
      throw new Error(`Thread '${input.threadId}' was not found`);
    }

    const expectedTurnId = input.expectedTurnId ?? getLatestInProgressTurnId(conversation);
    if (!expectedTurnId) {
      throw new Error(
        "Nodex is already running. Wait for the active turn to load or queue the follow-up instead.",
      );
    }

    const preparedPrompt = await prepareCodexPrompt(input.prompt, input.promptInput, {
      resolveImageInput: resolveOwnerPromptImageInput,
    });
    if (preparedPrompt.agentConfigs.length > 0) {
      throw new Error(
        "Agent config cannot be steered into a running turn. Wait for the turn to finish or queue a follow-up.",
      );
    }

    const clientUserMessageId = createOwnerClientUserMessageId();
    const followUpId = `follow-up:${input.threadId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const pendingSteer = createOwnerPendingSteer(
      input.threadId,
      expectedTurnId,
      input.prompt,
      clientUserMessageId,
    );
    const targetTurn = conversation.turns.find((turn) => turn.turnId === expectedTurnId) ?? null;
    const canonicalSteer: CodexCanonicalSteeringUserMessageItem = {
      type: "steeringUserMessage",
      id: pendingSteer.steerId,
      targetTurnId: expectedTurnId,
      targetTurnStartedAtMs: targetTurn?.turnStartedAtMs ?? targetTurn?.startedAt ?? null,
      status: "pending",
      clientUserMessageId,
      input: [...preparedPrompt.inputItems],
      attachments: [...preparedPrompt.fileAttachments, ...preparedPrompt.addedFiles],
      restoreMessage: {
        queueRow: {
          followUpId,
          clientUserMessageId,
          threadId: input.threadId,
          prompt: input.prompt,
          promptInput: input.promptInput ?? { text: input.prompt },
          createdAtMs: Date.now(),
          collaborationMode: input.collaborationMode ?? null,
          serviceTier: normalizeCodexServiceTier(input.serviceTier),
          summary: input.summary ?? null,
          pause: null,
          payloadRef: null,
        },
        context: { commentAttachments: [...preparedPrompt.commentAttachments] },
      },
      compareKey: buildCodexSteeringCompareKey(
        preparedPrompt.inputItems,
        preparedPrompt.commentAttachments,
      ),
    };
    const publications: Promise<number>[] = [
      this.publishOwnerActionSnapshotMutation(
        input.threadId,
        "pending steer add",
        (currentConversation) => {
          const canonical = currentConversation.canonicalState;
          if (!canonical) return null;
          const canonicalState = upsertCodexCanonicalSteeringItem(
            canonical,
            expectedTurnId,
            canonicalSteer,
          );
          if (canonicalState === canonical) return null;
          return {
            ...currentConversation,
            canonicalState,
            pendingSteers: [...currentConversation.pendingSteers, pendingSteer],
          };
        },
      ),
    ];

    let result: { turnId: string } | null = null;
    let targetTurnId = expectedTurnId;
    let streamRevision = this.streamState.getRevision(input.threadId) ?? 0;
    try {
      result = await runConversationOperation("codex:turn:steer", {
        ...input,
        expectedTurnId,
        intent: {
          steerId: pendingSteer.steerId,
          recoveryRow: canonicalSteer.restoreMessage.queueRow,
        },
      });
      if (result?.turnId && result.turnId !== expectedTurnId) {
        const actualTurnId = result.turnId;
        targetTurnId = actualTurnId;
        publications.push(
          this.publishOwnerActionSnapshotMutation(
            input.threadId,
            "pending steer retarget",
            (currentConversation) => {
              const canonical = currentConversation.canonicalState;
              if (!canonical) return null;
              const canonicalState = retargetCodexCanonicalSteeringItem(
                canonical,
                expectedTurnId,
                actualTurnId,
                pendingSteer.steerId,
              );
              if (canonicalState === canonical) return null;
              return {
                ...currentConversation,
                canonicalState,
                pendingSteers: currentConversation.pendingSteers.map((entry) =>
                  entry.steerId === pendingSteer.steerId
                    ? { ...entry, turnId: actualTurnId }
                    : entry,
                ),
              };
            },
          ),
        );
      }
    } finally {
      const completionPublication = this.publishOwnerActionSnapshotMutation(
        input.threadId,
        "pending steer clear",
        (currentConversation) => {
          const canonicalState =
            typeof result?.turnId === "string"
              ? currentConversation.canonicalState
              : currentConversation.canonicalState
                ? removeCodexCanonicalSteeringItem(
                    removeCodexCanonicalSteeringItem(
                      currentConversation.canonicalState,
                      expectedTurnId,
                      pendingSteer.steerId,
                    ),
                    targetTurnId,
                    pendingSteer.steerId,
                  )
                : currentConversation.canonicalState;
          return {
            ...currentConversation,
            canonicalState,
            pendingSteers: currentConversation.pendingSteers.filter(
              (entry) => entry.steerId !== pendingSteer.steerId,
            ),
          };
        },
      );
      publications.push(completionPublication);
      const revisions = await Promise.all(publications);
      streamRevision = revisions.at(-1) ?? streamRevision;
    }
    return result ? this.withOwnerStreamRevision(result, streamRevision) : result;
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<boolean> {
    if (this.isFollowerForConversation(threadId)) {
      return await this.runFollowerActionThroughOwner(
        threadId,
        {
          type: "interruptTurn",
          threadId,
        },
        {
          fallback: () => this.interruptTurnAsOwner(threadId),
          fallbackOnTimeout: true,
        },
      );
    }

    return await this.interruptTurnAsOwner(threadId, turnId);
  }

  private async interruptTurnAsOwner(threadId: string, turnId?: string): Promise<boolean> {
    const interruptedTurnId = this.resolveInterruptTurnId(threadId, turnId);
    await this.pauseActiveThreadGoalBeforeInterruptAsOwner(threadId);
    if (this.streamState.getRole(threadId)?.role === "owner") {
      await this.declineOwnerRequestsBeforeInterrupt(threadId);
    }
    return this.streamState.getRole(threadId)?.role === "owner"
      ? await this.ownerAppServerRequestClient.interruptTurn(threadId, {
          threadId,
          turnId: interruptedTurnId ?? turnId,
        })
      : ((await runConversationOperation("codex:turn:interrupt", threadId, turnId)) as boolean);
  }

  private async declineOwnerRequestsBeforeInterrupt(threadId: string): Promise<void> {
    const requests = [...(this.conversationsById.get(threadId)?.canonicalRequests ?? [])];
    for (const request of requests) {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          await this.respondApprovalAsOwner(
            request.id,
            {
              kind: getCodexApprovalKindForRequestMethod(request.method),
              decision: "decline",
            },
            threadId,
          );
          break;
        case "item/permissions/requestApproval":
          await this.respondPermissionRequestAsOwner(
            request.id,
            {
              permissions: {},
              scope: "turn",
            },
            threadId,
          );
          break;
        case "item/tool/requestUserInput":
          await this.respondUserInputAsOwner(request.id, {}, threadId);
          break;
        case "item/tool/requestOptionPicker":
          await this.respondOptionPickerAsOwner(threadId, request.id, {
            action: "dismiss",
            selectedOptions: [],
            freeformAnswer: null,
          });
          break;
        case "item/tool/requestSetupCodexContextPicker":
          await this.respondSetupContextPickerAsOwner(threadId, request.id, {
            action: "dismiss",
            selectedSources: [],
          });
          break;
        case "mcpServer/elicitation/request":
          await this.respondMcpElicitationAsOwner(
            request.id,
            {
              action: "decline",
              content: null,
              _meta: null,
            },
            threadId,
          );
          break;
        default:
          break;
      }
    }
  }

  private async pauseActiveThreadGoalBeforeInterruptAsOwner(threadId: string): Promise<void> {
    if (this.streamState.getRole(threadId)?.role !== "owner") return;

    const conversation = this.conversationsById.get(threadId);
    if (conversation?.threadGoal?.status !== "active") return;

    await this.setThreadGoalAsOwner(
      { threadId, status: "paused" },
      { clearResumeConfirmation: true },
    );
  }

  private canContinueActiveThreadGoalAsOwner(threadId: string): boolean {
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) return false;
    if (conversation.resumeState !== "resumed") return false;
    if (conversation.threadGoal?.status !== "active") return false;
    if ((conversation.canonicalRequests ?? []).length > 0) return false;
    if (hasPendingSteeringUserMessage(conversation)) return false;
    if (this.streamState.getRole(threadId)?.role !== "owner") return false;
    if (hasInProgressGoalContinuationWork(conversation)) return false;
    return true;
  }

  private clearActiveGoalContinuationTimer(threadId: string): void {
    const timer = this.activeGoalContinuationTimers.get(threadId);
    if (!timer) return;
    clearTimeout(timer);
    this.activeGoalContinuationTimers.delete(threadId);
  }

  private waitForActiveGoalContinuationDelay(threadId: string): Promise<void> {
    this.clearActiveGoalContinuationTimer(threadId);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.activeGoalContinuationTimers.delete(threadId);
        resolve();
      }, ACTIVE_THREAD_GOAL_CONTINUATION_DELAY_MS);
      this.activeGoalContinuationTimers.set(threadId, timer);
    });
  }

  private async maybeContinueActiveThreadGoalAsOwner(threadId: string): Promise<void> {
    if (this.activeGoalContinuationPromises.has(threadId)) return;
    if (!this.canContinueActiveThreadGoalAsOwner(threadId)) return;

    const continuation = this.waitForActiveGoalContinuationDelay(threadId)
      .then(async () => {
        if (!this.canContinueActiveThreadGoalAsOwner(threadId)) return;
        const subagents = await this.readSubagentOverview({
          rootThreadId: threadId,
          mode: "initial",
        });
        if (subagents.completeness !== "complete" || subagents.active.knownCount > 0) return;
        if (!this.canContinueActiveThreadGoalAsOwner(threadId)) return;
        await this.ownerAppServerRequestClient.setThreadGoal(threadId, {
          threadId,
          status: "active",
        });
      })
      .catch((error) => {
        console.error("[codex-thread-goal] Failed to continue active thread goal", {
          threadId,
          error,
        });
      })
      .finally(() => {
        this.clearActiveGoalContinuationTimer(threadId);
        this.activeGoalContinuationPromises.delete(threadId);
      });

    this.activeGoalContinuationPromises.set(threadId, continuation);
    await continuation;
  }

  async respondApproval(
    requestId: CodexProtocolRequestId,
    response: CodexApprovalResponse,
    conversationId?: string | null,
  ): Promise<boolean> {
    const followerConversationId = this.findOwnerRoutedConversationIdForRequestResponse(
      requestId,
      conversationId,
    );
    if (followerConversationId) {
      return await this.runFollowerRequestResponseThroughOwner(followerConversationId, {
        type: "respondApproval",
        conversationId: followerConversationId,
        requestId,
        response,
      });
    }

    return (await this.respondApprovalAsOwner(requestId, response, conversationId)).accepted;
  }

  private async respondApprovalAsOwner(
    requestId: CodexProtocolRequestId,
    response: CodexApprovalResponse,
    requestedConversationId?: string | null,
  ): Promise<OwnerServerRequestReplyResult> {
    const conversationId = this.findConversationIdForRequest(requestId, requestedConversationId);
    if (!conversationId) return { accepted: false };
    await this.ensureOwnerForConversationAction(conversationId, "respond to approval");
    const responsePromise = runConversationOperation(
      "codex:approval:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerApprovalResponseToConversation(conversation, before, requestId, response.kind),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  async respondUserInput(
    requestId: CodexProtocolRequestId,
    answers: Record<string, string[]>,
    conversationId?: string | null,
  ): Promise<boolean> {
    const followerConversationId = this.findOwnerRoutedConversationIdForRequestResponse(
      requestId,
      conversationId,
    );
    if (followerConversationId) {
      return await this.runFollowerRequestResponseThroughOwner(followerConversationId, {
        type: "respondUserInput",
        conversationId: followerConversationId,
        requestId,
        answers,
      });
    }

    return (await this.respondUserInputAsOwner(requestId, answers, conversationId)).accepted;
  }

  private async respondUserInputAsOwner(
    requestId: CodexProtocolRequestId,
    answers: Record<string, string[]>,
    requestedConversationId?: string | null,
  ): Promise<OwnerServerRequestReplyResult> {
    const conversationId = this.findConversationIdForRequest(requestId, requestedConversationId);
    if (!conversationId) return { accepted: false };
    await this.ensureOwnerForConversationAction(conversationId, "respond to user input");
    const responsePromise = runConversationOperation(
      "codex:user-input:respond",
      conversationId,
      requestId,
      answers,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerUserInputResponseToConversation(conversation, before, requestId, answers),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  async respondMcpElicitation(
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationAction | CodexMcpServerElicitationResponse,
    conversationId?: string | null,
  ): Promise<boolean> {
    const normalizedResponse = normalizeCodexMcpServerElicitationResponse(response);
    const followerConversationId = this.findOwnerRoutedConversationIdForRequestResponse(
      requestId,
      conversationId,
    );
    if (followerConversationId) {
      return await this.runFollowerRequestResponseThroughOwner(followerConversationId, {
        type: "respondMcpElicitation",
        conversationId: followerConversationId,
        requestId,
        response: normalizedResponse,
      });
    }

    return (await this.respondMcpElicitationAsOwner(requestId, normalizedResponse, conversationId))
      .accepted;
  }

  private async respondMcpElicitationAsOwner(
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationResponse,
    requestedConversationId?: string | null,
  ): Promise<OwnerServerRequestReplyResult> {
    const conversationId = this.findConversationIdForRequest(requestId, requestedConversationId);
    if (!conversationId) return { accepted: false };
    await this.ensureOwnerForConversationAction(conversationId, "respond to MCP elicitation");
    const responsePromise = runConversationOperation(
      "codex:mcp-elicitation:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerMcpElicitationResponseToConversation(conversation, before, requestId, response),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  async respondPermissionRequest(
    requestId: CodexProtocolRequestId,
    response: CodexPermissionRequestResponse,
    conversationId?: string | null,
  ): Promise<boolean> {
    const followerConversationId = this.findOwnerRoutedConversationIdForRequestResponse(
      requestId,
      conversationId,
    );
    if (followerConversationId) {
      return await this.runFollowerRequestResponseThroughOwner(followerConversationId, {
        type: "respondPermissionRequest",
        conversationId: followerConversationId,
        requestId,
        response,
      });
    }

    return (await this.respondPermissionRequestAsOwner(requestId, response, conversationId))
      .accepted;
  }

  requestNodexAgentAuthorization(
    request: NodexAgentAuthorizationRequest,
  ): Promise<NodexAgentAuthorizationResponse> {
    const conversation = this.conversationsById.get(request.threadId);
    if (
      !conversation ||
      conversation.projectId !== request.projectId ||
      conversation.threadId !== request.threadId
    ) {
      return Promise.reject(new Error("Nodex authorization requires the visible bound task"));
    }
    if (this.pendingNodexAgentAuthorizations.has(request.requestId)) {
      return Promise.reject(new Error("Nodex authorization occurrence is already pending"));
    }
    return new Promise<NodexAgentAuthorizationResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        void this.respondNodexAgentAuthorization(
          request.requestId,
          { decision: "deny" },
          request.threadId,
        );
      }, NODEX_AGENT_AUTHORIZATION_TIMEOUT_MS);
      this.pendingNodexAgentAuthorizations.set(request.requestId, {
        threadId: request.threadId,
        turnId: request.turnId,
        request,
        timeout,
        resolve,
      });
      try {
        this.applyConversationSnapshot(request.threadId, conversation);
      } catch (error) {
        this.pendingNodexAgentAuthorizations.delete(request.requestId);
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  async respondNodexAgentAuthorization(
    requestId: string,
    response: NodexAgentAuthorizationResponse,
    conversationId?: string | null,
  ): Promise<boolean> {
    const pending = this.pendingNodexAgentAuthorizations.get(requestId);
    if (!pending) return false;
    if (conversationId && conversationId !== pending.threadId) return false;
    if (
      response.decision !== "allow_once" &&
      response.decision !== "allow_task" &&
      response.decision !== "allow_project" &&
      response.decision !== "deny"
    ) {
      return false;
    }
    this.pendingNodexAgentAuthorizations.delete(requestId);
    clearTimeout(pending.timeout);
    const conversation = this.conversationsById.get(pending.threadId);
    if (conversation) this.applyConversationSnapshot(pending.threadId, conversation);
    pending.resolve(response);
    return true;
  }

  cancelPendingNodexAgentAuthorizations(): void {
    const affectedThreadIds = new Set<string>();
    for (const pending of this.pendingNodexAgentAuthorizations.values()) {
      clearTimeout(pending.timeout);
      affectedThreadIds.add(pending.threadId);
      pending.resolve({ decision: "deny" });
    }
    this.pendingNodexAgentAuthorizations.clear();
    for (const threadId of affectedThreadIds) {
      const conversation = this.conversationsById.get(threadId);
      if (conversation) this.applyConversationSnapshot(threadId, conversation);
    }
  }

  private async respondPermissionRequestAsOwner(
    requestId: CodexProtocolRequestId,
    response: CodexPermissionRequestResponse,
    requestedConversationId?: string | null,
  ): Promise<OwnerServerRequestReplyResult> {
    const conversationId = this.findConversationIdForRequest(requestId, requestedConversationId);
    if (!conversationId) return { accepted: false };
    await this.ensureOwnerForConversationAction(conversationId, "respond to permission request");
    const responsePromise = runConversationOperation(
      "codex:permission-request:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerPermissionRequestResponseToConversation(
          conversation,
          before,
          requestId,
          response,
        ),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  async respondSetupCodexStep(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupCodexStepResponse,
  ): Promise<boolean> {
    if (this.isFollowerForConversation(conversationId)) {
      return await this.runFollowerRequestResponseThroughOwner(conversationId, {
        type: "respondSetupCodexStep",
        conversationId,
        requestId,
        response,
      });
    }
    return (await this.respondSetupCodexStepAsOwner(conversationId, requestId, response)).accepted;
  }

  private async respondSetupCodexStepAsOwner(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupCodexStepResponse,
  ): Promise<OwnerServerRequestReplyResult> {
    await this.ensureOwnerForConversationAction(conversationId, "respond to setup step");
    const request = this.conversationsById
      .get(conversationId)
      ?.canonicalRequests?.find((candidate) => candidate.id === requestId);
    if (request?.method !== "item/tool/call" || request.params.tool !== "setup_codex_step") {
      return { accepted: false };
    }

    const responsePromise = runConversationOperation(
      "codex:setup-codex-step:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerSetupCodexStepResponseToConversation(conversation, before, requestId, response),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  async respondOptionPicker(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
  ): Promise<boolean> {
    if (this.isFollowerForConversation(conversationId)) {
      return await this.runFollowerRequestResponseThroughOwner(conversationId, {
        type: "respondOptionPicker",
        conversationId,
        requestId,
        response,
      });
    }
    return (await this.respondOptionPickerAsOwner(conversationId, requestId, response)).accepted;
  }

  private async respondOptionPickerAsOwner(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
  ): Promise<OwnerServerRequestReplyResult> {
    await this.ensureOwnerForConversationAction(conversationId, "respond to option picker");
    const conversation = this.conversationsById.get(conversationId);
    if (
      !conversation ||
      !hasOwnerStoredInteractiveResponseTarget(conversation, requestId, "optionPicker")
    )
      return { accepted: false };

    const responsePromise = runConversationOperation(
      "codex:option-picker:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerStoredInteractiveResponseToConversation(
          conversation,
          before,
          requestId,
          "optionPicker",
        ),
    );
    return await this.finishOwnerServerRequestReply(
      conversationId,
      responsePromise,
      streamRevision,
    );
  }

  private async respondSetupContextPickerAsOwner(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupContextPickerResponse,
  ): Promise<boolean> {
    await this.ensureOwnerForConversationAction(conversationId, "respond to setup context picker");
    const conversation = this.conversationsById.get(conversationId);
    if (
      !conversation ||
      !hasOwnerStoredInteractiveResponseTarget(conversation, requestId, "setupContextPicker")
    )
      return false;

    const responsePromise = runConversationOperation(
      "codex:setup-context-picker:respond",
      conversationId,
      requestId,
      response,
    ) as Promise<boolean>;
    const streamRevision = this.publishOwnerServerRequestReply(
      conversationId,
      (conversation, before) =>
        applyOwnerStoredInteractiveResponseToConversation(
          conversation,
          before,
          requestId,
          "setupContextPicker",
        ),
    );
    return (
      await this.finishOwnerServerRequestReply(conversationId, responsePromise, streamRevision)
    ).accepted;
  }

  private publishOwnerServerRequestReply(
    conversationId: string,
    reduce: (
      conversation: CodexConversationSnapshot,
      before: CodexCanonicalConversationState,
    ) => OwnerCanonicalServerRequestMutationResult,
  ): number | null {
    return this.publishOwnerActionConversationMutation(conversationId, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== conversationId) {
        this.handleOwnerReducerUnavailable(conversationId);
        return null;
      }
      const result = reduce(conversation, before);
      this.applyOwnerCanonicalHiddenTurns(conversationId, result.hiddenTurns);
      return result.conversation;
    });
  }

  private async finishOwnerServerRequestReply(
    conversationId: string,
    responsePromise: Promise<boolean>,
    streamRevision: number | null,
  ): Promise<OwnerServerRequestReplyResult> {
    try {
      const accepted = await responsePromise;
      return {
        accepted,
        ...(accepted && streamRevision !== null ? { streamRevision } : {}),
      };
    } catch (error) {
      this.handleOwnerReducerUnavailable(conversationId);
      throw error;
    }
  }

  async setPermissionMode(projectId: string | null, mode: CodexPermissionMode): Promise<void> {
    const current = this.permissionStateByScope.get(projectId);
    if (current?.mode === mode) {
      return;
    }

    const nextState = (await runConversationOperation(
      "codex:permission:mode:set",
      projectId,
      mode,
    )) as CodexPermissionState;
    this.applyPermissionState(projectId, nextState);
  }

  private applyConversationUnreadState(conversationId: string, hasUnreadTurn: boolean): boolean {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return false;
    const conversation = this.conversationsById.get(normalizedConversationId);
    const summary = this.threadSummariesById.get(normalizedConversationId);
    if (!conversation && !summary) return false;
    const conversationChanged = Boolean(
      conversation && conversation.hasUnreadTurn !== hasUnreadTurn,
    );
    const summaryChanged = Boolean(summary && summary.hasUnreadTurn !== hasUnreadTurn);
    if (!conversationChanged && !summaryChanged) return false;

    if (conversation && conversationChanged) {
      const nextConversation = {
        ...conversation,
        hasUnreadTurn,
        ...(!hasUnreadTurn ? { unreadMessageCount: 0 } : {}),
      };
      this.applyConversationSnapshot(normalizedConversationId, nextConversation);
      const cursor = this.ownerStreamPublishCursorsByConversationId.get(normalizedConversationId);
      if (cursor) {
        if (cursor.inFlight) {
          cursor.standaloneUnreadStateOverride = hasUnreadTurn;
        } else {
          cursor.acceptedDocument = applyStandaloneUnreadStateToSnapshot(
            cursor.acceptedDocument,
            hasUnreadTurn,
          );
        }
      }
      return true;
    }
    if (summary && summaryChanged) {
      this.applyThreadSummary({ ...summary, hasUnreadTurn });
    }
    return true;
  }

  async setConversationUnreadState(conversationId: string, hasUnreadTurn: boolean): Promise<void> {
    if (!this.applyConversationUnreadState(conversationId, hasUnreadTurn)) return;
    await runConversationOperation("codex:conversation-unread:set", conversationId, hasUnreadTurn);
  }

  async markConversationAsRead(conversationId: string): Promise<void> {
    await this.setConversationUnreadState(conversationId, false);
  }

  async markConversationAsUnread(conversationId: string): Promise<void> {
    await this.setConversationUnreadState(conversationId, true);
  }

  setComposerIntent(threadId: string, composerIntent: CodexComposerIntent): void {
    const currentIntent = this.composerIntentsByThread.get(threadId);
    if (
      currentIntent &&
      currentIntent.prompt === composerIntent.prompt &&
      currentIntent.focusNonce === composerIntent.focusNonce
    ) {
      return;
    }

    this.composerIntentsByThread.set(threadId, composerIntent);
    this.notifyConversationCallbacks(threadId);
  }

  consumeComposerIntent(threadId: string, focusNonce: number): void {
    const currentIntent = this.composerIntentsByThread.get(threadId);
    if (!currentIntent || currentIntent.focusNonce !== focusNonce) {
      return;
    }

    this.composerIntentsByThread.delete(threadId);
    this.notifyConversationCallbacks(threadId);
  }

  async removePlanImplementationRequest(threadId: string, turnId: string): Promise<boolean> {
    const result = await this.executeConversationAction({
      conversationId: threadId,
      label: "remove plan implementation request",
      action: {
        type: "removePlanImplementationRequest",
        threadId,
        turnId,
      },
      executeAsOwner: () => this.removePlanImplementationRequestAsOwner(threadId, turnId),
      waitForStreamRevision: true,
    });
    return this.readOwnerBooleanActionResult(result);
  }

  private async removePlanImplementationRequestAsOwner(
    threadId: string,
    turnId: string,
  ): Promise<OwnerBooleanActionResult> {
    await this.ensureOwnerForConversationAction(threadId, "remove plan implementation request");

    const streamRevision = await this.publishOwnerActionSnapshotMutation(
      threadId,
      "plan implementation remove",
      (conversation) => {
        const canonicalState = conversation.canonicalState
          ? completeCodexCanonicalPlanImplementationState(conversation.canonicalState, turnId)
          : null;
        if (!canonicalState) return null;
        const nextTurns = conversation.turns.map((turn) => {
          if (turn.turnId !== turnId) {
            return turn;
          }

          return {
            ...turn,
            items: turn.items.map((item) =>
              item.type !== "planImplementation"
                ? item
                : {
                    ...item,
                    status: "completed" as const,
                    rawItem:
                      typeof item.rawItem === "object" && item.rawItem !== null
                        ? {
                            ...item.rawItem,
                            isCompleted: true,
                          }
                        : item.rawItem,
                  },
            ),
          };
        });
        return {
          ...conversation,
          canonicalState,
          turns: nextTurns,
          requests: conversation.requests.filter(
            (request) => request.type !== "implementPlan" || request.turnId !== turnId,
          ),
          canonicalRequests: [...canonicalState.requests],
        };
      },
    );

    return {
      accepted: (await runConversationOperation(
        "codex:thread:plan-implementation:remove",
        threadId,
        turnId,
      )) as boolean,
      streamRevision,
    };
  }

  resetForTests(): void {
    this.cancelPendingNodexAgentAuthorizations();
    this.connection = INITIAL_CONNECTION;
    this.account = null;
    this.dictationState = DEFAULT_CODEX_DICTATION_STATE;
    this.availableModels = EMPTY_MODELS;
    this.threadSummariesByProject.clear();
    this.threadSummariesById.clear();
    this.loadedThreadSummariesByProject.clear();
    this.threadSummaryLoadsInFlightByProject.clear();
    this.resumeInFlightByThreadId.clear();
    this.attachmentStateByThreadId.clear();
    this.interruptedTurnResumesInFlightByThreadId.clear();
    this.conversationsById.clear();
    this.followerAcceptedReplicasByConversationId.clear();
    this.ownerHiddenLifecycleItemTypesByConversationId.clear();
    this.conversationVersionById.clear();
    this.streamState.reset();
    this.followerMembershipByConversationId.clear();
    this.composerIntentsByThread.clear();
    this.permissionStateByScope.clear();
    this.permissionStateLoadsInFlightByScope.clear();
    this.threadStartProgressByTarget.clear();
    this.threadTitlesById.clear();
    this.projectSummaryCallbacksByProject.clear();
    this.recentConversationIds.length = 0;
    this.lastHostError = null;
    this.lastAnySnapshotById.clear();
    this.lastMetaSnapshotById.clear();
    this.lastAnyOrderKey = null;
    this.lastMetaOrderKey = null;
    this.ownerTextDeltaQueue.dispose();
    this.ownerTextDeltaSequenceTracker.clear();
    this.ownerNotificationCompletionByConversationId.clear();
    this.unclaimedOwnerNotificationSequencesByConversationId.clear();
    this.outputDeltaQueue.dispose();
    this.cancelOwnerStreamPublishQueues();
    this.terminalInputBuffers.clear();
    this.bootstrapStarted = false;
    this.resyncInFlight.clear();
    this.stop();
  }

  private async bootstrapAccountAndConnection(): Promise<void> {
    try {
      const account = (await runConversationOperation(
        "codex:account:read",
      )) as CodexAccountSnapshot;
      this.handleSharedObjectUpdated({
        hostId: this.hostId,
        object: {
          objectType: "account",
          objectId: "account",
          value: account,
        },
      });
    } catch {
      // host messages stay authoritative if bootstrap fails
    }

    try {
      const connection = (await runConversationOperation(
        "codex:connection:status",
      )) as CodexConnectionState;
      this.handleSharedObjectUpdated({
        hostId: this.hostId,
        object: {
          objectType: "connection",
          objectId: "connection",
          value: connection,
        },
      });
    } catch {
      // host messages stay authoritative if bootstrap fails
    }
  }

  private async bootstrapDictationState(): Promise<void> {
    try {
      await this.loadDictationState();
    } catch {
      this.setDictationState(DEFAULT_CODEX_DICTATION_STATE);
    }
  }

  private async bootstrapAvailableModels(): Promise<void> {
    try {
      await this.loadAvailableModels();
    } catch {
      this.setAvailableModels([]);
    }
  }

  private async bootstrapPermissionModes(): Promise<void> {
    // Permission state is loaded lazily per permission scope from the main process.
  }

  async loadPermissionState(projectId: string | null): Promise<CodexPermissionState> {
    const inFlight = this.permissionStateLoadsInFlightByScope.get(projectId);
    if (inFlight) {
      return await inFlight;
    }

    const loadPromise = (async () => {
      const nextState = (await runConversationOperation(
        "codex:permission:state:get",
        projectId,
      )) as CodexPermissionState;
      this.applyPermissionState(projectId, nextState);
      return nextState;
    })();
    this.permissionStateLoadsInFlightByScope.set(projectId, loadPromise);

    try {
      return await loadPromise;
    } finally {
      this.permissionStateLoadsInFlightByScope.delete(projectId);
    }
  }

  private applyPermissionState(projectId: string | null, nextState: CodexPermissionState): void {
    const current = this.permissionStateByScope.get(projectId);
    if (current && arePermissionStatesEqual(current, nextState)) {
      return;
    }

    this.permissionStateByScope.set(projectId, nextState);
    this.notifyControlCallbacks();
  }

  private setAvailableModels(models: CodexModelOption[]): void {
    if (areModelsEqual(this.availableModels, models)) {
      return;
    }

    this.availableModels = models;
    this.notifyControlCallbacks();
  }

  private setDictationState(nextState: CodexDictationStateSnapshot): void {
    if (
      this.dictationState.isEnabled === nextState.isEnabled &&
      this.dictationState.authMethod === nextState.authMethod &&
      this.dictationState.shortcutLabel === nextState.shortcutLabel &&
      areDictationCapabilitiesEqual(this.dictationState.capabilities, nextState.capabilities)
    ) {
      return;
    }

    this.dictationState = nextState;
    this.notifyControlCallbacks();
  }

  private handleSharedObjectUpdated(event: CodexSharedObjectUpdatedEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    const sharedObject = event.object;
    if (sharedObject.objectType === "connection") {
      if (this.connection !== sharedObject.value) {
        this.connection = sharedObject.value;
        this.notifyListeners(this.connectionCallbacks);
      }
      return;
    }

    if (sharedObject.objectType === "account") {
      if (this.account === sharedObject.value) {
        return;
      }

      this.account = sharedObject.value;
      this.notifyListeners(this.accountCallbacks);
      void this.loadDictationState().catch(() => {});
      return;
    }

    if (sharedObject.objectType === "rateLimits") {
      if (!this.account) {
        return;
      }

      this.account = {
        ...this.account,
        rateLimits: sharedObject.value,
      };
      this.notifyListeners(this.accountCallbacks);
      return;
    }

    if (sharedObject.objectType === "threadSummary") {
      this.applyThreadSummary(sharedObject.value);
      return;
    }

    if (sharedObject.objectType === "conversationChildMemberships") {
      this.applyConversationChildMembershipsUpdate(sharedObject.value);
      return;
    }

    if (sharedObject.objectType === "threadStartProgress") {
      this.applyThreadStartProgress(sharedObject.value);
    }
  }

  private handleClientStatusChanged(event: CodexClientStatusChangedEvent): void {
    if (event.hostId !== this.hostId || event.status !== "connected") {
      return;
    }

    void this.loadDictationState().catch(() => {});
    for (const threadId of this.streamState.getStreamingConversationIds()) {
      const role = this.streamState.getRole(threadId);
      if (role?.role === "owner" || role?.role === "follower") {
        continue;
      }
      void this.requestThreadStreamSnapshot(threadId).catch(() => {});
    }
  }

  private handleThreadTitleUpdated(event: CodexThreadTitleUpdatedEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    this.applyThreadTitleUpdate(event.conversationId, event.title);
  }

  private handleThreadDeleted(event: CodexThreadDeletedEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    this.removeThreadLocalState(event.threadId);
  }

  private handleHostError(event: CodexErrorEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    this.lastHostError = {
      message: event.message,
      detail: event.detail,
      updatedAt: Date.now(),
    };
    console.error("[codex-host-error]", event.message, event.detail ?? "");
    this.notifyControlCallbacks();
  }

  private deferOwnerRecoveryMessage(
    conversationId: string,
    message: unknown,
    apply: () => void,
  ): boolean {
    const queue = this.deferredOwnerMessagesByRequestRecovery.get(conversationId);
    if (!queue) return false;

    let approximateBytes: number;
    try {
      const encoded = JSON.stringify(message);
      approximateBytes = new TextEncoder().encode(encoded ?? "null").byteLength;
    } catch {
      approximateBytes = CODEX_OWNER_RECOVERY_MAX_DEFERRED_BYTES + 1;
    }
    const totalMessages = [...this.deferredOwnerMessagesByRequestRecovery.values()].reduce(
      (total, candidate) => total + candidate.messages.length,
      0,
    );
    const totalBytes = [...this.deferredOwnerMessagesByRequestRecovery.values()].reduce(
      (total, candidate) => total + candidate.approximateBytes,
      0,
    );
    if (
      queue.messages.length + 1 > CODEX_OWNER_RECOVERY_MAX_DEFERRED_MESSAGES_PER_CONVERSATION ||
      totalMessages + 1 > CODEX_OWNER_RECOVERY_MAX_DEFERRED_MESSAGES ||
      queue.approximateBytes + approximateBytes >
        CODEX_OWNER_RECOVERY_MAX_DEFERRED_BYTES_PER_CONVERSATION ||
      totalBytes + approximateBytes > CODEX_OWNER_RECOVERY_MAX_DEFERRED_BYTES
    ) {
      return false;
    }

    queue.messages.push({ apply, approximateBytes });
    queue.approximateBytes += approximateBytes;
    return true;
  }

  private discardDeferredOwnerRecoveryMessages(conversationId: string): void {
    const queue = this.deferredOwnerMessagesByRequestRecovery.get(conversationId);
    if (!queue) return;
    queue.messages.length = 0;
    queue.approximateBytes = 0;
    this.deferredOwnerMessagesByRequestRecovery.delete(conversationId);
  }

  private handleThreadOwnerNotification(event: CodexThreadOwnerNotificationEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }
    if (typeof event.sequence !== "number") return;

    const eventConversationId = getOwnerNotificationConversationId(event.notification);
    const deferredMessages = eventConversationId
      ? this.deferredOwnerMessagesByRequestRecovery.get(eventConversationId)
      : null;
    if (deferredMessages) {
      if (
        !this.deferOwnerRecoveryMessage(eventConversationId!, event, () =>
          this.handleThreadOwnerNotification(event),
        )
      ) {
        this.markOwnerStreamPublishUnavailable(eventConversationId!);
      }
      return;
    }
    if (
      eventConversationId &&
      !this.beginOwnerNotificationHandling(eventConversationId, event.sequence)
    ) {
      this.markOwnerStreamPublishUnavailable(eventConversationId);
      return;
    }

    try {
      if (
        event.notification.method === "thread/started" ||
        event.notification.method === "thread/name/updated" ||
        event.notification.method === "thread/settings/updated" ||
        event.notification.method === "thread/status/changed" ||
        event.notification.method === "thread/tokenUsage/updated" ||
        event.notification.method === "thread/goal/updated" ||
        event.notification.method === "thread/goal/cleared"
      ) {
        this.handleOwnerThreadNotification(event);
        return;
      }

      if (
        event.notification.method === "turn/diff/updated" ||
        event.notification.method === "turn/plan/updated" ||
        event.notification.method === "model/safetyBuffering/updated" ||
        event.notification.method === "hook/started" ||
        event.notification.method === "hook/completed" ||
        event.notification.method === "item/autoApprovalReview/started" ||
        event.notification.method === "item/autoApprovalReview/completed" ||
        event.notification.method === "guardianWarning" ||
        event.notification.method === "model/rerouted"
      ) {
        this.handleOwnerTurnMutationNotification(event);
        return;
      }

      if (
        event.notification.method === "turn/started" ||
        event.notification.method === "turn/completed"
      ) {
        this.handleOwnerTurnLifecycleNotification(event);
        return;
      }

      if (
        event.notification.method === "item/started" ||
        event.notification.method === "item/completed"
      ) {
        this.handleOwnerItemLifecycleNotification(event);
        return;
      }

      if (event.notification.method === "item/fileChange/patchUpdated") {
        this.handleOwnerFileChangePatchUpdatedNotification(event);
        return;
      }

      if (event.notification.method === "item/mcpToolCall/progress") {
        this.handleOwnerMcpToolCallProgressNotification(event);
        return;
      }

      if (event.notification.method === "item/reasoning/summaryPartAdded") {
        this.handleOwnerReasoningSummaryPartAddedNotification(event);
        return;
      }

      if (event.notification.method === "item/fileChange/outputDelta") {
        this.handleOwnerNoopItemNotification(event);
        return;
      }

      if (event.notification.method === "serverRequest/resolved") {
        this.handleOwnerServerRequestResolvedNotification(event);
        return;
      }

      if (event.notification.method === "error") {
        this.handleOwnerErrorNotification(event);
        return;
      }

      if (event.notification.method === "item/commandExecution/terminalInteraction") {
        this.handleOwnerTerminalInteractionNotification(event);
        return;
      }

      const payload =
        typeof event.notification.params === "object" && event.notification.params !== null
          ? (event.notification.params as Record<string, unknown>)
          : null;
      if (!payload) return;
      if (
        typeof payload.threadId !== "string" ||
        typeof payload.itemId !== "string" ||
        typeof payload.delta !== "string"
      ) {
        return;
      }
      const turnId = getString(payload, "turnId");
      if (
        this.ackOwnerNotificationIfTombstoned(
          payload.threadId,
          [turnId, payload.itemId],
          event.sequence,
        )
      ) {
        return;
      }

      if (event.notification.method === "item/commandExecution/outputDelta") {
        this.claimOwnerNotificationSequence(payload.threadId, event.sequence);
        this.outputDeltaQueue.enqueue({
          conversationId: payload.threadId,
          turnId,
          itemId: payload.itemId,
          delta: payload.delta,
          ownerNotificationSequence: event.sequence,
        });
        return;
      }

      if (!isCodexFrameTextDeltaNotification(event.notification)) return;
      const frameTextDelta = toCodexFrameTextDelta(event.notification);
      if (frameTextDelta.target.type === "agentMessage" || frameTextDelta.target.type === "plan") {
        logAssistantStreamingDebugSampled(
          "renderer-owner-delta-received",
          `${payload.threadId}:${turnId ?? "latest"}:${payload.itemId}:${event.notification.method}`,
          {
            method: event.notification.method,
            sequence: event.sequence,
            threadId: payload.threadId,
            turnId,
            itemId: payload.itemId,
            deltaLength: payload.delta.length,
          },
        );
      }

      const queued = this.ownerTextDeltaQueue.enqueue({
        ...frameTextDelta,
        ownerNotificationSequence: event.sequence,
      });
      // The sequence becomes ACK-eligible only after both bounded buffers own the same delta.
      if (!queued.accepted) {
        this.markOwnerStreamPublishUnavailable(frameTextDelta.conversationId);
        return;
      }
      const tracked = this.ownerTextDeltaSequenceTracker.track(frameTextDelta, event.sequence);
      if (!tracked.accepted) {
        this.markOwnerStreamPublishUnavailable(frameTextDelta.conversationId);
        return;
      }
      this.claimOwnerNotificationSequence(frameTextDelta.conversationId, event.sequence);
    } catch (error) {
      if (eventConversationId) {
        this.claimOwnerNotificationSequence(eventConversationId, event.sequence);
      }
      throw error;
    } finally {
      if (eventConversationId) {
        this.finishOwnerNotificationHandling(eventConversationId, event.sequence);
      }
    }
  }

  private handleThreadOwnerRequest(event: CodexThreadOwnerRequestEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }
    if (typeof event.sequence !== "number") return;

    const conversationId = event.request.params.threadId;
    const deferredMessages = this.deferredOwnerMessagesByRequestRecovery.get(conversationId);
    if (deferredMessages) {
      if (
        !this.deferOwnerRecoveryMessage(conversationId, event, () =>
          this.handleThreadOwnerRequest(event),
        )
      ) {
        this.markOwnerStreamPublishUnavailable(conversationId);
      }
      return;
    }
    if (!this.registerOwnerNotificationSequence(conversationId, event.sequence)) {
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }
    if (!conversationId) {
      void this.ackOwnerNotification("", event.sequence);
      return;
    }

    const currentCanonical = this.conversationsById.get(conversationId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== conversationId) {
      void this.recoverThreadOwnerRequest(event, conversationId);
      return;
    }

    this.applyThreadOwnerRequest(event, conversationId);
  }

  private async recoverThreadOwnerRequest(
    event: CodexThreadOwnerRequestEvent,
    conversationId: string,
  ): Promise<void> {
    if (
      !this.deferredOwnerMessagesByRequestRecovery.has(conversationId) &&
      this.deferredOwnerMessagesByRequestRecovery.size >= CODEX_OWNER_RECOVERY_MAX_CONVERSATIONS
    ) {
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }
    const deferredMessages: DeferredOwnerRecoveryQueue = {
      messages: [],
      approximateBytes: 0,
    };
    this.deferredOwnerMessagesByRequestRecovery.set(conversationId, deferredMessages);
    let recovered = false;
    try {
      const conversation = await runWithOwnerStreamDeadline(
        this.requestThreadStreamResume(conversationId),
        `Owner request recovery for ${conversationId}`,
      );
      if (this.deferredOwnerMessagesByRequestRecovery.get(conversationId) !== deferredMessages) {
        return;
      }
      const canonicalState = conversation?.canonicalState;
      if (!canonicalState || canonicalState.protocol.id !== conversationId) {
        return;
      }

      recovered = true;
      this.applyThreadOwnerRequest(event, conversationId);
    } catch {
      // Recovery failure is handled by the fail-closed path below.
    } finally {
      if (this.deferredOwnerMessagesByRequestRecovery.get(conversationId) === deferredMessages) {
        this.deferredOwnerMessagesByRequestRecovery.delete(conversationId);
        if (!recovered) {
          this.handleOwnerReducerUnavailable(conversationId);
          await this.ackOwnerNotification(conversationId, event.sequence);
        }
        for (const deferredMessage of deferredMessages.messages) {
          deferredMessage.apply();
        }
      }
    }
  }

  private applyThreadOwnerRequest(
    event: CodexThreadOwnerRequestEvent,
    conversationId: string,
  ): void {
    if (event.request.method === "item/tool/call") {
      void this.handleOwnerDynamicToolCallRequest(event, conversationId);
      return;
    }

    this.publishOwnerConversationMutation(conversationId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== conversationId) return null;
      const application = applyOwnerServerRequestToConversation(
        conversation,
        before,
        event.request,
        this.isOpenAIFormElicitationsEnabled(),
      );
      this.applyOwnerCanonicalHiddenTurns(conversationId, application.hiddenTurns);
      return application.conversation;
    });
  }

  private async handleOwnerDynamicToolCallRequest(
    event: CodexThreadOwnerRequestEvent,
    conversationId: string,
  ): Promise<void> {
    const role = this.streamState.getRole(conversationId);
    if (role?.role !== "owner") {
      this.handleOwnerReducerUnavailable(conversationId);
      await this.ackOwnerNotification(conversationId, event.sequence);
      return;
    }

    const conversation = this.conversationsById.get(conversationId);
    if (!conversation) {
      this.handleOwnerReducerUnavailable(conversationId);
      await this.ackOwnerNotification(conversationId, event.sequence);
      return;
    }

    const before = conversation.canonicalState;
    if (!before || before.protocol.id !== conversationId) {
      this.handleOwnerReducerUnavailable(conversationId);
      await this.ackOwnerNotification(conversationId, event.sequence);
      return;
    }
    const application = applyOwnerServerRequestToConversation(
      conversation,
      before,
      event.request,
      this.isOpenAIFormElicitationsEnabled(),
    );
    if (application.lifecycle.disposition === "stored") {
      this.applyOwnerCanonicalHiddenTurns(conversationId, application.hiddenTurns);
      this.publishOwnerConversationMutation(
        conversationId,
        event.sequence,
        () => application.conversation,
      );
      return;
    }

    try {
      const serviceTier = readCodexServiceTier();
      await runConversationOperation(
        "codex:dynamic-tool-call:respond",
        conversationId,
        event.request.id,
        {
          permissionMode: conversation.projectId
            ? (this.permissionStateByScope.get(conversation.projectId)?.mode ??
              DEFAULT_PERMISSION_STATE.mode)
            : (this.permissionStateByScope.get(null)?.mode ?? DEFAULT_PERMISSION_STATE.mode),
          serviceTierSelector:
            serviceTier === "fast" ? { type: "custom", serviceTier } : { type: "standard" },
        },
      );
    } finally {
      await this.ackOwnerNotification(conversationId, event.sequence);
    }
  }

  private handleOwnerThreadNotification(event: CodexThreadOwnerNotificationEvent): void {
    if (event.notification.method === "thread/started") {
      const payload = toOwnerThreadStartedPayload(event.notification);
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationSnapshotMutation(
        payload.threadId,
        event.sequence,
        (conversation) => {
          const before = conversation.canonicalState;
          if (!before || before.protocol.id !== payload.threadId) return null;
          const state = reduceCodexConversationThreadStarted(
            before,
            buildOwnerCanonicalStartedThread(before, payload),
          );
          return applyOwnerThreadStartedToConversation(conversation, state);
        },
      );
      return;
    }

    if (event.notification.method === "thread/goal/updated") {
      const payload = event.notification.params;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      let effects: readonly CodexThreadMetadataEffect[] = [];
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationThreadGoalUpdated(
          before,
          payload.threadId,
          payload.goal,
        );
        effects = result.effects;
        return projectOwnerThreadGoalToConversation(conversation, result.state);
      });
      this.consumeOwnerThreadMetadataEffects(effects);
      return;
    }

    if (event.notification.method === "thread/goal/cleared") {
      const payload = event.notification.params;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const state = reduceCodexConversationThreadGoalCleared(before, payload.threadId);
        return projectOwnerThreadGoalToConversation(conversation, state);
      });
      return;
    }

    if (event.notification.method === "thread/name/updated") {
      const payload = event.notification.params;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const state = reduceCodexConversationThreadName(
          before,
          payload.threadId,
          payload.threadName,
        );
        return projectOwnerThreadNameToConversation(conversation, state);
      });
      return;
    }

    if (event.notification.method === "thread/settings/updated") {
      const payload = event.notification.params;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const state = reduceCodexConversationThreadSettings(
          before,
          payload.threadId,
          payload.threadSettings,
        );
        return projectOwnerThreadSettingsToConversation(conversation, state);
      });
      return;
    }

    if (event.notification.method === "thread/tokenUsage/updated") {
      const payload = event.notification.params;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const state = reduceCodexConversationThreadTokenUsage(before, {
          conversationId: payload.threadId,
          tokenUsage: payload.tokenUsage,
        });
        if (state === before) return conversation;
        return {
          ...conversation,
          canonicalState: state,
          latestTokenUsageInfo: state.sidecar.latestTokenUsageInfo ?? null,
        };
      });
      return;
    }

    if (event.notification.method !== "thread/status/changed") return;
    const payload = toOwnerThreadStatusPayload(
      event.notification.params.threadId,
      event.notification.params.status,
    );
    if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
    let effects: readonly CodexThreadMetadataEffect[] = [];
    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = reduceCodexConversationThreadStatus(
        before,
        payload.threadId,
        payload.threadRuntimeStatus,
      );
      effects = result.effects;
      return projectOwnerThreadStatusToConversation(conversation, result.state);
    });
    this.consumeOwnerThreadMetadataEffects(effects);
  }

  private requireOwnerCanonicalMetadata(threadId: string, sequence: number): boolean {
    const state = this.conversationsById.get(threadId)?.canonicalState;
    if (state?.protocol.id === threadId) return true;
    this.handleOwnerReducerUnavailable(threadId);
    void this.ackOwnerNotification(threadId, sequence);
    return false;
  }

  private consumeOwnerThreadMetadataEffects(effects: readonly CodexThreadMetadataEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "clearCompletedGoal") {
        void this.clearThreadGoal(effect.threadId).catch(() => {});
        continue;
      }
      void this.maybeContinueActiveThreadGoalAsOwner(effect.threadId);
    }
  }

  private handleOwnerTurnMutationNotification(event: CodexThreadOwnerNotificationEvent): void {
    if (event.notification.method === "guardianWarning") {
      const payload = event.notification.params;
      if (!shouldShowAutoReviewInterruptionWarning(payload)) {
        void this.ackOwnerNotification(payload.threadId, event.sequence);
        return;
      }
      const observedAtMs = Date.now();
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationGuardianWarning(
          before,
          payload.threadId,
          createOwnerGeneratedItemId("auto-review-interruption-warning"),
        );
        return projectOwnerCanonicalTurnMetadataResult(conversation, before, result, observedAtMs);
      });
      return;
    }

    if (
      event.notification.method === "item/autoApprovalReview/started" ||
      event.notification.method === "item/autoApprovalReview/completed"
    ) {
      const notification = event.notification;
      const payload = notification.params;
      const observedAtMs = Date.now();
      if (
        this.ackOwnerNotificationIfTombstoned(
          payload.threadId,
          [payload.turnId, payload.targetItemId],
          event.sequence,
        )
      )
        return;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationAutomaticApprovalReview(
          before,
          notification,
          observedAtMs,
        );
        return projectOwnerCanonicalTurnMetadataResult(conversation, before, result, observedAtMs);
      });
      return;
    }

    if (
      event.notification.method === "hook/started" ||
      event.notification.method === "hook/completed"
    ) {
      const method = event.notification.method;
      const payload = event.notification.params;
      const observedAtMs = Date.now();
      if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
        return;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      let effects: readonly CodexTurnMetadataEffect[] = [];
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationHookRun(
          before,
          payload.threadId,
          payload.turnId,
          method,
          payload.run,
          observedAtMs,
        );
        effects = result.effects;
        if (result.state === before) return conversation;
        const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
          observedAtMs,
          preserveExistingUpdatedAt: true,
        });
        return { ...projection.conversation, canonicalState: result.state };
      });
      this.consumeOwnerTurnMetadataEffects(effects);
      return;
    }

    if (event.notification.method === "model/safetyBuffering/updated") {
      const payload = event.notification.params;
      const observedAtMs = Date.now();
      const safetyBuffering: CodexSafetyBufferingState = {
        useCases: payload.useCases,
        reasons: payload.reasons,
        showBufferingUi: payload.showBufferingUi,
        fasterModel: payload.fasterModel,
      };
      if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
        return;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationSafetyBuffering(
          before,
          payload.threadId,
          payload.turnId,
          safetyBuffering,
          observedAtMs,
        );
        if (result.state === before) return conversation;
        const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
          observedAtMs,
          preserveExistingUpdatedAt: true,
        });
        return { ...projection.conversation, canonicalState: result.state };
      });
      return;
    }

    if (event.notification.method === "turn/plan/updated") {
      const notification = event.notification;
      const payload = notification.params;
      const observedAtMs = Date.now();
      if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
        return;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationTurnPlan(
          before,
          notification,
          createOwnerGeneratedItemId("todo-list"),
          observedAtMs,
        );
        return projectOwnerCanonicalTurnMetadataResult(conversation, before, result, observedAtMs);
      });
      return;
    }

    if (event.notification.method === "model/rerouted") {
      const notification = event.notification;
      const payload = notification.params;
      const observedAtMs = Date.now();
      if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
        return;
      if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;
      this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const result = reduceCodexConversationModelRerouted(
          before,
          notification,
          createOwnerGeneratedItemId("model-rerouted"),
          observedAtMs,
        );
        return projectOwnerCanonicalTurnMetadataResult(conversation, before, result, observedAtMs);
      });
      return;
    }

    if (event.notification.method !== "turn/diff/updated") return;
    const payload = event.notification.params;
    const observedAtMs = Date.now();
    if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
      return;
    if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;

    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = reduceCodexConversationTurnDiff(
        before,
        payload.threadId,
        payload.turnId,
        payload.diff,
        observedAtMs,
      );
      if (result.state === before) return conversation;
      const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
        observedAtMs,
        preserveExistingUpdatedAt: true,
      });
      return { ...projection.conversation, canonicalState: result.state };
    });
  }

  private consumeOwnerTurnMetadataEffects(effects: readonly CodexTurnMetadataEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "markConversationStreaming") {
        this.streamState.setStreaming(effect.threadId, true);
      }
    }
  }

  private handleOwnerTurnLifecycleNotification(event: CodexThreadOwnerNotificationEvent): void {
    const method = event.notification.method;
    if (method !== "turn/started" && method !== "turn/completed") {
      return;
    }

    const deferredForTextDrain =
      method === "turn/completed" &&
      this.ownerTextDeltaQueue.drainBefore(() => {
        this.handleThreadOwnerNotification(event);
      }, event.notification.params.threadId);
    if (deferredForTextDrain) {
      this.claimOwnerNotificationSequence(event.notification.params.threadId, event.sequence);
      return;
    }

    const payload = toOwnerTurnLifecyclePayload(event.notification);
    if (method === "turn/completed") {
      this.terminalInputBuffers.clearTurn(payload.threadId, payload.turnId);
    }
    if (this.ackOwnerNotificationIfTombstoned(payload.threadId, [payload.turnId], event.sequence))
      return;

    logAssistantStreamingDebug("renderer-owner-turn-lifecycle", {
      method,
      sequence: event.sequence,
      threadId: payload.threadId,
      turnId: payload.turnId,
      status: payload.status,
    });

    this.applyOwnerTurnLifecycleNotification(method, payload, event.sequence);
  }

  private applyOwnerTurnLifecycleNotification(
    method: OwnerTurnLifecycleMethod,
    payload: OwnerTurnLifecyclePayload,
    ownerNotificationSequence: number,
  ): void {
    const currentCanonical = this.conversationsById.get(payload.threadId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== payload.threadId) {
      this.handleOwnerReducerUnavailable(payload.threadId);
      void this.ackOwnerNotification(payload.threadId, ownerNotificationSequence);
      return;
    }
    this.publishOwnerConversationSnapshotMutation(
      payload.threadId,
      ownerNotificationSequence,
      (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const projection = applyOwnerTurnLifecycleToConversation(
          conversation,
          before,
          method,
          payload,
        );
        this.applyOwnerCanonicalHiddenTurns(payload.threadId, projection.hiddenTurns);
        return projection.conversation;
      },
    );
  }

  private handleOwnerItemLifecycleNotification(event: CodexThreadOwnerNotificationEvent): void {
    const method = event.notification.method;
    if (method !== "item/started" && method !== "item/completed") {
      return;
    }

    const deferredForTextDrain =
      method === "item/completed" &&
      this.ownerTextDeltaQueue.drainBefore(() => {
        this.handleThreadOwnerNotification(event);
      }, event.notification.params.threadId);
    if (deferredForTextDrain) {
      this.claimOwnerNotificationSequence(event.notification.params.threadId, event.sequence);
      return;
    }

    const payload = toOwnerItemLifecyclePayload(event.notification);
    const itemId = payload.item.id;
    if (payload.turnId) {
      this.terminalInputBuffers.clearItem({
        conversationId: payload.threadId,
        turnId: payload.turnId,
        itemId,
      });
    }
    if (
      this.ackOwnerNotificationIfTombstoned(
        payload.threadId,
        [payload.turnId, itemId],
        event.sequence,
      )
    ) {
      return;
    }
    logAssistantStreamingDebug("renderer-owner-item-lifecycle", {
      method,
      sequence: event.sequence,
      threadId: payload.threadId,
      turnId: payload.turnId,
      itemId,
      itemType: payload.item.type,
      itemStatus: "status" in payload.item ? payload.item.status : null,
    });

    this.applyOwnerItemLifecycleNotification(method, payload, event.sequence);
  }

  private applyOwnerItemLifecycleNotification(
    method: "item/started" | "item/completed",
    payload: OwnerItemLifecyclePayload,
    ownerNotificationSequence: number,
  ): void {
    const currentCanonical = this.conversationsById.get(payload.threadId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== payload.threadId) {
      this.handleOwnerReducerUnavailable(payload.threadId);
      void this.ackOwnerNotification(payload.threadId, ownerNotificationSequence);
      return;
    }

    this.publishOwnerConversationMutation(
      payload.threadId,
      ownerNotificationSequence,
      (conversation) => {
        const before = conversation.canonicalState;
        if (!before || before.protocol.id !== payload.threadId) return null;
        const canonicalResult = reduceCodexConversationEventWithEffects(
          before,
          { type: "notification", notification: payload.notification },
          {
            now: () => payload.observedAtMs,
            resolveCollabReceiverThread: (receiverThreadId) =>
              this.resolveLoadedOwnerCanonicalThread(receiverThreadId),
          },
        );
        const projection = applyOwnerCanonicalTurnProjection(
          conversation,
          before,
          canonicalResult.state,
          {
            observedAtMs: payload.observedAtMs,
            lifecycleStatus: method === "item/started" ? "inProgress" : "completed",
          },
        );
        for (const effect of canonicalResult.effects) {
          if (effect.type === "markConversationStreaming") {
            this.streamState.setStreaming(effect.threadId, true);
            continue;
          }
          // Collaboration receiver metadata invalidates the bounded overview projection; it must
          // never make an owner lifecycle notification hydrate child transcript history.
          if (effect.type === "hydrateCollabThreads") continue;
        }
        this.applyOwnerCanonicalHiddenTurns(payload.threadId, projection.hiddenTurns);
        return {
          ...projection.conversation,
          canonicalState: canonicalResult.state,
          canonicalRequests: [...canonicalResult.state.requests],
          hasUnreadTurn: canonicalResult.state.sidecar.hasUnreadTurn,
        };
      },
    );
  }

  private resolveLoadedOwnerCanonicalThread(threadId: string): Thread | null {
    const state = this.conversationsById.get(threadId)?.canonicalState;
    if (!state) return null;
    return {
      ...state.protocol,
      turns: state.turns.flatMap((turn): Turn[] => {
        if (turn.protocol.id === null) return [];
        return [
          {
            ...turn.protocol,
            id: turn.protocol.id,
            items: turn.items.filter(isCodexCanonicalProtocolItem),
            startedAt: turn.sidecar.turnStartedAtMs,
            completedAt: turn.sidecar.completedAtMs ?? null,
          },
        ];
      }),
    };
  }

  private applyOwnerCanonicalHiddenTurns(
    threadId: string,
    turns: readonly OwnerCanonicalLifecycleHiddenTurn[],
  ): void {
    const hiddenTypesByTurn =
      this.ownerHiddenLifecycleItemTypesByConversationId.get(threadId) ?? new Map();
    for (const turn of turns) {
      if (turn.sourceTurnKey !== turn.targetTurnKey) {
        hiddenTypesByTurn.delete(turn.sourceTurnKey);
      }
      if (turn.itemTypes.size === 0) {
        hiddenTypesByTurn.delete(turn.targetTurnKey);
        continue;
      }
      hiddenTypesByTurn.set(turn.targetTurnKey, new Map(turn.itemTypes));
    }
    if (hiddenTypesByTurn.size === 0) {
      this.ownerHiddenLifecycleItemTypesByConversationId.delete(threadId);
      return;
    }
    this.ownerHiddenLifecycleItemTypesByConversationId.set(threadId, hiddenTypesByTurn);
  }

  private handleOwnerFileChangePatchUpdatedNotification(
    event: CodexThreadOwnerNotificationEvent,
  ): void {
    if (!isCodexFileChangePatchUpdatedNotification(event.notification)) return;
    const update = toCodexFileChangePatchUpdate(event.notification);
    if (
      this.ackOwnerNotificationIfTombstoned(
        update.conversationId,
        [update.turnId, update.itemId],
        event.sequence,
      )
    ) {
      return;
    }
    const currentCanonical = this.conversationsById.get(update.conversationId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== update.conversationId) {
      this.handleOwnerReducerUnavailable(update.conversationId);
      void this.ackOwnerNotification(update.conversationId, event.sequence);
      return;
    }

    this.publishOwnerConversationMutation(update.conversationId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== update.conversationId) return null;
      const observedAtMs = Date.now();
      const result = reduceCodexConversationFileChangePatch(before, update, {
        now: () => observedAtMs,
      });
      if (result.disposition !== "applied") {
        console.warn("Dropping fileChange/patchUpdated for missing turn", {
          threadId: update.conversationId,
          turnId: update.turnId,
          itemId: update.itemId,
        });
        return conversation;
      }
      if (!result.stateChanged) return conversation;
      const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
        observedAtMs,
        preserveExistingUpdatedAt: true,
      });
      this.applyOwnerCanonicalHiddenTurns(update.conversationId, projection.hiddenTurns);
      return { ...projection.conversation, canonicalState: result.state };
    });
  }

  private handleOwnerMcpToolCallProgressNotification(
    event: CodexThreadOwnerNotificationEvent,
  ): void {
    if (!isCodexMcpToolCallProgressNotification(event.notification)) return;
    const update = toCodexMcpToolCallProgressUpdate(event.notification);
    if (
      this.ackOwnerNotificationIfTombstoned(
        update.conversationId,
        [update.turnId, update.itemId],
        event.sequence,
      )
    ) {
      return;
    }
    const currentCanonical = this.conversationsById.get(update.conversationId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== update.conversationId) {
      this.handleOwnerReducerUnavailable(update.conversationId);
      void this.ackOwnerNotification(update.conversationId, event.sequence);
      return;
    }

    this.publishOwnerConversationMutation(update.conversationId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== update.conversationId) return null;
      const observedAtMs = Date.now();
      const result = reduceCodexConversationMcpToolCallProgress(before, update, {
        now: () => observedAtMs,
      });
      if (result.disposition !== "applied") return conversation;
      if (result.matchedItemIndex >= 0) {
        console.debug("Ignoring mcpToolCall progress message", {
          itemId: update.itemId,
          message: update.message,
        });
      } else {
        console.error("Item not found in turn state", {
          itemId: update.itemId,
          expectedType: "mcpToolCall",
        });
      }
      if (!result.stateChanged) return conversation;
      const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
        observedAtMs,
        preserveExistingUpdatedAt: true,
      });
      this.applyOwnerCanonicalHiddenTurns(update.conversationId, projection.hiddenTurns);
      return { ...projection.conversation, canonicalState: result.state };
    });
  }

  private handleOwnerNoopItemNotification(event: CodexThreadOwnerNotificationEvent): void {
    if (event.notification.method !== "item/fileChange/outputDelta") return;

    void this.ackOwnerNotification(event.notification.params.threadId, event.sequence);
  }

  private handleOwnerReasoningSummaryPartAddedNotification(
    event: CodexThreadOwnerNotificationEvent,
  ): void {
    if (event.notification.method !== "item/reasoning/summaryPartAdded") return;
    const payload = event.notification.params;
    if (
      this.ackOwnerNotificationIfTombstoned(
        payload.threadId,
        [payload.turnId, payload.itemId],
        event.sequence,
      )
    ) {
      return;
    }
    const currentCanonical = this.conversationsById.get(payload.threadId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== payload.threadId) {
      this.handleOwnerReducerUnavailable(payload.threadId);
      void this.ackOwnerNotification(payload.threadId, event.sequence);
      return;
    }
    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = reduceCodexConversationEventWithEffects(
        before,
        { type: "notification", notification: event.notification },
        { now: () => Date.now() },
      );
      if (result.state === before) return conversation;
      const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
        observedAtMs: Date.now(),
        preserveExistingUpdatedAt: true,
      });
      this.applyOwnerCanonicalHiddenTurns(payload.threadId, projection.hiddenTurns);
      return {
        ...projection.conversation,
        canonicalState: result.state,
        canonicalRequests: [...result.state.requests],
        hasUnreadTurn: result.state.sidecar.hasUnreadTurn,
      };
    });
  }

  private handleOwnerTerminalInteractionNotification(
    event: CodexThreadOwnerNotificationEvent,
  ): void {
    if (event.notification.method !== "item/commandExecution/terminalInteraction") return;
    const payload = event.notification.params;

    if (
      this.ackOwnerNotificationIfTombstoned(
        payload.threadId,
        [payload.turnId, payload.itemId],
        event.sequence,
      )
    ) {
      return;
    }
    const parsed = this.terminalInputBuffers.accept(
      {
        conversationId: payload.threadId,
        turnId: payload.turnId,
        itemId: payload.itemId,
      },
      payload.stdin,
    );
    if (parsed.disposition === "overflow") {
      console.warn("Dropping overflowing commandExecution/terminalInteraction", {
        threadId: payload.threadId,
        turnId: payload.turnId,
        itemId: payload.itemId,
        reason: parsed.reason,
      });
      this.claimOwnerNotificationSequence(payload.threadId, event.sequence);
      this.markOwnerStreamPublishUnavailable(payload.threadId);
      return;
    }
    if (parsed.commands.length === 0) return;

    const terminalUpdate: CodexTerminalCommandUpdate = {
      conversationId: payload.threadId,
      turnId: payload.turnId,
      itemId: payload.itemId,
      commands: parsed.commands,
    };
    const currentCanonical = this.conversationsById.get(payload.threadId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== payload.threadId) {
      this.handleOwnerReducerUnavailable(payload.threadId);
      void this.ackOwnerNotification(payload.threadId, event.sequence);
      return;
    }
    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = reduceCodexConversationTerminalCommands(before, terminalUpdate);
      if (result.disposition !== "applied") {
        console.warn("Dropping commandExecution/terminalInteraction for missing item", {
          threadId: payload.threadId,
          turnId: terminalUpdate.turnId,
          itemId: payload.itemId,
        });
        return conversation;
      }
      if (!result.stateChanged) return conversation;
      const projection = applyOwnerCanonicalTurnProjection(conversation, before, result.state, {
        observedAtMs: Date.now(),
        preserveExistingUpdatedAt: true,
      });
      this.applyOwnerCanonicalHiddenTurns(payload.threadId, projection.hiddenTurns);
      return {
        ...projection.conversation,
        canonicalState: result.state,
        canonicalRequests: [...result.state.requests],
        hasUnreadTurn: result.state.sidecar.hasUnreadTurn,
      };
    });
  }

  private handleOwnerServerRequestResolvedNotification(
    event: CodexThreadOwnerNotificationEvent,
  ): void {
    if (event.notification.method !== "serverRequest/resolved") return;
    const payload = event.notification.params;

    const currentCanonical = this.conversationsById.get(payload.threadId)?.canonicalState;
    if (!currentCanonical || currentCanonical.protocol.id !== payload.threadId) {
      this.handleOwnerReducerUnavailable(payload.threadId);
      void this.ackOwnerNotification(payload.threadId, event.sequence);
      return;
    }

    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = applyOwnerServerRequestResolvedToConversation(conversation, before, payload);
      this.applyOwnerCanonicalHiddenTurns(payload.threadId, result.hiddenTurns);
      return result.conversation;
    });
  }

  private handleOwnerErrorNotification(event: CodexThreadOwnerNotificationEvent): void {
    if (event.notification.method !== "error") return;
    const notification = event.notification;
    const payload = notification.params;
    const observedAtMs = Date.now();
    if (!this.requireOwnerCanonicalMetadata(payload.threadId, event.sequence)) return;

    this.publishOwnerConversationMutation(payload.threadId, event.sequence, (conversation) => {
      const before = conversation.canonicalState;
      if (!before || before.protocol.id !== payload.threadId) return null;
      const result = reduceCodexConversationError(
        before,
        notification,
        createOwnerGeneratedItemId("error"),
        observedAtMs,
      );
      return projectOwnerCanonicalTurnMetadataResult(conversation, before, result, observedAtMs);
    });
  }

  private handleThreadOwnerUnavailable(event: CodexThreadOwnerUnavailableEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    const targetConversationIds = new Set([
      ...this.streamState.markOwnerUnavailable(event.ownerClientId),
      ...event.conversationIds,
    ]);
    for (const conversationId of targetConversationIds) {
      this.queueOwnerProjectionFenceByConversationId.delete(conversationId);
      this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
      this.followerAcceptedReplicasByConversationId.delete(conversationId);
      this.ownerTextDeltaQueue.discardConversation(conversationId);
      this.outputDeltaQueue.discardConversation(conversationId);
      this.discardOwnerNotificationState(conversationId);
      if (this.streamState.getRole(conversationId)?.role === "owner") continue;

      const conversation = this.conversationsById.get(conversationId);
      if (!conversation || conversation.resumeState === "needs_resume") continue;

      this.applyConversationSnapshot(conversationId, {
        ...conversation,
        resumeState: "needs_resume",
      });
    }
  }

  private handleThreadStreamFollowingStatusRequested(
    event: CodexThreadStreamFollowingStatusRequestedEvent,
  ): void {
    if (event.hostId !== this.hostId) return;
    if (!this.streamState.isConversationFollowing(event.conversationId)) return;

    void this.setThreadStreamFollowingWithOptions(event.conversationId, true, {
      reannounce: true,
    }).catch(() => {
      // A renderer that is closing may receive the status request after its IPC bridge is gone.
    });
  }

  private handleThreadStreamFollowersChanged(event: CodexThreadStreamFollowersChangedEvent): void {
    if (event.hostId !== this.hostId) return;

    const previous = this.followerMembershipByConversationId.get(event.conversationId);
    if (
      previous &&
      previous.ownerClientId === event.ownerClientId &&
      event.membershipEpoch <= previous.membershipEpoch
    ) {
      return;
    }

    this.followerMembershipByConversationId.set(event.conversationId, {
      ownerClientId: event.ownerClientId,
      followerClientIds: [...event.followerClientIds],
      membershipEpoch: event.membershipEpoch,
    });
  }

  private handleThreadStreamTransportReset(event: CodexThreadStreamTransportResetEvent): void {
    if (event.hostId !== this.hostId) return;

    const ownerConversationIds = new Set(
      event.conversationIds.filter(
        (conversationId) => this.streamState.getRole(conversationId)?.role === "owner",
      ),
    );
    const affectedConversationIds = this.streamState.handleTransportReset(event.conversationIds);
    for (const conversationId of affectedConversationIds) {
      this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
      this.followerAcceptedReplicasByConversationId.delete(conversationId);
      this.conversationVersionById.delete(conversationId);
      if (ownerConversationIds.has(conversationId)) {
        this.ownerTextDeltaQueue.discardConversation(conversationId);
        this.outputDeltaQueue.discardConversation(conversationId);
        this.discardDeferredOwnerRecoveryMessages(conversationId);
        this.discardOwnerNotificationState(conversationId);
        this.cancelOwnerStreamPublishQueues(
          conversationId,
          new Error(`Owner stream transport reset for ${conversationId}`),
        );
      }
      void this.setThreadStreamFollowingWithOptions(conversationId, true, {
        reannounce: true,
      }).catch(() => {
        // The owner may be reconnecting while this renderer is recovering its stream role.
      });
      const conversation = this.conversationsById.get(conversationId);
      if (!conversation || conversation.resumeState === "needs_resume") continue;
      this.applyConversationSnapshot(conversationId, {
        ...conversation,
        resumeState: "needs_resume",
      });
    }
  }

  private handleMcpNotification(event: CodexMcpNotificationEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    if (event.notification.method !== "item/commandExecution/outputDelta") {
      return;
    }

    this.outputDeltaQueue.enqueue({
      conversationId: event.notification.params.threadId,
      turnId: event.notification.params.turnId,
      itemId: event.notification.params.itemId,
      delta: event.notification.params.delta,
    });
  }

  private discardOwnerNotificationState(conversationId: string): void {
    this.ownerTextDeltaSequenceTracker.discardConversation(conversationId);
    this.ownerNotificationCompletionByConversationId.delete(conversationId);
    this.unclaimedOwnerNotificationSequencesByConversationId.delete(conversationId);
  }

  private pendingOwnerNotificationSequenceCount(conversationId?: string): number {
    const conversationIds = new Set([
      ...this.ownerNotificationCompletionByConversationId.keys(),
      ...this.unclaimedOwnerNotificationSequencesByConversationId.keys(),
    ]);
    let total = 0;
    for (const candidateConversationId of conversationIds) {
      if (conversationId !== undefined && candidateConversationId !== conversationId) continue;
      const completion =
        this.ownerNotificationCompletionByConversationId.get(candidateConversationId);
      total += completion?.completedSequences.size ?? 0;
      if (completion?.reservedAckThrough !== null && completion?.reservedAckThrough !== undefined) {
        total += 1;
      }
      total +=
        this.unclaimedOwnerNotificationSequencesByConversationId.get(candidateConversationId)
          ?.size ?? 0;
    }
    return total;
  }

  private canRetainOwnerNotificationSequences(
    conversationId: string,
    additionalCount: number,
  ): boolean {
    if (additionalCount <= 0) return true;
    return (
      this.pendingOwnerNotificationSequenceCount(conversationId) + additionalCount <=
        CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES_PER_CONVERSATION &&
      this.pendingOwnerNotificationSequenceCount() + additionalCount <=
        CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES
    );
  }

  private beginOwnerNotificationHandling(conversationId: string, sequence: number): boolean {
    if (!this.registerOwnerNotificationSequence(conversationId, sequence)) return false;
    const sequences = this.unclaimedOwnerNotificationSequencesByConversationId.get(conversationId);
    if (sequences) {
      if (
        !sequences.has(sequence) &&
        !this.canRetainOwnerNotificationSequences(conversationId, 1)
      ) {
        return false;
      }
      sequences.add(sequence);
      return true;
    }
    if (!this.canRetainOwnerNotificationSequences(conversationId, 1)) return false;
    this.unclaimedOwnerNotificationSequencesByConversationId.set(
      conversationId,
      new Set([sequence]),
    );
    return true;
  }

  private claimOwnerNotificationSequence(conversationId: string, sequence: number): void {
    const sequences = this.unclaimedOwnerNotificationSequencesByConversationId.get(conversationId);
    if (!sequences) return;
    sequences.delete(sequence);
    if (sequences.size === 0) {
      this.unclaimedOwnerNotificationSequencesByConversationId.delete(conversationId);
    }
  }

  private finishOwnerNotificationHandling(conversationId: string, sequence: number): void {
    const sequences = this.unclaimedOwnerNotificationSequencesByConversationId.get(conversationId);
    if (!sequences?.delete(sequence)) return;
    if (sequences.size === 0) {
      this.unclaimedOwnerNotificationSequencesByConversationId.delete(conversationId);
    }
    void this.ackOwnerNotification(conversationId, sequence);
  }

  private registerOwnerNotificationSequence(conversationId: string, sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return false;
    if (this.ownerNotificationCompletionByConversationId.has(conversationId)) {
      return true;
    }
    if (
      this.ownerNotificationCompletionByConversationId.size >=
      CODEX_OWNER_NOTIFICATION_MAX_TRACKED_CONVERSATIONS
    ) {
      return false;
    }

    this.ownerNotificationCompletionByConversationId.set(conversationId, {
      nextSequenceToAck: sequence,
      completedSequences: new Set(),
      reservedAckThrough: null,
    });
    return true;
  }

  private recordOwnerNotificationCompletions(
    conversationId: string,
    input: OwnerNotificationSequenceInput,
  ): boolean {
    const sequences = typeof input === "number" ? [input] : input;
    const firstSequence = sequences.find(
      (sequence) => Number.isSafeInteger(sequence) && sequence > 0,
    );
    if (firstSequence === undefined) return sequences.every((value) => value === 0);

    for (const sequence of sequences) {
      this.claimOwnerNotificationSequence(conversationId, sequence);
    }
    if (!this.registerOwnerNotificationSequence(conversationId, firstSequence)) return false;
    const state = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (!state) return false;
    const additions = new Set(
      sequences.filter(
        (sequence) =>
          Number.isSafeInteger(sequence) &&
          sequence >= state.nextSequenceToAck &&
          !state.completedSequences.has(sequence),
      ),
    );
    if (!this.canRetainOwnerNotificationSequences(conversationId, additions.size)) return false;
    for (const sequence of additions) {
      state.completedSequences.add(sequence);
    }
    return true;
  }

  private reserveOwnerNotificationAck(conversationId: string): number {
    const state = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (!state || state.reservedAckThrough !== null) return 0;

    let nextSequence = state.nextSequenceToAck;
    let ackThrough = 0;
    while (state.completedSequences.delete(nextSequence)) {
      ackThrough = nextSequence;
      nextSequence += 1;
    }
    if (ackThrough === 0) return 0;

    state.nextSequenceToAck = nextSequence;
    state.reservedAckThrough = ackThrough;
    return ackThrough;
  }

  private confirmOwnerNotificationAck(conversationId: string, sequence: number): void {
    if (sequence <= 0) return;
    const state = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (!state || state.reservedAckThrough !== sequence) return;
    state.reservedAckThrough = null;
  }

  private flushOwnerNotificationCompletions(conversationId: string): void {
    const state = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (!state || state.reservedAckThrough !== null) return;

    const cursor = this.ownerStreamPublishCursorsByConversationId.get(conversationId);
    if (cursor?.inFlight) return;
    if (cursor?.dirty) {
      this.processOwnerStreamPublishCursor(conversationId);
      return;
    }

    const sequence = this.reserveOwnerNotificationAck(conversationId);
    if (sequence <= 0) return;
    this.dispatchReservedOwnerNotificationAck(conversationId, sequence);
  }

  private dispatchReservedOwnerNotificationAck(conversationId: string, sequence: number): void {
    const completionState = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (!completionState || completionState.reservedAckThrough !== sequence) return;

    void (async () => {
      let accepted = false;
      try {
        accepted =
          (await runWithOwnerStreamDeadline(
            runConversationOperation("codex:thread-owner:notification:ack", {
              conversationId,
              sequence,
            }),
            `Owner notification ACK for ${conversationId}`,
          )) === true;
      } catch {
        accepted = false;
      }

      if (
        this.ownerNotificationCompletionByConversationId.get(conversationId) !== completionState
      ) {
        return;
      }
      if (!accepted) {
        this.markOwnerStreamPublishUnavailable(conversationId);
        return;
      }

      this.confirmOwnerNotificationAck(conversationId, sequence);
      this.processOwnerStreamPublishCursor(conversationId);
      this.flushOwnerNotificationCompletions(conversationId);
    })();
  }

  private applyOwnerTextDeltas(
    updates: readonly OwnerFrameTextDeltaUpdate[],
    options: OwnerFrameTextDeltaFlushOptions = {},
  ): void {
    if (updates.length === 0) return;

    for (const [conversationId, conversationUpdates] of groupCodexFrameTextDeltasByConversation(
      updates,
    )) {
      const completedSequences =
        options.completedSequencesByConversationId?.get(conversationId) ?? [];
      const currentCanonical = this.conversationsById.get(conversationId)?.canonicalState;
      if (!currentCanonical || currentCanonical.protocol.id !== conversationId) {
        this.handleOwnerReducerUnavailable(conversationId);
        void this.ackOwnerNotification(conversationId, completedSequences);
        continue;
      }
      this.publishOwnerConversationMutation(
        conversationId,
        completedSequences,
        (currentConversation) => {
          const before = currentConversation.canonicalState;
          if (!before || before.protocol.id !== conversationId) return null;
          const observedAtMs = Date.now();
          const canonicalResult = reduceCodexConversationFrameTextDeltas(
            before,
            conversationUpdates,
            { now: () => observedAtMs },
          );
          const projection =
            canonicalResult.state === before
              ? { conversation: currentConversation, hiddenTurns: [] }
              : applyOwnerCanonicalTurnProjection(
                  currentConversation,
                  before,
                  canonicalResult.state,
                  { observedAtMs, preserveExistingUpdatedAt: true },
                );

          for (const [outcomeIndex, outcome] of canonicalResult.outcomes.entries()) {
            const update = conversationUpdates[outcomeIndex];
            if (!update) continue;
            if (update.target.type === "agentMessage" || update.target.type === "plan") {
              const beforeState = readOwnerStreamingDebugItemState(
                currentConversation,
                update.itemId,
              );
              const afterState = readOwnerStreamingDebugItemState(
                projection.conversation,
                update.itemId,
              );
              const turnStatus = afterState.turnStatus;
              const itemStatus = afterState.itemStatus;
              logAssistantStreamingDebugSampled(
                "renderer-owner-delta-applied",
                `${conversationId}:${update.turnId ?? "latest"}:${update.itemId}:${update.target.type}`,
                {
                  conversationId,
                  turnId: update.turnId,
                  itemId: update.itemId,
                  targetType: update.target.type,
                  sequence: update.ownerNotificationSequence,
                  deltaLength: update.delta.length,
                  applied: outcome.disposition === "applied",
                  beforeState,
                  afterState,
                  wouldAnimateAssistantMarkdown:
                    update.target.type === "agentMessage" &&
                    turnStatus === "inProgress" &&
                    itemStatus === "inProgress",
                },
              );
            }
          }
          if (canonicalResult.state === before) return currentConversation;
          this.applyOwnerCanonicalHiddenTurns(conversationId, projection.hiddenTurns);
          return {
            ...projection.conversation,
            canonicalState: canonicalResult.state,
            canonicalRequests: [...canonicalResult.state.requests],
            hasUnreadTurn: canonicalResult.state.sidecar.hasUnreadTurn,
          };
        },
        { notifyMode: options.notifyMode ?? "default" },
      );
    }
  }

  private ensureOwnerStreamPublishCursor(
    conversationId: string,
    acceptedCheckpoint: CodexThreadStreamCheckpoint,
    acceptedDocument: CodexConversationSnapshot,
  ): OwnerStreamPublishCursor {
    const existing = this.ownerStreamPublishCursorsByConversationId.get(conversationId);
    if (existing) {
      return existing;
    }

    const cursor: OwnerStreamPublishCursor = {
      acceptedCheckpoint,
      acceptedDocument: toSharedConversationDocument(acceptedDocument),
      inFlight: false,
      dirty: false,
    };
    this.ownerStreamPublishCursorsByConversationId.set(conversationId, cursor);
    return cursor;
  }

  private seedOwnerStreamPublishCursor(
    conversationId: string,
    acceptedCheckpoint: CodexThreadStreamCheckpoint,
    acceptedReplica: CodexConversationSnapshot,
  ): void {
    const existing = this.ownerStreamPublishCursorsByConversationId.get(conversationId);
    if (existing && !existing.inFlight && !existing.dirty) {
      existing.acceptedCheckpoint = acceptedCheckpoint;
      existing.acceptedDocument = acceptedReplica;
      return;
    }

    if (!existing) {
      this.ownerStreamPublishCursorsByConversationId.set(conversationId, {
        acceptedCheckpoint,
        acceptedDocument: acceptedReplica,
        inFlight: false,
        dirty: false,
      });
    }
  }

  private consumeOwnerStandaloneUnreadStateOverride(
    cursor: OwnerStreamPublishCursor,
    conversation: CodexConversationSnapshot,
  ): CodexConversationSnapshot {
    const override = cursor.standaloneUnreadStateOverride;
    cursor.standaloneUnreadStateOverride = undefined;
    if (override === undefined) return conversation;
    return applyStandaloneUnreadStateToSnapshot(conversation, override);
  }

  private isOwnerStreamPublishIdle(conversationId: string): boolean {
    const cursor = this.ownerStreamPublishCursorsByConversationId.get(conversationId);
    if (cursor && (cursor.inFlight || cursor.dirty)) {
      return false;
    }
    return true;
  }

  private waitForOwnerStreamPublishIdle(conversationId: string): Promise<void> {
    if (this.isOwnerStreamPublishIdle(conversationId)) {
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiters = this.ownerStreamPublishIdleWaitersByConversationId.get(conversationId);
      const totalWaiters = [...this.ownerStreamPublishIdleWaitersByConversationId.values()].reduce(
        (total, candidates) => total + candidates.size,
        0,
      );
      if (
        (waiters?.size ?? 0) >= CODEX_OWNER_STREAM_MAX_IDLE_WAITERS_PER_CONVERSATION ||
        totalWaiters >= CODEX_OWNER_STREAM_MAX_IDLE_WAITERS
      ) {
        const error = new Error(`Owner stream waiters exceeded their bound for ${conversationId}`);
        this.markOwnerStreamPublishUnavailable(conversationId);
        reject(error);
        return;
      }
      const waiter: OwnerStreamPublishIdleWaiter = { resolve, reject };
      if (waiters) {
        waiters.add(waiter);
        return;
      }
      this.ownerStreamPublishIdleWaitersByConversationId.set(conversationId, new Set([waiter]));
    });
  }

  private resolveOwnerStreamPublishIdleWaiters(conversationId: string): void {
    if (!this.isOwnerStreamPublishIdle(conversationId)) {
      return;
    }

    const waiters = this.ownerStreamPublishIdleWaitersByConversationId.get(conversationId);
    if (!waiters) {
      return;
    }

    this.ownerStreamPublishIdleWaitersByConversationId.delete(conversationId);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private rejectOwnerStreamPublishIdleWaiters(conversationId: string, error: Error): void {
    const waiters = this.ownerStreamPublishIdleWaitersByConversationId.get(conversationId);
    if (!waiters) return;
    this.ownerStreamPublishIdleWaitersByConversationId.delete(conversationId);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  private queueOwnerStreamCursorPublish(
    conversationId: string,
    ownerNotificationSequence: OwnerNotificationSequenceInput,
    cursor: OwnerStreamPublishCursor,
  ): void {
    cursor.dirty = true;
    if (!this.recordOwnerNotificationCompletions(conversationId, ownerNotificationSequence)) {
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }
    this.processOwnerStreamPublishCursor(conversationId);
  }

  private processOwnerStreamPublishCursor(conversationId: string): void {
    const cursor = this.ownerStreamPublishCursorsByConversationId.get(conversationId);
    if (!cursor || cursor.inFlight || !cursor.dirty) {
      return;
    }
    const completionState = this.ownerNotificationCompletionByConversationId.get(conversationId);
    if (completionState && completionState.reservedAckThrough !== null) {
      return;
    }

    const localConversation = this.conversationsById.get(conversationId);
    const role = this.streamState.getRole(conversationId);
    if (!localConversation || !role || role.role !== "owner") {
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }
    const conversation = toSharedConversationDocument(localConversation);

    const patches = buildCodexConversationStateUpdates(cursor.acceptedDocument, conversation);
    const ownerNotificationSequence = this.reserveOwnerNotificationAck(conversationId);
    cursor.dirty = false;

    if (patches.length === 0) {
      if (ownerNotificationSequence > 0) {
        this.dispatchReservedOwnerNotificationAck(conversationId, ownerNotificationSequence);
      }
      this.resolveOwnerStreamPublishIdleWaiters(conversationId);
      return;
    }

    const baseRevision = cursor.acceptedCheckpoint.revision;
    const revision = baseRevision + 1;
    const publishedConversation = conversation;
    const checkpoint = buildCodexThreadStreamCheckpoint({
      ownerEpoch: cursor.acceptedCheckpoint.ownerEpoch,
      revision,
      conversation: publishedConversation,
    });
    cursor.inFlight = true;

    void (async () => {
      const result = await this.dispatchOwnerStreamPatches(
        conversationId,
        cursor.acceptedCheckpoint,
        checkpoint,
        patches,
        ownerNotificationSequence || undefined,
      );

      if (this.ownerStreamPublishCursorsByConversationId.get(conversationId) !== cursor) {
        return;
      }

      if (result.accepted) {
        cursor.acceptedCheckpoint = result.checkpoint;
        cursor.acceptedDocument = this.consumeOwnerStandaloneUnreadStateOverride(
          cursor,
          publishedConversation,
        );
        cursor.inFlight = false;
        this.confirmOwnerNotificationAck(conversationId, ownerNotificationSequence);
        this.streamState.recordOwnerCheckpoint(conversationId, result.checkpoint);
        this.processOwnerStreamPublishCursor(conversationId);
        this.flushOwnerNotificationCompletions(conversationId);
        this.resolveOwnerStreamPublishIdleWaiters(conversationId);
        return;
      }

      await this.repairOwnerStreamPublishCursor(
        conversationId,
        cursor,
        ownerNotificationSequence,
        result,
      );
    })();
  }

  private async repairOwnerStreamPublishCursor(
    conversationId: string,
    cursor: OwnerStreamPublishCursor,
    ownerNotificationSequence: number,
    rejection: Exclude<CodexThreadOwnerStreamStatePublishResult, { accepted: true }>,
  ): Promise<void> {
    if (!rejection.recovery) {
      cursor.inFlight = false;
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }

    const conversation = this.adoptOwnerSnapshotRecovery(
      conversationId,
      cursor,
      rejection.recovery,
    );
    if (!conversation) {
      cursor.inFlight = false;
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }
    cursor.dirty = false;
    const result = await this.publishOwnerSnapshotFromCursor(
      conversationId,
      cursor,
      conversation,
      ownerNotificationSequence || undefined,
    );
    if (!result.accepted) {
      cursor.inFlight = false;
      this.markOwnerStreamPublishUnavailable(conversationId);
      return;
    }

    cursor.acceptedCheckpoint = result.checkpoint;
    cursor.acceptedDocument = this.consumeOwnerStandaloneUnreadStateOverride(
      cursor,
      result.conversation,
    );
    cursor.inFlight = false;
    this.confirmOwnerNotificationAck(conversationId, ownerNotificationSequence);
    this.streamState.recordOwnerCheckpoint(conversationId, result.checkpoint);
    this.processOwnerStreamPublishCursor(conversationId);
    this.flushOwnerNotificationCompletions(conversationId);
    this.resolveOwnerStreamPublishIdleWaiters(conversationId);
  }

  private adoptOwnerSnapshotRecovery(
    conversationId: string,
    cursor: OwnerStreamPublishCursor,
    recovery: NonNullable<
      Exclude<CodexThreadOwnerStreamStatePublishResult, { accepted: true }>["recovery"]
    >,
  ): CodexConversationSnapshot | null {
    const localConversation = this.conversationsById.get(conversationId);
    const role = this.streamState.getRole(conversationId);
    if (
      !localConversation ||
      !role ||
      role.role !== "owner" ||
      this.ownerStreamPublishCursorsByConversationId.get(conversationId) !== cursor
    ) {
      return null;
    }

    cursor.acceptedCheckpoint = recovery.checkpoint;
    cursor.acceptedDocument = recovery.conversationState;
    this.streamState.recordOwnerCheckpoint(conversationId, recovery.checkpoint);

    const authoritativeUnread =
      cursor.standaloneUnreadStateOverride ?? recovery.conversationState.hasUnreadTurn;
    const convergedConversation =
      typeof authoritativeUnread === "boolean"
        ? applyStandaloneUnreadStateToSnapshot(recovery.conversationState, authoritativeUnread)
        : recovery.conversationState;
    // Main recovery is the accepted authority. Replaying the stale owner document here would
    // resurrect history that Main already evicted; only the standalone unread override survives.
    this.applyConversationSnapshot(
      conversationId,
      materializeOwnerCanonicalConversationSnapshot(convergedConversation),
    );
    return toSharedConversationDocument(convergedConversation);
  }

  private async publishOwnerSnapshotFromCursor(
    conversationId: string,
    cursor: OwnerStreamPublishCursor,
    initialConversation: CodexConversationSnapshot,
    ownerNotificationSequence?: number,
  ): Promise<OwnerSnapshotPublishOutcome> {
    let conversation = initialConversation;
    let rejectionReason: Exclude<
      CodexThreadOwnerStreamStatePublishResult,
      { accepted: true }
    >["reason"] = "base-checkpoint-mismatch";

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const baseCheckpoint = cursor.acceptedCheckpoint;
      const checkpoint = buildCodexThreadStreamCheckpoint({
        ownerEpoch: baseCheckpoint.ownerEpoch,
        revision: baseCheckpoint.revision + 1,
        conversation,
      });
      const result = await this.dispatchOwnerStreamSnapshot(
        conversationId,
        baseCheckpoint,
        checkpoint,
        conversation,
        ownerNotificationSequence,
      );
      if (this.ownerStreamPublishCursorsByConversationId.get(conversationId) !== cursor) {
        return { accepted: false, reason: "not-owner" };
      }
      if (result.accepted) {
        return { accepted: true, checkpoint: result.checkpoint, conversation };
      }

      rejectionReason = result.reason;
      if (!result.recovery) break;
      const recovered = this.adoptOwnerSnapshotRecovery(conversationId, cursor, result.recovery);
      if (!recovered) break;
      conversation = recovered;
    }

    return { accepted: false, reason: rejectionReason };
  }

  private publishOwnerConversationMutation(
    conversationId: string,
    ownerNotificationSequence: OwnerNotificationSequenceInput,
    buildNextConversation: (
      conversation: CodexConversationSnapshot,
    ) => CodexConversationSnapshot | null,
    options: { notifyMode?: ConversationNotifyMode } = {},
  ): void {
    const role = this.streamState.getRole(conversationId);
    const acceptedCheckpoint = this.streamState.getCheckpoint(conversationId);
    const currentConversation = this.conversationsById.get(conversationId);
    if (!currentConversation || !role || role.role !== "owner" || !acceptedCheckpoint) {
      this.handleOwnerReducerUnavailable(conversationId);
      void this.ackOwnerNotification(conversationId, ownerNotificationSequence);
      return;
    }

    const candidateConversation = buildNextConversation(currentConversation);
    if (!candidateConversation || candidateConversation === currentConversation) {
      void this.ackOwnerNotification(conversationId, ownerNotificationSequence);
      return;
    }
    const nextConversation = finalizeOwnerConversationMutation(
      currentConversation,
      candidateConversation,
    );

    if (buildCodexConversationStateUpdates(currentConversation, nextConversation).length === 0) {
      this.applyConversationSnapshot(
        conversationId,
        nextConversation,
        undefined,
        options.notifyMode ?? "default",
      );
      void this.ackOwnerNotification(conversationId, ownerNotificationSequence);
      return;
    }

    const cursor = this.ensureOwnerStreamPublishCursor(
      conversationId,
      acceptedCheckpoint,
      currentConversation,
    );
    this.applyConversationSnapshot(
      conversationId,
      nextConversation,
      undefined,
      options.notifyMode ?? "default",
    );
    this.queueOwnerStreamCursorPublish(conversationId, ownerNotificationSequence, cursor);
  }

  private publishOwnerConversationSnapshotMutation(
    conversationId: string,
    ownerNotificationSequence: number,
    buildNextConversation: (
      conversation: CodexConversationSnapshot,
    ) => CodexConversationSnapshot | null,
  ): void {
    const role = this.streamState.getRole(conversationId);
    const acceptedCheckpoint = this.streamState.getCheckpoint(conversationId);
    const currentConversation = this.conversationsById.get(conversationId);
    if (!currentConversation || !role || role.role !== "owner" || !acceptedCheckpoint) {
      this.handleOwnerReducerUnavailable(conversationId);
      void this.ackOwnerNotification(conversationId, ownerNotificationSequence);
      return;
    }

    const candidateConversation = buildNextConversation(currentConversation);
    if (!candidateConversation || candidateConversation === currentConversation) {
      void this.ackOwnerNotification(conversationId, ownerNotificationSequence);
      return;
    }
    const nextConversation = finalizeOwnerConversationMutation(
      currentConversation,
      candidateConversation,
    );

    const cursor = this.ensureOwnerStreamPublishCursor(
      conversationId,
      acceptedCheckpoint,
      currentConversation,
    );
    this.applyConversationSnapshot(conversationId, nextConversation);
    this.queueOwnerStreamCursorPublish(conversationId, ownerNotificationSequence, cursor);
  }

  private publishOwnerActionConversationMutation(
    conversationId: string,
    buildNextConversation: (
      conversation: CodexConversationSnapshot,
    ) => CodexConversationSnapshot | null,
    options: { notifyMode?: ConversationNotifyMode } = {},
  ): number | null {
    const role = this.streamState.getRole(conversationId);
    const acceptedCheckpoint = this.streamState.getCheckpoint(conversationId);
    const currentConversation = this.conversationsById.get(conversationId);
    if (!currentConversation || !role || role.role !== "owner" || !acceptedCheckpoint) {
      this.handleOwnerReducerUnavailable(conversationId);
      return null;
    }

    const candidateConversation = buildNextConversation(currentConversation);
    if (!candidateConversation || candidateConversation === currentConversation) {
      return null;
    }
    const nextConversation = finalizeOwnerConversationMutation(
      currentConversation,
      candidateConversation,
    );

    if (buildCodexConversationStateUpdates(currentConversation, nextConversation).length === 0) {
      this.applyConversationSnapshot(
        conversationId,
        nextConversation,
        undefined,
        options.notifyMode ?? "default",
      );
      return acceptedCheckpoint.revision;
    }

    const cursor = this.ensureOwnerStreamPublishCursor(
      conversationId,
      acceptedCheckpoint,
      currentConversation,
    );
    const streamRevision = cursor.acceptedCheckpoint.revision + (cursor.inFlight ? 2 : 1);
    this.applyConversationSnapshot(
      conversationId,
      nextConversation,
      undefined,
      options.notifyMode ?? "default",
    );
    this.queueOwnerStreamCursorPublish(conversationId, 0, cursor);
    return streamRevision;
  }

  private ackOwnerNotification(
    conversationId: string,
    sequence: OwnerNotificationSequenceInput,
  ): Promise<void> {
    if (!this.recordOwnerNotificationCompletions(conversationId, sequence)) {
      this.markOwnerStreamPublishUnavailable(conversationId);
      return Promise.resolve();
    }
    this.flushOwnerNotificationCompletions(conversationId);
    return Promise.resolve();
  }

  private async dispatchOwnerStreamPatches(
    conversationId: string,
    baseCheckpoint: CodexThreadStreamCheckpoint,
    checkpoint: CodexThreadStreamCheckpoint,
    patches: OwnerStreamPublishPatches,
    ownerNotificationSequence?: number,
  ): Promise<CodexThreadOwnerStreamStatePublishResult> {
    try {
      const result = (await runWithOwnerStreamDeadline(
        runConversationOperation("codex:thread-owner:stream-state:publish", {
          conversationId,
          change: {
            type: "patches",
            baseRevision: baseCheckpoint.revision,
            revision: checkpoint.revision,
            patches,
          },
          baseCheckpoint,
          checkpoint,
          ownerNotificationSequence,
        }),
        `Owner patch publication for ${conversationId}`,
      )) as CodexThreadOwnerStreamStatePublishResult | boolean;
      if (result === true) return { accepted: true, checkpoint };
      if (result === false) {
        return { accepted: false, reason: "base-checkpoint-mismatch", recovery: null };
      }
      return result;
    } catch {
      return { accepted: false, reason: "not-owner", recovery: null };
    }
  }

  private async dispatchOwnerStreamHistoryMutation(
    conversationId: string,
    baseCheckpoint: CodexThreadStreamCheckpoint,
    checkpoint: CodexThreadStreamCheckpoint,
    mutation: CodexConversationHistoryMutation,
  ): Promise<CodexThreadOwnerStreamStatePublishResult> {
    try {
      const result = (await runWithOwnerStreamDeadline(
        runConversationOperation("codex:thread-owner:stream-state:publish", {
          conversationId,
          change: {
            type: "historyMutation",
            baseRevision: baseCheckpoint.revision,
            revision: checkpoint.revision,
            mutation,
          },
          baseCheckpoint,
          checkpoint,
        }),
        `Owner history publication for ${conversationId}`,
      )) as CodexThreadOwnerStreamStatePublishResult | boolean;
      if (result === true) return { accepted: true, checkpoint };
      if (result === false) {
        return { accepted: false, reason: "base-checkpoint-mismatch", recovery: null };
      }
      return result;
    } catch {
      return { accepted: false, reason: "not-owner", recovery: null };
    }
  }

  private async dispatchOwnerStreamSnapshot(
    conversationId: string,
    baseCheckpoint: CodexThreadStreamCheckpoint,
    checkpoint: CodexThreadStreamCheckpoint,
    conversation: CodexConversationSnapshot,
    ownerNotificationSequence?: number,
  ): Promise<CodexThreadOwnerStreamStatePublishResult> {
    try {
      const result = (await runWithOwnerStreamDeadline(
        runConversationOperation("codex:thread-owner:stream-state:publish", {
          conversationId,
          change: {
            type: "snapshot",
            revision: checkpoint.revision,
            conversationState: toSharedConversationDocument(conversation),
          },
          baseCheckpoint,
          checkpoint,
          ownerNotificationSequence,
        }),
        `Owner snapshot publication for ${conversationId}`,
      )) as CodexThreadOwnerStreamStatePublishResult | boolean;
      if (result === true) return { accepted: true, checkpoint };
      if (result === false) {
        return { accepted: false, reason: "base-checkpoint-mismatch", recovery: null };
      }
      return result;
    } catch {
      return { accepted: false, reason: "not-owner", recovery: null };
    }
  }

  private cancelOwnerStreamPublishQueues(conversationId?: string, error?: Error): void {
    if (typeof conversationId === "string") {
      this.ownerStreamPublishCursorsByConversationId.delete(conversationId);
      if (error) {
        this.rejectOwnerStreamPublishIdleWaiters(conversationId, error);
      } else {
        this.resolveOwnerStreamPublishIdleWaiters(conversationId);
      }
      return;
    }

    this.ownerStreamPublishCursorsByConversationId.clear();
    for (const conversationId of this.ownerStreamPublishIdleWaitersByConversationId.keys()) {
      this.resolveOwnerStreamPublishIdleWaiters(conversationId);
    }
  }

  private markOwnerStreamPublishUnavailable(conversationId: string): void {
    this.ownerTextDeltaQueue.discardConversation(conversationId);
    this.outputDeltaQueue.discardConversation(conversationId);
    this.discardDeferredOwnerRecoveryMessages(conversationId);
    this.discardOwnerNotificationState(conversationId);
    this.cancelOwnerStreamPublishQueues(
      conversationId,
      new Error(`Owner stream became unavailable for ${conversationId}`),
    );
    this.queueOwnerProjectionFenceByConversationId.delete(conversationId);
    const conversation = this.conversationsById.get(conversationId);
    if (!conversation) {
      this.streamState.removeConversation(conversationId);
      this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
      return;
    }

    if (conversation.resumeState !== "needs_resume") {
      this.applyConversationSnapshot(conversationId, {
        ...conversation,
        resumeState: "needs_resume",
      });
    }
    this.streamState.removeConversation(conversationId);
    this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
  }

  private handleOwnerReducerUnavailable(conversationId: string): void {
    if (this.streamState.getRole(conversationId)?.role === "follower") {
      return;
    }

    this.markOwnerStreamPublishUnavailable(conversationId);
  }

  private applyOutputDeltas(updates: readonly OutputDeltaUpdate[]): void {
    if (updates.length === 0) {
      return;
    }

    for (const [
      conversationId,
      conversationUpdates,
    ] of groupCodexCommandOutputUpdatesByConversation(updates)) {
      const completedOwnerSequences = conversationUpdates.flatMap(
        (update) =>
          update.ownerNotificationSequences ??
          (typeof update.ownerNotificationSequence === "number"
            ? [update.ownerNotificationSequence]
            : []),
      );
      const hasOwnerNotifications = completedOwnerSequences.length > 0;
      const baseRevision = this.streamState.getRevision(conversationId);
      const currentConversation = this.conversationsById.get(conversationId);
      if (!currentConversation) {
        void this.ackOwnerNotification(conversationId, completedOwnerSequences);
        continue;
      }

      if (hasOwnerNotifications) {
        const role = this.streamState.getRole(conversationId);
        if (!role || role.role !== "owner" || typeof baseRevision !== "number") {
          this.handleOwnerReducerUnavailable(conversationId);
          void this.ackOwnerNotification(conversationId, completedOwnerSequences);
          continue;
        }
      }

      const before = currentConversation.canonicalState;
      if (!before || before.protocol.id !== conversationId) {
        if (hasOwnerNotifications) {
          this.handleOwnerReducerUnavailable(conversationId);
          void this.ackOwnerNotification(conversationId, completedOwnerSequences);
        }
        continue;
      }

      let state = before;
      for (const update of conversationUpdates) {
        const result = reduceCodexConversationCommandOutput(state, update);
        state = result.state;
        if (result.disposition === "missingItem") {
          warnMissingOutputDeltaTarget(
            "Skipping command output delta for missing raw command execution",
            update,
          );
        }
      }

      if (state === before) {
        void this.ackOwnerNotification(conversationId, completedOwnerSequences);
        continue;
      }

      const projection = applyOwnerCanonicalTurnProjection(currentConversation, before, state, {
        observedAtMs: Date.now(),
        preserveExistingUpdatedAt: true,
      });
      this.applyOwnerCanonicalHiddenTurns(conversationId, projection.hiddenTurns);
      const nextConversation: CodexConversationSnapshot = {
        ...projection.conversation,
        canonicalState: state,
        canonicalRequests: [...state.requests],
        hasUnreadTurn: state.sidecar.hasUnreadTurn,
      };

      this.publishOwnerConversationMutation(
        conversationId,
        completedOwnerSequences,
        () => nextConversation,
      );
    }
  }

  private requestOwnerFollowerStreamResync(
    conversationId: string,
    ownerClientId: string,
    reason: CodexThreadStreamResyncRequestInput["reason"],
  ): void {
    if (this.resyncInFlight.has(conversationId)) return;
    this.resyncInFlight.add(conversationId);
    void runConversationOperation("codex:thread:stream-resync:request", {
      conversationId,
      ownerClientId,
      observedCheckpoint: this.streamState.getCheckpoint(conversationId),
      reason,
    }).finally(() => {
      this.resyncInFlight.delete(conversationId);
    });
  }

  private acknowledgeOwnerFollowerSnapshot(
    conversationId: string,
    ownerClientId: string,
    checkpoint: CodexThreadStreamCheckpoint,
  ): void {
    void runConversationOperation("codex:thread-follower:snapshot-applied", {
      conversationId,
      ownerClientId,
      checkpoint,
    });
  }

  private handleThreadStreamStateChanged(event: CodexThreadStreamStateChangedEvent): void {
    if (event.hostId !== this.hostId) {
      return;
    }

    const sourceClientId = event.sourceClientId?.trim() ?? "";
    if (!sourceClientId) return;
    const existingRole = this.streamState.getRole(event.conversationId);
    if (existingRole?.role === "owner") {
      return;
    }
    const checkpoint = event.checkpoint;
    if (!checkpoint || checkpoint.revision !== event.change.revision) {
      this.requestOwnerFollowerStreamResync(
        event.conversationId,
        existingRole?.role === "follower" ? existingRole.ownerClientId : sourceClientId,
        "missing-snapshot",
      );
      return;
    }
    if (event.change.type === "snapshot") {
      if (
        hashCodexConversationReplica(event.change.conversationState) !== checkpoint.canonicalHash
      ) {
        this.requestOwnerFollowerStreamResync(
          event.conversationId,
          sourceClientId,
          "checkpoint-hash-mismatch",
        );
        return;
      }
      const decision = this.streamState.acceptSnapshot({
        conversationId: event.conversationId,
        checkpoint,
        sourceClientId,
      });
      if (decision.type === "resync") {
        this.requestOwnerFollowerStreamResync(
          event.conversationId,
          existingRole?.role === "follower" ? existingRole.ownerClientId : sourceClientId,
          decision.reason,
        );
        return;
      }
      if (decision.type === "drop") return;
      this.ownerStreamPublishCursorsByConversationId.delete(event.conversationId);
      this.followerAcceptedReplicasByConversationId.set(
        event.conversationId,
        event.change.conversationState,
      );
      const materialized = materializeOwnerCanonicalConversationSnapshot(
        event.change.conversationState,
      );
      this.applyConversationSnapshot(event.conversationId, materialized);
      this.setConversationAttachmentState(event.conversationId, {
        status: "attached",
      });
      this.conversationVersionById.set(
        event.conversationId,
        Math.max(event.version, this.conversationVersionById.get(event.conversationId) ?? 0),
      );
      this.acknowledgeOwnerFollowerSnapshot(event.conversationId, sourceClientId, checkpoint);
      return;
    }

    const baseCheckpoint = event.baseCheckpoint;
    if (
      !baseCheckpoint ||
      baseCheckpoint.revision !== event.change.baseRevision ||
      checkpoint.revision !== event.change.revision
    ) {
      this.requestOwnerFollowerStreamResync(
        event.conversationId,
        existingRole?.role === "follower" ? existingRole.ownerClientId : sourceClientId,
        "revision-gap",
      );
      return;
    }
    const patchDecision = this.streamState.evaluatePatch({
      conversationId: event.conversationId,
      baseCheckpoint,
      checkpoint,
      sourceClientId,
    });
    if (patchDecision.type === "resync") {
      this.requestOwnerFollowerStreamResync(
        event.conversationId,
        existingRole?.role === "follower" ? existingRole.ownerClientId : sourceClientId,
        patchDecision.reason,
      );
      return;
    }
    if (patchDecision.type === "drop") {
      return;
    }

    const currentReplica = this.followerAcceptedReplicasByConversationId.get(event.conversationId);
    if (!currentReplica) {
      this.requestOwnerFollowerStreamResync(
        event.conversationId,
        sourceClientId,
        "missing-snapshot",
      );
      return;
    }

    try {
      const nextReplica =
        event.change.type === "historyMutation"
          ? (() => {
              const applied = applyCodexConversationHistoryMutation(
                currentReplica,
                event.change.mutation,
              );
              if (!applied.ok) throw new Error(applied.reason);
              return applied.conversation;
            })()
          : applyCodexConversationStateUpdates(currentReplica, event.change.patches);
      if (hashCodexConversationReplica(nextReplica) !== checkpoint.canonicalHash) {
        this.requestOwnerFollowerStreamResync(
          event.conversationId,
          sourceClientId,
          "checkpoint-hash-mismatch",
        );
        return;
      }
      this.followerAcceptedReplicasByConversationId.set(event.conversationId, nextReplica);
      const currentPresentation = this.conversationsById.get(event.conversationId);
      const materialized = materializeOwnerCanonicalConversationSnapshot(nextReplica);
      const nextConversation = currentPresentation
        ? applyStandaloneUnreadStateToSnapshot(
            materialized,
            currentPresentation.hasUnreadTurn === true,
          )
        : materialized;
      this.applyConversationSnapshot(
        event.conversationId,
        nextConversation,
        undefined,
        event.change.type === "patches" &&
          shouldSynchronouslyNotifyStreamingProsePatch(nextConversation, event.change.patches)
          ? "sync"
          : "default",
      );
      this.streamState.acceptPatch({
        conversationId: event.conversationId,
        checkpoint,
        sourceClientId,
      });
      this.setConversationAttachmentState(event.conversationId, {
        status: "attached",
      });
      this.conversationVersionById.set(
        event.conversationId,
        Math.max(event.version, this.conversationVersionById.get(event.conversationId) ?? 0),
      );
    } catch {
      this.requestOwnerFollowerStreamResync(
        event.conversationId,
        sourceClientId,
        "patch-apply-failed",
      );
    }
  }

  private applyConversationChildMembershipsUpdate(
    event: Extract<CodexSharedObject, { objectType: "conversationChildMemberships" }>["value"],
  ): void {
    const parentThreadId = event.parentThreadId.trim();
    if (!parentThreadId) return;

    const previous = this.childMembershipsByParentThreadId.get(parentThreadId);
    if (areConversationChildMembershipsEqual(previous, event.childMemberships)) return;
    this.childMembershipsByParentThreadId.set(parentThreadId, [...event.childMemberships]);
    this.notifyListeners(this.relationshipCallbacks.get(parentThreadId));
  }

  private applyThreadStartProgress(
    event: Extract<CodexSharedObject, { objectType: "threadStartProgress" }>["value"],
  ): void {
    const targetKey = getThreadStartProgressTargetKey(event.projectId, event.sessionId);
    const previous = this.threadStartProgressByTarget.get(targetKey);
    const previousText = event.clearOutput ? "" : (previous?.outputText ?? "");
    const previousCarriageReturnPending = event.clearOutput
      ? false
      : (previous?.outputCarriageReturnPending ?? false);
    const previousOutputTruncated = event.clearOutput
      ? false
      : (previous?.outputTruncated ?? false);
    const mergedOutput = event.outputDelta
      ? applyTerminalTextDelta({
          currentText: previousText,
          delta: event.outputDelta,
          carriageReturnPending: previousCarriageReturnPending,
          didTruncate: previousOutputTruncated,
          maxChars: WORKTREE_OUTPUT_TAIL_MAX_CHARS,
        })
      : {
          text: previousText,
          carriageReturnPending: previousCarriageReturnPending,
          didTruncate: previousOutputTruncated,
        };

    const nextState: CodexThreadStartProgressState = {
      projectId: event.projectId,
      sessionId: event.sessionId,
      runInTarget: event.runInTarget,
      threadId: event.threadId,
      phase: event.phase,
      message: event.message,
      outputText: mergedOutput.text,
      outputCarriageReturnPending: mergedOutput.carriageReturnPending,
      outputTruncated: mergedOutput.didTruncate,
      rendererLaunchPending: previous?.rendererLaunchPending ?? false,
      updatedAt: event.updatedAt,
    };
    if (areThreadStartProgressStatesEqual(previous, nextState)) {
      return;
    }

    this.threadStartProgressByTarget.set(targetKey, nextState);
    this.notifyControlCallbacks();
  }

  private setRendererFreshLaunchPending(
    projectId: string | null,
    sessionId: string,
    pending: boolean,
  ): void {
    const targetKey = getThreadStartProgressTargetKey(projectId, sessionId);
    const current = this.threadStartProgressByTarget.get(targetKey);
    if (!current || current.rendererLaunchPending === pending) return;

    this.threadStartProgressByTarget.set(targetKey, {
      ...current,
      rendererLaunchPending: pending,
    });
    this.notifyControlCallbacks();
  }

  private commitRendererFreshLaunchVisible(
    projectId: string | null,
    sessionId: string,
    threadId: string,
  ): void {
    const targetKey = getThreadStartProgressTargetKey(projectId, sessionId);
    const current = this.threadStartProgressByTarget.get(targetKey);
    if (!current) return;

    this.threadStartProgressByTarget.set(targetKey, {
      ...current,
      threadId,
      phase: "ready",
      rendererLaunchPending: false,
    });
    this.notifyControlCallbacks("sync");
  }

  private withCachedThreadTitle(thread: CodexThreadSummary): CodexThreadSummary {
    if (thread.threadName?.trim()) {
      return thread;
    }

    const cachedTitle = this.threadTitlesById.get(thread.threadId);
    if (!cachedTitle) {
      return thread;
    }

    return {
      ...thread,
      threadName: cachedTitle,
    };
  }

  private withCachedConversationTitle(
    conversation: CodexConversationSnapshot,
  ): CodexConversationSnapshot {
    if (conversation.threadName?.trim()) {
      return conversation;
    }

    const cachedTitle = this.threadTitlesById.get(conversation.threadId);
    if (!cachedTitle) {
      return conversation;
    }

    return {
      ...conversation,
      threadName: cachedTitle,
    };
  }

  private applyThreadTitleUpdate(threadId: string, title: string): void {
    const normalizedThreadId = threadId.trim();
    const normalizedTitle = title.trim();
    if (!normalizedThreadId || !normalizedTitle) {
      return;
    }

    if (this.threadTitlesById.get(normalizedThreadId) === normalizedTitle) {
      return;
    }

    this.threadTitlesById.set(normalizedThreadId, normalizedTitle);
    const summary = this.threadSummariesById.get(normalizedThreadId);
    if (summary && summary.threadName !== normalizedTitle) {
      this.applyThreadSummary({
        ...summary,
        threadName: normalizedTitle,
      });
    }

    const conversation = this.conversationsById.get(normalizedThreadId);
    if (conversation && conversation.threadName !== normalizedTitle) {
      this.applyConversationSnapshot(normalizedThreadId, {
        ...conversation,
        threadName: normalizedTitle,
      });
      return;
    }

    this.notifyAnyConversationCallbacks({ forceMeta: true });
  }

  private applyThreadSummary(thread: CodexThreadSummary): void {
    const nextThread = this.withCachedThreadTitle(thread);
    if (nextThread.threadName?.trim()) {
      this.threadTitlesById.set(nextThread.threadId, nextThread.threadName);
    }

    this.threadSummariesById.set(nextThread.threadId, nextThread);
    if (
      nextThread.source?.sideConversation === true ||
      isCodexNotificationChildConversation({
        parentThreadId: null,
        source: nextThread.source,
      })
    ) {
      this.notifyAnyConversationCallbacks({ forceMeta: true });
      return;
    }

    this.ensureRecentConversationId(nextThread.threadId);
    if (!nextThread.projectId) {
      this.notifyAnyConversationCallbacks({ forceMeta: true });
      return;
    }

    const currentThreads = this.threadSummariesByProject.get(nextThread.projectId) ?? EMPTY_THREADS;
    const nextThreads = upsertThreadSummary(currentThreads, nextThread);
    if (areThreadSummariesEqual(currentThreads, nextThreads)) {
      this.notifyAnyConversationCallbacks({ forceMeta: true });
      return;
    }

    this.threadSummariesByProject.set(nextThread.projectId, nextThreads);
    this.notifyProjectThreadSummaries(nextThread.projectId);
    this.notifyAnyConversationCallbacks({ forceMeta: true });
  }

  private removeThreadLocalState(threadId: string): void {
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return;
    }
    for (const [requestId, pending] of this.pendingNodexAgentAuthorizations) {
      if (pending.threadId !== normalizedThreadId) continue;
      this.pendingNodexAgentAuthorizations.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({ decision: "deny" });
    }

    const changedProjectIds = new Set<string>();
    const existingSummary = this.threadSummariesById.get(normalizedThreadId);
    if (existingSummary?.projectId) {
      changedProjectIds.add(existingSummary.projectId);
    }

    this.threadSummariesById.delete(normalizedThreadId);
    this.conversationsById.delete(normalizedThreadId);
    this.attachmentStateByThreadId.delete(normalizedThreadId);
    for (const listener of this.attachmentCallbacks.get(normalizedThreadId) ?? []) listener();
    this.childMembershipsByParentThreadId.delete(normalizedThreadId);
    this.followerAcceptedReplicasByConversationId.delete(normalizedThreadId);
    this.ownerHiddenLifecycleItemTypesByConversationId.delete(normalizedThreadId);
    this.primaryConversationRequestByThread.delete(normalizedThreadId);
    this.conversationVersionById.delete(normalizedThreadId);
    this.followerMembershipByConversationId.delete(normalizedThreadId);
    this.streamState.removeConversation(normalizedThreadId);
    this.ownerTextDeltaQueue.discardConversation(normalizedThreadId);
    this.outputDeltaQueue.discardConversation(normalizedThreadId);
    this.terminalInputBuffers.clearConversation(normalizedThreadId);
    this.discardDeferredOwnerRecoveryMessages(normalizedThreadId);
    this.discardOwnerNotificationState(normalizedThreadId);
    this.cancelOwnerStreamPublishQueues(
      normalizedThreadId,
      new Error(`Thread ${normalizedThreadId} was removed`),
    );
    this.ownerRollbackTombstonesByConversationId.delete(normalizedThreadId);
    this.queueOwnerProjectionFenceByConversationId.delete(normalizedThreadId);
    this.clearActiveGoalContinuationTimer(normalizedThreadId);
    this.activeGoalContinuationPromises.delete(normalizedThreadId);
    this.composerIntentsByThread.delete(normalizedThreadId);
    this.resyncInFlight.delete(normalizedThreadId);

    for (const [projectId, threads] of this.threadSummariesByProject.entries()) {
      const nextThreads = threads.filter((thread) => thread.threadId !== normalizedThreadId);
      if (nextThreads.length === threads.length) {
        continue;
      }

      changedProjectIds.add(projectId);
      this.threadSummariesByProject.set(projectId, nextThreads);
    }

    for (let index = this.recentConversationIds.length - 1; index >= 0; index -= 1) {
      if (this.recentConversationIds[index] === normalizedThreadId) {
        this.recentConversationIds.splice(index, 1);
      }
    }

    this.notifyConversationCallbacks(normalizedThreadId);
    this.notifyListeners(this.relationshipCallbacks.get(normalizedThreadId));
    for (const projectId of changedProjectIds) {
      this.notifyProjectThreadSummaries(projectId);
    }
    this.notifyAnyConversationCallbacks({ forceMeta: true });
  }

  private ensureProjectThreadSummariesLoaded(projectId: string): void {
    if (this.loadedThreadSummariesByProject.has(projectId)) {
      return;
    }

    if (this.threadSummaryLoadsInFlightByProject.has(projectId)) {
      return;
    }

    void this.loadThreads(projectId).catch(() => {});
  }

  private resolveInterruptTurnId(threadId: string, turnId?: string): string | null {
    if (typeof turnId === "string" && turnId.trim().length > 0) {
      return turnId;
    }

    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      return null;
    }

    for (let index = conversation.turns.length - 1; index >= 0; index -= 1) {
      const turn = conversation.turns[index];
      if (turn?.status === "inProgress") {
        return turn.turnId;
      }
    }

    return null;
  }

  private rememberOwnerRollbackTombstones(
    threadId: string,
    before: CodexConversationSnapshot,
    after: CodexConversationSnapshot,
  ): void {
    const liveIds = new Set<string>();
    for (const turn of after.turns) {
      if (turn.turnId) liveIds.add(turn.turnId);
      for (const itemId of turn.itemIds) {
        liveIds.add(itemId);
      }
      for (const item of turn.items) {
        liveIds.add(item.itemId);
      }
    }

    const tombstones =
      this.ownerRollbackTombstonesByConversationId.get(threadId) ?? new Set<string>();
    for (const turn of before.turns) {
      if (turn.turnId && !liveIds.has(turn.turnId)) {
        tombstones.add(turn.turnId);
      }
      for (const itemId of turn.itemIds) {
        if (!liveIds.has(itemId)) {
          tombstones.add(itemId);
        }
      }
      for (const item of turn.items) {
        if (!liveIds.has(item.itemId)) {
          tombstones.add(item.itemId);
        }
      }
    }

    if (tombstones.size > 0) {
      this.ownerRollbackTombstonesByConversationId.set(threadId, tombstones);
    }
  }

  private isOwnerRollbackTombstoned(
    threadId: string,
    ids: readonly (string | null | undefined)[],
  ): boolean {
    const tombstones = this.ownerRollbackTombstonesByConversationId.get(threadId);
    if (!tombstones) return false;

    return ids.some((id) => typeof id === "string" && tombstones.has(id));
  }

  private ackOwnerNotificationIfTombstoned(
    threadId: string,
    ids: readonly (string | null | undefined)[],
    sequence: number,
  ): boolean {
    if (!this.isOwnerRollbackTombstoned(threadId, ids)) return false;

    void this.ackOwnerNotification(threadId, sequence);
    return true;
  }

  private withNodexAgentAuthorizationPresentationOverlays(
    conversation: CodexConversationSnapshot,
  ): CodexConversationSnapshot {
    const canonicalRequests = conversation.requests.filter(
      (request) => request.type !== "nodexAgentAuthorization",
    );
    const presentationRequests = [...this.pendingNodexAgentAuthorizations.values()]
      .filter((pending) => pending.threadId === conversation.threadId)
      .map((pending) => pending.request);
    if (
      canonicalRequests.length === conversation.requests.length &&
      presentationRequests.length === 0
    ) {
      return conversation;
    }
    return {
      ...conversation,
      requests: [...canonicalRequests, ...presentationRequests],
    };
  }

  private applyConversationSnapshot(
    threadId: string,
    conversation: CodexConversationSnapshot,
    version?: number,
    notifyMode: ConversationNotifyMode = "default",
  ): void {
    if (typeof version === "number" && this.conversationVersionById.get(threadId) === version) {
      return;
    }

    const normalizedConversation = normalizeConversationSnapshot(conversation);
    const terminalTurnIds = new Set(
      normalizedConversation.turns
        .filter((turn) => turn.turnId !== null && turn.status !== "inProgress")
        .map((turn) => turn.turnId),
    );
    for (const [requestId, pending] of this.pendingNodexAgentAuthorizations) {
      if (pending.threadId !== threadId || !terminalTurnIds.has(pending.turnId)) continue;
      this.pendingNodexAgentAuthorizations.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({ decision: "deny" });
    }
    const nextConversation = this.withCachedConversationTitle(
      this.withNodexAgentAuthorizationPresentationOverlays(normalizedConversation),
    );
    const currentConversation = this.conversationsById.get(threadId);
    if (currentConversation === nextConversation) {
      return;
    }

    if (nextConversation.threadName?.trim()) {
      this.threadTitlesById.set(threadId, nextConversation.threadName);
    }

    this.conversationsById.set(threadId, nextConversation);
    const previousPrimaryRequest = this.primaryConversationRequestByThread.get(threadId) ?? null;
    const nextPrimaryRequest = selectPrimaryConversationRequest(nextConversation);
    this.primaryConversationRequestByThread.set(
      threadId,
      areConversationLiveRequestsEqual(previousPrimaryRequest, nextPrimaryRequest)
        ? previousPrimaryRequest
        : nextPrimaryRequest,
    );
    if (
      nextConversation.source?.sideConversation !== true &&
      !isCodexNotificationChildConversation({
        parentThreadId: null,
        source: nextConversation.source,
      })
    ) {
      this.ensureRecentConversationId(threadId);
    }
    if (isConversationStreaming(nextConversation)) {
      this.streamState.setStreaming(threadId, true);
    } else {
      this.streamState.setStreaming(threadId, false);
    }
    if (typeof version === "number") {
      this.conversationVersionById.set(threadId, version);
    }

    const existingSummary = this.threadSummariesById.get(threadId);
    const mergedSummary: CodexThreadSummary = {
      ...(existingSummary ?? nextConversation),
      ...nextConversation,
    };
    this.applyThreadSummary(mergedSummary);

    this.notifyConversationCallbacks(threadId, notifyMode);
  }

  private notifyConversationCallbacks(
    threadId: string,
    notifyMode: ConversationNotifyMode = "default",
  ): void {
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      return;
    }

    const callbacks = this.conversationCallbacks.get(threadId);
    const notifyConversation = () => {
      if (!callbacks) return;

      for (const callback of callbacks) {
        callback(conversation);
      }
    };

    if (notifyMode === "sync") {
      flushSync(notifyConversation);
    } else {
      notifyConversation();
    }

    const anySnapshot = buildConversationAnyProjection(conversation);
    const previousAnySnapshot = this.lastAnySnapshotById.get(threadId);
    const anyChanged =
      !previousAnySnapshot || !areConversationAnyProjectionsEqual(previousAnySnapshot, anySnapshot);
    this.lastAnySnapshotById.set(threadId, anySnapshot);

    const metaSnapshot = buildConversationMetaProjection(conversation);
    const previousMetaSnapshot = this.lastMetaSnapshotById.get(threadId);
    const metaChanged =
      !previousMetaSnapshot ||
      !areConversationMetaProjectionsEqual(previousMetaSnapshot, metaSnapshot);
    this.lastMetaSnapshotById.set(threadId, metaSnapshot);

    if (anyChanged || metaChanged) {
      this.notifyAnyConversationCallbacks({
        forceAny: anyChanged,
        forceMeta: metaChanged,
      });
    }
  }

  private notifyAnyConversationCallbacks({
    forceAny = false,
    forceMeta = false,
  }: {
    forceAny?: boolean;
    forceMeta?: boolean;
  } = {}): void {
    const conversations = this.readRecentConversations();
    const orderKey = buildRecentConversationOrderKey(conversations);
    const shouldNotifyAny = forceAny || orderKey !== this.lastAnyOrderKey;
    const shouldNotifyMeta = forceMeta || orderKey !== this.lastMetaOrderKey;

    if (shouldNotifyAny) {
      this.lastAnyOrderKey = orderKey;
      for (const callback of this.anyConversationCallbacks) {
        callback(conversations);
      }
    }

    if (shouldNotifyMeta) {
      this.lastMetaOrderKey = orderKey;
      for (const callback of this.anyConversationMetaCallbacks) {
        callback(conversations);
      }
    }
  }

  private notifyControlCallbacks(notifyMode: ConversationNotifyMode = "default"): void {
    const notify = () => {
      this.notifyListeners(this.controlCallbacks);
    };
    if (notifyMode === "sync") {
      flushSync(notify);
      return;
    }
    notify();
  }

  private notifyProjectThreadSummaries(projectId: string): void {
    this.notifyListeners(this.projectSummaryCallbacksByProject.get(projectId));
  }

  private notifyListeners<T extends StoreListener | ControlListener>(
    listeners: Set<T> | undefined,
  ): void {
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener();
    }
  }

  private ensureRecentConversationId(threadId: string): void {
    if (this.recentConversationIds.includes(threadId)) {
      return;
    }

    this.recentConversationIds.unshift(threadId);
  }
}

export class CodexAppServerManagerRegistry {
  private readonly managers = new Map<string, CodexAppServerManager>();
  private readonly callbacks = new Set<StoreListener>();

  addManager(manager: CodexAppServerManager): void {
    this.managers.set(manager.getHostId(), manager);
    this.notifyRegistryChanged();
  }

  addRegistryCallback(listener: StoreListener): () => void {
    return subscribeSet(this.callbacks, listener);
  }

  deleteManager(hostId: string): void {
    const manager = this.managers.get(hostId);
    if (!manager) {
      return;
    }

    manager.destroy();
    this.managers.delete(hostId);
    this.notifyRegistryChanged();
  }

  getAll(): CodexAppServerManager[] {
    return Array.from(this.managers.values());
  }

  getDefault(): CodexAppServerManager {
    return this.getForHostId(DEFAULT_CODEX_HOST_ID);
  }

  getForHostId(hostId: string): CodexAppServerManager {
    const existing = this.managers.get(hostId);
    if (existing) {
      return existing;
    }

    const manager = new CodexAppServerManager(hostId);
    this.managers.set(hostId, manager);
    this.notifyRegistryChanged();
    return manager;
  }

  getForConversationId(conversationId: string): CodexAppServerManager {
    const manager = this.getMaybeForConversationId(conversationId);
    if (manager) {
      return manager;
    }

    throw new Error(`No CodexAppServerManager registered for conversationId: ${conversationId}`);
  }

  getMaybeForConversationId(conversationId: string): CodexAppServerManager | null {
    for (const manager of this.managers.values()) {
      if (manager.readConversation(conversationId) || manager.readThreadSummary(conversationId)) {
        return manager;
      }
    }

    return null;
  }

  notifyRegistryChanged(): void {
    for (const callback of this.callbacks) {
      callback();
    }
  }

  resetForTests(): void {
    for (const manager of this.managers.values()) {
      manager.resetForTests();
      manager.destroy();
    }
    this.managers.clear();
    this.callbacks.clear();
  }
}

const codexAppServerRegistry = new CodexAppServerManagerRegistry();

function getDefaultLocalConversationManager(): CodexAppServerManager {
  return codexAppServerRegistry.getDefault();
}

let rendererClientRequestBridgeRefCount = 0;
let unsubscribeRendererClientRequests: (() => void) | null = null;
let rendererClientRequestManager: CodexAppServerManager | null = null;

function isCodexThreadOwnerActionRequest(value: unknown): value is CodexThreadOwnerActionRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function isCodexRendererThreadRoleRequest(value: unknown): value is CodexRendererThreadRoleRequest {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { conversationId?: unknown }).conversationId === "string"
  );
}

function isNodexAgentAuthorizationRequest(value: unknown): value is NodexAgentAuthorizationRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<NodexAgentAuthorizationRequest>;
  const preview = request.preview;
  if (typeof preview !== "object" || preview === null) return false;
  if (
    typeof preview.title !== "string" ||
    typeof preview.summary !== "string" ||
    !Array.isArray(preview.details) ||
    !preview.details.every(
      (detail) =>
        typeof detail === "object" &&
        detail !== null &&
        typeof detail.label === "string" &&
        typeof detail.value === "string",
    ) ||
    (preview.nfmPreview !== undefined && typeof preview.nfmPreview !== "string") ||
    (preview.markdownPreview !== undefined && typeof preview.markdownPreview !== "string")
  ) {
    return false;
  }
  return (
    request.type === "nodexAgentAuthorization" &&
    typeof request.requestId === "string" &&
    typeof request.threadId === "string" &&
    typeof request.turnId === "string" &&
    typeof request.itemId === "string" &&
    typeof request.projectId === "string" &&
    (request.tool === "create" ||
      request.tool === "edit_document" ||
      request.tool === "transfer_blocks" ||
      request.tool === "edit_database" ||
      request.tool === "create_pages" ||
      request.tool === "update_page" ||
      request.tool === "advanced_update_page" ||
      request.tool === "move_pages" ||
      request.tool === "duplicate_page") &&
    (request.effect === "write" || request.effect === "destructive") &&
    typeof request.createdAt === "number" &&
    Number.isFinite(request.createdAt)
  );
}

async function buildRendererClientResponse(
  manager: CodexAppServerManager,
  message: CodexRendererClientRequestMessage,
): Promise<CodexRendererClientResponseMessage> {
  try {
    if (message.method === "thread-role") {
      if (!isCodexRendererThreadRoleRequest(message.params)) {
        throw new Error("Invalid thread role request");
      }

      return {
        type: "success",
        requestId: message.requestId,
        result: manager.getThreadRoleForRendererClientRequest(message.params.conversationId),
      };
    }

    if (message.method === NODEX_AGENT_AUTHORIZATION_RENDERER_METHOD) {
      if (!isNodexAgentAuthorizationRequest(message.params)) {
        throw new Error("Invalid Nodex authorization request");
      }
      return {
        type: "success",
        requestId: message.requestId,
        result: await manager.requestNodexAgentAuthorization(message.params),
      };
    }

    if (message.method === CODEX_QUEUE_OWNER_UPDATE_METHOD) {
      if (!isCodexQueueOwnerUpdateRequest(message.params)) {
        throw new Error("Invalid Main queue owner update");
      }
      return {
        type: "success",
        requestId: message.requestId,
        result: await manager.applyQueueOwnerUpdate(message.params),
      };
    }

    if (message.method !== "thread-owner-action") {
      throw new Error(`Unsupported renderer client request method ${message.method}`);
    }
    if (!isCodexThreadOwnerActionRequest(message.params)) {
      throw new Error("Invalid thread owner action request");
    }

    const result = await manager.handleThreadOwnerActionRequest(message.params);
    return {
      type: "success",
      requestId: message.requestId,
      result,
    };
  } catch (error) {
    return {
      type: "error",
      requestId: message.requestId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function startLocalConversationRendererClientRequestBridge(
  manager: CodexAppServerManager,
): () => void {
  rendererClientRequestBridgeRefCount += 1;
  rendererClientRequestManager = manager;
  if (!unsubscribeRendererClientRequests) {
    unsubscribeRendererClientRequests = subscribeCodexRendererClientRequests((message) => {
      const activeManager = rendererClientRequestManager;
      if (!activeManager) return;

      void (async () => {
        const response = await buildRendererClientResponse(activeManager, message);
        await runConversationOperation("codex:renderer-client:response", response);
      })();
    });
  }

  return () => {
    rendererClientRequestBridgeRefCount = Math.max(0, rendererClientRequestBridgeRefCount - 1);
    if (rendererClientRequestBridgeRefCount > 0) return;

    rendererClientRequestManager?.cancelPendingNodexAgentAuthorizations();
    rendererClientRequestManager = null;
    unsubscribeRendererClientRequests?.();
    unsubscribeRendererClientRequests = null;
  };
}

const CodexAppServerRegistryContext =
  createContext<CodexAppServerManagerRegistry>(codexAppServerRegistry);

export function LocalConversationProvider({
  children,
  hostId = DEFAULT_CODEX_HOST_ID,
}: {
  children: ReactNode;
  hostId?: string;
}) {
  const registry = codexAppServerRegistry;
  const manager = useMemo(() => registry.getForHostId(hostId), [hostId, registry]);

  useEffect(() => {
    const stopHostBridge = startLocalConversationHostBridge();
    const stopRendererClientRequestBridge =
      startLocalConversationRendererClientRequestBridge(manager);
    manager.start();
    return () => {
      stopRendererClientRequestBridge();
      stopHostBridge();
    };
  }, [manager]);

  return createElement(CodexAppServerRegistryContext.Provider, { value: registry }, children);
}

export function useCodexAppServerRegistry(): CodexAppServerManagerRegistry {
  const registry = useContext(CodexAppServerRegistryContext);
  return useExternalSelector(
    (listener) => registry.addRegistryCallback(listener),
    () => registry,
  );
}

export function useDefaultCodexAppServerManager(): CodexAppServerManager {
  const registry = useCodexAppServerRegistry();
  return useExternalSelector(
    (listener) => registry.addRegistryCallback(listener),
    () => registry.getDefault(),
  );
}

function useExternalSelector<T>(
  subscribe: (listener: StoreListener) => () => void,
  getSnapshot: () => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const cacheRef = useRef<{ hasValue: boolean; value: T }>({
    hasValue: false,
    value: undefined as T,
  });

  return useSyncExternalStore(subscribe, () => {
    const nextValue = getSnapshot();
    if (cacheRef.current.hasValue && isEqual(cacheRef.current.value, nextValue)) {
      return cacheRef.current.value;
    }

    cacheRef.current = {
      hasValue: true,
      value: nextValue,
    };
    return nextValue;
  });
}

export function useMaybeCodexAppServerManagerForConversationId(
  conversationId: string | null,
): CodexAppServerManager | null {
  const registry = useCodexAppServerRegistry();
  return useExternalSelector(
    (listener) => {
      if (!conversationId) {
        return () => {};
      }

      const managerUnsubscribers = new Map<string, () => void>();
      const bindManagers = () => {
        const managers = registry.getAll();
        const nextHostIds = new Set(managers.map((manager) => manager.getHostId()));
        for (const [hostId, unsubscribe] of managerUnsubscribers.entries()) {
          if (!nextHostIds.has(hostId)) {
            unsubscribe();
            managerUnsubscribers.delete(hostId);
          }
        }

        for (const manager of managers) {
          const hostId = manager.getHostId();
          if (managerUnsubscribers.has(hostId)) {
            continue;
          }

          const unsubscribeConversation = manager.addConversationCallback(conversationId, () => {
            listener();
          });
          const unsubscribeMeta = manager.addAnyConversationMetaCallback(() => {
            listener();
          });
          managerUnsubscribers.set(hostId, () => {
            unsubscribeConversation();
            unsubscribeMeta();
          });
        }
      };

      bindManagers();
      const unsubscribeRegistry = registry.addRegistryCallback(() => {
        bindManagers();
        listener();
      });

      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of managerUnsubscribers.values()) {
          unsubscribe();
        }
      };
    },
    () => {
      if (!conversationId) {
        return null;
      }

      return registry.getMaybeForConversationId(conversationId);
    },
  );
}

export function useCodexAppServerManagerForConversationId(
  conversationId: string | null,
): CodexAppServerManager {
  const manager = useMaybeCodexAppServerManagerForConversationId(conversationId);
  const defaultManager = useDefaultCodexAppServerManager();
  return manager ?? defaultManager;
}

export function useCodexConversationValue<T>(
  conversationId: string | null,
  selector: (conversation: CodexConversationSnapshot | null) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const manager = useCodexAppServerManagerForConversationId(conversationId);
  return useExternalSelector(
    (listener) =>
      conversationId
        ? manager.addConversationCallback(conversationId, () => {
            listener();
          })
        : () => {},
    () => selector(conversationId ? manager.readConversation(conversationId) : null),
    isEqual,
  );
}

function useManagerControlSelection<T>(
  selector: (manager: CodexAppServerManager) => T,
  isEqual: (left: T, right: T) => boolean = Object.is,
): T {
  const manager = useDefaultCodexAppServerManager();
  return useExternalSelector(
    (listener) => manager.subscribeControl(listener),
    () => selector(manager),
    isEqual,
  );
}

function areModelsEqual(left: CodexModelOption[], right: CodexModelOption[]): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function areThreadStartProgressStatesEqual(
  left: CodexThreadStartProgressState | undefined | null,
  right: CodexThreadStartProgressState | undefined | null,
): boolean {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return (
    left.projectId === right.projectId &&
    left.sessionId === right.sessionId &&
    left.runInTarget === right.runInTarget &&
    left.threadId === right.threadId &&
    left.phase === right.phase &&
    left.message === right.message &&
    left.outputText === right.outputText &&
    left.outputCarriageReturnPending === right.outputCarriageReturnPending &&
    left.outputTruncated === right.outputTruncated &&
    left.rendererLaunchPending === right.rendererLaunchPending &&
    left.updatedAt === right.updatedAt
  );
}

export function hydrateLocalConversationThreadSummaries(
  projectId: string,
  threads: CodexThreadSummary[],
): void {
  getDefaultLocalConversationManager().hydrateThreadSummaries(projectId, threads);
}

export function requestLocalConversationSnapshot(
  threadId: string,
): Promise<CodexConversationSnapshot | null> {
  return getDefaultLocalConversationManager().requestThreadStreamSnapshot(threadId);
}

export function requestLocalConversationResume(
  threadId: string,
): Promise<CodexConversationSnapshot | null> {
  return getDefaultLocalConversationManager().requestThreadStreamResume(threadId);
}

export function markLocalConversationAsRead(threadId: string): Promise<void> {
  return getDefaultLocalConversationManager().markConversationAsRead(threadId);
}

export function setLocalConversationThreadViewActive(
  threadId: string,
  active: boolean,
): Promise<boolean> {
  return getDefaultLocalConversationManager().setThreadViewActive(threadId, active);
}

export function setLocalConversationThreadPresented(
  threadId: string,
  surfaceId: string,
  presented: boolean,
): Promise<boolean> {
  return getDefaultLocalConversationManager().setThreadPresented(threadId, surfaceId, presented);
}

export function requestLocalConversationHistoryPage(
  request: CodexConversationHistoryPageRequest,
): Promise<CodexConversationHistoryPageResult> {
  return getDefaultLocalConversationManager().requestHistoryPage(request);
}

export function publishLocalConversationHistoryMutation(
  threadId: string,
  mutation: CodexConversationHistoryMutation,
): Promise<number> {
  return getDefaultLocalConversationManager().publishLocalConversationHistoryMutation(
    threadId,
    mutation,
  );
}

export function setLocalConversationHistoryResidencyPins(
  pins: CodexHistoryResidencyPinsInput,
): Promise<CodexHistoryResidencyPinsResult> {
  return getDefaultLocalConversationManager().setHistoryResidencyPins(pins);
}

export function hydrateLocalPersistedHistoryOccurrence(
  input: CodexPersistedHistoryOccurrenceHydrateInput,
): Promise<CodexPersistedHistoryOccurrenceResolution> {
  return getDefaultLocalConversationManager().hydratePersistedHistoryOccurrence(input);
}

export function setLocalConversationComposerIntent(
  threadId: string,
  composerIntent: CodexComposerIntent,
): void {
  getDefaultLocalConversationManager().setComposerIntent(threadId, composerIntent);
}

export function consumeLocalConversationComposerIntent(threadId: string, focusNonce: number): void {
  getDefaultLocalConversationManager().consumeComposerIntent(threadId, focusNonce);
}

export function removeLocalConversationPlanImplementationRequest(
  threadId: string,
  turnId: string,
): Promise<boolean> {
  return getDefaultLocalConversationManager().removePlanImplementationRequest(threadId, turnId);
}

export function setLocalConversationCollaborationMode(
  threadId: string,
  mode: CodexCollaborationModeKind,
): Promise<CodexCollaborationModeState> {
  return getDefaultLocalConversationManager().setLatestCollaborationModeForConversation(
    threadId,
    mode,
  );
}

export function readLocalConversation(threadId: string): CodexConversationSnapshot | null {
  return getDefaultLocalConversationManager().readConversation(threadId);
}

export function __resetLocalConversationStoreForTests(): void {
  codexAppServerRegistry.resetForTests();
  rendererClientRequestBridgeRefCount = 0;
  rendererClientRequestManager = null;
  unsubscribeRendererClientRequests?.();
  unsubscribeRendererClientRequests = null;
  __resetLocalConversationHostBridgeForTests();
  __resetCodexAppServerMessageBusForTests();
}

export function useProjectThreadSummaries(projectId: string | null): CodexThreadSummary[] {
  const manager = useDefaultCodexAppServerManager();
  return useExternalSelector(
    (listener) => {
      if (projectId === null) return () => undefined;
      return manager.subscribeProjectThreadSummaries(projectId, listener);
    },
    () => {
      if (projectId === null) return EMPTY_THREADS;
      return manager.readProjectThreadSummaries(projectId);
    },
  );
}

export function useConversation(threadId: string | null): CodexConversationSnapshot | null {
  return useCodexConversationValue(threadId, (conversation) => conversation);
}

export function useConversationSummaryFields(threadId: string | null): ConversationSummaryFields {
  return useCodexConversationValue(
    threadId,
    (conversation) => {
      if (!conversation) {
        return EMPTY_CONVERSATION_SUMMARY_FIELDS;
      }

      return {
        threadId: conversation.threadId,
        projectId: conversation.projectId,
        threadName: conversation.threadName,
        threadPreview: conversation.threadPreview,
        cwd: conversation.cwd,
        managedWorktreePath: conversation.managedWorktreePath ?? null,
        projectlessOutputDirectory: conversation.projectlessOutputDirectory ?? null,
        projectlessWorkspaceBrowserRoot: conversation.projectlessWorkspaceBrowserRoot ?? null,
        archived: conversation.archived,
        hasUnreadTurn: conversation.hasUnreadTurn ?? false,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        linkedAt: conversation.linkedAt,
      };
    },
    areConversationSummaryFieldsEqual,
  );
}

export function useConversationTurns(threadId: string | null): CodexConversationTurn[] {
  return useCodexConversationValue(threadId, (conversation) => conversation?.turns ?? EMPTY_TURNS);
}

export function useConversationRequests(threadId: string | null): CodexConversationServerRequest[] {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.requests ?? EMPTY_REQUESTS,
  );
}

export function useConversationCwd(threadId: string | null): string | null {
  return useCodexConversationValue(threadId, (conversation) => conversation?.cwd ?? null);
}

export function useConversationResumeState(
  threadId: string | null,
): CodexConversationResumeState | null {
  return useCodexConversationValue(threadId, (conversation) => conversation?.resumeState ?? null);
}

export function useConversationAttachmentState(
  threadId: string | null,
): LocalConversationAttachmentState {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  return useExternalSelector(
    (listener) =>
      threadId ? manager.subscribeConversationAttachment(threadId, listener) : () => {},
    () =>
      threadId
        ? manager.readConversationAttachmentState(threadId)
        : IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE,
    areLocalConversationAttachmentStatesEqual,
  );
}

export function useConversationStreamRole(
  threadId: string | null,
): LocalConversationStreamRole["role"] | null {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  return useExternalSelector(
    (listener) => (threadId ? manager.addConversationCallback(threadId, listener) : () => {}),
    () => (threadId ? manager.readConversationStreamRole(threadId) : null),
  );
}

export function useConversationStatusType(
  threadId: string | null,
): CodexConversationSnapshot["statusType"] | null {
  return useCodexConversationValue(threadId, (conversation) => conversation?.statusType ?? null);
}

export function useConversationStatusActiveFlags(
  threadId: string | null,
): CodexConversationSnapshot["statusActiveFlags"] {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.statusActiveFlags ?? EMPTY_STATUS_ACTIVE_FLAGS,
  );
}

export function useConversationCapabilityFlags(
  threadId: string | null,
): CodexConversationCapabilityFlags {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.capabilityFlags ?? EMPTY_CONVERSATION_CAPABILITY_FLAGS,
  );
}

export function useConversationChildMemberships(
  threadId: string | null,
): CodexConversationChildMembership[] {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  return useExternalSelector(
    (listener) =>
      threadId ? manager.subscribeConversationChildMemberships(threadId, listener) : () => {},
    () => (threadId ? manager.readConversationChildMemberships(threadId) : EMPTY_CHILD_MEMBERSHIPS),
  );
}

export function useConversationPendingSteers(threadId: string | null): CodexPendingSteer[] {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.pendingSteers ?? EMPTY_PENDING_STEERS,
  );
}

export function useConversationQueuedFollowUps(
  threadId: string | null,
): readonly CodexQueuedFollowUp[] {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.queuedFollowUps.entries ?? EMPTY_QUEUED_FOLLOW_UPS,
  );
}

export function useConversationBackgroundTerminalRows(
  threadId: string | null,
): CodexBackgroundTerminalRow[] {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.backgroundTerminalRows ?? EMPTY_BACKGROUND_TERMINAL_ROWS,
  );
}

export function useConversationSource(threadId: string | null): CodexConversationSource | null {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.source ?? null,
    (left, right) => left?.parentThreadId === right?.parentThreadId,
  );
}

export function useConversationParentThreadId(threadId: string | null): string | null {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.source?.parentThreadId ?? null,
  );
}

export function useConversationPrimaryRequest(
  threadId: string | null,
): CodexConversationLiveRequest | null {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  return useExternalSelector(
    (listener) =>
      threadId
        ? manager.addConversationCallback(threadId, () => {
            listener();
          })
        : () => {},
    () => (threadId ? manager.readPrimaryConversationRequest(threadId) : null),
    areConversationLiveRequestsEqual,
  );
}

export function useConversationCollaborationMode(
  threadId: string | null,
): CodexCollaborationModeState | null {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.latestCollaborationMode ?? null,
  );
}

export function useConversationThreadSettings(
  threadId: string | null,
): CodexConversationThreadSettings | null {
  return useCodexConversationValue(
    threadId,
    (conversation) => conversation?.latestThreadSettings ?? null,
  );
}

export function useConversationSubset(
  threadIds: readonly string[],
): Record<string, CodexConversationSnapshot> {
  const registry = useCodexAppServerRegistry();
  return useExternalSelector(
    (listener) => {
      if (threadIds.length === 0) {
        return () => {};
      }

      const unsubs = threadIds.map((threadId) => {
        const manager = registry.getMaybeForConversationId(threadId) ?? registry.getDefault();
        return manager.addConversationCallback(threadId, () => {
          listener();
        });
      });

      const unsubscribeRegistry = registry.addRegistryCallback(listener);
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of unsubs) {
          unsubscribe();
        }
      };
    },
    () => {
      if (threadIds.length === 0) {
        return EMPTY_CONVERSATION_MAP;
      }

      let hasConversation = false;
      const conversations: Record<string, CodexConversationSnapshot> = {};
      for (const threadId of threadIds) {
        const manager = registry.getMaybeForConversationId(threadId) ?? registry.getDefault();
        const conversation = manager.readConversation(threadId);
        if (!conversation) {
          continue;
        }

        conversations[threadId] = conversation;
        hasConversation = true;
      }

      return hasConversation ? conversations : EMPTY_CONVERSATION_MAP;
    },
    areConversationMapSelectionsEqual,
  );
}

export function useThreadSummarySubset(
  anchorConversationId: string,
  threadIds: readonly string[],
): Record<string, CodexThreadSummary> {
  const manager = useCodexAppServerManagerForConversationId(anchorConversationId);
  return useExternalSelector(
    (listener) => manager.addAnyConversationMetaCallback(listener),
    () => {
      if (threadIds.length === 0) return EMPTY_THREAD_SUMMARY_MAP;
      const summaries: Record<string, CodexThreadSummary> = {};
      for (const threadId of threadIds) {
        const summary = manager.readThreadSummary(threadId);
        if (summary) summaries[threadId] = summary;
      }
      return Object.keys(summaries).length > 0 ? summaries : EMPTY_THREAD_SUMMARY_MAP;
    },
    areThreadSummaryMapSelectionsEqual,
  );
}

export function useComposerIntent(threadId: string | null): CodexComposerIntent | null {
  const manager = useCodexAppServerManagerForConversationId(threadId);
  return useExternalSelector(
    (listener) =>
      threadId
        ? manager.addConversationCallback(threadId, () => {
            listener();
          })
        : () => {},
    () => (threadId ? manager.readComposerIntent(threadId) : null),
  );
}

export function useLocalConversationConnection(): CodexConnectionState {
  const manager = useDefaultCodexAppServerManager();
  return useExternalSelector(
    (listener) => manager.subscribeConnection(listener),
    () => manager.readConnection(),
  );
}

export function useLocalConversationAccount(): CodexAccountSnapshot | null {
  const manager = useDefaultCodexAppServerManager();
  return useExternalSelector(
    (listener) => manager.subscribeAccount(listener),
    () => manager.readAccount(),
  );
}

export function useCodexAvailableModels(): CodexModelOption[] {
  return useManagerControlSelection((manager) => manager.readAvailableModels(), areModelsEqual);
}

export function useCodexDictationState(): CodexDictationStateSnapshot {
  return useManagerControlSelection(
    (manager) => manager.readDictationState(),
    (left, right) =>
      left.isEnabled === right.isEnabled &&
      left.authMethod === right.authMethod &&
      left.shortcutLabel === right.shortcutLabel &&
      areDictationCapabilitiesEqual(left.capabilities, right.capabilities),
  );
}

export function useCodexPermissionMode(projectId: string | null): CodexPermissionMode {
  return useCodexPermissionState(projectId).mode;
}

export function useCodexPermissionState(projectId: string | null): CodexPermissionState {
  const manager = useDefaultCodexAppServerManager();
  useEffect(() => {
    void manager.loadPermissionState(projectId).catch(() => {
      // main-process authority will retry on the next interaction
    });
  }, [manager, projectId]);

  return useManagerControlSelection(
    (managed) => managed.readPermissionState(projectId),
    arePermissionStatesEqual,
  );
}

export function useCodexLastHostError(): CodexHostErrorState | null {
  return useManagerControlSelection((manager) => manager.readLastHostError());
}

export function useCodexThreadStartProgress(
  projectId: string | null,
  sessionId: string | null,
): Omit<CodexThreadStartProgressState, "outputCarriageReturnPending"> | null {
  return useManagerControlSelection(
    (manager) => {
      if (!sessionId) return null;

      const progress = manager.readThreadStartProgress(projectId, sessionId);
      if (!progress) {
        return null;
      }

      return {
        projectId: progress.projectId,
        sessionId: progress.sessionId,
        runInTarget: progress.runInTarget,
        threadId: progress.threadId,
        phase: progress.phase,
        message: progress.message,
        outputText: progress.outputText,
        outputTruncated: progress.outputTruncated,
        rendererLaunchPending: progress.rendererLaunchPending,
        updatedAt: progress.updatedAt,
      };
    },
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
  );
}

export function useCodexAppServerControl(activeProjectId: string | null) {
  const manager = useDefaultCodexAppServerManager();
  const availableModels = useCodexAvailableModels();
  const permissionState = useCodexPermissionState(activeProjectId);
  const permissionMode = permissionState.mode;
  const { settings: storedThreadSettings, updateSettings: updateStoredThreadSettings } =
    useCodexThreadSettings();
  const { serviceTierSettings, setServiceTier } = useCodexServiceTierSettings();
  const [personality, setPersonalityState] = useState<CodexPersonality>("friendly");
  const personalityIntentVersion = useRef(0);

  useEffect(() => {
    let disposed = false;
    const observedIntentVersion = personalityIntentVersion.current;
    void runConversationOperation("codex:personality:get")
      .then((value) => {
        if (disposed || personalityIntentVersion.current !== observedIntentVersion) return;
        if (value === "none" || value === "friendly" || value === "pragmatic") {
          setPersonalityState(value);
        }
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  const threadSettings = useMemo(
    () => resolveCodexThreadSettings(storedThreadSettings, availableModels),
    [availableModels, storedThreadSettings],
  );
  const executionProfile = useMemo(
    () =>
      threadSettings.model
        ? {
            modelId: threadSettings.model,
            reasoningEffort: threadSettings.reasoningEffort,
            serviceTier: serviceTierSettings.serviceTier,
          }
        : null,
    [serviceTierSettings.serviceTier, threadSettings.model, threadSettings.reasoningEffort],
  );
  const setExecutionProfile = useCallback(
    (profile: NonNullable<typeof executionProfile>) => {
      updateStoredThreadSettings({
        model: profile.modelId,
        reasoningEffort: profile.reasoningEffort ?? threadSettings.reasoningEffort,
      });
      setServiceTier(profile.serviceTier, "composer_menu");
    },
    [setServiceTier, threadSettings.reasoningEffort, updateStoredThreadSettings],
  );
  const reasoningEffortOptions = useMemo<CodexReasoningEffortOption[]>(
    () => [...resolveCodexReasoningEffortOptions(threadSettings.model, availableModels)],
    [availableModels, threadSettings.model],
  );

  const loadThreads = useCallback(
    async (projectId: string, opts?: { includeArchived?: boolean }) =>
      manager.loadThreads(projectId, opts),
    [manager],
  );
  const loadModels = useCallback(async () => manager.loadAvailableModels(), [manager]);
  const listCollaborationModes = useCallback(
    async () => manager.listCollaborationModes(),
    [manager],
  );
  const requestThreadStreamSnapshot = useCallback(
    async (threadId: string) => manager.requestThreadStreamSnapshot(threadId),
    [manager],
  );
  const readSubagentOverview = useCallback(
    async (input: CodexSubagentOverviewReadInput) => manager.readSubagentOverview(input),
    [manager],
  );
  const hydrateSelectedSubagent = useCallback(
    async (input: CodexSelectedSubagentHydrateInput) => manager.hydrateSelectedSubagent(input),
    [manager],
  );
  const refreshSelectedSubagentAuthority = useCallback(
    async (input: CodexSelectedSubagentHydrateInput) =>
      manager.refreshSelectedSubagentAuthority(input),
    [manager],
  );

  const startThreadForSession = useCallback(
    async (
      input: CodexThreadStartForSessionInput & {
        collaborationMode?: CodexCollaborationModeKind;
      },
    ) => {
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const requestSettings = resolveCodexDraftRequestSettings(input, resolvedSettings);
      const effectiveServiceTier = resolveCodexRequestServiceTier(
        input,
        serviceTierSettings.serviceTier,
      );
      const result = await manager.startThreadForSession({
        ...input,
        ...requestSettings,
        ...buildCodexServiceTierRequestOverride(effectiveServiceTier),
        executionProfile: input.executionProfile ?? executionProfile ?? undefined,
      });
      if (result.kind === "started" && input.projectId !== null) {
        await manager.loadThreads(input.projectId);
      }
      return result;
    },
    [
      availableModels,
      executionProfile,
      manager,
      serviceTierSettings.serviceTier,
      storedThreadSettings,
    ],
  );

  const startSideChat = useCallback(
    async (input: CodexSideChatStartInput) => {
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const requestSettings = resolveCodexDraftRequestSettings(input, resolvedSettings);
      const effectiveServiceTier = resolveCodexRequestServiceTier(
        input,
        serviceTierSettings.serviceTier,
      );
      return manager.startSideChat({
        ...input,
        ...requestSettings,
        ...buildCodexServiceTierRequestOverride(effectiveServiceTier),
      });
    },
    [availableModels, manager, serviceTierSettings.serviceTier, storedThreadSettings],
  );

  const discardSideChat = useCallback(
    async (threadId: string) => manager.discardSideChat(threadId),
    [manager],
  );

  const setThreadName = useCallback(
    async (threadId: string, name: string, projectId: string) =>
      manager.setThreadName(threadId, name, projectId),
    [manager],
  );
  const archiveThread = useCallback(
    async (threadId: string, projectId: string | null) =>
      manager.archiveThread(threadId, projectId),
    [manager],
  );
  const unarchiveThread = useCallback(
    async (threadId: string, projectId: string | null) =>
      manager.unarchiveThread(threadId, projectId),
    [manager],
  );

  const startTurn = useCallback(
    async (
      threadId: string,
      prompt: string,
      opts?: {
        projectId?: string;
        collaborationMode?: CodexCollaborationModeKind;
        model?: string;
        reasoningEffort?: CodexReasoningEffort;
        serviceTier?: CodexServiceTier;
        promptInput?: CodexTurnStartOptions["promptInput"];
      },
    ) => {
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      await manager.loadPermissionState(resolvedProjectId);
      const turnOpts: CodexTurnStartOptions = {
        permissionMode: manager.readPermissionMode(resolvedProjectId),
        collaborationMode: opts?.collaborationMode,
        model: opts?.model,
        reasoningEffort: opts?.reasoningEffort,
        ...(opts?.promptInput ? { promptInput: opts.promptInput } : {}),
        ...buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
      };
      return manager.startTurn(threadId, prompt, turnOpts);
    },
    [activeProjectId, manager],
  );

  const resumeInterruptedTurn = useCallback(
    async (threadId: string, opts?: { projectId?: string }) => {
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      await manager.loadPermissionState(resolvedProjectId);
      return await manager.resumeInterruptedTurn(threadId, {
        permissionMode: manager.readPermissionMode(resolvedProjectId),
      });
    },
    [activeProjectId, manager],
  );

  const enqueueQueuedFollowUp = useCallback(
    async (
      threadId: string,
      prompt: string,
      opts?: {
        projectId?: string;
        collaborationMode?: CodexCollaborationModeKind | null;
        serviceTier?: CodexServiceTier;
        promptInput?: CodexTurnStartOptions["promptInput"];
      },
    ) => {
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      await manager.loadPermissionState(resolvedProjectId);
      const turnOpts: CodexTurnStartOptions = {
        permissionMode: manager.readPermissionMode(resolvedProjectId),
        collaborationMode: opts?.collaborationMode ?? undefined,
        ...(opts?.promptInput ? { promptInput: opts.promptInput } : {}),
        ...buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
      };
      await manager.enqueueQueuedFollowUp(threadId, prompt, turnOpts);
    },
    [activeProjectId, manager],
  );

  const removeQueuedFollowUp = useCallback(
    async (threadId: string, followUpId: string) =>
      manager.removeQueuedFollowUp(threadId, followUpId),
    [manager],
  );
  const replaceQueuedFollowUp = useCallback(
    async (
      threadId: string,
      followUpId: string,
      expectedLedgerRevision: number,
      prompt: string,
      opts?: CodexTurnStartOptions,
    ) => manager.replaceQueuedFollowUp(threadId, followUpId, expectedLedgerRevision, prompt, opts),
    [manager],
  );
  const reorderQueuedFollowUps = useCallback(
    async (threadId: string, orderedFollowUpIds: string[]) =>
      manager.reorderQueuedFollowUps(threadId, orderedFollowUpIds),
    [manager],
  );
  const resumeQueuedFollowUps = useCallback(
    async (threadId: string) => manager.resumeQueuedFollowUps(threadId),
    [manager],
  );
  const resolveQueuedFollowUpsAfterFreshStart = useCallback(
    async (threadId: string, expectedLedgerRevision: number, resolution: "resume" | "clear") =>
      manager.resolveQueuedFollowUpsAfterFreshStart(threadId, expectedLedgerRevision, resolution),
    [manager],
  );
  const sendQueuedFollowUpNow = useCallback(
    async (threadId: string, followUpId: string) =>
      manager.sendQueuedFollowUpNow(threadId, followUpId),
    [manager],
  );
  const editLastUserTurn = useCallback(
    async (
      threadId: string,
      turnId: string,
      message: string,
      opts?: { serviceTier?: CodexServiceTier },
    ) => {
      return manager.editLastUserTurn(
        threadId,
        turnId,
        message,
        buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
      );
    },
    [manager],
  );
  const forkConversationFromTurn = useCallback(
    async (threadId: string, turnId: string, message: string) =>
      manager.forkConversationFromTurn(threadId, turnId, message),
    [manager],
  );
  const compactThread = useCallback(
    async (threadId: string) => manager.compactThread(threadId),
    [manager],
  );
  const getThreadGoal = useCallback(
    async (threadId: string) => manager.getThreadGoal(threadId),
    [manager],
  );
  const setThreadGoal = useCallback(
    async (input: CodexThreadGoalSetActionInput) => manager.setThreadGoal(input),
    [manager],
  );
  const clearThreadGoal = useCallback(
    async (threadId: string) => manager.clearThreadGoal(threadId),
    [manager],
  );
  const dismissThreadGoalResumeConfirmation = useCallback(
    async (threadId: string) => manager.dismissThreadGoalResumeConfirmation(threadId),
    [manager],
  );
  const setThreadMemoryMode = useCallback(
    async (input: { threadId: string; mode: ThreadMemoryMode }) =>
      manager.setThreadMemoryMode(input),
    [manager],
  );
  const uploadFeedback = useCallback(
    async (params: FeedbackUploadParams) => manager.uploadFeedback(params),
    [manager],
  );
  const cleanBackgroundTerminals = useCallback(
    async (threadId: string) => manager.cleanBackgroundTerminals(threadId),
    [manager],
  );
  const listBackgroundTerminals = useCallback(
    async (threadId: string) => manager.listBackgroundTerminals(threadId),
    [manager],
  );
  const listBackgroundProcesses = useCallback(
    async (threadId: string) => manager.listBackgroundProcesses(threadId),
    [manager],
  );
  const runBackgroundProcess = useCallback(
    async (input: CodexBackgroundProcessRunActionInput) => manager.runBackgroundProcess(input),
    [manager],
  );
  const stopBackgroundProcess = useCallback(
    async (input: {
      threadId: string;
      processId: string | null;
      terminalSessionId: string | null;
    }) => manager.stopBackgroundProcess(input),
    [manager],
  );
  const terminateBackgroundTerminal = useCallback(
    async (input: { threadId: string; processId: string }) =>
      manager.terminateBackgroundTerminal(input),
    [manager],
  );
  const setComposerIntent = useCallback(
    (threadId: string, composerIntent: CodexComposerIntent) =>
      manager.setComposerIntent(threadId, composerIntent),
    [manager],
  );
  const consumeComposerIntent = useCallback(
    (threadId: string, focusNonce: number) => manager.consumeComposerIntent(threadId, focusNonce),
    [manager],
  );
  const setConversationCollaborationMode = useCallback(
    async (threadId: string, mode: CodexCollaborationModeKind) =>
      manager.setLatestCollaborationModeForConversation(threadId, mode),
    [manager],
  );
  const setConversationThreadSettings = useCallback(
    async (threadId: string, patch: CodexConversationThreadSettingsPatch) =>
      manager.setThreadSettingsForConversation(threadId, patch),
    [manager],
  );
  const setPersonality = useCallback(async (nextPersonality: CodexPersonality) => {
    const intentVersion = personalityIntentVersion.current + 1;
    personalityIntentVersion.current = intentVersion;
    let previousPersonality: CodexPersonality = "friendly";
    setPersonalityState((current) => {
      previousPersonality = current;
      return nextPersonality;
    });
    try {
      await runConversationOperation("codex:personality:set", nextPersonality);
    } catch (error) {
      if (personalityIntentVersion.current === intentVersion) {
        setPersonalityState(previousPersonality);
      }
      throw error;
    }
  }, []);
  const removePlanImplementationRequest = useCallback(
    async (threadId: string, turnId: string) =>
      manager.removePlanImplementationRequest(threadId, turnId),
    [manager],
  );
  const markConversationAsRead = useCallback(
    async (conversationId: string) => manager.markConversationAsRead(conversationId),
    [manager],
  );
  const markConversationAsUnread = useCallback(
    async (conversationId: string) => manager.markConversationAsUnread(conversationId),
    [manager],
  );

  const steerTurn = useCallback(
    async (input: CodexSteerTurnInput) => manager.steerTurn(input),
    [manager],
  );
  const interruptTurn = useCallback(
    async (threadId: string, turnId?: string) => manager.interruptTurn(threadId, turnId),
    [manager],
  );
  const respondApproval = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexApprovalResponse,
      conversationId?: string | null,
    ) => manager.respondApproval(requestId, response, conversationId),
    [manager],
  );
  const respondUserInput = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      answers: Record<string, string[]>,
      conversationId?: string | null,
    ) => manager.respondUserInput(requestId, answers, conversationId),
    [manager],
  );
  const respondMcpElicitation = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexMcpServerElicitationAction | CodexMcpServerElicitationResponse,
      conversationId?: string | null,
    ) => manager.respondMcpElicitation(requestId, response, conversationId),
    [manager],
  );
  const respondPermissionRequest = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexPermissionRequestResponse,
      conversationId?: string | null,
    ) => manager.respondPermissionRequest(requestId, response, conversationId),
    [manager],
  );
  const respondNodexAgentAuthorization = useCallback(
    async (
      requestId: string,
      response: NodexAgentAuthorizationResponse,
      conversationId?: string | null,
    ) => manager.respondNodexAgentAuthorization(requestId, response, conversationId),
    [manager],
  );
  const respondOptionPicker = useCallback(
    async (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalOptionPickerResponse,
    ) => manager.respondOptionPicker(conversationId, requestId, response),
    [manager],
  );
  const respondSetupCodexStep = useCallback(
    async (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalSetupCodexStepResponse,
    ) => manager.respondSetupCodexStep(conversationId, requestId, response),
    [manager],
  );
  const setPermissionMode = useCallback(
    async (projectId: string | null, mode: CodexPermissionMode) =>
      manager.setPermissionMode(projectId, mode),
    [manager],
  );
  const setThreadModel = useCallback(
    (model: string) => {
      const normalizedModel = normalizeThreadSettingsModel(model);
      if (!normalizedModel) {
        return;
      }

      updateStoredThreadSettings({ model: normalizedModel });
    },
    [updateStoredThreadSettings],
  );
  const setThreadReasoningEffort = useCallback(
    (reasoningEffort: CodexThreadSettings["reasoningEffort"]) => {
      if (!reasoningEffort) {
        return;
      }

      updateStoredThreadSettings({ reasoningEffort });
    },
    [updateStoredThreadSettings],
  );
  const setDefaultServiceTier = useCallback(
    (serviceTier: CodexServiceTier) => {
      setServiceTier(serviceTier, "composer_menu");
    },
    [setServiceTier],
  );
  return {
    availableModels,
    executionProfile,
    threadSettings,
    reasoningEffortOptions,
    permissionState,
    permissionMode,
    loadThreads,
    loadModels,
    listCollaborationModes,
    requestThreadStreamSnapshot,
    readSubagentOverview,
    hydrateSelectedSubagent,
    refreshSelectedSubagentAuthority,
    startThreadForSession,
    startSideChat,
    discardSideChat,
    setThreadName,
    archiveThread,
    unarchiveThread,
    startTurn,
    resumeInterruptedTurn,
    enqueueQueuedFollowUp,
    removeQueuedFollowUp,
    replaceQueuedFollowUp,
    reorderQueuedFollowUps,
    resumeQueuedFollowUps,
    resolveQueuedFollowUpsAfterFreshStart,
    sendQueuedFollowUpNow,
    editLastUserTurn,
    forkConversationFromTurn,
    compactThread,
    getThreadGoal,
    setThreadGoal,
    clearThreadGoal,
    dismissThreadGoalResumeConfirmation,
    setThreadMemoryMode,
    uploadFeedback,
    cleanBackgroundTerminals,
    listBackgroundTerminals,
    listBackgroundProcesses,
    runBackgroundProcess,
    stopBackgroundProcess,
    terminateBackgroundTerminal,
    setComposerIntent,
    consumeComposerIntent,
    setConversationCollaborationMode,
    setConversationThreadSettings,
    personality,
    setPersonality,
    removePlanImplementationRequest,
    markConversationAsRead,
    markConversationAsUnread,
    steerTurn,
    interruptTurn,
    respondApproval,
    respondUserInput,
    respondMcpElicitation,
    respondPermissionRequest,
    respondNodexAgentAuthorization,
    respondOptionPicker,
    respondSetupCodexStep,
    setPermissionMode,
    setThreadModel,
    setThreadReasoningEffort,
    setDefaultServiceTier,
    setExecutionProfile,
  };
}
