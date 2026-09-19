import {
  buildCodexCommandApprovalRequest,
  buildCodexFileApprovalRequest,
  buildCodexPermissionRequest,
} from "../../../shared/codex-background-request-projection";
import {
  mutateCodexTurnStartRejection,
  type CodexPreparedTurnExecution,
} from "../../../shared/codex-conversation-state/codex-turn-execution";
import {
  acceptCodexPreparedEnvironmentSelection,
  resolveCodexAcceptedThreadEnvironmentSelection,
} from "../../../shared/codex-conversation-state/codex-environment-selection";
import type { CodexCanonicalServerRequest } from "../../../shared/types";
import { receiveConversationStreamServiceEvent } from "../../../shared/codex-stream-service-events";
import {
  allowsAutomaticResumeHistoryDrain,
  refreshResumedConversationTurnParams,
} from "../../../shared/codex-conversation-state/codex-history-resume";
import type {
  CodexNativeAutoResponseInput,
  CodexNativeServerResponseInput,
  CodexNativeUserResponse,
  CodexNativeUserResponseInput,
} from "../../../shared/codex-native-server-response";
import {
  canonicalResumePreparation,
  resolveConversationResumePermissions,
} from "../../../shared/codex-conversation-state/codex-resume-permissions";
import {
  prepareConversationResumePermissionContext,
  type ConversationResumePreparationOptions,
} from "../../../shared/codex-conversation-state/codex-resume-request";
import { conversationResumeRequestOptions } from "../../../shared/codex-conversation-resume-retry";
import type { CodexRendererNativeRequestOptions } from "../../../shared/codex-renderer-request";
import {
  requestRendererConversationResume,
  type ConversationResumeRequestLifetime,
} from "./renderer-conversation-resume-request";
import { CodexManualCompactions } from "../../../shared/codex-manual-compactions";
import {
  mutateCodexCanonicalInProgressSyntheticItem,
  mutateCodexCanonicalLocalSyntheticItemRemoval,
  resolveCodexCanonicalHydratedCwd,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import { mutateCodexCanonicalThreadGoalTranscriptTurn } from "../../../shared/codex-conversation-state/codex-thread-goal-transcript";
import { reconcileCodexResumedConversationState } from "../../../shared/codex-conversation-state/codex-thread-metadata";
import {
  isSteerTurnInactiveError,
  isNoActiveTurnError,
  parseSteerTurnMismatchActualTurnId,
} from "../../../shared/codex-steer-errors";
import {
  QueuedMessageExecution,
  QueueNotReady,
} from "../../../shared/codex-queued-message-execution";
import {
  bindRendererConversationWindowActivity,
  readRendererConversationWindowActivity,
} from "./renderer-conversation-window-activity";
import {
  canAutomaticallySendQueuedMessage,
  resumeInterruptedQueuedMessage,
} from "../../../shared/codex-queued-message-policy";
import {
  hasPendingConversationTurnStart,
  latestConversationTurn,
  latestResidentConversationTurn,
} from "../../../shared/codex-conversation-state/codex-turn-selectors";
import { QueuedMessageLocks } from "../../../shared/codex-queued-message-locks";
import type { ConversationFollowerTurnStart } from "../../../shared/codex-thread-follower-request";
const queuedStartLocks = new QueuedMessageLocks();
import { QueuedMessageCoordinator } from "../../../shared/codex-queued-message-coordinator";
import {
  isCodexQueuedMessage,
  projectCodexQueuedMessage,
  queuedMessagePromptInput,
  type CodexQueuedMessage,
} from "../../../shared/codex-queued-message";
import { prepareUntrustedAppInput } from "../../../shared/codex-untrusted-app-input";
import {
  CodexServerQueuedMessages,
  preserveGeneratedQueueText,
} from "./codex-server-queued-messages";
import { rendererQueuedMessageStorage } from "./renderer-queued-message-storage";
import { registerAppCloseFlushHandler } from "../../lib/app-close-flush";
import {
  CanonicalConversationRetention,
  shouldKeepCanonicalConversationLoaded,
  releaseCanonicalConversationHistoryDraft,
  completeCanonicalConversationUnsubscribeDraft,
  selectCanonicalRetentionRequestKind,
} from "../../../shared/codex-canonical-retention";
import {
  editCanonicalLastUserTurn,
  type CanonicalEditOptions,
} from "../../../shared/codex-conversation-state/codex-owner-edit";
import {
  canonicalPermissionsForMode,
  nativePermissionRequestFields,
} from "../../../shared/codex-conversation-state/codex-native-permissions";
import {
  mutateCodexCanonicalRevert,
  mutateCodexCanonicalRollbackThread,
} from "../../../shared/codex-conversation-state/codex-rollback-state";
import { isCodexNativeMethodUnsupported } from "../../../shared/codex-native-request-outcome";
import {
  runCanonicalOwnerSteer,
  type CanonicalOwnerSteerInput,
} from "../../../shared/codex-conversation-state/codex-owner-steer";
import {
  clearCodexUnconfirmedTurnSubmission,
  recordCodexUnconfirmedTurnSubmission,
  CodexTurnDeliveryError,
  type CodexTurnDelivery,
} from "../../../shared/codex-conversation-state/codex-turn-delivery";
import { interruptCanonicalConversationTurn } from "../../../shared/codex-conversation-state/codex-conversation-interrupt";
import { mutateCodexBackgroundTerminalCleanup } from "../../../shared/codex-conversation-state/codex-background-terminal-cleanup";
import {
  updateCanonicalThreadSettings,
  type CanonicalThreadSettingsPatch,
  type CanonicalThreadSettingsCondition,
} from "../../../shared/codex-conversation-state/codex-thread-settings-update";
import {
  conversationFollowerRequest,
  type ConversationFollowerParams,
} from "../../../shared/codex-thread-follower-request";
import {
  CanonicalCompleteHistoryLoader,
  hasCompleteCanonicalConversationHistory,
} from "../../../shared/codex-conversation-state/codex-complete-history-loader";
import { CanonicalConversationArchiveState } from "../../../shared/codex-conversation-state/codex-conversation-archive-state";
import {
  mutateCodexCanonicalOptimisticTurn,
  mutateCodexCanonicalOptimisticTurnBinding,
} from "../../../shared/codex-conversation-state/codex-optimistic-turn";
import {
  loadCanonicalPromptRailIndex,
  previewCanonicalPromptRailTurn,
} from "../../../shared/codex-conversation-state/codex-canonical-prompt-rail";
import type {
  CodexPromptRailIndexRequest,
  CodexPromptRailIndexCommandResult,
  CodexPromptRailRevealRequest,
  CodexPromptRailRevealCommandResult,
  CodexPromptRailReveal,
} from "../../../shared/codex-prompt-rail-history";
import { hydrateCanonicalHistorySearchMatch } from "../../../shared/codex-conversation-state/codex-canonical-history-search";
type LocalHistoryPageResult = { readonly status: "applied" | "stale" };
import {
  CanonicalHistoryItemLoader,
  listCanonicalHistoryTurns,
  replaceCanonicalHistoryDraft,
  loadCanonicalHistoryBoundaryPage,
  type CanonicalHistoryClient,
} from "../../../shared/codex-conversation-state/codex-canonical-history-loader";
import { CodexConversationEntityDocument } from "../../../shared/codex-conversation-entity-document";
import type {
  CodexNativeNotificationMessage,
  CodexNativeRequestMessage,
} from "../../../shared/types";
import { mutateCodexConversationEvent } from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  CODEX_APP_TOOL_NAMESPACE,
  hasCodexDynamicToolIdentity,
} from "../../../shared/codex-dynamic-tool-identity";
import { mutateCodexConversationThreadMetadata } from "../../../shared/codex-conversation-state/codex-thread-metadata";
import {
  createCodexCanonicalHydratedConversationState,
  canonicalHistoryPermissionContext,
  extractCodexCanonicalHydratedAttachments,
  hydrateCodexCanonicalTurns,
  mergeCodexCanonicalTurnStates,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import { applyPatches, castDraft, type Draft, type Patch } from "immer";
import {
  ConversationStream,
  type ConversationWindowActivity,
  type ConversationStreamRole as LocalConversationStreamRole,
} from "../../../shared/codex-conversation-stream";
import type {
  ConversationCoordinationHost,
  ConversationCoordinationEvent,
  ConversationFollowerRequest,
} from "../../../shared/codex-client-coordination";
import type { ConversationCoordinationBroadcast } from "../../../shared/codex-coordination-view";
import {
  connectConversationCoordination,
  type ConversationCoordinationConnection,
} from "./conversation-coordination-connection";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import { connectRendererThreadReadState } from "./renderer-thread-read-state";
import { RendererNativeAppServer, type NativeRequestOptions } from "./renderer-native-app-server";
import { codexTurnFirstResponseTracker } from "./codex-turn-first-response";
import {
  startCodexRequestInteractionTrace,
  startCodexServerResponseInteractionTrace,
} from "./codex-request-interaction-trace";
import { readNativeModelCatalog, readNativeCollaborationModes } from "./renderer-native-catalog";
import { ConversationActivity } from "../../../shared/codex-conversation-activity";
import {
  ConversationStreamRecovery,
  type ConversationReconnectOptions,
} from "../../../shared/codex-conversation-recovery";
import { createAsyncQuestionRuntime } from "./async-question-runtime";
import type { CodexTurnPresentationTicket } from "../../../shared/nodex-app-tools/turn-presentation";
import type { WorkbenchSubmitPresentation } from "../../../shared/nodex-app-tools/workbench";
import {
  captureCodexTurnPresentation,
  readCodexSubmissionPresentation,
} from "../../lib/codex-turn-presentation";
import { useWorkbenchWindowOwner } from "../../lib/use-workbench-window-state";
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
  ThreadGoal,
  ThreadGoalSetParams,
  Thread,
  ThreadStatus,
  Turn,
  TurnStartResponse,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import { parseAssetSource } from "../../../shared/assets";
import type {
  CodexPersistedHistoryOccurrenceHydrateInput,
  CodexPersistedHistoryOccurrenceResolution,
} from "../../../shared/codex-persisted-history-search";
import {
  prepareCodexPrompt,
  createEmptyCodexPreparedPrompt,
} from "../../../shared/codex-prompt-preparation";
import { normalizeCodexServiceTier } from "../../../shared/codex-service-tier";
import type {
  CodexAccountSnapshot,
  CodexApprovalRequest,
  CodexApprovalResponse,
  CodexSubagentOverviewReadInput,
  CodexSubagentOverviewWindow,
  CodexSelectedSubagentHydrateInput,
  CodexSelectedSubagentHydrateResult,
  CodexBackgroundTerminalRow,
  PageRunInTarget,
  CodexCanonicalOptionPickerResponse,
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
  CodexPendingSteer,
  CodexPreparedPrompt,
  CodexPermissionMode,
  CodexPermissionRequestResponse,
  CodexPersonality,
  CodexPermissionState,
  CodexProtocolRequestId,
  CodexQueuedFollowUp,
  CodexUserInputRequest,
  CodexRendererClientRequestMessage,
  CodexRendererClientResponseMessage,
  NodexAgentAuthorizationRequest,
  NodexAgentAuthorizationResponse,
  CodexSideChatStartInput,
  CodexSideChatStartResult,
  CodexSteerTurnInput,
  CodexThreadActionResult,
  CodexThreadGoalSetActionInput,
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
import { EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION } from "../../../shared/codex-queued-follow-up-state";
import {
  mutateCodexCanonicalForkedFromConversationItem,
  type CodexCanonicalConversationState,
  type CodexCanonicalLiveTurnParams,
  type CodexCanonicalTurnState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  normalizeCodexMcpServerElicitationMode,
  normalizeCodexMcpServerElicitationResponse,
} from "../../../shared/codex-mcp-elicitation";
import { completeCodexMcpToolCallForTurn } from "../../../shared/codex-mcp-tool-call";
import type {
  CodexBackgroundProcessRow,
  CodexBackgroundProcessRunActionInput,
  CodexThreadActiveFlag,
  CodexThreadRuntimeStatus,
  CodexTurnStatus,
} from "../../../shared/types";
import { applyTerminalTextDelta } from "../../../shared/terminal-text";
import { WORKTREE_OUTPUT_TAIL_MAX_CHARS } from "../../../shared/worktree-output";
import { sessionFirstSubmissionOwner } from "../conversation-launch/session-first-submission-owner";
import {
  IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE,
  areLocalConversationAttachmentStatesEqual,
  makeLocalConversationAttachmentFailure,
  type LocalConversationAttachmentState,
} from "./conversation-attachment-state";
import {
  codexConversationHistoryPageRequestKey,
  type CodexConversationHistoryPageRequest,
} from "../../../shared/codex-conversation-history-page";
import { applyCodexLifecycleProjectionDiff } from "../../../shared/codex-conversation-state/codex-lifecycle-projection-diff";
import { buildCodexTurnOccurrenceKey } from "../../../shared/codex-turn-identity";
import {
  groupCodexFrameTextDeltasByConversation,
  isCodexFrameTextDeltaNotification,
  mutateCodexConversationFrameTextDeltas,
  toCodexFrameTextDelta,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta";
import {
  CodexFrameTextDeltaQueue,
  type CodexFrameTextDeltaUpdate,
} from "../../../shared/codex-conversation-state/codex-frame-text-delta-queue";
import {
  groupCodexCommandOutputUpdatesByConversation,
  isCodexCommandOutputNotification,
  toCodexCommandOutputUpdate,
  mutateCodexConversationCommandOutput,
  mutateCodexConversationTerminalCommands,
} from "../../../shared/codex-conversation-state/codex-command-execution-stream";
import {
  CodexCommandOutputQueue,
  type CodexCommandOutputUpdate,
} from "../../../shared/codex-conversation-state/codex-command-output-queue";
import {
  mutateCodexCanonicalPlanImplementationCompletion,
  mutateCodexConversationApprovalResponse,
  mutateCodexConversationUserInputResponse,
  mutateCodexConversationMcpElicitationResponse,
  mutateCodexConversationPermissionResponse,
  mutateCodexConversationOnboardingInputResponse,
  mutateCodexConversationOptionPickerResponse,
  mutateCodexConversationSetupCodexStepResponse,
  reduceCodexConversationOptionPickerResponse,
  reduceCodexConversationSetupContextPickerResponse,
  reduceCodexServerRequestOptionPickerResponseRawState,
  reduceCodexServerRequestSetupContextPickerResponseRawState,
  type CodexServerRequestRawState,
} from "../../../shared/codex-conversation-state/codex-server-request-lifecycle";
import { type CodexThreadMetadataEffect } from "../../../shared/codex-conversation-state/codex-thread-metadata";
import { getCodexApprovalKindForRequestMethod } from "../../../shared/codex-approval";
import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import {
  normalizeCodexManualThreadTitle,
  projectCodexMarkdownLabel,
} from "../../../shared/codex-thread-title";
import { isCodexNotificationChildConversation } from "../../../shared/codex-thread-notification";
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
  runConversationOperation,
  subscribeCodexEvents,
  subscribeCodexRendererClientRequests,
} from "./local-conversation-deps";
import {
  subscribeCodexAppServerMessage,
  type CodexClientStatusChangedEvent,
  type CodexErrorEvent,
  type CodexSharedObjectUpdatedEvent,
  type CodexThreadDeletedEvent,
  type CodexThreadTitleUpdatedEvent,
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

function normalizeThreadSettingsModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
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
type StoreListener = () => void;
type ConversationResumeSource = "view" | "executor" | "recovery";
interface ConversationResumeOptions extends ConversationResumePreparationOptions {
  showThreadGoalResumeConfirmation?: boolean;
  timeoutMs?: number;
  source?: ConversationResumeSource;
  isReconnectRecovery?: boolean;
}
interface QueuedConversationResumeInput {
  readonly conversationId: string;
  readonly model: null;
  readonly serviceTier?: CodexServiceTier;
  readonly reasoningEffort: null;
  readonly workspaceRoots: readonly string[];
  readonly useAppServerPermissionDefault: boolean;
  readonly collaborationMode:
    | import("@nodex/codex-app-server-protocol/v2/TurnStartParams").TurnStartParams["collaborationMode"]
    | null;
}
type ConversationListener = (conversation: CodexConversationSnapshot) => void;
type AnyConversationListener = (conversations: CodexConversationSnapshot[]) => void;
type ControlListener = () => void;
interface CodexThreadStartProgressState {
  launchId: string;
  projectId: string | null;
  sessionId: string | null;
  runInTarget: PageRunInTarget;
  threadId?: string | null;
  phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
  message: string;
  outputText: string;
  outputCarriageReturnPending: boolean;
  outputTruncated: boolean;
  updatedAt: number;
}

interface CodexHostErrorState {
  message: string;
  detail?: string;
  updatedAt: number;
}

type OutputDeltaUpdate = CodexCommandOutputUpdate;

type ConversationNotifyMode = "default" | "sync";

function applyStandaloneUnreadStateToSnapshot(
  conversation: CodexConversationSnapshot,
  hasUnreadTurn: boolean,
): CodexConversationSnapshot {
  return {
    ...conversation,
    hasUnreadTurn,
    canonicalState: conversation.canonicalState
      ? { ...conversation.canonicalState, hasUnreadTurn }
      : conversation.canonicalState,
    ...(!hasUnreadTurn ? { unreadMessageCount: 0 } : {}),
  };
}

interface OwnerTurnRequestContext {
  readonly options: NativeRequestOptions;
  readonly assertCurrent: () => void;
  readonly confirmDelivery: () => void;
}

interface OwnerServerRequestReplyResult {
  readonly accepted: boolean;
  readonly streamRevision?: number;
}

function mergeOutputDeltaQueueUpdate(
  _existing: OutputDeltaUpdate | undefined,
  incoming: OutputDeltaUpdate,
  delta: string,
): OutputDeltaUpdate {
  return { ...incoming, delta };
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
  const nextThreadName = projectCodexMarkdownLabel(conversation.threadName) ?? "";
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function getString(candidate: Record<string, unknown>, key: string): string | null {
  const value = candidate[key];
  return typeof value === "string" ? value : null;
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

function projectConversationItemToIdentityView(item: CodexConversationItem): CodexItemView {
  return {
    ...item,
    normalizedKind: item.kind,
  } as CodexItemView;
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
  if (value > 0 && value < 10000000000) return value * 1000;
  return value;
}

function parseOwnerTurnErrorMessage(value: unknown): string | undefined {
  const candidate = asRecord(value);
  if (!candidate) return undefined;
  const message = getString(candidate, "message");
  return message ?? undefined;
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

async function compileServerQueuedMessageInput(
  message: CodexQueuedMessage,
  previous: import("@nodex/codex-app-server-protocol/v2").QueuedSubmission | undefined,
  preserveGeneratedText: boolean,
): Promise<UserInput[]> {
  const prepared = await prepareCodexPrompt(
    message.context.prompt,
    queuedMessagePromptInput(message),
    { resolveImageInput: resolveOwnerPromptImageInput },
  );
  const appInput = prepareUntrustedAppInput(
    prepared.promptText,
    message.context,
    `untrusted_input_${message.id}`,
  );
  const input = [appInput.input, ...prepared.inputItems.slice(1)];
  if (!previous) return input;

  const previousAttachments = extractCodexCanonicalHydratedAttachments(previous.input);
  return [
    ...input.map((entry) => {
      if (entry.type === "text" && preserveGeneratedText) {
        const previousText = previous.input.find((candidate) => candidate.type === "text");
        if (previousText?.type === "text") {
          return { ...entry, text: preserveGeneratedQueueText(previousText.text, entry.text) };
        }
      }
      if (entry.type === "image")
        return (
          previous.input.find(
            (candidate) => candidate.type === "image" && candidate.url === entry.url,
          ) ?? entry
        );
      if (entry.type === "localImage")
        return (
          previous.input.find(
            (candidate) => candidate.type === "localImage" && candidate.path === entry.path,
          ) ?? entry
        );
      return entry;
    }),
    ...previous.input.filter(
      (entry) =>
        entry.type !== "text" &&
        entry.type !== "image" &&
        entry.type !== "localImage" &&
        (entry.type !== "mention" ||
          !previousAttachments.some(({ path }) => path === entry.path) ||
          message.context.fileAttachments.some(({ path }) => path === entry.path)),
    ),
  ];
}

function createOwnerClientUserMessageId(): string {
  const cryptoWithRandomUuid = globalThis.crypto as Crypto | undefined;
  const randomId = cryptoWithRandomUuid?.randomUUID?.();
  if (randomId) return randomId;

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface RendererTurnSubmissionIdentity {
  readonly clientUserMessageId: string;
  readonly startedAtMs: number;
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
  const turnId = canonicalTurn.turnId;

  const projection = applyCodexLifecycleProjectionDiff({
    threadId: currentTurn.threadId,
    turnKey: buildCodexTurnOccurrenceKey(turnId, turnIndex, canonicalTurn.entityKey),
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
    const mcpToolCall = completeCodexMcpToolCallForTurn(entry.mcpToolCall, canonicalTurn.status);
    return mcpToolCall === entry.mcpToolCall
      ? (entry as CodexConversationItem)
      : ({ ...entry, mcpToolCall } as CodexConversationItem);
  });

  return {
    ...currentTurn,
    turnId,
    clientUserMessageId: canonicalTurn.params.clientUserMessageId ?? null,
    ...(canonicalTurn.entityKey === undefined ? {} : { entityKey: canonicalTurn.entityKey }),
    status: canonicalTurn.status,
    errorMessage: canonicalTurn.error?.message ?? undefined,
    diff: canonicalTurn.diff ?? undefined,
    durationMs: canonicalTurn.durationMs,
    turnStartedAtMs: canonicalTurn.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: canonicalTurn.firstTurnWorkItemStartedAtMs ?? null,
    finalAssistantStartedAtMs: canonicalTurn.finalAssistantStartedAtMs,
    commandExecutionStartedAtMsById:
      canonicalTurn.commandExecutionStartedAtMsById === undefined
        ? undefined
        : { ...canonicalTurn.commandExecutionStartedAtMsById },
    interruptedCommandExecutionItemIds:
      canonicalTurn.interruptedCommandExecutionItemIds === undefined
        ? undefined
        : [...canonicalTurn.interruptedCommandExecutionItemIds],
    hookRuns: canonicalTurn.hookRuns === undefined ? undefined : [...canonicalTurn.hookRuns],
    safetyBuffering:
      canonicalTurn.safetyBuffering === undefined
        ? undefined
        : {
            useCases: [...canonicalTurn.safetyBuffering.useCases],
            reasons: [...canonicalTurn.safetyBuffering.reasons],
            showBufferingUi: canonicalTurn.safetyBuffering.showBufferingUi,
            fasterModel: canonicalTurn.safetyBuffering.fasterModel,
          },
    startedAt: canonicalTurn.turnStartedAtMs,
    completedAt: canonicalTurn.completedAtMs ?? null,
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
    turnId: canonicalTurn.turnId,
    clientUserMessageId: canonicalTurn.params.clientUserMessageId ?? null,
    ...(canonicalTurn.entityKey === undefined ? {} : { entityKey: canonicalTurn.entityKey }),
    status: canonicalTurn.status,
    errorMessage: canonicalTurn.error?.message ?? undefined,
    itemIds: [],
    turnStartedAtMs: canonicalTurn.turnStartedAtMs,
    firstTurnWorkItemStartedAtMs: canonicalTurn.firstTurnWorkItemStartedAtMs ?? null,
    finalAssistantStartedAtMs: canonicalTurn.finalAssistantStartedAtMs,
    startedAt: canonicalTurn.turnStartedAtMs,
    completedAt: canonicalTurn.completedAtMs ?? null,
    durationMs: canonicalTurn.durationMs,
    items: [],
  };
}

function materializeOwnerCanonicalConversationSnapshot(
  conversation: CodexConversationSnapshot,
  previousCanonicalState: CodexCanonicalConversationState | null = null,
): CodexConversationSnapshot {
  const canonicalState = conversation.canonicalState;
  if (!canonicalState) return conversation;

  const turns = residentConversationTurns(canonicalState).map((canonicalTurn, turnIndex) => {
    const currentTurn =
      conversation.turns[turnIndex] ??
      buildOwnerCanonicalTurnPlaceholder(conversation.threadId, canonicalTurn);
    const observedAtMs =
      canonicalTurn.turnStartedAtMs ?? currentTurn.startedAt ?? conversation.updatedAt;
    const indexedPrevious = residentConversationTurns(previousCanonicalState)[turnIndex] ?? null;
    const previousCanonicalTurn =
      indexedPrevious?.turnId === canonicalTurn.turnId
        ? indexedPrevious
        : canonicalTurn.turnId === null
          ? null
          : (residentConversationTurns(previousCanonicalState).findLast(
              (turn) => turn.turnId === canonicalTurn.turnId,
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
    hasUnreadTurn: canonicalState.hasUnreadTurn,
  };
}

function parseOwnerTurnStartResult(
  threadId: string,
  result: unknown,
): {
  protocol: Turn;
  summary: Omit<CodexConversationTurn, "items">;
} | null {
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
      startedAt: summary.startedAt == null ? null : summary.startedAt / 1000,
      completedAt: summary.completedAt == null ? null : summary.completedAt / 1000,
      items: [],
    },
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

function buildOwnerConversationThreadSettings(
  conversation: CodexConversationSnapshot,
  threadSettings: NonNullable<CodexCanonicalConversationState["latestThreadSettings"]>,
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
    personality:
      threadSettings.personality ?? conversation.latestThreadSettings?.personality ?? null,
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
  const settings = state.latestThreadSettings;
  if (!settings) return { ...conversation, canonicalState: state };
  const latestThreadSettings = buildOwnerConversationThreadSettings(conversation, settings);
  if (areOwnerThreadSettingsEqual(conversation.latestThreadSettings, latestThreadSettings)) {
    return {
      ...conversation,
      canonicalState: state,
      modelProvider: state.modelProvider,
      cwd: state.cwd,
    };
  }

  return {
    ...conversation,
    canonicalState: state,
    latestThreadSettings,
    latestCollaborationMode:
      latestThreadSettings.collaborationMode ?? DEFAULT_COLLABORATION_MODE_STATE,
    modelProvider: state.modelProvider,
    cwd: state.cwd,
  };
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

function buildOwnerUserInputRequest(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  params: Extract<
    CodexCanonicalServerRequest,
    {
      method: "item/tool/requestUserInput";
    }
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
    CodexCanonicalServerRequest,
    {
      method: "mcpServer/elicitation/request";
    }
  >["params"],
): CodexMcpServerElicitationRequest | null {
  if (params.mode === "openai/userVerification") return null;
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

function hasOwnerStoredInteractiveResponseTarget(
  conversation: CodexConversationSnapshot,
  requestId: CodexProtocolRequestId,
  kind: "optionPicker" | "setupContextPicker",
): boolean {
  const state = conversation.canonicalState;
  if (state && state.id !== conversation.threadId) return false;
  if (!state) {
    const raw = ownerRawServerRequestState(conversation);
    const result =
      kind === "optionPicker"
        ? reduceCodexServerRequestOptionPickerResponseRawState(raw, requestId)
        : reduceCodexServerRequestSetupContextPickerResponseRawState(raw, requestId);
    return result.selectedRequests.length > 0;
  }
  const lifecycle =
    kind === "optionPicker"
      ? reduceCodexConversationOptionPickerResponse(state, requestId)
      : reduceCodexConversationSetupContextPickerResponse(state, requestId);
  return lifecycle.selectedRequests.length > 0;
}

function ownerRawServerRequestState(
  conversation: CodexConversationSnapshot,
): CodexServerRequestRawState {
  return {
    threadId: conversation.threadId,
    turns: [],
    requests: conversation.canonicalRequests ?? [],
    hasUnreadTurn: conversation.hasUnreadTurn ?? false,
  };
}

/** Projects only requests retained by the canonical draft transition. */
function projectOwnerServerRequestToConversation(
  conversation: CodexConversationSnapshot,
  request: import("../../../shared/codex-conversation-state/codex-conversation-state").CodexCanonicalServerRequest,
): CodexConversationSnapshot {
  if (!conversation.canonicalState?.requests.some((pending) => pending.id === request.id))
    return conversation;
  const viewRequestId = request.id;
  const withCanonicalState = conversation;
  let nextConversation = conversation;
  switch (request.method) {
    case "item/commandExecution/requestApproval": {
      const approvalRequest = buildCodexCommandApprovalRequest(
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
      const approvalRequest = buildCodexFileApprovalRequest(
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
      if (elicitationRequest) {
        nextConversation = upsertOwnerConversationRequest(withCanonicalState, elicitationRequest);
      }
      break;
    }
    case "item/permissions/requestApproval": {
      const permissionRequest = buildCodexPermissionRequest(
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
    case "item/plan/requestImplementation": {
      if (typeof request.id !== "string") break;
      const turn = withCanonicalState.turns.find(
        (candidate) => candidate.turnId === request.params.turnId,
      );
      const item = turn?.items.find((candidate) => candidate.itemId === request.id);
      nextConversation = upsertOwnerConversationRequest(withCanonicalState, {
        type: "implementPlan",
        requestId: request.id,
        projectId: withCanonicalState.projectId,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
        itemId: request.id,
        planContent: request.params.planContent,
        createdAt: item?.createdAt ?? Date.now(),
      });
      break;
    }
  }

  return nextConversation;
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

function sendCodexAppServerResponse(input: CodexNativeServerResponseInput): Promise<boolean> {
  const method = "effect" in input ? input.effect.method : input.method;
  const interactionTrace = startCodexServerResponseInteractionTrace(method);
  try {
    const result = runConversationOperation(
      "codex:app-server:respond",
      interactionTrace
        ? {
            ...input,
            requestMethod: method,
            trace: interactionTrace.trace,
          }
        : input,
    );
    interactionTrace?.finish();
    return result;
  } catch (error) {
    interactionTrace?.finish(error);
    throw error;
  }
}

export class CodexAppServerManager {
  private destroyed = false;
  private readonly foregroundConversations = new Map<symbol, string>();
  readonly asyncQuestions = createAsyncQuestionRuntime();
  private readonly conversationActivity = new ConversationActivity((threadId, active) => {
    void this.applyThreadActivity(threadId, active).catch(() => {});
  });
  private readonly queuedExecution: QueuedMessageExecution<
    CodexQueuedMessage,
    QueuedConversationResumeInput,
    ConversationFollowerTurnStart,
    CanonicalOwnerSteerInput
  >;
  private readonly queuedMessages: QueuedMessageCoordinator<CodexQueuedMessage>;
  private readonly serverQueuedMessages: CodexServerQueuedMessages;
  private readonly retention: CanonicalConversationRetention;
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
  private savedReadState: Set<string> | null = null;
  private readonly conversationsById = new Map<string, CodexConversationSnapshot>();
  private readonly threadsById = new Map<string, Thread>();
  private readonly childMembershipsByParentThreadId = new Map<
    string,
    CodexConversationChildMembership[]
  >();
  private readonly ownerHiddenLifecycleItemTypesByConversationId = new Map<
    string,
    Map<string, Map<string, string>>
  >();
  private readonly resumeInFlightByThreadId = new Map<
    string,
    {
      source: ConversationResumeSource;
      promise: Promise<CodexConversationSnapshot | null>;
      cancel(): void;
    }
  >();
  private readonly conversationRemovedCallbacks = new Set<(threadId: string) => void>();
  private readonly attachmentStateByThreadId = new Map<string, LocalConversationAttachmentState>();
  private readonly interruptedTurnResumesInFlightByThreadId = new Map<string, Promise<unknown>>();
  private readonly ownerHistoryOperationsByThread = new Map<string, Promise<void>>();
  private readonly ownerHistoryReadBarriers = new Set<string>();
  private readonly historyPageLoadsInFlightByTarget = new Map<
    string,
    Promise<LocalHistoryPageResult>
  >();
  private readonly primaryConversationRequestByThread = new Map<
    string,
    CodexConversationLiveRequest | null
  >();
  private readonly conversationVersionById = new Map<string, number>();
  private readonly streamState: ConversationStream<CodexCanonicalConversationState, Patch>;
  private readonly streamRecovery: ConversationStreamRecovery<CodexCanonicalConversationState>;
  private readonly activeStreamingIds = new Set<string>();
  private readonly goalHydrationTokens = new Map<string, symbol>();
  private readonly manualCompactions = new CodexManualCompactions();
  private readonly nativeRequestOccurrences = new Map<string, CodexNativeRequestMessage[]>();
  private readonly nativeResumeBuffers = new Map<
    string,
    {
      generation: number;
      notifications: (CodexNativeNotificationMessage | CodexNativeRequestMessage)[];
    }
  >();
  private readonly nativeGenerationByThread = new Map<string, number>();
  private readonly archiveState = new CanonicalConversationArchiveState();
  private supportsPaginatedHistory = false;
  private nativeHostContext:
    | import("../../../shared/codex-renderer-resume").CodexRendererHostContext
    | null = null;
  private suspendedNativeHostContext: typeof this.nativeHostContext = null;
  private readonly disposalCallbacks = new Set<() => void>();
  private readonly settingsUpdates = new Map<string, Promise<boolean>>();
  private nativeSettingsSupport: "unknown" | "supported" | "unsupported" = "unknown";
  private nativeHostContextLoad: Promise<void> | null = null;
  private nativeHostContextRevision = 0;
  private readonly historyClient: CanonicalHistoryClient;
  private readonly historyItemLoader: CanonicalHistoryItemLoader;
  private readonly completeHistoryLoader: CanonicalCompleteHistoryLoader;
  private readonly followerMembershipByConversationId = new Map<
    string,
    {
      ownerClientId: string;
      followerClientIds: readonly string[];
      membershipEpoch: number;
    }
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
  private readonly ownerTextDeltaQueue = new CodexFrameTextDeltaQueue<CodexFrameTextDeltaUpdate>({
    onFlush: (updates) => {
      for (const [id, deltas] of groupCodexFrameTextDeltasByConversation(updates)) {
        if (this.streamState.getRole(id)?.role !== "owner") continue;
        this.historyClient.updateConversation(id, (draft) => {
          mutateCodexConversationFrameTextDeltas(draft, deltas, { now: Date.now });
        });
      }
    },
  });
  private readonly outputDeltaQueue = new CodexCommandOutputQueue<OutputDeltaUpdate>({
    mergeUpdate: mergeOutputDeltaQueueUpdate,
    onFlush: (updates) => {
      for (const [id, deltas] of groupCodexCommandOutputUpdatesByConversation(updates)) {
        if (this.streamState.getRole(id)?.role !== "owner") continue;
        this.historyClient.updateConversation(
          id,
          (draft) => {
            for (const delta of deltas) mutateCodexConversationCommandOutput(draft, delta);
          },
          false,
        );
      }
    },
  });
  private readonly terminalInputBuffers = new CodexTerminalInteractionAccumulator();
  private readonly nativeAppServer: RendererNativeAppServer;
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
  private readonly lastAnySnapshotById = new Map<string, ConversationAnyProjection>();
  private readonly lastMetaSnapshotById = new Map<string, ConversationMetaProjection>();
  private lastAnyOrderKey: string | null = null;
  private lastMetaOrderKey: string | null = null;

  private readonly busUnsubscribers: Array<() => void> = [];
  private bootstrapStarted = false;
  private lastHostError: CodexHostErrorState | null = null;
  private readonly isOpenAIFormElicitationsEnabled: () => boolean;
  private readonly saveReadState: (
    threadId: string,
    hasUnreadTurn: boolean,
    origin?: "user" | "turn",
  ) => Promise<unknown>;

  constructor(
    private readonly hostId: string,
    options: {
      isOpenAIFormElicitationsEnabled?: () => boolean;
      saveReadState?: (
        threadId: string,
        hasUnreadTurn: boolean,
        origin?: "user" | "turn",
      ) => Promise<unknown>;
    } = {},
  ) {
    this.nativeAppServer = new RendererNativeAppServer(hostId);
    this.streamState = new ConversationStream({
      hostId,
      isLocalHost: hostId === DEFAULT_CODEX_HOST_ID,
      canHandleOwnerlessDynamicTool: () => false,
      getConversation: (id) => this.conversationsById.get(id)?.canonicalState ?? undefined,
      normalizeSnapshot: (state) => state,
      applyPatches: (state, patches) => applyPatches(state, patches as Patch[]),
      setConversation: (state, details) => {
        const before = this.conversationsById.get(state.id)?.canonicalState;
        this.applyCanonicalDocument(state);
        if (!details || !before) return;
        const existing = new Set(
          mergeCodexCanonicalTurnStates(residentConversationTurns(before), before.turns)
            .flatMap((turn) => turn.items)
            .filter((item) => item.type === "agentMessage" && item.delivery === "async")
            .map((item) => item.id),
        );
        for (const turn of mergeCodexCanonicalTurnStates(
          residentConversationTurns(state),
          state.turns,
        ))
          for (const item of turn.items) {
            if (item.type === "agentMessage" && item.delivery === "async" && !existing.has(item.id))
              this.asyncQuestions.receive(state.id, item.id);
          }
      },
      notifyConversation: (id) => this.notifyConversationCallbacks(id),
      onRoleChanged: (id) => {
        this.manualCompactions.clear(id);
        this.wakeQueuedMessages(id);
        this.notifyConversationCallbacks(id);
        if (this.conversationsById.get(id)?.canonicalState) this.retention?.reconcile(id);
      },
      onFollowersChanged: (id) => {
        if (this.conversationsById.get(id)?.canonicalState) this.retention?.reconcile(id);
      },
      onOwnerUnavailable: (id, owner) =>
        this.markConversationNeedsResumeAfterUnavailableOwner(id, owner),
      onError: (operation, id, error) =>
        console.error("Conversation stream failed", { operation, id, error }),
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      transport: {
        sendState: async (conversationId, hostId, targetClientIds, change) =>
          (await getConversationCoordinationHost()).threadStreamStateChanged({
            params: { conversationId, hostId, change },
            targetClientIds,
          }),
        sendFollowing: async (conversationId, hostId, following, targetClientIds) =>
          (await getConversationCoordinationHost()).threadStreamFollowingChanged({
            params: { conversationId, hostId, following },
            targetClientIds,
          }),
        requestFollowingStatus: async (conversationId, hostId) =>
          (await getConversationCoordinationHost()).threadStreamFollowingStatusRequested({
            conversationId,
            hostId,
          }),
        setThreadOwnership: async (conversationId, hostId, ownsThread) =>
          (await getConversationCoordinationHost()).setThreadOwnership({
            conversationId,
            hostId,
            ownsThread,
          }),
      },
    });

    this.historyClient = {
      hostId,
      supportsPaginatedHistory: () => this.supportsPaginatedHistory,
      getConversation: (id) => this.conversationsById.get(id)?.canonicalState,
      sendRequest: (method, params, options) =>
        this.nativeAppServer.request(method, params, options),
      updateConversation: (id, recipe, broadcast = true) => {
        const before = this.conversationsById.get(id)?.canonicalState;
        if (!before) return;
        const receipt = new CodexConversationEntityDocument()
          .withCanonicalState(before)
          .mutate(recipe);
        if (!receipt) return;
        this.applyCanonicalDocument(receipt.after);
        if (broadcast) this.streamState.broadcastPatches(id, receipt.patches);
      },
      broadcastSnapshot: (id) => {
        this.streamState.broadcastSnapshot(id);
      },
      mapTurns: (id, turns, pagination) => {
        const state = this.conversationsById.get(id)?.canonicalState;
        const context = state?.hydrationContext;
        if (!state || !context || !state.currentPermissions)
          throw new Error("History hydration context unavailable");
        const params = residentConversationTurns(state).at(-1)?.params;
        const settings = state.latestThreadSettings;
        const current = state.currentPermissions;
        return hydrateCodexCanonicalTurns(id, turns, {
          hostId,
          model: state.latestModel ?? context.model,
          reasoningEffort: state.latestReasoningEffort ?? context.reasoningEffort,
          cwd: settings?.cwd ?? state.cwd ?? params?.cwd ?? context.cwd ?? "/",
          ...canonicalHistoryPermissionContext(current),
          approvalPolicy:
            settings?.approvalPolicy ?? params?.approvalPolicy ?? current.approvalPolicy,
          approvalsReviewer:
            settings?.approvalsReviewer ?? params?.approvalsReviewer ?? current.approvalsReviewer,
          sandboxPolicy:
            settings?.sandboxPolicy ??
            (params && "sandboxPolicy" in params ? params.sandboxPolicy : undefined) ??
            current.sandboxPolicy,
          latestThreadSettings: context.latestThreadSettings,
          turnItemsPaginationById: pagination,
          pendingRequests: state.requests,
          hasUnreadTurn: state.hasUnreadTurn,
        });
      },
    };

    this.historyItemLoader = new CanonicalHistoryItemLoader(this.historyClient);
    this.completeHistoryLoader = new CanonicalCompleteHistoryLoader(
      this.historyClient,
      this.historyItemLoader,
    );
    this.streamRecovery = new ConversationStreamRecovery<CodexCanonicalConversationState>({
      conversations: () =>
        [...this.conversationsById.values()].flatMap((value) =>
          value.canonicalState ? [value.canonicalState] : [],
        ),
      getConversation: (id) => this.historyClient.getConversation(id) ?? undefined,
      streamingConversationIds: () => this.streamState.getStreamingConversationIds(),
      ownsHistory: (id) => this.streamState.ownsConversationHistoryStream(id),
      hasResumeInFlight: (id) => this.resumeInFlightByThreadId.has(id),
      isSuppressed: (id) =>
        this.archiveState.isSuppressed(id) || this.threadSummariesById.get(id)?.archived === true,
      isDisposed: () => this.destroyed,
      cancelResumes: () => {
        for (const id of this.resumeInFlightByThreadId.keys()) this.nativeResumeBuffers.delete(id);
        this.cancelPendingConversationResumes();
      },
      resetHistory: () => this.resetConversationHistoryAfterReconnect(),
      resetStreams: (preserve) => {
        this.streamState.resetAfterReconnect(preserve);
      },
      markNeedsResume: (id) => {
        this.historyClient.updateConversation(id, (draft) => {
          draft.resumeState = "needs_resume";
        });
        this.setConversationAttachmentState(id, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
      },
      resume: (conversation) =>
        this.requestThreadStreamResume(conversation.id, {
          source: "recovery",
          isReconnectRecovery: true,
        }),
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      onError: (threadId, error) =>
        console.warn("Failed to restore conversation after reconnect", { threadId, error }),
    });

    const ephemeralSide = (state: CodexCanonicalConversationState) =>
      state.ephemeral && state.sideConversation === true;
    this.retention = new CanonicalConversationRetention({
      getConversation: (id) => this.historyClient.getConversation(id),
      getRole: (id) => this.streamState.getRole(id)?.role ?? null,
      ownsHistory: (id) => this.streamState.getRole(id)?.role === "owner",
      hasActiveView: (id) => this.conversationActivity.has(id),
      hasFollowers: (id) => this.streamState.hasFollowersOrPendingReconnect(id),
      shouldKeepLoaded: (state) =>
        shouldKeepCanonicalConversationLoaded(
          state,
          selectCanonicalRetentionRequestKind(state),
          ephemeralSide(state),
        ),
      isEphemeralSide: ephemeralSide,
      unsubscribe: (id) => this.nativeAppServer.request("thread/unsubscribe", { threadId: id }),
      releaseHistory: (id) =>
        this.historyClient.updateConversation(id, releaseCanonicalConversationHistoryDraft, false),
      completeUnsubscribe: (id, options) =>
        this.historyClient.updateConversation(id, (draft) =>
          completeCanonicalConversationUnsubscribeDraft(draft, {
            ...options,
            primaryRequest: selectCanonicalRetentionRequestKind(draft),
          }),
        ),
      clearOwnership: (id) => {
        this.nativeGenerationByThread.delete(id);
        this.streamState.setRole(id, null);
      },
      now: Date.now,
      schedule: (callback, delay) => {
        const timer = setTimeout(callback, delay);
        return () => clearTimeout(timer);
      },
      scheduleMicrotask: (callback) => queueMicrotask(callback),
    });

    this.queuedMessages = new QueuedMessageCoordinator({
      storage: rendererQueuedMessageStorage,
      role: (id) => this.streamState.getRole(id),
      validate: (messages) => {
        if (!messages.every(isCodexQueuedMessage)) throw new Error("Invalid queued messages");
      },
      requestFollower: async (id, state, ownerClientId) => {
        const response = await (
          await getConversationCoordinationHost()
        ).requestThreadFollower({
          hostId: this.hostId,
          targetClientId: ownerClientId,
          request: conversationFollowerRequest("thread-follower-set-queued-follow-ups-state", {
            conversationId: id,
            state,
          }),
        });
        if (response.resultType !== "success")
          throw new Error(
            response.resultType === "error" ? response.error : "Queue owner unavailable",
          );
      },
      broadcast: async (id, messages) =>
        (await getConversationCoordinationHost()).threadQueuedFollowUpsChanged({
          hostId: this.hostId,
          conversationId: id,
          messages,
        }),
      changed: (id) => {
        for (const threadId of id ? [id] : this.conversationsById.keys()) {
          this.refreshQueuedMessageProjection(threadId);
          if (
            this.isServerQueueSelected(threadId) &&
            this.serverQueuedMessages.read(threadId) == null
          )
            void this.serverQueuedMessages
              .load(threadId)
              .catch((error) => console.error("Server queue load failed", error));
        }
      },
      wake: (id) => this.wakeQueuedMessages(id),
      error: (operation, error) => console.error("Queued messages failed", { operation, error }),
    });
    this.serverQueuedMessages = new CodexServerQueuedMessages({
      request: (method, params) => this.nativeAppServer.request(method, params),
      compileInput: compileServerQueuedMessageInput,
      getConversationCwd: (id) => this.historyClient.getConversation(id)?.cwd ?? null,
      isConversationInterrupted: (id) =>
        latestResidentConversationTurn(this.historyClient.getConversation(id))?.status ===
        "interrupted",
      isConversationStreaming: (id) => {
        const conversation = this.conversationsById.get(id);
        return conversation ? isConversationStreaming(conversation) : false;
      },
      onQueueChanged: (id) => this.refreshQueuedMessageProjection(id),
    });
    this.queuedExecution = new QueuedMessageExecution<
      CodexQueuedMessage,
      QueuedConversationResumeInput,
      ConversationFollowerTurnStart,
      CanonicalOwnerSteerInput
    >({
      coordinator: this.queuedMessages,
      role: (id) => this.streamState.getRole(id),
      canSend: (id, message) =>
        !this.isServerQueueSelected(id) &&
        canAutomaticallySendQueuedMessage({
          conversation: this.historyClient.getConversation(id),
          message,
          role: this.streamState.getRole(id),
        }),
      validate: (messages) => {
        if (!messages.every(isCodexQueuedMessage)) throw new Error("Invalid queued messages");
      },
      error: (operation, error) => console.error("Queued submission failed", { operation, error }),
      runtime: {
        isClientReady: () => this.connection.status === "connected" && !this.destroyed,
        canAcquireOwnership: () => this.canAcquireConversationOwnership("executor"),
        tryAcquireStartTurn: (id) => queuedStartLocks.tryAcquireStartTurn(id),
        releaseStartTurn: (id) => queuedStartLocks.releaseStartTurn(id),
        waitUntilReady: async () => {
          await this.refreshNativeHostContext();
        },
        acquireSendLock: async (conversationId, messageId) => {
          const identity = { conversationId, messageId, lockId: crypto.randomUUID() };
          if (!(await runConversationOperation("codex:queued-messages:acquire-send", identity)))
            return null;
          return {
            release: async (sent) => {
              await Promise.all([
                runConversationOperation("codex:turn:native:release", messageId),
                runConversationOperation("codex:turn:native-steer:release", messageId),
              ]);
              await runConversationOperation("codex:queued-messages:release-send", {
                ...identity,
                sent,
              });
            },
          };
        },
        errorReason: (error) => (error instanceof Error ? error.message : String(error)),
        prepare: (conversationId, message, mode) =>
          this.prepareQueuedSubmission(conversationId, message, mode, "executor"),
      },
      submissionHost: {
        needsResume: (id) =>
          this.historyClient.getConversation(id)?.resumeState !== "resumed" ||
          !this.streamState.getRole(id),
        resume: async (resume, automatic) => {
          const resumed = await this.requestThreadStreamResume(resume.conversationId, {
            source: automatic ? "executor" : "view",
            serviceTier: resume.serviceTier,
            useAppServerPermissionDefault: resume.useAppServerPermissionDefault,
            workspaceRoots: resume.workspaceRoots,
            collaborationMode: resume.collaborationMode,
          });
          if (!resumed) return { status: "not-ready" };
          return {
            status: "ready",
            activeTurnId: this.queuedActiveTurn(resume.conversationId),
          };
        },
        getActiveTurnId: (id) => this.queuedActiveTurn(id),
        hasPendingTurnStart: (id) =>
          hasPendingConversationTurnStart(this.historyClient.getConversation(id)),
        start: (id, turnStart) => this.startPreparedQueuedMessage(id, turnStart),
        steer: (id, input) => this.steerPreparedQueuedMessage(id, input),
        canStartAfterSteerError: (_id, error) => isSteerTurnInactiveError(error),
        isNoActiveTurnError,
      },
    });
    this.busUnsubscribers.push(
      rendererQueuedMessageStorage.subscribe(() => this.queuedMessages.storageChanged()),
      registerAppCloseFlushHandler(() => this.queuedMessages.flushPendingWrites()),
    );

    this.saveReadState =
      options.saveReadState ??
      (async (threadId, hasUnreadTurn, origin) =>
        readStateConnection?.set({ hostId: this.hostId, threadId, hasUnreadTurn }, origin));
    this.isOpenAIFormElicitationsEnabled = options.isOpenAIFormElicitationsEnabled ?? (() => true);
    this.busUnsubscribers.push(
      subscribeCodexEvents((event) => {
        if (event.type === "queuedMessageStateChanged") {
          rendererQueuedMessageStorage.invalidate();
          return;
        }
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
        this.archiveState.suppress(event.conversationId);
        this.historyItemLoader.cancelLoads(event.conversationId);
        this.removeThreadLocalState(event.conversationId);
      }),
      subscribeCodexAppServerMessage("thread-deleted", (event) => {
        this.handleThreadDeleted(event);
      }),
      subscribeCodexAppServerMessage("native-notification", (event) =>
        this.receiveNativeNotification(event),
      ),
      subscribeCodexAppServerMessage("native-request", (event) => this.receiveNativeRequest(event)),
      subscribeCodexAppServerMessage("error", (event) => {
        this.handleHostError(event);
      }),
    );
  }

  private receiveNativeNotification(event: CodexNativeNotificationMessage): void {
    if (event.hostId !== this.hostId || this.destroyed) return;
    if (
      this.nativeHostContext
        ? this.nativeHostContext.generation !== event.generation
        : this.nativeHostContextRevision > 0
    )
      return;
    if (event.notification.method === "thread/started")
      this.registerThreadMetadata(event.notification.params.thread);
    if (event.notification.method === "thread/archived") {
      const id = event.notification.params.threadId;
      this.archiveState.suppress(id);
      this.historyItemLoader.cancelLoads(id);
      this.removeThreadLocalState(id);
      return;
    }
    if (event.notification.method === "thread/unarchived") {
      this.archiveState.unsuppress(event.notification.params.threadId);
      return;
    }
    const params = event.notification.params as { threadId?: unknown; thread?: { id?: unknown } };
    const threadId =
      typeof params.threadId === "string"
        ? params.threadId
        : typeof params.thread?.id === "string"
          ? params.thread.id
          : null;
    if (threadId && event.notification.method === "thread/queue/changed") {
      if (this.isServerQueueEnabled())
        void this.serverQueuedMessages
          .refresh(threadId)
          .catch((error) => console.error("Server queue refresh failed", error));
      return;
    }
    if (!threadId || this.streamState.getRole(threadId)?.role !== "owner") return;
    const buffer = this.nativeResumeBuffers.get(threadId);
    if (buffer) {
      if (buffer.generation === event.generation) buffer.notifications.push(event);
      return;
    }
    if (this.nativeGenerationByThread.get(threadId) !== event.generation) return;
    if (
      [
        "thread/started",
        "thread/status/changed",
        "turn/completed",
        "serverRequest/resolved",
      ].includes(event.notification.method)
    )
      this.retention.notificationHandled(threadId);
    if (event.notification.method === "item/commandExecution/terminalInteraction") {
      const payload = event.notification.params;
      const parsed = this.terminalInputBuffers.accept(
        { conversationId: threadId, itemId: payload.itemId },
        payload.stdin,
      );
      if (parsed.commands.length > 0)
        this.historyClient.updateConversation(
          threadId,
          (draft) => {
            mutateCodexConversationTerminalCommands(draft, {
              conversationId: threadId,
              turnId: payload.turnId,
              itemId: payload.itemId,
              commands: parsed.commands,
            });
          },
          false,
        );
      return;
    }
    if (
      event.notification.method === "item/completed" &&
      event.notification.params.item.type === "commandExecution"
    )
      this.terminalInputBuffers.clearItem({
        conversationId: threadId,
        itemId: event.notification.params.item.id,
      });
    if (isCodexCommandOutputNotification(event.notification)) {
      this.outputDeltaQueue.enqueue(toCodexCommandOutputUpdate(event.notification));
      return;
    }
    if (
      event.notification.method === "item/completed" ||
      event.notification.method === "turn/completed"
    )
      this.outputDeltaQueue.flushNow();
    if (isCodexFrameTextDeltaNotification(event.notification)) {
      if (event.notification.method === "item/agentMessage/delta") {
        codexTurnFirstResponseTracker.markFirstDataReceived(event.notification.params.turnId);
      }
      this.ownerTextDeltaQueue.enqueue(toCodexFrameTextDelta(event.notification));
      return;
    }
    if (
      (event.notification.method === "item/completed" ||
        event.notification.method === "turn/completed") &&
      this.ownerTextDeltaQueue.drainBefore(() => this.receiveNativeNotification(event), threadId)
    )
      return;
    const before = this.conversationsById.get(threadId)?.canonicalState;
    if (!before) return;
    const receipt = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) =>
        mutateCodexConversationEvent(
          draft,
          { type: "notification", notification: event.notification },
          {
            now: Date.now,
            createId: () => crypto.randomUUID(),
            consumeContextCompactionSource: () => this.manualCompactions.consumeSource(threadId),
            resolveCollabReceiverThread: (id) => this.threadsById.get(id) ?? null,
            isOpenAIFormElicitationsEnabled: this.isOpenAIFormElicitationsEnabled(),
          },
        ),
      );
    if (!receipt) return;
    if (receipt.after !== before) this.applyCanonicalDocument(receipt.after);
    if (event.notification.method === "item/started")
      this.asyncQuestions.receive(threadId, event.notification.params.item.id);
    if (event.notification.method === "turn/started") {
      const turnId = event.notification.params.turn.id;
      const turn = receipt.after.turns.find((candidate) => candidate.turnId === turnId);
      const clientUserMessageId = turn?.params.clientUserMessageId;
      if (clientUserMessageId) {
        codexTurnFirstResponseTracker.markTurnStarted(clientUserMessageId, threadId, turnId);
      }
    }
    if (
      event.notification.method === "item/started" &&
      event.notification.params.item.type !== "userMessage" &&
      event.notification.params.item.type !== "hookPrompt"
    ) {
      codexTurnFirstResponseTracker.markFirstDataReceived(event.notification.params.turnId);
    }
    if (event.notification.method !== "item/fileChange/patchUpdated" && receipt.patches.length > 0)
      this.streamState.broadcastPatches(threadId, receipt.patches);
    for (const effect of receipt.result) {
      if (effect.type === "markConversationStreaming") this.activeStreamingIds.add(effect.threadId);
      if (effect.type === "clearCompletedGoal") this.consumeOwnerThreadMetadataEffects([effect]);
    }
    if (event.notification.method === "turn/completed") {
      if (event.notification.params.turn.status !== "inProgress") {
        codexTurnFirstResponseTracker.finishTurn(
          event.notification.params.turn.id,
          event.notification.params.turn.status,
        );
      }
      this.queuedExecution.turnCompleted(
        threadId,
        event.notification.params.turn.status === "interrupted",
      );
    }
    if (!before.hasUnreadTurn && receipt.after.hasUnreadTurn)
      void this.saveReadState(threadId, true, "turn");
  }

  private receiveNativeRequest(event: CodexNativeRequestMessage): void {
    if (event.hostId !== this.hostId || this.destroyed) return;
    if (
      this.nativeHostContext
        ? this.nativeHostContext.generation !== event.generation
        : this.nativeHostContextRevision > 0
    )
      return;
    if (event.request.method === "currentTime/read") {
      void sendCodexAppServerResponse({
        ...event,
        effect: {
          type: "respond",
          method: "currentTime/read",
          requestId: event.request.id,
          response: { currentTimeAt: Math.floor(Date.now() / 1_000) },
        },
      } satisfies CodexNativeAutoResponseInput);
      return;
    }
    const threadId = "threadId" in event.request.params ? event.request.params.threadId : null;
    if (typeof threadId !== "string") return;
    const key = JSON.stringify([threadId, event.request.id]);
    const occurrences = this.nativeRequestOccurrences.get(key) ?? [];
    if (!occurrences.some((entry) => entry.occurrenceToken === event.occurrenceToken))
      this.nativeRequestOccurrences.set(key, [...occurrences, event]);
    if (this.streamState.getRole(threadId)?.role !== "owner") return;
    const buffer = this.nativeResumeBuffers.get(threadId);
    if (buffer) {
      if (buffer.generation === event.generation) buffer.notifications.push(event);
      return;
    }
    if (this.nativeGenerationByThread.get(threadId) !== event.generation) return;
    const before = this.conversationsById.get(threadId)?.canonicalState;
    if (!before) return;
    const receipt = new CodexConversationEntityDocument()
      .withCanonicalState(before)
      .mutate((draft) =>
        mutateCodexConversationEvent(
          draft,
          { type: "request", request: event.request },
          {
            now: Date.now,
            createId: () => crypto.randomUUID(),
            isOpenAIFormElicitationsEnabled: this.isOpenAIFormElicitationsEnabled(),
          },
        ),
      );
    if (!receipt) return;
    this.applyCanonicalDocument(receipt.after);
    this.streamState.broadcastPatches(threadId, receipt.patches);
    for (const effect of receipt.result) {
      if (effect.type === "respond")
        void sendCodexAppServerResponse({
          ...event,
          effect,
        } satisfies CodexNativeAutoResponseInput);
      if (effect.type === "dispatchDynamicToolCall") {
        const projectId = this.conversationsById.get(threadId)?.projectId ?? null;
        const serviceTier = readCodexServiceTier();
        void runConversationOperation(
          "codex:dynamic-tool-call:respond",
          threadId,
          event.request.id,
          {
            nativeOccurrence: event,
            permissionMode:
              this.permissionStateByScope.get(projectId)?.mode ?? DEFAULT_PERMISSION_STATE.mode,
            serviceTierSelector:
              serviceTier === "fast" ? { type: "custom", serviceTier } : { type: "standard" },
          },
        );
      }
    }
  }

  getStreamRole(conversationId: string): LocalConversationStreamRole | null {
    return this.streamState.getRole(conversationId);
  }

  async handleThreadFollowerRequest(
    request: ConversationFollowerRequest,
  ): Promise<{ method: string; result: unknown }> {
    const params = asRecord(request.params);
    if (typeof params?.conversationId !== "string")
      throw new Error("Conversation follower request is missing its conversation identity");
    this.assertOwnerForConversation(params.conversationId);
    if (request.method === "thread-follower-command-approval-decision") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-command-approval-decision"];
      this.assertOwnerForConversation(params.conversationId);
      await this.respondApprovalAsOwner(
        params.requestId,
        { kind: "command", decision: params.decision },
        params.conversationId,
      );
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-file-approval-decision") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-file-approval-decision"];
      this.assertOwnerForConversation(params.conversationId);
      await this.respondApprovalAsOwner(
        params.requestId,
        { kind: "file", decision: params.decision },
        params.conversationId,
      );
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-permissions-request-approval-response") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-permissions-request-approval-response"];
      this.assertOwnerForConversation(params.conversationId);
      await this.respondPermissionRequestAsOwner(
        params.requestId,
        params.response,
        params.conversationId,
      );
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-submit-user-input") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-submit-user-input"];
      this.assertOwnerForConversation(params.conversationId);
      await this.respondUserInputAsOwner(
        params.requestId,
        Object.fromEntries(
          Object.entries(params.response.answers).map(([id, answer]) => [
            id,
            answer?.answers ?? [],
          ]),
        ),
        params.conversationId,
      );
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-submit-mcp-server-elicitation-response") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-submit-mcp-server-elicitation-response"];
      this.assertOwnerForConversation(params.conversationId);
      await this.respondMcpElicitationAsOwner(
        params.requestId,
        params.response,
        params.conversationId,
      );
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-start-turn") {
      const { conversationId, turnStart } =
        request.params as ConversationFollowerParams["thread-follower-start-turn"];
      this.assertOwnerForConversation(conversationId);
      const prepared = await this.inspectOwnerTurnStart(turnStart);
      const clientUserMessageId = turnStart.request.clientUserMessageId;
      if (!clientUserMessageId) throw new Error("Prepared native turn identity missing");
      const result = await this.executeOwnerOptimisticTurnTransaction({
        threadId: conversationId,
        clientUserMessageId,
        canonicalParams: prepared.params,
        execution: prepared,
        turnContext: turnStart.context,
        request: (submission) =>
          this.executePreparedNativeTurn(turnStart, prepared.request, submission),
      });
      return { method: request.method, result: { result } };
    }
    if (request.method === "thread-follower-edit-last-user-turn") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-edit-last-user-turn"];
      await this.executeNativeEditAsOwner(params.conversationId, params as CanonicalEditOptions);
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-steer-turn") {
      const params = request.params as ConversationFollowerParams["thread-follower-steer-turn"];
      if (!params.clientUserMessageId) throw new Error("Steer preparation identity missing");
      const prepared = await runConversationOperation(
        "codex:turn:native-steer:inspect",
        params.clientUserMessageId,
      );
      const result = await this.executeNativeSteerAsOwner(prepared);
      return { method: request.method, result: { result } };
    }
    if (request.method === "thread-follower-interrupt-turn") {
      const params = request.params as ConversationFollowerParams["thread-follower-interrupt-turn"];
      try {
        const interruptedTurnId = await this.interruptNativeConversationAsOwner(
          params.conversationId,
          params.mode,
          params.expectedTurnId,
        );
        return { method: request.method, result: { interruptedTurnId, ok: true } };
      } catch (error) {
        if (
          params.mode !== "user-stop" ||
          !(error instanceof Error) ||
          !("interruptedTurnId" in error) ||
          typeof error.interruptedTurnId !== "string"
        )
          throw error;
        return {
          method: request.method,
          result: {
            interruptedTurnId: error.interruptedTurnId,
            goalPauseError: error.message,
            ok: true,
          },
        };
      }
    }
    if (request.method === "thread-follower-update-thread-settings") {
      const params =
        request.params as ConversationFollowerParams["thread-follower-update-thread-settings"];
      const applied = await this.updateNativeThreadSettingsAsOwner(
        params.conversationId,
        params.threadSettings as CanonicalThreadSettingsPatch,
        params.condition as CanonicalThreadSettingsCondition | undefined,
        params.activeTurnId,
      );
      return { method: request.method, result: { applied } };
    }
    if (request.method === "thread-follower-compact-thread") {
      const params = request.params as ConversationFollowerParams["thread-follower-compact-thread"];
      this.assertOwnerForConversation(params.conversationId);
      await this.compactThread(params.conversationId);
      return { method: request.method, result: { ok: true } };
    }
    if (request.method === "thread-follower-load-complete-history") {
      const params = request.params as { conversationId: string };
      this.assertOwnerForConversation(params.conversationId);
      const before = this.conversationsById.get(params.conversationId)?.canonicalState ?? null;
      const complete = before ? hasCompleteCanonicalConversationHistory(before) : false;
      const beforeRevision = this.streamState.getRevision(params.conversationId);
      await this.completeHistoryLoader.load(params.conversationId);
      const afterRevision = this.streamState.getRevision(params.conversationId);
      const revision =
        !complete && afterRevision !== null && afterRevision > (beforeRevision ?? 0)
          ? afterRevision
          : this.streamState.broadcastSnapshot(params.conversationId);
      if (revision === null)
        throw new Error("no-client-found: thread stream owner became unavailable");
      return {
        method: request.method,
        result: { revision },
      };
    }
    if (request.method === "thread-follower-set-queued-follow-ups-state") {
      const params =
        request.params as import("../../../shared/codex-thread-follower-request").ConversationFollowerParams["thread-follower-set-queued-follow-ups-state"];
      const messages = params.state[params.conversationId] ?? [];
      if (!messages.every(isCodexQueuedMessage)) throw new Error("Invalid queued messages");
      await this.queuedMessages.acceptFromFollower(params.conversationId, messages);
      return { method: request.method, result: { ok: true } };
    }
    throw new Error(`Unsupported conversation follower method: ${request.method}`);
  }

  receiveCoordination(
    method: ConversationCoordinationBroadcast,
    event: ConversationCoordinationEvent,
  ): void {
    receiveConversationStreamServiceEvent(this.streamState, this.hostId, method, event);
    const params = event.params as {
      hostId?: string;
      conversationId?: string;
    };
    if (params?.hostId !== this.hostId) return;
    const id = params.conversationId;
    if (!id) return;
    if (method === "threadQueuedFollowUpsChanged") {
      const messages: unknown =
        event.params !== null && typeof event.params === "object"
          ? Reflect.get(event.params, "messages")
          : null;
      if (Array.isArray(messages) && messages.every(isCodexQueuedMessage))
        this.queuedMessages.receiveBroadcast(event.sourceClientId, id, messages);
    }
    if (method === "threadUnarchived") this.archiveState.unsuppress(id);
    if (method === "threadArchived") {
      this.archiveState.suppress(id);
      this.historyItemLoader.cancelLoads(id);
      this.removeThreadLocalState(id);
    }
  }

  private installNativeThreadResponse(
    response:
      | import("@nodex/codex-app-server-protocol/v2").ThreadStartResponse
      | import("@nodex/codex-app-server-protocol/v2").ThreadForkResponse,
    resumeState: "resumed" | "needs_resume",
    workspaceKind?: CodexCanonicalConversationState["workspaceKind"],
  ): void {
    this.registerThreadMetadata(response.thread);
    const hydrated = createCodexCanonicalHydratedConversationState(response.thread, {
      hostId: this.hostId,
      model: response.model,
      reasoningEffort: response.reasoningEffort,
      cwd: response.cwd,
      approvalPolicy: response.approvalPolicy,
      approvalsReviewer: response.approvalsReviewer,
      sandboxPolicy: response.sandbox,
      activePermissionProfile: response.activePermissionProfile,
      runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
      latestThreadSettings: {
        cwd: response.cwd,
        model: response.model,
        effort: response.reasoningEffort,
        serviceTier: response.serviceTier,
        multiAgentMode: response.multiAgentMode,
        approvalPolicy: response.approvalPolicy,
        approvalsReviewer: response.approvalsReviewer,
        activePermissionProfile: response.activePermissionProfile,
        sandboxPolicy: response.sandbox,
      },
      hasUnreadTurn: false,
    });
    const canonical = reconcileCodexResumedConversationState({
      existing: null,
      resumed: hydrated,
      thread: response.thread,
      settingsPatch: {
        ...(hydrated.hydrationContext?.latestThreadSettings ?? {}),
        permissions: response.activePermissionProfile?.id ?? null,
      },
    });
    this.applyCanonicalDocument({ ...canonical, workspaceKind, resumeState });
  }

  private applyCanonicalDocument(state: CodexCanonicalConversationState): void {
    const current = this.conversationsById.get(state.id);
    const interruptionChanged =
      (latestResidentConversationTurn(current?.canonicalState)?.status === "interrupted") !==
      (latestResidentConversationTurn(state)?.status === "interrupted");
    const status = toOwnerThreadStatusPayload(state.id, state.threadRuntimeStatus);
    const summary = this.threadSummariesById.get(state.id);
    const rawMetadata = this.threadsById.get(state.id);
    const base: CodexConversationSnapshot = {
      threadId: state.id,
      projectId: summary?.projectId ?? null,
      source: state.parentThreadId ? { parentThreadId: state.parentThreadId } : null,
      threadName: state.title,
      threadPreview: summary?.threadPreview ?? "",
      cwd: state.cwd,
      statusType: status.statusType,
      statusActiveFlags: status.statusActiveFlags,
      archived: summary?.archived ?? false,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      linkedAt: summary?.linkedAt ?? "",
      turns: [],
      requests: [],
      resumeState: state.resumeState,
      queuedFollowUps: this.projectQueuedMessages(
        state.id,
        EMPTY_CODEX_QUEUED_FOLLOW_UP_PROJECTION,
      ),
      pendingSteers: [],
      backgroundTerminalRows: [],
      capabilityFlags: {
        canEditLastUserTurn: true,
        canForkFromTurn: true,
        canSearch: true,
        canCollapseTurns: true,
      },
    };
    const conversation: CodexConversationSnapshot = {
      ...base,
      ...current,
      canonicalState: state,
      threadName: state.title,
      cwd: state.cwd,
      projectId: summary?.projectId ?? current?.projectId ?? null,
      agentNickname: state.agentNickname,
      ephemeral: state.ephemeral,
      threadSource: state.threadSource,
      ...(rawMetadata
        ? { threadPreview: rawMetadata.preview, agentRole: rawMetadata.agentRole }
        : {}),
      ...(state.sideConversation !== undefined
        ? {
            source: {
              parentThreadId: null,
              ...(current?.source ?? base.source),
              sideConversation: state.sideConversation,
            },
          }
        : {}),
      statusType: status.statusType,
      statusActiveFlags: status.statusActiveFlags,
      threadRuntimeStatus: state.threadRuntimeStatus,
      modelProvider: state.modelProvider,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      resumeState: state.resumeState,
      latestTokenUsageInfo: state.latestTokenUsageInfo,
      threadGoal: state.threadGoal,
      completedThreadGoal: state.completedThreadGoal,
    };
    const nativeRequestIds = new Set(
      [...(current?.canonicalState?.requests ?? []), ...state.requests].map(
        (request) => request.id,
      ),
    );
    let projected = clearOwnerApprovalAttachments(
      {
        ...conversation,
        requests: conversation.requests.filter(
          (request) => !("requestId" in request) || !nativeRequestIds.has(request.requestId),
        ),
      },
      nativeRequestIds,
    );
    for (const request of state.requests)
      projected = projectOwnerServerRequestToConversation(projected, request);
    this.applyConversationSnapshot(
      state.id,
      materializeOwnerCanonicalConversationSnapshot(
        projectOwnerThreadSettingsToConversation(projected, state),
        current?.canonicalState,
      ),
    );
    if (interruptionChanged && this.isServerQueueSelected(state.id)) {
      this.refreshQueuedMessageProjection(state.id);
    }
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
    this.queuedExecution[Symbol.dispose]();
    this.queuedMessages[Symbol.dispose]();
    this.serverQueuedMessages[Symbol.dispose]();
    if (this.destroyed) return;
    this.destroyed = true;
    this.streamRecovery.dispose();
    for (const callback of this.disposalCallbacks) callback();
    this.disposalCallbacks.clear();
    this.manualCompactions.clearAll();
    this.goalHydrationTokens.clear();
    this.retention.dispose();
    this.nativeAppServer[Symbol.dispose]();
    this.archiveState.clear();
    this.completeHistoryLoader[Symbol.dispose]();
    this.historyItemLoader[Symbol.dispose]();
    this.streamState.dispose();
    this.nativeResumeBuffers.clear();
    this.nativeRequestOccurrences.clear();
    this.nativeGenerationByThread.clear();
    this.threadsById.clear();
    this.asyncQuestions.clear();
    this.cancelPendingNodexAgentAuthorizations();
    this.conversationActivity.clear();
    this.foregroundConversations.clear();
    this.ownerTextDeltaQueue.dispose();
    this.outputDeltaQueue.dispose();
    this.cancelPendingConversationResumes();
    this.conversationRemovedCallbacks.clear();
    this.attachmentStateByThreadId.clear();
    this.attachmentCallbacks.clear();
    this.interruptedTurnResumesInFlightByThreadId.clear();
    this.ownerHiddenLifecycleItemTypesByConversationId.clear();

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
      if (this.archiveState.isSuppressed(threadId)) continue;
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
    opts?: {
      includeArchived?: boolean;
    },
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
    opts?: {
      includeArchived?: boolean;
    },
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
    const models = await readNativeModelCatalog(this.nativeAppServer);
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
    return readNativeCollaborationModes(this.nativeAppServer);
  }

  async hydrateArchivedThreadPreview(threadId: string): Promise<boolean> {
    await this.refreshNativeHostContext();
    const hostContext = this.nativeHostContext;
    return this.archiveState.hydratePreview(threadId, {
      hasOrdinaryState: () =>
        this.conversationsById.has(threadId) || this.threadsById.has(threadId),
      hasConversation: () => this.conversationsById.has(threadId),
      hasPreviewHistory: () =>
        Boolean(this.conversationsById.get(threadId)?.canonicalState?.turnHistory),
      onSuppressed: () => this.notifyAnyConversationCallbacks({ forceMeta: true }),
      hydrate: async (isCurrent) => {
        const prepared = await runConversationOperation(
          "codex:thread:history-hydration:prepare",
          threadId,
        );
        if (prepared.context.hostId !== this.hostId)
          throw new Error("Archived history belongs to another host");
        const response = await this.nativeAppServer.request(
          "thread/read",
          { threadId, includeTurns: !this.supportsPaginatedHistory },
          { source: "thread_hydration" },
        );
        const page = this.supportsPaginatedHistory
          ? await listCanonicalHistoryTurns(this.historyClient, threadId, {
              limit: 5,
              itemsView: "full",
              sortDirection: "desc",
              requestOptions: { source: "thread_hydration" },
            })
          : null;
        if (!isCurrent() || this.destroyed || this.nativeHostContext !== hostContext) return;
        const rawTurns = page ? [...page.response.data].reverse() : response.thread.turns;
        const canonical = createCodexCanonicalHydratedConversationState(
          { ...response.thread, turns: rawTurns },
          { ...prepared.context, turnItemsPaginationById: page?.itemsPaginationByTurnId },
        );
        const receipt = new CodexConversationEntityDocument()
          .withCanonicalState(canonical)
          .mutate((draft) => {
            const turns = residentConversationTurns(draft);
            const cursor = page?.response.nextCursor ?? null;
            replaceCanonicalHistoryDraft(
              draft,
              turns,
              cursor === null,
              cursor === null ? null : { cursor, oldestLoadedTurnId: turns[0]?.turnId ?? null },
            );
            draft.resumeState = "needs_resume";
          });
        if (!receipt) return;
        this.applyThreadSummary(prepared.summary);
        this.registerThreadMetadata(response.thread);
        this.applyCanonicalDocument(receipt.after);
      },
    });
  }

  async requestThreadStreamSnapshot(threadId: string): Promise<CodexConversationSnapshot | null> {
    if (
      this.archiveState.isSuppressed(threadId) ||
      this.threadSummariesById.get(threadId)?.archived
    ) {
      await this.hydrateArchivedThreadPreview(threadId);
      return this.conversationsById.get(threadId) ?? null;
    }
    return this.conversationsById.get(threadId) ?? this.requestThreadStreamResume(threadId);
  }

  async requestThreadStreamResume(
    threadId: string,
    options: ConversationResumeOptions = {},
  ): Promise<CodexConversationSnapshot | null> {
    if (this.destroyed) throw new Error("Conversation manager is disposed");
    if (
      this.archiveState.isSuppressed(threadId) ||
      this.threadSummariesById.get(threadId)?.archived
    ) {
      await this.hydrateArchivedThreadPreview(threadId);
      return this.conversationsById.get(threadId) ?? null;
    }
    const source = options.source ?? "view";
    const canAcquireOwnership = () => this.canAcquireConversationOwnership(source);
    if (!this.streamState.getRole(threadId) && !canAcquireOwnership()) {
      this.ensureRecentConversationId(threadId);
      return null;
    }
    const existing = this.resumeInFlightByThreadId.get(threadId);
    if (existing) {
      if (existing.source === source || source === "recovery") return await existing.promise;
      let removed = false;
      const onRemoved = (id: string) => {
        if (id === threadId) removed = true;
      };
      this.conversationRemovedCallbacks.add(onRemoved);
      try {
        await existing.promise.catch(() => {});
        if (removed || this.destroyed) return null;
        return this.requestThreadStreamResume(threadId, options);
      } finally {
        this.conversationRemovedCallbacks.delete(onRemoved);
      }
    }

    let retryCleanup: (() => void) | undefined;
    let result: CodexConversationSnapshot | null = null;
    let failure: unknown;
    const cancel = () => {
      const cleanup = retryCleanup;
      retryCleanup = undefined;
      cleanup?.();
    };
    const isCurrent = (): boolean =>
      !this.destroyed && this.resumeInFlightByThreadId.get(threadId) === attempt;
    const attempt = {
      source,
      cancel,
      promise: Promise.resolve()
        .then(() =>
          this.runThreadStreamResume(
            threadId,
            options,
            {
              isCurrent,
              setRetryCleanup: (cleanup) => {
                retryCleanup = cleanup;
                if (!isCurrent()) cancel();
              },
            },
            canAcquireOwnership,
          ),
        )
        .then((value) => {
          result = value;
          return value;
        })
        .catch((error: unknown) => {
          failure = error;
          if (isCurrent()) {
            this.markConversationResumeState(threadId, "needs_resume");
            this.setConversationAttachmentState(
              threadId,
              makeLocalConversationAttachmentFailure(error),
            );
          }
          throw error;
        })
        .finally(() => {
          cancel();
          if (this.resumeInFlightByThreadId.get(threadId) === attempt) {
            this.streamRecovery.onResumeAttemptSettled(
              threadId,
              result?.resumeState === "resumed",
              failure,
            );
            this.resumeInFlightByThreadId.delete(threadId);
          }
        }),
    };
    this.resumeInFlightByThreadId.set(threadId, attempt);
    return await attempt.promise;
  }

  private cancelPendingConversationResumes(): void {
    const attempts = [...this.resumeInFlightByThreadId.values()];
    this.resumeInFlightByThreadId.clear();
    for (const attempt of attempts) attempt.cancel();
  }

  registerWindowActivity(activity: ConversationWindowActivity): Disposable & {
    update(activity: ConversationWindowActivity): void;
  } {
    if (this.destroyed) throw new Error("Conversation manager is disposed");
    return this.streamState.registerWindowActivity(activity, () => {
      for (const threadId of this.conversationsById.keys()) this.wakeQueuedMessages(threadId);
    });
  }

  getWindowActivity(): ConversationWindowActivity | undefined {
    return this.streamState.getWindowActivity();
  }

  onDispose(callback: () => void): Disposable {
    if (this.destroyed) callback();
    else this.disposalCallbacks.add(callback);
    return {
      [Symbol.dispose]: () => {
        this.disposalCallbacks.delete(callback);
      },
    };
  }

  private canAcquireConversationOwnership(source: ConversationResumeSource): boolean {
    return source === "executor"
      ? readRendererConversationWindowActivity().canAcquireThreadStream
      : (this.getWindowActivity()?.canAcquireThreadStream ?? true);
  }

  markAllConversationsNeedResumeAfterReconnect(options: ConversationReconnectOptions = {}): void {
    if (this.destroyed) return;
    this.streamRecovery.markAllConversationsNeedResumeAfterReconnect(options);
  }

  private resetConversationHistoryAfterReconnect(): void {
    this.historyItemLoader.cancelLoads();
    this.completeHistoryLoader.resetAfterReconnect();
    this.historyPageLoadsInFlightByTarget.clear();
    this.threadsById.clear();
    for (const id of this.conversationsById.keys()) {
      this.historyClient.updateConversation(id, (draft) => {
        draft.connectedEnvironmentIds = undefined;
        if (draft.turnHistory?.kind !== "canonical") return;
        draft.turnHistory.history.generation += 1;
        draft.turnHistory.history.isComplete = false;
      });
    }
  }

  /** Revokes native work synchronously, before any replacement identity is loaded. */
  retireNativeHostContext(): void {
    if (this.destroyed) return;
    this.suspendedNativeHostContext = null;
    this.invalidateNativeRequests();
    this.markAllConversationsNeedResumeAfterReconnect();
    for (const id of this.conversationsById.keys())
      this.setConversationAttachmentState(id, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
  }

  private suspendNativeConnection(options?: { readonly preserveHostContextLoad?: boolean }): void {
    this.suspendedNativeHostContext ??= this.nativeHostContext;
    this.streamRecovery.dispose();
    this.invalidateNativeRequests(options);
  }

  private invalidateNativeRequests(options?: { readonly preserveHostContextLoad?: boolean }): void {
    this.nativeHostContextRevision += 1;
    this.nativeHostContext = null;
    if (options?.preserveHostContextLoad !== true) this.nativeHostContextLoad = null;
    this.nativeAppServer.retire();
    this.cancelPendingConversationResumes();
    this.settingsUpdates.clear();
    this.nativeSettingsSupport = "unknown";
    this.serverQueuedMessages.retire();
    this.nativeResumeBuffers.clear();
    this.nativeRequestOccurrences.clear();
    this.goalHydrationTokens.clear();
    this.nativeGenerationByThread.clear();
    for (const id of this.conversationsById.keys()) {
      this.ownerTextDeltaQueue.discardConversation(id);
      this.outputDeltaQueue.discardConversation(id);
      this.terminalInputBuffers.clearConversation(id);
      this.manualCompactions.clear(id);
    }
  }

  private async refreshNativeHostContext(): Promise<void> {
    if (this.nativeHostContextLoad) return this.nativeHostContextLoad;
    const revision = this.nativeHostContextRevision;
    const load = (async () => {
      const context = await runConversationOperation("codex:app-server:host-context", this.hostId);
      if (this.destroyed) throw new Error("Conversation manager disposed during host bootstrap");
      if (this.nativeHostContextRevision !== revision)
        throw new Error("Conversation manager retired during host bootstrap");
      if (context.hostId !== this.hostId) throw new Error("Host bootstrap returned another host");
      const previous = this.nativeHostContext ?? this.suspendedNativeHostContext;
      const sameIdentity =
        previous !== null &&
        previous.sourceEpoch === context.sourceEpoch &&
        JSON.stringify(previous.accountContext) === JSON.stringify(context.accountContext);
      const unchanged =
        sameIdentity &&
        previous === this.nativeHostContext &&
        previous.generation === context.generation;
      const restoreStreams =
        sameIdentity &&
        !unchanged &&
        this.connection.native?.transportKind === "websocket" &&
        this.connection.native.sourceEpoch === context.sourceEpoch;
      if (previous && !unchanged) {
        if (restoreStreams) this.suspendNativeConnection({ preserveHostContextLoad: true });
        else this.retireNativeHostContext();
      }
      // Pending hydration captures this identity, so an unchanged refresh must preserve it.
      this.nativeHostContext = unchanged ? previous : context;
      this.suspendedNativeHostContext = null;
      this.supportsPaginatedHistory = context.supportsPaginatedHistory;
      if (restoreStreams)
        this.markAllConversationsNeedResumeAfterReconnect({
          restoreStreams: true,
          foregroundConversationId: [...this.foregroundConversations.values()].at(-1) ?? null,
        });
    })();
    this.nativeHostContextLoad = load;
    try {
      await load;
    } finally {
      if (this.nativeHostContextLoad === load) this.nativeHostContextLoad = null;
    }
  }

  private async readResumedThreadGoal(
    threadId: string,
    requestOptions?: CodexRendererNativeRequestOptions,
  ): Promise<{ ok: true; goal: ThreadGoal | null } | { ok: false }> {
    try {
      return { ok: true, goal: await this.getThreadGoal(threadId, requestOptions) };
    } catch (error) {
      console.warn("Failed to hydrate thread goal after resume", { threadId, error });
      return { ok: false };
    }
  }

  private async runThreadStreamResume(
    threadId: string,
    options: ConversationResumeOptions,
    lifetime: ConversationResumeRequestLifetime,
    canAcquireOwnership: () => boolean,
  ): Promise<CodexConversationSnapshot | null> {
    if (!lifetime.isCurrent()) return null;
    const showGoalConfirmation = options.showThreadGoalResumeConfirmation === true;
    const isReconnectRecovery = options.isReconnectRecovery === true;
    const cannotAcquire = () => !this.streamState.getRole(threadId) && !canAcquireOwnership();
    if (cannotAcquire()) return null;
    await this.refreshNativeHostContext();
    if (!lifetime.isCurrent()) return null;
    if (cannotAcquire()) return null;
    const metadataHostContext = this.nativeHostContext;
    const requestOptions = conversationResumeRequestOptions(isReconnectRecovery, options.timeoutMs);
    const { priority } = requestOptions;
    const goalRequestOptions =
      showGoalConfirmation || isReconnectRecovery
        ? { source: "thread_hydration" as const, priority }
        : undefined;
    const previousRole = this.streamState.getRole(threadId);
    const existing = this.historyClient.getConversation(threadId);
    if (previousRole?.role === "follower" && existing?.resumeState !== "resumed") return null;
    if (previousRole && existing && existing.resumeState !== "needs_resume") {
      this.setConversationAttachmentState(threadId, { status: "attached" });
      return this.conversationsById.get(threadId) ?? null;
    }
    this.setConversationAttachmentState(threadId, { status: "attaching" });
    const [metadata, workspace] = await Promise.all([
      this.nativeAppServer
        .request(
          "thread/read",
          { threadId, includeTurns: false },
          { source: "thread_hydration", priority, timeoutMs: 30_000 },
        )
        .then((result) => result.thread)
        .catch(() => null),
      runConversationOperation("codex:thread:history-hydration:prepare", threadId),
    ]);
    if (!lifetime.isCurrent() || this.nativeHostContext !== metadataHostContext)
      throw new Error("Conversation manager retired during resume metadata read");
    this.markConversationResumeState(threadId, "resuming");
    if (metadata) this.registerThreadMetadata(metadata);
    const workspaceRoots = options.workspaceRoots ?? workspace.context.runtimeWorkspaceRoots;
    const preparation = canonicalResumePreparation(this.historyClient.getConversation(threadId), {
      cwd: workspace.context.cwd ?? null,
      metadataCwd: metadata?.cwd ?? null,
      resumeWorkspaceRoots: workspaceRoots,
      permissions: {
        approvalPolicy: workspace.context.approvalPolicy,
        approvalsReviewer: workspace.context.approvalsReviewer,
        sandboxPolicy: workspace.context.sandboxPolicy,
        activePermissionProfile: workspace.context.activePermissionProfile,
        runtimeWorkspaceRoots: workspace.context.runtimeWorkspaceRoots,
      },
    });
    const prepared = await runConversationOperation(
      "codex:thread:resume:prepare",
      threadId,
      metadata,
      preparation.overrides,
      {
        permissions: options.permissions,
        useAppServerPermissionDefault: options.useAppServerPermissionDefault,
        preserveServerConfiguration: options.preserveServerConfiguration,
        serviceTier: options.serviceTier,
        workspaceRoots: options.workspaceRoots,
        collaborationMode: options.collaborationMode,
      },
    );
    const permissionContext = prepareConversationResumePermissionContext({
      preparation,
      request: prepared.params,
      hostId: this.hostId,
      status: metadata?.status,
      options,
    });
    const goalToken = Symbol();
    const hostContext = metadataHostContext;
    const resumeBuffer = {
      generation: prepared.generation,
      notifications: [] as (CodexNativeNotificationMessage | CodexNativeRequestMessage)[],
    };
    const isCurrent = () =>
      !this.destroyed &&
      this.nativeHostContext === hostContext &&
      this.goalHydrationTokens.get(threadId) === goalToken;
    try {
      if (
        !lifetime.isCurrent() ||
        this.nativeHostContext !== hostContext ||
        prepared.generation !== hostContext?.generation
      )
        throw new Error("Conversation manager retired during resume preparation");
      if (prepared.hostId !== this.hostId) throw new Error("Resume execution host changed");
      if (cannotAcquire()) {
        if (this.historyClient.getConversation(threadId)?.resumeState === "resuming")
          this.markConversationResumeState(threadId, "needs_resume");
        this.setConversationAttachmentState(threadId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
        return null;
      }
      // Active views can receive the owner's snapshot while native preparation is pending.
      // That snapshot already supplies the ordinary host's live conversation.
      const role = this.streamState.getRole(threadId);
      if (role?.role === "follower") {
        if (this.historyClient.getConversation(threadId)?.resumeState === "resuming")
          this.markConversationResumeState(threadId, "resumed");
        this.setConversationAttachmentState(threadId, { status: "attached" });
        return this.conversationsById.get(threadId) ?? null;
      }
      this.goalHydrationTokens.set(threadId, goalToken);
      this.applyThreadSummary(prepared.summary);
      if (!role) this.streamState.setRole(threadId, { role: "owner" });
      this.supportsPaginatedHistory = prepared.supportsPaginatedHistory;
      this.nativeGenerationByThread.set(threadId, prepared.generation);
      this.nativeResumeBuffers.set(threadId, resumeBuffer);
      const environmentSelectionEvidenceAtDispatch =
        this.historyClient.getConversation(threadId)?.environmentSelectionEvidence;
      const response = await requestRendererConversationResume(
        this.nativeAppServer,
        prepared,
        { ...lifetime, isCurrent: () => lifetime.isCurrent() && isCurrent() },
        requestOptions.timeoutMs,
        priority,
      );
      if (response === null) return null;
      if (!lifetime.isCurrent() || !isCurrent() || response.thread.id !== threadId)
        throw new Error("Resume response no longer belongs to this manager");
      const goalResult = showGoalConfirmation
        ? await this.readResumedThreadGoal(threadId, goalRequestOptions)
        : { ok: false as const };
      if (!lifetime.isCurrent() || !isCurrent()) throw new Error("Resume goal hydration retired");
      const previous = this.historyClient.getConversation(threadId);
      const cwd =
        resolveCodexCanonicalHydratedCwd({
          requestedCwd: prepared.requestedCwd,
          responseCwd: response.cwd,
          threadCwd: response.thread.cwd,
          fallbackCwd: workspace.context.cwd ?? null,
        }) ?? "/";
      this.registerThreadMetadata({ ...response.thread, cwd });
      const thread = { ...response.thread, cwd, turns: [] };
      const permissions = resolveConversationResumePermissions(response, permissionContext);
      const canonicalBase = createCodexCanonicalHydratedConversationState(thread, {
        hostId: this.hostId,
        model: response.model,
        reasoningEffort: response.reasoningEffort,
        cwd,
        ...permissions,
        runtimeWorkspaceRoots: [...permissions.runtimeWorkspaceRoots],
        latestThreadSettings: {
          cwd,
          model: response.model,
          effort: response.reasoningEffort,
          serviceTier: response.serviceTier,
          multiAgentMode: response.multiAgentMode,
          approvalPolicy: permissions.approvalPolicy,
          approvalsReviewer: permissions.approvalsReviewer,
          activePermissionProfile: permissions.activePermissionProfile,
          sandboxPolicy: permissions.sandboxPolicy,
        },
        hasUnreadTurn:
          this.savedReadState?.has(threadId) ?? prepared.summary.hasUnreadTurn ?? false,
      });
      const canonical =
        options.collaborationMode == null
          ? canonicalBase
          : {
              ...canonicalBase,
              latestCollaborationMode: {
                mode: "default" as const,
                settings: {
                  ...options.collaborationMode.settings,
                  model: canonicalBase.latestModel,
                  reasoning_effort: canonicalBase.latestReasoningEffort,
                },
              },
            };
      const resumeSettingsPatch: CanonicalThreadSettingsPatch = {
        ...(canonical.hydrationContext?.latestThreadSettings ?? {}),
        permissions: permissions.activePermissionProfile?.id ?? null,
        ...(options.collaborationMode == null
          ? {}
          : {
              collaborationMode: {
                mode: "default" as const,
                settings: {
                  ...options.collaborationMode.settings,
                  model: canonical.latestModel,
                  reasoning_effort: canonical.latestReasoningEffort,
                },
              },
            }),
      };
      const retained = reconcileCodexResumedConversationState({
        existing: previous ?? null,
        resumed: canonical,
        thread: response.thread,
        catalogTitle: prepared.summary.threadName,
        settingsPatch: resumeSettingsPatch,
        preserveResidentHistory: true,
      });
      const acceptedEnvironmentSelection = resolveCodexAcceptedThreadEnvironmentSelection(
        response.thread,
        previous ?? retained,
        environmentSelectionEvidenceAtDispatch,
      );
      // Host and preparation select history before response metadata can change it.
      const durableHost = prepared.hostId === "durable";
      const paginated =
        !durableHost &&
        prepared.supportsPaginatedHistory &&
        prepared.params.initialTurnsPage == null;
      this.applyCanonicalDocument({
        ...retained,
        ...acceptedEnvironmentSelection,
        resumeState: "resuming",
        threadGoal: goalResult.ok ? goalResult.goal : previous?.threadGoal,
        completedThreadGoal: previous?.completedThreadGoal,
        threadGoalResumeConfirmation: goalResult.ok
          ? goalResult.goal &&
            ["paused", "blocked", "usageLimited"].includes(goalResult.goal.status)
            ? goalResult.goal
            : null
          : previous?.threadGoalResumeConfirmation,
        paginatedHistory: paginated
          ? {
              turnsBackwardsCursor: response.turnsBackwardsCursor,
              itemsBackwardsCursor: response.itemsBackwardsCursor,
            }
          : undefined,
      });
      // Preparation selects the history contract. New response metadata must not
      // discard a requested legacy page or reinterpret its remaining cursor.
      const page = durableHost
        ? await listCanonicalHistoryTurns(this.historyClient, threadId, {
            cursor: null,
            limit: 5,
            sortDirection: "desc",
            itemsView: "full",
            requestOptions: { source: "thread_hydration", priority },
          })
        : paginated
          ? response.turnsBackwardsCursor == null
            ? { response: { data: [], nextCursor: null }, itemsPaginationByTurnId: {} }
            : await listCanonicalHistoryTurns(this.historyClient, threadId, {
                cursor: response.turnsBackwardsCursor,
                limit: 5,
                sortDirection: "desc",
                itemsView: "full",
                requestOptions: { source: "thread_hydration", priority },
              })
          : response.initialTurnsPage
            ? { response: response.initialTurnsPage, itemsPaginationByTurnId: {} }
            : null;
      const legacy =
        page === null
          ? await this.nativeAppServer.request(
              "thread/read",
              { threadId, includeTurns: true },
              { source: "thread_hydration", priority },
            )
          : null;
      if (!lifetime.isCurrent() || !isCurrent())
        throw new Error("Resume history hydration retired");
      // Durable acceptance may yield to another peer's snapshot. Complete that I/O before
      // the final canonical transition, owner assignment, ingress replay and publication.
      await runConversationOperation("codex:thread:resume:accept", prepared.receiptId);
      if (!lifetime.isCurrent() || !isCurrent())
        throw new Error("Resume manager retired during durable acceptance");
      const rawTurns = page
        ? ([...page.response.data].reverse() as Thread["turns"])
        : (legacy?.thread.turns ?? []);
      const pageTurns = this.historyClient.mapTurns(
        threadId,
        rawTurns,
        page?.itemsPaginationByTurnId ?? {},
      );
      const turns = durableHost
        ? mergeCodexCanonicalTurnStates(
            pageTurns,
            this.historyClient.mapTurns(threadId, response.thread.turns, {}),
            () => ({ preserveExistingTerminalState: true }),
          )
        : pageTurns;
      const olderCursor = page?.response.nextCursor ?? null;
      const oldestLoadedTurnId = page
        ? (turns.find((turn) => turn.turnId !== null)?.turnId ?? null)
        : null;
      this.historyClient.updateConversation(
        threadId,
        (draft) => {
          const merged = mergeCodexCanonicalTurnStates(
            residentConversationTurns(draft),
            turns,
            () => ({ isResumeSnapshot: paginated }),
          );
          replaceCanonicalHistoryDraft(
            draft,
            merged,
            olderCursor === null,
            olderCursor === null ? null : { cursor: olderCursor, oldestLoadedTurnId },
          );
          refreshResumedConversationTurnParams(draft, response, cwd);
          draft.turnsPagination = {
            olderCursor,
            oldestLoadedTurnId,
            isLoadingOlder: false,
            hasLoadedOldest: olderCursor === null,
          };
          draft.resumeState = "resumed";
        },
        false,
      );
      this.streamState.setRole(threadId, { role: "owner" });
      let goalHydration: Promise<void> | null = null;
      if (!showGoalConfirmation) {
        const previousGoal = this.historyClient.getConversation(threadId)?.threadGoal;
        goalHydration = this.readResumedThreadGoal(threadId, goalRequestOptions).then((result) => {
          if (
            !result.ok ||
            !isCurrent() ||
            this.historyClient.getConversation(threadId)?.threadGoal !== previousGoal
          )
            return;
          this.historyClient.updateConversation(threadId, (draft) => {
            draft.threadGoal = result.goal;
            draft.threadGoalResumeConfirmation = null;
          });
        });
      }
      const buffered = this.nativeResumeBuffers.get(threadId)?.notifications ?? [];
      this.nativeResumeBuffers.delete(threadId);
      for (const event of buffered) {
        if (event.type === "nativeRequest") this.receiveNativeRequest(event);
        else this.receiveNativeNotification(event);
      }
      this.streamState.broadcastSnapshot(threadId);
      const drainRemainingHistory =
        allowsAutomaticResumeHistoryDrain({
          hostId: this.hostId,
          tailHydration: prepared.params.excludeTurns === true,
          paginated,
          requested: true,
          reconnectRecovery: isReconnectRecovery,
          suppressed: prepared.supportsPaginatedHistory,
        }) && this.historyClient.getConversation(threadId)?.turnsPagination?.olderCursor != null;
      const finishGoalHydration = () => {
        if (!isCurrent()) return;
        this.goalHydrationTokens.delete(threadId);
        if (!drainRemainingHistory) return;
        void this.completeHistoryLoader.load(threadId).catch((error: unknown) => {
          console.warn("Failed to load remaining thread turns after resume", { threadId, error });
        });
      };
      if (goalHydration)
        void goalHydration.then(finishGoalHydration).finally(() => {
          if (this.goalHydrationTokens.get(threadId) === goalToken)
            this.goalHydrationTokens.delete(threadId);
        });
      else finishGoalHydration();
      this.setConversationAttachmentState(threadId, { status: "attached" });
      return this.conversationsById.get(threadId) ?? null;
    } catch (error) {
      if (this.goalHydrationTokens.get(threadId) === goalToken) {
        this.goalHydrationTokens.delete(threadId);
        this.markConversationResumeState(threadId, "needs_resume");
      }
      throw error;
    } finally {
      if (this.nativeResumeBuffers.get(threadId) === resumeBuffer)
        this.nativeResumeBuffers.delete(threadId);
      await runConversationOperation("codex:thread:resume:release", prepared.receiptId).catch(
        () => {},
      );
    }
  }

  private markConversationResumeState(
    threadId: string,
    resumeState: CodexConversationSnapshot["resumeState"],
  ): void {
    const conversation = this.conversationsById.get(threadId);
    if (
      !conversation ||
      (conversation.resumeState === resumeState &&
        (!conversation.canonicalState || conversation.canonicalState.resumeState === resumeState))
    ) {
      return;
    }

    this.applyConversationSnapshot(threadId, {
      ...conversation,
      resumeState,
      canonicalState: conversation.canonicalState
        ? { ...conversation.canonicalState, resumeState }
        : conversation.canonicalState,
    });
  }

  retainActiveConversation(threadId: string, options: { foreground?: boolean } = {}): Disposable {
    if (this.destroyed) throw new Error("Conversation manager is disposed");
    void this.loadQueuedMessages(threadId).catch((error: unknown) =>
      console.error("Queue load failed", error),
    );
    const activity = this.conversationActivity.retain(threadId);
    const token = Symbol();
    if (options.foreground) this.foregroundConversations.set(token, threadId);
    return {
      [Symbol.dispose]: () => {
        this.foregroundConversations.delete(token);
        activity[Symbol.dispose]();
      },
    };
  }

  private async applyThreadActivity(threadId: string, active: boolean): Promise<boolean> {
    this.streamState.setFollowing(threadId, active);
    this.retention.activityChanged(threadId, active);
    return true;
  }

  async setThreadStreamFollowing(threadId: string, following: boolean): Promise<boolean> {
    return this.setThreadStreamFollowingWithOptions(threadId, following);
  }

  private async setThreadStreamFollowingWithOptions(
    threadId: string,
    following: boolean,
    options: { reannounce?: boolean } = {},
  ): Promise<boolean> {
    this.streamState.setFollowing(threadId, following);
    if (options.reannounce)
      await (
        await getConversationCoordinationHost()
      ).threadStreamFollowingChanged({
        params: { hostId: this.hostId, conversationId: threadId, following },
      });
    return true;
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

  async loadPromptRailIndex(
    input: CodexPromptRailIndexRequest,
  ): Promise<CodexPromptRailIndexCommandResult> {
    await this.refreshNativeHostContext();
    const generation = this.nativeHostContext?.generation;
    if (generation === undefined) return { status: "cancelled", requestId: input.requestId };
    const result = await loadCanonicalPromptRailIndex(this.historyClient, input.threadId);
    if (this.destroyed || this.nativeHostContext?.generation !== generation)
      return { status: "cancelled", requestId: input.requestId };
    return {
      status: "completed",
      requestId: input.requestId,
      expectedTopologyGeneration: input.expectedTopologyGeneration,
      index: {
        threadId: input.threadId,
        hostId: this.hostId,
        generation,
        shells: result.items,
        complete: result.complete,
        truncatedBy: result.complete ? null : "page-budget",
        approximateBytes: 0,
        loadedAtMs: Date.now(),
      },
    };
  }

  async revealPromptRail(
    input: CodexPromptRailRevealRequest,
  ): Promise<CodexPromptRailRevealCommandResult> {
    await this.refreshNativeHostContext();
    if (input.hostId !== this.hostId || this.nativeHostContext?.generation !== input.generation)
      return { status: "cancelled", requestId: input.requestId };
    const target = input.target;
    const shell =
      target.kind === "shell"
        ? target.shell
        : (await loadCanonicalPromptRailIndex(this.historyClient, input.threadId)).items.find(
            (item) => item.turnId === target.turnId,
          );
    if (!shell) return { status: "cancelled", requestId: input.requestId };
    const preview = await previewCanonicalPromptRailTurn(this.historyClient, input.threadId, shell);
    if (!preview || this.destroyed || this.nativeHostContext?.generation !== input.generation)
      return { status: "cancelled", requestId: input.requestId };
    return {
      status: "completed",
      requestId: input.requestId,
      expectedTopologyGeneration: input.expectedTopologyGeneration,
      reveal: {
        threadId: input.threadId,
        hostId: this.hostId,
        generation: input.generation,
        turnId: shell.turnId,
        topologyGeneration: input.expectedTopologyGeneration,
        ...preview,
      },
    };
  }

  async preparePromptRailNavigation(reveal: CodexPromptRailReveal): Promise<void> {
    const item = reveal.previews[0];
    if (!item) return;
    await this.hydratePersistedHistoryOccurrence({
      threadId: reveal.threadId,
      hostId: reveal.hostId,
      hostGeneration: reveal.generation,
      topologyGeneration: reveal.topologyGeneration,
      occurrence: {
        turnId: reveal.turnId,
        itemId: item.itemId,
        turnCursor: reveal.turnCursor,
        snippet: "",
        snippetMatchRange: { start: 0, end: 0 },
      },
    });
  }

  requestHistoryPage(
    request: CodexConversationHistoryPageRequest,
  ): Promise<LocalHistoryPageResult> {
    const key = codexConversationHistoryPageRequestKey(request);
    const existing = this.historyPageLoadsInFlightByTarget.get(key);
    if (existing) return existing;

    const loadPromise = this.loadHistoryPage(request);

    this.historyPageLoadsInFlightByTarget.set(key, loadPromise);
    const release = () => {
      if (this.historyPageLoadsInFlightByTarget.get(key) === loadPromise) {
        this.historyPageLoadsInFlightByTarget.delete(key);
      }
    };
    void loadPromise.then(release, release);
    return loadPromise;
  }

  private async loadHistoryPage(
    request: CodexConversationHistoryPageRequest,
  ): Promise<LocalHistoryPageResult> {
    const { threadId, target } = request;
    if (target.kind === "turnBoundary") {
      const status = await loadCanonicalHistoryBoundaryPage(
        this.historyClient,
        threadId,
        target.boundary,
      );
      return { status };
    }
    const before = this.historyClient.getConversation(threadId);
    const turn = residentConversationTurns(before).find(
      (entry) => entry.turnId === target.items.turnId,
    );
    if (!turn?.itemsPagination) return { status: "stale" };
    await this.historyItemLoader.loadTurnItems(threadId, target.items.turnId);
    return { status: "applied" };
  }

  async hydratePersistedHistoryOccurrence(
    input: CodexPersistedHistoryOccurrenceHydrateInput,
  ): Promise<CodexPersistedHistoryOccurrenceResolution> {
    await this.refreshNativeHostContext();
    if (
      input.hostId !== this.hostId ||
      this.nativeHostContext?.generation !== input.hostGeneration
    ) {
      throw new Error("History search belongs to an unavailable host generation");
    }
    await hydrateCanonicalHistorySearchMatch(
      this.historyClient,
      {
        conversationId: input.threadId,
        itemId: input.occurrence.itemId,
        turnId: input.occurrence.turnId,
        turnCursor: input.occurrence.turnCursor,
      },
      () => crypto.randomUUID(),
    );
    return {
      status: "found",
      threadId: input.threadId,
      turnId: input.occurrence.turnId,
      itemId: input.occurrence.itemId,
      topologyGeneration:
        this.historyClient.getConversation(input.threadId)?.turnHistory?.history.generation ??
        input.topologyGeneration,
    };
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
        launchId: input.firstSubmission.launchId,
        projectId: input.projectId,
        sessionId: input.sessionId,
        runInTarget,
        threadId: null,
        phase: "startingThread",
        message: "Sending message…",
        clearOutput: true,
        updatedAt: Date.now(),
      });
    }

    try {
      await this.loadPermissionState(input.projectId);
      const launchInput = {
        ...input,
        executionHostId: input.executionHostId ?? this.hostId,
        permissionMode: this.readPermissionMode(input.projectId),
      };
      const result =
        runInTarget === "newWorktree"
          ? await runConversationOperation("codex:thread:start-for-session", launchInput)
          : await this.startNativeSessionThread(launchInput);

      if (result.kind === "started") {
        if (result.freshLaunch) {
          if (
            result.freshLaunch.launchId !== input.firstSubmission.launchId ||
            result.freshLaunch.clientUserMessageId !== input.firstSubmission.clientUserMessageId
          ) {
            throw new Error("Fresh Thread launch identity did not match its admitted submission");
          }
          await this.adoptFreshThreadLaunch(input.projectId, input.sessionId, result.freshLaunch);
        } else {
          await this.requestThreadStreamSnapshot(result.detail.threadId).catch(() => null);
        }
      }
      return result;
    } catch (error) {
      if (!reportsDirectThreadProgress) throw error;
      const currentProgress = this.threadStartProgressByTarget.get(progressTargetKey);
      if (currentProgress?.phase !== "failed") {
        this.applyThreadStartProgress({
          launchId: input.firstSubmission.launchId,
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

  private async startNativeSessionThread(
    input: CodexThreadStartForSessionInput,
  ): Promise<CodexThreadStartForSessionResult> {
    const clientUserMessageId = input.firstSubmission.clientUserMessageId;
    codexTurnFirstResponseTracker.markThreadCreationStarted(clientUserMessageId, "regular");
    await this.refreshNativeHostContext();
    const hostContext = this.nativeHostContext;
    let prepared: import("../../../shared/codex-native-thread-start").CodexNativeSessionLaunchPreparation;
    try {
      prepared = await runConversationOperation("codex:thread:native-session:prepare", input);
    } catch (error) {
      codexTurnFirstResponseTracker.fail(clientUserMessageId, "submit_preparation_failed");
      throw error;
    }
    try {
      if (
        this.destroyed ||
        this.nativeHostContext !== hostContext ||
        prepared.generation !== hostContext?.generation
      )
        throw new Error("Starting conversation manager retired during preparation");
      codexTurnFirstResponseTracker.markThreadInputsReady(clientUserMessageId);
      codexTurnFirstResponseTracker.markRequestDispatched(clientUserMessageId, "thread/start");
      const response = await this.nativeAppServer.executeSessionThread(prepared, {
        clientUserMessageId,
        trace: codexTurnFirstResponseTracker.getTrace(clientUserMessageId),
      });
      if (
        this.destroyed ||
        prepared.hostId !== this.hostId ||
        this.nativeHostContext !== hostContext
      )
        throw new Error("Starting conversation manager retired");
      codexTurnFirstResponseTracker.bindConversation(clientUserMessageId, response.thread.id);
      codexTurnFirstResponseTracker.markThreadCreated(clientUserMessageId);
      this.nativeGenerationByThread.set(response.thread.id, prepared.generation);
      this.streamState.setRole(response.thread.id, { role: "owner" });
      this.installNativeThreadResponse(response, "resumed");
      this.streamState.broadcastSnapshot(response.thread.id);
      const accepted = await runConversationOperation(
        "codex:thread:native-session:accept",
        prepared.receiptId,
      );
      if (this.destroyed || this.nativeHostContext !== hostContext)
        throw new Error("Starting conversation manager retired during acceptance");
      if (accepted.kind === "started") this.applyThreadSummary(accepted.detail);
      return accepted;
    } finally {
      await runConversationOperation("codex:thread:native-session:release", prepared.receiptId);
    }
  }

  private async adoptFreshThreadLaunch(
    projectId: string | null,
    sessionId: string,
    launch: NonNullable<
      Extract<
        CodexThreadStartForSessionResult,
        {
          kind: "started";
        }
      >["freshLaunch"]
    >,
  ): Promise<void> {
    await this.refreshNativeHostContext();
    const hostContext = this.nativeHostContext;
    sessionFirstSubmissionOwner.update(launch.launchId, {
      threadId: launch.threadId,
      phase: "adoptingOwner",
    });
    this.setConversationAttachmentState(launch.threadId, {
      status: "attaching",
    });
    try {
      const result = await runConversationOperation(
        "codex:thread:fresh-owner:adopt",
        launch.threadId,
        launch.launchId,
      );
      if (
        result.hostId !== this.hostId ||
        result.response.thread.id !== launch.threadId ||
        this.nativeHostContext !== hostContext ||
        result.generation !== hostContext?.generation ||
        this.destroyed
      )
        throw new Error("Fresh thread response belongs to a retired owner");
      this.nativeGenerationByThread.set(launch.threadId, result.generation);
      this.streamState.setRole(launch.threadId, { role: "owner" });
      this.installNativeThreadResponse(result.response, "resumed");
      this.streamState.broadcastSnapshot(launch.threadId);
      this.setConversationAttachmentState(launch.threadId, {
        status: "attached",
      });
    } catch (error) {
      sessionFirstSubmissionOwner.fail(launch.launchId, {
        stage: "adoptingOwner",
        message: error instanceof Error ? error.message : "Message could not be sent.",
      });
      this.streamState.setRole(launch.threadId, null);
      this.setConversationAttachmentState(
        launch.threadId,
        makeLocalConversationAttachmentFailure(error),
      );
      throw error;
    }

    try {
      const operation = await runConversationOperation(
        "codex:turn:native-fresh:prepare",
        launch.threadId,
        launch.launchId,
      );
      const prepared = await this.inspectOwnerTurnStart(operation);
      if (this.destroyed || this.nativeHostContext !== hostContext)
        throw new Error("Fresh turn preparation belongs to a retired owner");
      // The transaction commits and synchronously notifies the optimistic turn
      // before returning this transport-completion promise.
      const firstTurnCompletion = this.executeOwnerOptimisticTurnTransaction({
        threadId: launch.threadId,
        clientUserMessageId: launch.clientUserMessageId,
        canonicalParams: prepared.params,
        execution: prepared,
        turnContext: operation.context,
        request: (submission) =>
          this.executePreparedNativeTurn(operation, prepared.request, submission, (options) =>
            this.nativeAppServer.executeFreshTurn(
              launch.threadId,
              launch.launchId,
              prepared.request,
              options,
            ),
          ),
        onOptimisticCommitted: () => {
          this.commitRendererFreshLaunchReady(
            launch.launchId,
            projectId,
            sessionId,
            launch.threadId,
          );
        },
        optimisticNotifyMode: "sync",
      });
      await firstTurnCompletion;
    } catch (error) {
      sessionFirstSubmissionOwner.fail(launch.launchId, {
        stage: "startingTurn",
        message: error instanceof Error ? error.message : "Message could not be sent.",
      });
      const current = this.readThreadStartProgress(projectId, sessionId);
      if (current?.phase !== "failed") {
        this.applyThreadStartProgress({
          launchId: launch.launchId,
          projectId,
          sessionId,
          runInTarget: current?.runInTarget ?? "localProject",
          threadId: launch.threadId,
          phase: "failed",
          message: "Message could not be sent.",
          updatedAt: Date.now(),
        });
      }
      throw error;
    } finally {
      await runConversationOperation("codex:turn:native:release", launch.clientUserMessageId);
    }
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
    if (result) {
      this.archiveState.suppress(threadId);
      this.historyItemLoader.cancelLoads(threadId);
    }
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
    if (result) {
      this.archiveState.unsuppress(threadId);
      this.applyThreadSummary(result);
    }
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

  /** Observe one admitted owner without creating a separate lifetime authority. */
  private observeOwnerActionLifetime(threadId: string, action: string) {
    this.assertOwnerForConversation(threadId);
    const owner = this.streamState.getRole(threadId);
    const nativeRevision = this.nativeHostContextRevision;
    let removed = false;
    const onRemoved = (id: string) => {
      if (id === threadId) removed = true;
    };
    const assertCurrent = () => {
      if (
        removed ||
        this.destroyed ||
        this.nativeHostContextRevision !== nativeRevision ||
        this.streamState.getRole(threadId) !== owner
      )
        throw new Error(`Conversation owner changed during ${action}`);
      this.assertOwnerForConversation(threadId);
    };
    this.conversationRemovedCallbacks.add(onRemoved);
    return {
      assertCurrent,
      isCurrent: () => {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
      [Symbol.dispose]: () => {
        this.conversationRemovedCallbacks.delete(onRemoved);
      },
    };
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

  private isUnavailableOwnerActionError(error: unknown, includeTimeout: boolean): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes("no-client-found") ||
      message.includes("No renderer owner") ||
      (includeTimeout && (message.includes("timeout") || message.includes("timed out")))
    );
  }

  private markConversationNeedsResumeAfterUnavailableOwner(
    conversationId: string,
    ownerClientId: string | null,
  ): void {
    const role = this.streamState.getRole(conversationId);
    if (role?.role === "follower" && role.ownerClientId !== ownerClientId) return;
    if (role?.role === "follower") {
      const wasFollowing = this.streamState.isFollowing(conversationId);
      this.streamState.removeConversation(conversationId);
      if (wasFollowing) {
        void this.setThreadStreamFollowing(conversationId, false).catch((error: unknown) => {
          console.warn("Failed to stop following an unavailable conversation owner", error);
        });
      }
    }
    this.markConversationResumeState(conversationId, "needs_resume");
    this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
  }

  private buildOriginalNativeTurnRequest(
    threadId: string,
    clientUserMessageId: string,
    preparedPrompt: CodexPreparedPrompt,
    opts?: CodexTurnStartOptions,
  ): import("@nodex/codex-app-server-protocol/v2/TurnStartParams").TurnStartParams {
    const context = this.conversationsById.get(threadId)?.canonicalState;
    const model = opts?.model ?? context?.latestModel;
    if (opts?.collaborationMode && !model)
      throw new Error("Collaboration mode requires a selected model");
    return {
      threadId,
      clientUserMessageId,
      input: [...preparedPrompt.inputItems],
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
      ...(opts?.reasoningEffort !== undefined ? { effort: opts.reasoningEffort } : {}),
      ...(opts?.serviceTier !== undefined ? { serviceTier: opts.serviceTier } : {}),
      ...(opts?.summary !== undefined ? { summary: opts.summary } : {}),
      ...(opts?.collaborationMode
        ? {
            collaborationMode: {
              mode: opts.collaborationMode,
              settings: {
                model: model!,
                reasoning_effort: opts.reasoningEffort ?? context?.latestReasoningEffort ?? null,
                developer_instructions: null,
              },
            },
          }
        : {}),
    };
  }

  async startTurn(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
    presentationTicket?: CodexTurnPresentationTicket,
    submissionIdentity?: RendererTurnSubmissionIdentity,
  ): Promise<unknown> {
    await this.settingsUpdates.get(threadId);
    const role = this.streamState.getRole(threadId);
    if (role?.role === "follower") {
      const preparedPrompt = await prepareCodexPrompt(prompt, opts?.promptInput, {
        resolveImageInput: resolveOwnerPromptImageInput,
      });
      const clientUserMessageId =
        submissionIdentity?.clientUserMessageId ?? createOwnerClientUserMessageId();
      const request = await runConversationOperation("codex:turn:native:prepare", {
        threadId,
        prompt,
        opts,
        presentationTicket,
        clientUserMessageId,
        preparedPrompt,
        originalRequest: this.buildOriginalNativeTurnRequest(
          threadId,
          clientUserMessageId,
          preparedPrompt,
          opts,
        ),
        sourceContext: {
          attachments: [...preparedPrompt.fileAttachments, ...preparedPrompt.addedFiles],
          commentAttachments: [...preparedPrompt.commentAttachments],
          inheritThreadSettings: true,
        },
      });
      try {
        const currentRole = this.streamState.getRole(threadId);
        if (currentRole?.role !== "follower" || currentRole.ownerClientId !== role.ownerClientId)
          throw new Error("Turn owner changed during preparation");
        const forwarded = await this.forwardPreparedStartTurnOrRecover(
          threadId,
          role.ownerClientId,
          request,
        );
        if (forwarded.forwarded) {
          codexTurnFirstResponseTracker.abort(clientUserMessageId, "follower_window_forwarded");
          return forwarded.result;
        }

        const prepared = await this.inspectOwnerTurnStart(request);
        return await this.executeOwnerOptimisticTurnTransaction({
          threadId,
          clientUserMessageId,
          canonicalParams: prepared.params,
          execution: prepared,
          turnContext: request.context,
          optimisticNotifyMode: "sync",
          request: (submission) =>
            this.executePreparedNativeTurn(request, prepared.request, submission),
        });
      } finally {
        await runConversationOperation("codex:turn:native:release", clientUserMessageId);
      }
    }
    return this.startTurnAsOwner(threadId, prompt, opts, presentationTicket, submissionIdentity);
  }

  async resumeInterruptedTurn(
    threadId: string,
    opts?: CodexTurnStartOptions,
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<unknown> {
    const existing = this.interruptedTurnResumesInFlightByThreadId.get(threadId);
    if (existing) return await existing;

    const operation = this.resumeInterruptedTurnAsOwner(threadId, opts, presentationTicket);
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
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<unknown> {
    if (!this.conversationsById.has(threadId)) await this.requestThreadStreamResume(threadId);
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

    return await this.startTurnAsOwnerLocalTransaction(threadId, "", opts, presentationTicket);
  }

  private async forwardPreparedStartTurnOrRecover(
    threadId: string,
    ownerClientId: string,
    turnStart: ConversationFollowerTurnStart,
  ): Promise<
    { readonly forwarded: true; readonly result: unknown } | { readonly forwarded: false }
  > {
    try {
      const response = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({
        hostId: this.hostId,
        targetClientId: ownerClientId,
        request: conversationFollowerRequest("thread-follower-start-turn", {
          conversationId: threadId,
          turnStart,
        }),
      });
      if (response.resultType !== "success") {
        throw new Error(response.resultType === "error" ? response.error : "no-client-found");
      }
      return { forwarded: true, result: (response.result as { result: unknown }).result };
    } catch (error) {
      if (!this.isUnavailableOwnerActionError(error, false)) throw error;
      this.markConversationNeedsResumeAfterUnavailableOwner(threadId, ownerClientId);
      await this.requestThreadStreamResume(threadId);
      if (this.streamState.getRole(threadId)?.role !== "owner") {
        throw new Error("Conversation owner unavailable after resume", { cause: error });
      }
      return { forwarded: false };
    }
  }

  private async startTurnAsOwner(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
    presentationTicket?: CodexTurnPresentationTicket,
    submissionIdentity?: RendererTurnSubmissionIdentity,
  ): Promise<unknown> {
    await this.ensureOwnerForConversationAction(threadId, "start turn");
    return await this.startTurnAsOwnerLocalTransaction(
      threadId,
      prompt,
      opts,
      presentationTicket,
      submissionIdentity,
    );
  }

  private async startTurnAsOwnerLocalTransaction(
    threadId: string,
    prompt: string,
    opts?: CodexTurnStartOptions,
    presentationTicket?: CodexTurnPresentationTicket,
    submissionIdentity?: RendererTurnSubmissionIdentity,
  ): Promise<unknown> {
    await this.settingsUpdates.get(threadId);
    const promptInput = opts?.promptInput;
    const clientUserMessageId =
      submissionIdentity?.clientUserMessageId ?? createOwnerClientUserMessageId();
    let preparedPrompt: CodexPreparedPrompt;
    try {
      preparedPrompt =
        prompt.length === 0 && !promptInput
          ? createEmptyCodexPreparedPrompt()
          : await prepareCodexPrompt(prompt, promptInput, {
              resolveImageInput: resolveOwnerPromptImageInput,
            });
    } catch (error) {
      codexTurnFirstResponseTracker.fail(clientUserMessageId, "submit_preparation_failed");
      throw error;
    }
    const request = await runConversationOperation("codex:turn:native:prepare", {
      threadId,
      prompt,
      opts,
      presentationTicket,
      clientUserMessageId,
      preparedPrompt,
      originalRequest: this.buildOriginalNativeTurnRequest(
        threadId,
        clientUserMessageId,
        preparedPrompt,
        opts,
      ),
      sourceContext: {
        attachments: [...preparedPrompt.fileAttachments, ...preparedPrompt.addedFiles],
        commentAttachments: [...preparedPrompt.commentAttachments],
        inheritThreadSettings: true,
      },
    });
    try {
      const role = this.streamState.getRole(threadId);
      if (role?.role === "follower") {
        const forwarded = await this.forwardPreparedStartTurnOrRecover(
          threadId,
          role.ownerClientId,
          request,
        );
        if (forwarded.forwarded) {
          codexTurnFirstResponseTracker.abort(clientUserMessageId, "follower_window_forwarded");
          return forwarded.result;
        }
      }
      const prepared = await this.inspectOwnerTurnStart(request);
      return await this.executeOwnerOptimisticTurnTransaction({
        threadId,
        clientUserMessageId,
        canonicalParams: prepared.params,
        execution: prepared,
        turnContext: request.context,
        optimisticNotifyMode: "sync",
        request: (submission) =>
          this.executePreparedNativeTurn(request, prepared.request, submission),
      });
    } finally {
      await runConversationOperation("codex:turn:native:release", clientUserMessageId);
    }
  }

  private async inspectOwnerTurnStart(operation: ConversationFollowerTurnStart) {
    const threadId = operation.request.threadId;
    using lifetime = this.observeOwnerActionLifetime(threadId, "turn preparation");
    await this.settingsUpdates.get(threadId);
    lifetime.assertCurrent();
    const prepared = await runConversationOperation("codex:turn:native:inspect", operation);
    lifetime.assertCurrent();
    return prepared;
  }

  private async executeOwnerOptimisticTurnTransaction(input: {
    readonly threadId: string;
    readonly clientUserMessageId: string;
    readonly canonicalParams: CodexCanonicalLiveTurnParams;
    readonly execution: CodexPreparedTurnExecution;
    readonly turnContext?: ConversationFollowerTurnStart["context"];
    readonly request: (submission: OwnerTurnRequestContext) => Promise<TurnStartResponse | unknown>;
    readonly onOptimisticCommitted?: () => void;
    readonly optimisticNotifyMode?: ConversationNotifyMode;
  }): Promise<unknown> {
    const { threadId, clientUserMessageId, canonicalParams } = input;
    using lifetime = this.observeOwnerActionLifetime(threadId, "turn submission");
    const observedAtMs = Date.now();
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      this.handleOwnerReducerUnavailable(threadId);
      throw new Error(`Canonical conversation state unavailable for '${threadId}'`);
    }
    if (conversation.canonicalState?.unconfirmedTurnSubmissions?.length)
      throw new Error("A previous turn submission is awaiting confirmation");
    if (
      Array.isArray(input.turnContext?.responseItems) &&
      input.turnContext.responseItems.length > 0 &&
      (latestConversationTurn(conversation.canonicalState)?.status === "inProgress" ||
        conversation.threadRuntimeStatus?.type === "active")
    )
      throw new Error("App context must wait until the current turn finishes");
    const previousRuntimeStatus =
      conversation.threadRuntimeStatus ??
      buildOwnerThreadRuntimeStatus(conversation.statusType, conversation.statusActiveFlags);
    const optimisticRuntimeStatus: CodexThreadRuntimeStatus | null =
      previousRuntimeStatus.type === "active" ? null : { type: "active", activeFlags: [] };

    this.historyClient.updateConversation(threadId, (draft) => {
      mutateCodexCanonicalOptimisticTurn(draft, {
        execution: input.execution,
        params: canonicalParams,
        startedAtMs: observedAtMs,
        localMetadata: input.turnContext?.localTurnMetadata,
        mcpAppModelContextAttachments: input.turnContext?.mcpAppModelContextAttachments,
      });
      if (optimisticRuntimeStatus) draft.threadRuntimeStatus = optimisticRuntimeStatus;
    });
    const optimisticStatus = this.historyClient.getConversation(threadId)?.threadRuntimeStatus;
    let pendingRequestId: CodexTurnDelivery["requestId"] | null = null;
    const confirmDelivery = () => {
      lifetime.assertCurrent();
      if (pendingRequestId === null) return;
      this.historyClient.updateConversation(threadId, (draft) => {
        clearCodexUnconfirmedTurnSubmission(draft, pendingRequestId);
      });
      pendingRequestId = null;
    };
    const onOutcomeUnknown = (delivery: CodexTurnDelivery) => {
      if (!lifetime.isCurrent()) return;
      pendingRequestId = delivery.requestId;
      this.historyClient.updateConversation(threadId, (draft) => {
        recordCodexUnconfirmedTurnSubmission(draft, delivery, clientUserMessageId);
      });
    };
    try {
      input.onOptimisticCommitted?.();
      const environmentSelectionEvidence =
        this.historyClient.getConversation(threadId)?.environmentSelectionEvidence;
      const result = await input.request({
        options: { priority: "critical", timeoutMs: 30_000, onOutcomeUnknown },
        assertCurrent: lifetime.assertCurrent,
        confirmDelivery,
      });
      lifetime.assertCurrent();
      const startedTurn = parseOwnerTurnStartResult(threadId, result);
      if (startedTurn)
        this.historyClient.updateConversation(threadId, (draft) => {
          mutateCodexCanonicalOptimisticTurnBinding(
            draft,
            clientUserMessageId,
            startedTurn.protocol,
          );
          const environmentSelection = acceptCodexPreparedEnvironmentSelection(
            draft,
            input.execution.environments,
            environmentSelectionEvidence,
            observedAtMs / 1_000,
          );
          draft.environments = castDraft(environmentSelection.environments);
          draft.environmentSelectionEvidence = castDraft(
            environmentSelection.environmentSelectionEvidence,
          );
          if (input.execution.pendingWorkspace) {
            draft.workspaceBrowserRoot = null;
            draft.cwd = input.execution.pendingWorkspace.cwd;
          }
          const workspaceKind = input.execution.workspaceKind;
          if (workspaceKind === "project" || workspaceKind === "projectless") {
            draft.workspaceKind = workspaceKind;
          }
          draft.currentPermissions = castDraft(input.execution.permissions);
        });
      confirmDelivery();
      return result;
    } catch (error) {
      if (!lifetime.isCurrent()) throw error;
      const delivery =
        error instanceof CodexTurnDeliveryError && error.delivery.stage === "outcome-unknown"
          ? error.delivery
          : null;
      if (delivery) {
        this.historyClient.updateConversation(threadId, (draft) => {
          recordCodexUnconfirmedTurnSubmission(
            draft,
            delivery,
            clientUserMessageId,
            delivery.method === "thread/inject_items",
          );
        });
        if (delivery.method !== "thread/inject_items") throw error;
      } else confirmDelivery();
      const restoreRuntimeStatus =
        optimisticRuntimeStatus !== null &&
        this.historyClient.getConversation(threadId)?.threadRuntimeStatus === optimisticStatus;
      this.historyClient.updateConversation(threadId, (draft) => {
        mutateCodexTurnStartRejection(draft, {
          clientUserMessageId,
          previousPermissions: input.execution.previousPermissions,
          message: error instanceof Error ? error.message : "Error submitting message",
          failureItemId: crypto.randomUUID(),
          retainTurn: delivery?.method === "thread/inject_items",
          restoreRuntimeStatus: restoreRuntimeStatus ? previousRuntimeStatus : undefined,
        });
      });
      throw error;
    }
  }

  async setThreadSettingsForConversation(
    threadId: string,
    patch: CodexConversationThreadSettingsPatch,
  ): Promise<CodexConversationThreadSettings> {
    if (!this.streamState.getRole(threadId)) await this.requestThreadStreamResume(threadId);
    const profile = patch.executionProfile
      ? await runConversationOperation(
          "codex:thread:settings:prepare-profile",
          threadId,
          patch.executionProfile,
          patch.executionProfileChange,
        )
      : null;
    const current = this.historyClient.getConversation(threadId);
    if (!current) throw new Error("Conversation document unavailable");
    const nativePatch: CanonicalThreadSettingsPatch = {
      ...(profile
        ? {
            model: profile.modelId,
            effort: profile.reasoningEffort as CodexReasoningEffort | null,
            serviceTier: profile.serviceTier,
          }
        : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.reasoningEffort !== undefined ? { effort: patch.reasoningEffort } : {}),
      ...(patch.serviceTier !== undefined ? { serviceTier: patch.serviceTier } : {}),
      ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
      ...(patch.personality !== undefined ? { personality: patch.personality } : {}),
      ...(patch.collaborationMode != null
        ? {
            collaborationMode: {
              mode: patch.collaborationMode,
              settings: {
                model: patch.model ?? profile?.modelId ?? current.latestModel,
                reasoning_effort:
                  patch.reasoningEffort !== undefined
                    ? patch.reasoningEffort
                    : current.latestReasoningEffort,
                developer_instructions: null,
              },
            },
          }
        : {}),
    };
    const role = this.streamState.getRole(threadId);
    if (role?.role === "follower") {
      const response = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({
        hostId: this.hostId,
        targetClientId: role.ownerClientId,
        request: conversationFollowerRequest("thread-follower-update-thread-settings", {
          conversationId: threadId,
          threadSettings: nativePatch,
        }),
      });
      if (response.resultType !== "success")
        throw new Error(
          response.resultType === "error" ? response.error : "Thread settings owner unavailable",
        );
    } else {
      await this.updateNativeThreadSettingsAsOwner(threadId, nativePatch);
    }
    const conversation = this.conversationsById.get(threadId);
    const settings = conversation?.canonicalState?.latestThreadSettings;
    if (!conversation || !settings) throw new Error("Thread settings unavailable");
    return buildOwnerConversationThreadSettings(conversation, settings);
  }

  private async setThreadSettingsForConversationAsOwner(
    threadId: string,
    patch: CodexConversationThreadSettingsPatch,
  ): Promise<CodexConversationThreadSettings> {
    this.assertOwnerForConversation(threadId);
    return this.setThreadSettingsForConversation(threadId, patch);
  }

  private updateNativeThreadSettingsAsOwner(
    id: string,
    patch: CanonicalThreadSettingsPatch,
    condition?: CanonicalThreadSettingsCondition,
    activeTurnId?: string | null,
  ): Promise<boolean> {
    const revision = this.nativeHostContextRevision;
    const previous = this.settingsUpdates.get(id) ?? Promise.resolve(true);
    const pending = previous
      .catch(() => false)
      .then(async () => {
        if (this.nativeHostContextRevision !== revision)
          throw new Error("Thread settings owner lifetime ended");
        this.assertOwnerForConversation(id);
        await this.refreshNativeHostContext();
        if (this.nativeHostContextRevision !== revision)
          throw new Error("Thread settings owner lifetime ended");
        const context = this.nativeHostContext;
        const read = () => {
          this.assertOwnerForConversation(id);
          if (this.destroyed || this.nativeHostContext !== context)
            throw new Error("Thread settings owner lifetime ended");
          const state = this.historyClient.getConversation(id);
          if (!state) throw new Error("Conversation document unavailable");
          return state;
        };
        return updateCanonicalThreadSettings(
          {
            getConversation: read,
            updateConversation: (threadId, recipe) => {
              read();
              this.historyClient.updateConversation(threadId, recipe);
            },
            getSupport: () => this.nativeSettingsSupport,
            setSupport: (support) => {
              read();
              this.nativeSettingsSupport = support;
            },
            isUnsupported: (error) =>
              isCodexNativeMethodUnsupported(error, "thread/settings/update"),
            updateThread: (params) =>
              this.nativeAppServer.request("thread/settings/update", params),
            updateTurnReviewer: (threadId, turnId, approvalsReviewer) =>
              this.nativeAppServer.request("turn/settings/update", {
                threadId,
                turnId,
                approvalsReviewer,
              }),
            supportsTurnReviewer: () =>
              this.nativeHostContext?.supportsTurnApprovalsReviewer === true,
          },
          id,
          patch,
          condition,
          activeTurnId,
        );
      });
    this.settingsUpdates.set(id, pending);
    void pending
      .finally(() => {
        if (this.settingsUpdates.get(id) === pending) this.settingsUpdates.delete(id);
      })
      .catch(() => {});
    return pending;
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

  private async executePreparedNativeTurn(
    operation: ConversationFollowerTurnStart,
    request: import("@nodex/codex-app-server-protocol/v2").TurnStartParams,
    submission: OwnerTurnRequestContext,
    execute: (options: NativeRequestOptions) => Promise<TurnStartResponse> = (options) =>
      this.nativeAppServer.executePreparedTurn(request, options),
  ): Promise<TurnStartResponse> {
    submission.assertCurrent();
    const responseItems = operation.context?.responseItems;
    if (Array.isArray(responseItems) && responseItems.length) {
      await this.nativeAppServer.injectPreparedTurn(operation, submission.options);
      submission.confirmDelivery();
      if (this.historyClient.getConversation(request.threadId)?.unconfirmedTurnSubmissions?.length)
        throw new Error("An earlier turn submission is not yet confirmed");
    }
    submission.assertCurrent();
    const clientUserMessageId = request.clientUserMessageId ?? undefined;
    if (clientUserMessageId) {
      codexTurnFirstResponseTracker.markRequestDispatched(clientUserMessageId, "turn/start");
    }
    const trace = clientUserMessageId
      ? codexTurnFirstResponseTracker.getTrace(clientUserMessageId)
      : undefined;
    return execute({
      ...submission.options,
      ...(clientUserMessageId ? { clientUserMessageId } : {}),
      ...(trace ? { trace } : {}),
    });
  }

  private queuedActiveTurn(id: string): string | null {
    const turn = latestConversationTurn(this.historyClient.getConversation(id));
    return turn?.status === "inProgress" ? turn.turnId : null;
  }
  private isServerQueueEnabled(): boolean {
    return this.nativeHostContext?.supportsThreadQueue === true;
  }
  private isServerQueueSelected(id: string): boolean {
    if (!this.isServerQueueEnabled()) return false;
    const local = this.queuedMessages.readMessages(id);
    return local !== undefined && local.length === 0;
  }
  private async loadQueuedMessages(id: string): Promise<void> {
    await this.queuedMessages.loadMessages(id);
    if (this.isServerQueueSelected(id) && this.serverQueuedMessages.read(id) == null)
      await this.serverQueuedMessages.load(id);
    this.refreshQueuedMessageProjection(id);
  }
  private wakeQueuedMessages(id: string): void {
    this.queuedExecution?.wake(id);
  }
  private async prepareQueuedSubmission(
    conversationId: string,
    message: CodexQueuedMessage,
    mode: "start" | "steer",
    source: ConversationResumeSource,
    clientUserMessageId?: string,
  ) {
    const conversation = this.historyClient.getConversation(conversationId);
    const needsResume =
      conversation?.resumeState !== "resumed" || !this.streamState.getRole(conversationId);
    const cwd = conversation?.cwd ?? message.cwd;
    let workspaceRoots = message.context.workspaceRoots;
    if (workspaceRoots === undefined) {
      if (needsResume) {
        const workspace = await runConversationOperation(
          "codex:thread:history-hydration:prepare",
          conversationId,
        );
        workspaceRoots = workspace.context.runtimeWorkspaceRoots;
      } else {
        workspaceRoots =
          conversation?.currentPermissions?.runtimeWorkspaceRoots ??
          (cwd === null ? undefined : [cwd]);
      }
    }
    if (workspaceRoots === undefined || !workspaceRoots.every((root) => root.length > 0)) {
      return { status: "paused" as const, reason: "workspace-unavailable" };
    }
    const usePermissionSelection = message.submissionOptions?.usePermissionSelection ?? false;
    const resume: QueuedConversationResumeInput = {
      conversationId,
      model: null,
      serviceTier: message.submissionOptions?.serviceTier,
      reasoningEffort: null,
      workspaceRoots: [...workspaceRoots],
      useAppServerPermissionDefault: usePermissionSelection,
      collaborationMode: message.submissionOptions?.collaborationMode ?? null,
    };
    if (needsResume) {
      const resumed = await this.requestThreadStreamResume(conversationId, {
        source,
        model: resume.model,
        serviceTier: resume.serviceTier,
        useAppServerPermissionDefault: resume.useAppServerPermissionDefault,
        workspaceRoots: resume.workspaceRoots,
        collaborationMode: resume.collaborationMode,
      });
      if (!resumed) throw new QueueNotReady("Thread is not ready");
    }
    await runConversationOperation(
      "codex:turn:native-steer:release",
      clientUserMessageId ?? message.id,
    );
    const prepared = await runConversationOperation(
      "codex:queued-messages:prepare-native",
      conversationId,
      message,
      mode,
      {
        runtimeWorkspaceRoots: workspaceRoots,
        usePermissionSelection,
        ...(clientUserMessageId ? { clientUserMessageId } : {}),
      },
    );
    return {
      status: "ready" as const,
      submission: {
        conversationId,
        executionHostId: message.submissionOptions?.executionHostId,
        resume,
        ...prepared,
      },
    };
  }
  private async startPreparedQueuedMessage(
    id: string,
    turnStart: ConversationFollowerTurnStart,
  ): Promise<string> {
    const role = this.streamState.getRole(id);
    if (role?.role === "follower") {
      const response = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({
        hostId: this.hostId,
        targetClientId: role.ownerClientId,
        request: conversationFollowerRequest("thread-follower-start-turn", {
          conversationId: id,
          turnStart,
        }),
      });
      if (response.resultType !== "success")
        throw new Error(
          response.resultType === "error" ? response.error : "Queue owner unavailable",
        );
      return (response.result as { result: TurnStartResponse }).result.turn.id;
    }
    this.assertOwnerForConversation(id);
    const prepared = await this.inspectOwnerTurnStart(turnStart);
    const clientUserMessageId = turnStart.request.clientUserMessageId;
    if (!clientUserMessageId) throw new Error("Queue submission identity missing");
    const result = (await this.executeOwnerOptimisticTurnTransaction({
      threadId: id,
      clientUserMessageId,
      canonicalParams: prepared.params,
      execution: prepared,
      turnContext: turnStart.context,
      request: (submission) =>
        this.executePreparedNativeTurn(turnStart, prepared.request, submission),
    })) as TurnStartResponse;
    return result.turn.id;
  }

  private async steerPreparedQueuedMessage(
    id: string,
    input: CanonicalOwnerSteerInput,
  ): Promise<string> {
    const role = this.streamState.getRole(id);
    if (role?.role !== "follower") return (await this.executeNativeSteerAsOwner(input)).turnId;
    const response = await (
      await getConversationCoordinationHost()
    ).requestThreadFollower({
      hostId: this.hostId,
      targetClientId: role.ownerClientId,
      request: conversationFollowerRequest("thread-follower-steer-turn", input),
    });
    if (response.resultType !== "success")
      throw new Error(response.resultType === "error" ? response.error : "Queue owner unavailable");
    return (response.result as { result: { turnId: string } }).result.turnId;
  }

  private async sendServerQueuedMessageNow(
    threadId: string,
    message: CodexQueuedMessage,
    clientUserMessageId: string,
  ): Promise<{ status: "sent"; messageId: string; turnId: string }> {
    try {
      const result = await this.queuedExecution.sendPreparedNow(threadId, message, {
        prepare: (id, queuedMessage, mode) =>
          this.prepareQueuedSubmission(id, queuedMessage, mode, "view", clientUserMessageId),
      });
      return { status: "sent", messageId: message.id, turnId: result.turnId };
    } finally {
      await Promise.all([
        runConversationOperation("codex:turn:native:release", clientUserMessageId),
        runConversationOperation("codex:turn:native-steer:release", clientUserMessageId),
      ]);
    }
  }

  private projectQueuedMessages(
    id: string,
    previous: CodexConversationSnapshot["queuedFollowUps"],
  ): CodexConversationSnapshot["queuedFollowUps"] {
    const messages = this.isServerQueueSelected(id)
      ? this.serverQueuedMessages.read(id)
      : this.queuedMessages.readMessages(id);
    return {
      ...previous,
      status: messages === undefined ? "loading" : "ready",
      entries: (messages ?? []).map((message) => projectCodexQueuedMessage(id, message)),
      ledgerRevision: previous.ledgerRevision + 1,
      projectionRevision: previous.projectionRevision + 1,
      error: null,
    };
  }
  private refreshQueuedMessageProjection(id: string): void {
    const conversation = this.conversationsById.get(id);
    if (!conversation) return;
    this.applyConversationSnapshot(id, {
      ...conversation,
      queuedFollowUps: this.projectQueuedMessages(id, conversation.queuedFollowUps),
    });
  }

  async enqueueQueuedFollowUp(
    threadId: string,
    prompt: string,
    opts?: import("../../../shared/codex-queued-message").CodexQueuedMessagePrepareOptions,
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<void> {
    const message = await runConversationOperation(
      "codex:queued-messages:prepare",
      threadId,
      prompt,
      opts,
      presentationTicket,
    );
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      await this.serverQueuedMessages.enqueue(threadId, message);
      return;
    }
    await this.queuedMessages.update(threadId, (messages) => [...messages, message]);
  }
  private enqueueQueuedFollowUpAsOwner = this.enqueueQueuedFollowUp.bind(this);

  async removeQueuedFollowUp(threadId: string, followUpId: string): Promise<void> {
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      await this.serverQueuedMessages.remove(threadId, followUpId);
      return;
    }
    await this.queuedMessages.update(threadId, (messages) =>
      messages.filter((message) => message.id !== followUpId),
    );
  }
  private removeQueuedFollowUpAsOwner = this.removeQueuedFollowUp.bind(this);

  async replaceQueuedFollowUp(
    threadId: string,
    followUpId: string,
    _expectedLedgerRevision: number,
    prompt: string,
    opts?: import("../../../shared/codex-queued-message").CodexQueuedMessagePrepareOptions,
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<boolean> {
    const replacement = await runConversationOperation(
      "codex:queued-messages:prepare",
      threadId,
      prompt,
      opts,
      presentationTicket,
    );
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      const messages = this.serverQueuedMessages.read(threadId) ?? [];
      const index = messages.findIndex((message) => message.id === followUpId);
      if (index === -1) return false;
      await this.serverQueuedMessages.enqueue(threadId, replacement, {
        messageId: followUpId,
        previousMessageId: messages[index - 1]?.id ?? null,
        nextMessageId: messages[index + 1]?.id ?? null,
      });
      return true;
    }
    const before = await this.queuedMessages.update(threadId, (messages) =>
      messages.map((message) =>
        message.id === followUpId ? { ...replacement, id: message.id } : message,
      ),
    );
    return before.some((message) => message.id === followUpId);
  }
  private replaceQueuedFollowUpAsOwner = this.replaceQueuedFollowUp.bind(this);

  async reorderQueuedFollowUps(threadId: string, orderedFollowUpIds: string[]): Promise<void> {
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      await this.serverQueuedMessages.reorder(threadId, orderedFollowUpIds);
      return;
    }
    await this.queuedMessages.update(threadId, (messages) => {
      const byId = new Map(messages.map((message) => [message.id, message]));
      const ordered = orderedFollowUpIds.flatMap((id) => {
        const message = byId.get(id);
        byId.delete(id);
        return message ? [message] : [];
      });
      return [...ordered, ...byId.values()];
    });
  }
  private reorderQueuedFollowUpsAsOwner = this.reorderQueuedFollowUps.bind(this);

  async resumeQueuedFollowUps(threadId: string): Promise<void> {
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      await this.serverQueuedMessages.resume(threadId);
      return;
    }
    await this.queuedMessages.update(threadId, (messages) =>
      messages.map(resumeInterruptedQueuedMessage),
    );
  }
  private resumeQueuedFollowUpsAsOwner = this.resumeQueuedFollowUps.bind(this);

  async resolveQueuedFollowUpsAfterFreshStart(
    threadId: string,
    _expectedLedgerRevision: number,
    resolution: "resume" | "clear",
  ): Promise<boolean> {
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      if (resolution === "clear") await this.serverQueuedMessages.clear(threadId);
      else await this.serverQueuedMessages.resume(threadId);
      return true;
    }
    await this.queuedMessages.update(threadId, (messages) =>
      resolution === "clear" ? [] : messages.map((message) => ({ ...message, pausedReason: null })),
    );
    return true;
  }
  private resolveQueuedFollowUpsAfterFreshStartAsOwner =
    this.resolveQueuedFollowUpsAfterFreshStart.bind(this);

  async sendQueuedFollowUpNow(threadId: string, followUpId: string): Promise<void> {
    await this.loadQueuedMessages(threadId);
    if (this.isServerQueueSelected(threadId)) {
      await this.serverQueuedMessages.sendNow(
        threadId,
        followUpId,
        (message, clientUserMessageId) =>
          this.sendServerQueuedMessageNow(threadId, message, clientUserMessageId),
      );
      return;
    }
    await this.queuedExecution.sendNow(threadId, followUpId, {
      prepare: (id, message, mode) => this.prepareQueuedSubmission(id, message, mode, "view"),
    });
  }
  private sendQueuedFollowUpNowAsOwner = this.sendQueuedFollowUpNow.bind(this);

  async editLastUserTurn(
    threadId: string,
    turnId: string,
    message: string,
    opts?: { serviceTier?: CodexServiceTier },
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<CodexThreadActionResult> {
    if (!this.streamState.getRole(threadId)) await this.requestThreadStreamResume(threadId);
    const role = this.streamState.getRole(threadId);
    if (role?.role === "follower") {
      const response = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({
        hostId: this.hostId,
        targetClientId: role.ownerClientId,
        request: conversationFollowerRequest("thread-follower-edit-last-user-turn", {
          conversationId: threadId,
          turnId,
          message,
          serviceTier: opts?.serviceTier,
        }),
      });
      if (response.resultType !== "success")
        throw new Error(
          response.resultType === "error" ? response.error : "Edit owner unavailable",
        );
    } else {
      await this.executeNativeEditAsOwner(
        threadId,
        { turnId, message, serviceTier: opts?.serviceTier },
        presentationTicket,
      );
    }
    return { threadId, streamRevision: this.streamState.getRevision(threadId) ?? 0 };
  }

  private async executeNativeEditAsOwner(
    id: string,
    options: CanonicalEditOptions,
    presentationTicket?: CodexTurnPresentationTicket,
  ): Promise<void> {
    this.assertOwnerForConversation(id);
    await this.refreshNativeHostContext();
    await editCanonicalLastUserTurn(
      {
        getConversation: () => {
          this.assertOwnerForConversation(id);
          return this.historyClient.getConversation(id) ?? undefined;
        },
        awaitSettings: async () => {
          await this.settingsUpdates.get(id);
        },
        supportsRevert: () => this.nativeHostContext?.supportsThreadRevert === true,
        readPermissionOverrides: async (_id, state, edit) => {
          const response = await this.nativeAppServer.request("config/read", {
            includeLayers: false,
            cwd: state.cwd ?? null,
          });
          return (cwd) => {
            const resolved = canonicalPermissionsForMode(
              edit.agentMode,
              cwd === undefined ? [] : [cwd],
              response.config as import("@nodex/codex-app-server-protocol/v2/ConfigReadResponse").ConfigReadResponse["config"],
            );
            if (!resolved) return null;
            const profile =
              state.latestThreadSettings?.activePermissionProfile === undefined
                ? state.currentPermissions?.activePermissionProfile
                : state.latestThreadSettings.activePermissionProfile;
            return nativePermissionRequestFields(
              profile === undefined ? resolved : { ...resolved, activePermissionProfile: profile },
            );
          };
        },
        revert: async (_id, beforeTurnId) => {
          const response = await this.nativeAppServer.request("thread/revert", {
            threadId: id,
            beforeTurnId,
          });
          this.assertOwnerForConversation(id);
          return response as import("@nodex/codex-app-server-protocol/v2/ThreadRevertResponse").ThreadRevertResponse;
        },
        rollback: async (_id, numTurns) => {
          const response = await this.nativeAppServer.request("thread/rollback", {
            threadId: id,
            numTurns,
          });
          this.assertOwnerForConversation(id);
          return response as import("@nodex/codex-app-server-protocol/v2/ThreadRollbackResponse").ThreadRollbackResponse;
        },
        applyRevert: (_id, response, removed) =>
          this.historyClient.updateConversation(id, (draft) =>
            mutateCodexCanonicalRevert(
              draft,
              response,
              new Set(removed.map((turn) => turn.turnId)),
            ),
          ),
        applyRollback: (_id, _before, response) =>
          this.historyClient.updateConversation(id, (draft) => {
            if (!mutateCodexCanonicalRollbackThread(draft, response.thread))
              throw new Error("Rollback could not hydrate retained turns");
          }),
        start: async (request, original, inheritPermissionDefaults) => {
          const clientUserMessageId = createOwnerClientUserMessageId();
          const prompt = await prepareCodexPrompt(options.message, undefined, {
            resolveImageInput: resolveOwnerPromptImageInput,
          });
          const preparedPrompt = { ...prompt, inputItems: request.input };
          const turnStart = await runConversationOperation("codex:turn:native:prepare", {
            threadId: id,
            prompt: options.message,
            presentationTicket,
            clientUserMessageId,
            preparedPrompt,
            originalRequest: { ...request, clientUserMessageId },
            sourceContext: {
              attachments: original.params.attachments,
              commentAttachments: original.params.commentAttachments,
              useAppServerPermissionDefault: inheritPermissionDefaults,
              writingBlockContextPrepared: options.writingBlockContextPrepared,
              mcpAppModelContextAttachments: original.mcpAppModelContextAttachments,
            },
          });
          try {
            const materialized = await this.inspectOwnerTurnStart(turnStart);
            return await this.executeOwnerOptimisticTurnTransaction({
              threadId: id,
              clientUserMessageId,
              canonicalParams: materialized.params,
              execution: materialized,
              turnContext: turnStart.context,
              request: (submission) =>
                this.executePreparedNativeTurn(turnStart, materialized.request, submission),
            });
          } finally {
            await runConversationOperation("codex:turn:native:release", clientUserMessageId);
          }
        },
      },
      id,
      options,
    );
  }

  async forkConversationFromTurn(
    threadId: string,
    turnId: string,
    _message: string,
  ): Promise<CodexThreadActionResult> {
    await this.refreshNativeHostContext();
    if (!this.historyClient.getConversation(threadId))
      await this.requestThreadStreamResume(threadId);
    const hostContext = this.nativeHostContext;
    const source = this.historyClient.getConversation(threadId);
    if (!source) throw new Error("Source conversation not found");
    if (source.historyMode !== "paginated") await this.completeHistoryLoader.load(threadId);
    const forkTrace = startCodexRequestInteractionTrace({
      attributes: {
        "thread.ephemeral": false,
        "thread.side_conversation": false,
      },
      childName: "thread.fork",
      rootName: "desktop.thread_fork",
    });
    let prepared: import("../../../shared/codex-native-fork").CodexNativeForkPreparation | null =
      null;
    try {
      prepared = await runConversationOperation(
        "codex:thread:native-fork:prepare",
        threadId,
        turnId,
      );
      if (prepared.hostId !== this.hostId) throw new Error("Fork execution host changed");
      if (
        this.destroyed ||
        this.nativeHostContext !== hostContext ||
        prepared.generation !== hostContext?.generation
      )
        throw new Error("Fork manager retired during preparation");
      const response = await this.nativeAppServer.executePreparedFork(prepared.receiptId, {
        source: "thread_hydration",
        trace: forkTrace?.trace ?? null,
      });
      if (this.destroyed || this.nativeHostContext !== hostContext)
        throw new Error("Fork manager retired");
      this.installNativeThreadResponse(response, "needs_resume", source.workspaceKind);
      const accepted = await runConversationOperation(
        "codex:thread:native-fork:accept",
        prepared.receiptId,
      );
      if (this.destroyed || this.nativeHostContext !== hostContext)
        throw new Error("Fork manager retired during acceptance");
      this.applyThreadSummary(accepted.summary);
      await this.requestThreadStreamResume(response.thread.id);
      const sourceTitle = prepared.sourceTitle;
      this.historyClient.updateConversation(response.thread.id, (draft) =>
        mutateCodexCanonicalForkedFromConversationItem(draft, {
          id: crypto.randomUUID(),
          type: "forkedFromConversation",
          sourceConversationId: threadId,
          sourceConversationTitle: sourceTitle,
        }),
      );
      forkTrace?.finish();
      return { threadId: accepted.threadId, composerIntent: accepted.composerIntent };
    } catch (error) {
      forkTrace?.finish(error);
      throw error;
    } finally {
      if (prepared)
        await runConversationOperation("codex:thread:native-fork:release", prepared.receiptId);
    }
  }

  private forkConversationFromTurnAsOwner = this.forkConversationFromTurn.bind(this);

  async compactThread(threadId: string): Promise<void> {
    const nativeRevision = this.nativeHostContextRevision;
    const assertNativeCurrent = () => {
      if (this.destroyed || this.nativeHostContextRevision !== nativeRevision)
        throw new Error("Conversation connection changed during compaction");
    };
    try {
      await this.settingsUpdates.get(threadId);
    } catch (error) {
      if (
        !this.isFollowerForConversation(threadId) ||
        !(error instanceof Error) ||
        !error.message.includes("no-client-found")
      )
        throw error;
    }
    assertNativeCurrent();
    const role = this.streamState.getRole(threadId);
    if (role?.role === "follower") {
      try {
        const coordination = await getConversationCoordinationHost();
        assertNativeCurrent();
        const response = await coordination.requestThreadFollower({
          hostId: this.hostId,
          targetClientId: role.ownerClientId,
          request: conversationFollowerRequest("thread-follower-compact-thread", {
            conversationId: threadId,
          }),
        });
        if (response.resultType !== "success")
          throw new Error(response.resultType === "error" ? response.error : "no-client-found");
        assertNativeCurrent();
        return;
      } catch (error) {
        assertNativeCurrent();
        if (!(error instanceof Error) || !error.message.includes("no-client-found")) throw error;
        this.markConversationNeedsResumeAfterUnavailableOwner(threadId, role.ownerClientId);
        await this.requestThreadStreamResume(threadId);
      }
    }
    assertNativeCurrent();
    await this.compactThreadAsOwner(threadId);
  }

  private async compactThreadAsOwner(threadId: string): Promise<void> {
    const lifetime = this.observeOwnerActionLifetime(threadId, "compaction");
    const { assertCurrent } = lifetime;
    try {
      this.manualCompactions.register(threadId);
      this.historyClient.updateConversation(threadId, (draft) =>
        mutateCodexCanonicalInProgressSyntheticItem(
          draft,
          {
            type: "contextCompaction",
            id: "pending-manual-context-compaction",
            completed: false,
            source: "manual",
          },
          Date.now(),
        ),
      );
      await this.nativeAppServer.request("thread/compact/start", { threadId });
      assertCurrent();
    } catch (error) {
      assertCurrent();
      if (this.manualCompactions.remove(threadId))
        this.historyClient.updateConversation(threadId, (draft) =>
          mutateCodexCanonicalLocalSyntheticItemRemoval(draft, "pending-manual-context-compaction"),
        );
      throw error;
    } finally {
      lifetime[Symbol.dispose]();
    }
  }

  async getThreadGoal(
    threadId: string,
    requestOptions?: CodexRendererNativeRequestOptions,
  ): Promise<ThreadGoal | null> {
    return (await this.nativeAppServer.request("thread/goal/get", { threadId }, requestOptions))
      .goal;
  }

  async setThreadGoal(input: CodexThreadGoalSetActionInput): Promise<ThreadGoal | null> {
    return this.setThreadGoalAsOwner(normalizeThreadGoalSetActionInput(input));
  }

  private async setThreadGoalAsOwner(
    input: CodexThreadGoalSetActionInput,
    options: SetThreadGoalAsOwnerOptions = {},
  ): Promise<ThreadGoal | null> {
    const action = normalizeThreadGoalSetActionInput(input);
    const params = normalizeThreadGoalSetParams(action);
    if (typeof action.objective === "string")
      await this.ensureOwnerForConversationAction(input.threadId, "set thread goal");
    if (typeof action.objective === "string" || action.status === "active") {
      if (action.threadSettings)
        await this.setThreadSettingsForConversationAsOwner(input.threadId, action.threadSettings);
      else await this.settingsUpdates.get(input.threadId);
    }
    const { goal } = await this.nativeAppServer.request("thread/goal/set", params);
    if (this.destroyed) throw new Error("Conversation manager retired");
    this.historyClient.updateConversation(input.threadId, (draft) => {
      draft.threadGoal = goal;
      if (typeof action.objective !== "string" || options.clearResumeConfirmation)
        draft.threadGoalResumeConfirmation = null;
      if (goal && action.appendTranscriptItem !== false && typeof action.objective === "string")
        mutateCodexCanonicalThreadGoalTranscriptTurn(draft, goal);
    });
    return goal;
  }

  async clearThreadGoal(threadId: string): Promise<void> {
    await this.clearThreadGoalAsOwner(threadId);
  }
  private async clearThreadGoalAsOwner(threadId: string): Promise<void> {
    await this.nativeAppServer.request("thread/goal/clear", { threadId });
  }

  async dismissThreadGoalResumeConfirmation(threadId: string): Promise<void> {
    await this.dismissThreadGoalResumeConfirmationAsOwner(threadId);
  }
  private async dismissThreadGoalResumeConfirmationAsOwner(threadId: string): Promise<void> {
    this.historyClient.updateConversation(threadId, (draft) => {
      draft.threadGoalResumeConfirmation = null;
    });
  }

  async setThreadMemoryMode(input: { threadId: string; mode: ThreadMemoryMode }): Promise<void> {
    await this.setThreadMemoryModeAsOwner(input);
  }
  private async setThreadMemoryModeAsOwner(input: {
    threadId: string;
    mode: ThreadMemoryMode;
  }): Promise<void> {
    await this.nativeAppServer.request("thread/memoryMode/set", input);
  }

  async uploadFeedback(params: FeedbackUploadParams): Promise<void> {
    await runConversationOperation("codex:feedback:upload", params);
  }

  async cleanBackgroundTerminals(threadId: string): Promise<boolean> {
    if (this.isFollowerForConversation(threadId))
      throw new Error("Please continue this conversation on the window where it was started.");
    await this.nativeAppServer.request("thread/backgroundTerminals/clean", { threadId });
    this.historyClient.updateConversation(threadId, mutateCodexBackgroundTerminalCleanup, false);
    return true;
  }

  async listBackgroundTerminals(threadId: string): Promise<ThreadBackgroundTerminal[]> {
    const trimmedThreadId = threadId.trim();
    if (!trimmedThreadId) return [];
    if (this.isFollowerForConversation(trimmedThreadId))
      throw new Error("Please continue this conversation on the window where it was started.");
    const rows: ThreadBackgroundTerminal[] = [];
    let cursor: string | null = null;
    do {
      const response: import("@nodex/codex-app-server-protocol/v2").ThreadBackgroundTerminalsListResponse =
        await this.nativeAppServer.request("thread/backgroundTerminals/list", {
          threadId: trimmedThreadId,
          cursor,
          limit: 100,
        });
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

    const response = await this.nativeAppServer.request("thread/backgroundTerminals/terminate", {
      threadId,
      processId,
    });
    return response.terminated;
  }

  async steerTurn(input: CodexSteerTurnInput): Promise<{ turnId: string } | null> {
    if (!input.prompt.trim()) throw new Error("Turn steer requires a non-empty prompt");
    if (!this.streamState.getRole(input.threadId))
      await this.requestThreadStreamResume(input.threadId);
    const prepared = await runConversationOperation("codex:turn:native-steer:prepare", input);
    try {
      const role = this.streamState.getRole(input.threadId);
      if (role?.role !== "follower") return await this.executeNativeSteerAsOwner(prepared);
      try {
        const response = await (
          await getConversationCoordinationHost()
        ).requestThreadFollower({
          hostId: this.hostId,
          targetClientId: role.ownerClientId,
          request: conversationFollowerRequest("thread-follower-steer-turn", { ...prepared }),
        });
        if (response.resultType !== "success")
          throw new Error(response.resultType === "error" ? response.error : "no-client-found");
        return (response.result as { result: { turnId: string } }).result;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes("no-client-found")) throw error;
        this.markConversationNeedsResumeAfterUnavailableOwner(input.threadId, role.ownerClientId);
        await this.requestThreadStreamResume(input.threadId);
        return await this.executeNativeSteerAsOwner(prepared);
      }
    } finally {
      await runConversationOperation(
        "codex:turn:native-steer:release",
        prepared.clientUserMessageId,
      );
    }
  }

  private async executeNativeSteerAsOwner(
    input: CanonicalOwnerSteerInput,
  ): Promise<import("@nodex/codex-app-server-protocol/v2/TurnSteerResponse").TurnSteerResponse> {
    const id = input.conversationId;
    const lifetime = this.observeOwnerActionLifetime(id, "steering");
    const { assertCurrent } = lifetime;
    try {
      return await runCanonicalOwnerSteer(
        {
          read: () => {
            assertCurrent();
            return this.historyClient.getConversation(id) ?? null;
          },
          update: (recipe) => {
            assertCurrent();
            this.historyClient.updateConversation(id, recipe);
          },
          subscribe: (callback) => {
            const unsubscribe = this.addConversationCallback(id, callback);
            return { [Symbol.dispose]: unsubscribe };
          },
          onDispose: (callback) => {
            const disposed = this.onDispose(callback);
            const removed = (threadId: string) => {
              if (threadId === id) callback();
            };
            this.conversationRemovedCallbacks.add(removed);
            return {
              [Symbol.dispose]: () => {
                disposed[Symbol.dispose]();
                this.conversationRemovedCallbacks.delete(removed);
              },
            };
          },
          createId: () => crypto.randomUUID(),
          sendNative: async (request, options) => {
            assertCurrent();
            const response = await this.nativeAppServer.executePreparedSteer(
              request,
              input.clientUserMessageId,
              options,
            );
            assertCurrent();
            return response;
          },
          outcomeUnknown: (error) =>
            error instanceof CodexTurnDeliveryError && error.delivery.stage === "outcome-unknown"
              ? error.delivery
              : null,
          mismatchTurnId: parseSteerTurnMismatchActualTurnId,
          isLocalHost: this.hostId === DEFAULT_CODEX_HOST_ID,
          emitSteered: () => {
            assertCurrent();
            void runConversationOperation(
              "codex:thread:interrupt-effects",
              this.hostId,
              id,
              "steered",
            ).catch((error) => console.warn("Failed to publish steering event", error));
          },
        },
        input,
      );
    } finally {
      lifetime[Symbol.dispose]();
    }
  }

  async interruptTurn(threadId: string, turnId?: string): Promise<boolean> {
    const role = this.streamState.getRole(threadId);
    if (role?.role !== "follower") return this.interruptTurnAsOwner(threadId, turnId);
    try {
      const response = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({
        hostId: this.hostId,
        targetClientId: role.ownerClientId,
        request: conversationFollowerRequest("thread-follower-interrupt-turn", {
          conversationId: threadId,
          mode: "user-stop",
          ...(turnId !== undefined ? { expectedTurnId: turnId } : {}),
        }),
      });
      if (response.resultType !== "success")
        throw new Error(response.resultType === "error" ? response.error : "no-client-found");
      const result = response.result as {
        interruptedTurnId?: string | null;
        goalPauseError?: string;
      };
      if (result.goalPauseError != null)
        throw Object.assign(new Error(result.goalPauseError), {
          interruptedTurnId: result.interruptedTurnId,
        });
      return result.interruptedTurnId != null;
    } catch (error) {
      if (
        !/timeout|request-version-mismatch|no-client-found/i.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
      this.markConversationNeedsResumeAfterUnavailableOwner(threadId, role.ownerClientId);
      await this.requestThreadStreamResume(threadId);
      return this.interruptTurnAsOwner(threadId, turnId);
    }
  }

  private async interruptTurnAsOwner(threadId: string, turnId?: string): Promise<boolean> {
    await this.ensureOwnerForConversationAction(threadId, "interrupt turn");
    return (await this.interruptNativeConversationAsOwner(threadId, "user-stop", turnId)) != null;
  }

  private async interruptNativeConversationAsOwner(
    threadId: string,
    mode: "system" | "user-stop" | "descendant-cleanup",
    expectedTurnId?: string,
  ): Promise<string | null> {
    const lifetime = this.observeOwnerActionLifetime(threadId, "interruption");
    const { assertCurrent } = lifetime;
    const activeGoal =
      expectedTurnId == null &&
      this.historyClient.getConversation(threadId)?.threadGoal?.status === "active";
    const pause = async (critical = false) => {
      assertCurrent();
      const response = await this.nativeAppServer.request(
        "thread/goal/set",
        { threadId, status: "paused" },
        critical ? { priority: "critical", timeoutMs: 500 } : undefined,
      );
      assertCurrent();
      this.historyClient.updateConversation(threadId, (draft) => {
        draft.threadGoal = response.goal as ThreadGoal | null;
        draft.threadGoalResumeConfirmation = null;
      });
    };
    let pauseError: unknown;
    let interruptedTurnId: string | null = null;
    try {
      if (activeGoal && mode === "system") await pause();
      if (activeGoal && mode === "user-stop") {
        try {
          await pause(true);
        } catch (error) {
          pauseError = error;
          console.warn("Failed to pause thread goal before interrupt", error);
        }
      }
      assertCurrent();
      if (expectedTurnId == null)
        void this.declineOwnerRequestsBeforeInterrupt(threadId).catch((error) =>
          console.warn("Failed to decline interrupted requests", error),
        );
      interruptedTurnId = await interruptCanonicalConversationTurn(
        {
          getConversation: () => {
            assertCurrent();
            return this.historyClient.getConversation(threadId) ?? undefined;
          },
          updateConversation: (id, recipe) => {
            assertCurrent();
            this.historyClient.updateConversation(id, recipe);
          },
          sendInterrupt: async (id, turnId) => {
            assertCurrent();
            try {
              return await this.nativeAppServer.request("turn/interrupt", { threadId: id, turnId });
            } finally {
              assertCurrent();
            }
          },
          cleanBackgroundTerminals: async (id) => {
            assertCurrent();
            await this.nativeAppServer.request("thread/backgroundTerminals/clean", {
              threadId: id,
            });
            assertCurrent();
            this.historyClient.updateConversation(id, mutateCodexBackgroundTerminalCleanup, false);
          },
          killNodeReplExecutions: (_sessionId, turnId) =>
            lifetime.isCurrent()
              ? runConversationOperation(
                  "codex:thread:node-repl:cleanup",
                  this.hostId,
                  threadId,
                  turnId,
                )
              : Promise.resolve(),
          onInterruptStarted: (id) => {
            if (!lifetime.isCurrent()) return;
            void runConversationOperation(
              "codex:thread:interrupt-effects",
              this.hostId,
              id,
              "started",
            ).catch((error) => console.warn("Failed to publish interrupt start", error));
          },
          errorMessage: (error) => (error instanceof Error ? error.message : String(error)),
          warn: (error) => console.warn("Failed to clean background terminals", error),
        },
        threadId,
        expectedTurnId,
        mode === "user-stop" && expectedTurnId == null,
      );
      assertCurrent();
      if (activeGoal && mode === "descendant-cleanup") {
        try {
          await pause();
        } catch (error) {
          console.warn("Failed to pause thread goal after interrupt", error);
        }
      }
      assertCurrent();
      if (pauseError !== undefined)
        throw Object.assign(new Error("Failed to pause thread goal", { cause: pauseError }), {
          interruptedTurnId,
        });
      return interruptedTurnId;
    } finally {
      try {
        if (
          lifetime.isCurrent() &&
          (expectedTurnId == null || interruptedTurnId != null) &&
          mode !== "descendant-cleanup" &&
          this.streamState.getRole(threadId)?.role !== "follower"
        ) {
          const cleanup = runConversationOperation(
            "codex:thread:interrupt-effects",
            this.hostId,
            threadId,
            "descendants",
          ).catch((error) => console.warn("Failed to interrupt descendants", error));
          if (mode === "user-stop") void cleanup;
          else await cleanup;
        }
      } finally {
        lifetime[Symbol.dispose]();
      }
    }
  }

  private async declineOwnerRequestsBeforeInterrupt(threadId: string): Promise<void> {
    const requests = [...(this.conversationsById.get(threadId)?.canonicalRequests ?? [])];
    await Promise.all(
      requests.map(async (request) => {
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
            await this.respondOptionPickerRequest(threadId, request.id, {
              action: "dismiss",
              selectedOptions: [],
              freeformAnswer: null,
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
      }),
    );
  }

  private async sendNativeUserResponseToOwner(
    conversationId: string,
    response: Exclude<
      CodexNativeUserResponse,
      {
        readonly method:
          | "item/tool/requestOptionPicker"
          | "item/tool/requestSetupCodexContextPicker";
      }
    >,
  ): Promise<boolean> {
    const role = this.streamState.getRole(conversationId);
    if (role?.role !== "follower") return false;
    const common = { conversationId, requestId: response.requestId };
    const request =
      response.method === "item/commandExecution/requestApproval"
        ? conversationFollowerRequest("thread-follower-command-approval-decision", {
            ...common,
            decision: response.response.decision,
          })
        : response.method === "item/fileChange/requestApproval"
          ? conversationFollowerRequest("thread-follower-file-approval-decision", {
              ...common,
              decision: response.response.decision,
            })
          : response.method === "item/tool/requestUserInput"
            ? conversationFollowerRequest("thread-follower-submit-user-input", {
                ...common,
                response: response.response,
              })
            : response.method === "item/permissions/requestApproval"
              ? conversationFollowerRequest(
                  "thread-follower-permissions-request-approval-response",
                  { ...common, response: response.response },
                )
              : conversationFollowerRequest(
                  "thread-follower-submit-mcp-server-elicitation-response",
                  { ...common, response: response.response },
                );
    try {
      const result = await (
        await getConversationCoordinationHost()
      ).requestThreadFollower({ hostId: this.hostId, targetClientId: role.ownerClientId, request });
      if (result.resultType !== "success") return false;
      return (
        typeof result.result === "object" &&
        result.result !== null &&
        "ok" in result.result &&
        result.result.ok === true
      );
    } catch (error) {
      console.warn("Failed to send follower request response to owner", error);
      return false;
    }
  }

  private async commitNativeUserResponse(
    conversationId: string,
    response: CodexNativeUserResponse,
    mutate: (draft: Draft<CodexCanonicalConversationState>) => {
      readonly selectedRequests: readonly unknown[];
    },
  ): Promise<OwnerServerRequestReplyResult> {
    if (response.method !== "item/tool/requestOptionPicker")
      this.assertOwnerForConversation(conversationId);
    const before = this.historyClient.getConversation(conversationId);
    if (!before) return { accepted: false };
    const key = JSON.stringify([conversationId, response.requestId]);
    const occurrence = this.nativeRequestOccurrences
      .get(key)
      ?.find(
        (entry) =>
          entry.request.method === response.method &&
          entry.generation === this.nativeHostContext?.generation,
      );
    if (!occurrence) return { accepted: false };
    const receipt = new CodexConversationEntityDocument().withCanonicalState(before).mutate(mutate);
    if (!receipt || receipt.result.selectedRequests.length === 0) return { accepted: false };
    const result = sendCodexAppServerResponse({
      hostId: occurrence.hostId,
      generation: occurrence.generation,
      occurrenceId: occurrence.occurrenceId,
      occurrenceToken: occurrence.occurrenceToken,
      threadId: conversationId,
      ...response,
    } satisfies CodexNativeUserResponseInput);
    this.nativeRequestOccurrences.delete(key);
    if (receipt.after !== before) this.applyCanonicalDocument(receipt.after);
    if (receipt.patches.length) this.streamState.broadcastPatches(conversationId, receipt.patches);
    return { accepted: await result };
  }

  private async commitNativeDynamicToolResponse(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    value: unknown,
    mutate: (draft: Draft<CodexCanonicalConversationState>) => {
      readonly selectedRequests: readonly unknown[];
    },
  ): Promise<OwnerServerRequestReplyResult> {
    const before = this.historyClient.getConversation(conversationId);
    if (!before) return { accepted: false };
    const key = JSON.stringify([conversationId, requestId]);
    const occurrence = this.nativeRequestOccurrences
      .get(key)
      ?.find(
        (entry) =>
          entry.request.method === "item/tool/call" &&
          entry.generation === this.nativeHostContext?.generation,
      );
    if (!occurrence) return { accepted: false };
    const receipt = new CodexConversationEntityDocument().withCanonicalState(before).mutate(mutate);
    if (!receipt || receipt.result.selectedRequests.length === 0) return { accepted: false };
    const result = sendCodexAppServerResponse({
      ...occurrence,
      effect: {
        type: "respond",
        method: "item/tool/call",
        requestId,
        response: {
          contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
          success: true,
        },
      },
    } satisfies CodexNativeAutoResponseInput);
    this.nativeRequestOccurrences.delete(key);
    if (receipt.after !== before) this.applyCanonicalDocument(receipt.after);
    if (receipt.patches.length) this.streamState.broadcastPatches(conversationId, receipt.patches);
    return { accepted: await result };
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
      return await this.sendNativeUserResponseToOwner(
        followerConversationId,
        response.kind === "command"
          ? {
              method: "item/commandExecution/requestApproval",
              requestId,
              response: { decision: response.decision },
            }
          : {
              method: "item/fileChange/requestApproval",
              requestId,
              response: { decision: response.decision },
            },
      );
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
    const native: CodexNativeUserResponse =
      response.kind === "command"
        ? {
            method: "item/commandExecution/requestApproval",
            requestId,
            response: { decision: response.decision },
          }
        : {
            method: "item/fileChange/requestApproval",
            requestId,
            response: { decision: response.decision },
          };
    return this.commitNativeUserResponse(conversationId, native, (draft) =>
      mutateCodexConversationApprovalResponse(draft, requestId, native.method),
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
      return await this.sendNativeUserResponseToOwner(followerConversationId, {
        method: "item/tool/requestUserInput",
        requestId,
        response: {
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
          ),
        },
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
    const response = {
      answers: Object.fromEntries(
        Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
      ),
    };
    const request = this.conversationsById
      .get(conversationId)
      ?.canonicalRequests?.find((candidate) => candidate.id === requestId);
    if (
      request?.method === "item/tool/call" &&
      hasCodexDynamicToolIdentity(request.params, {
        namespace: CODEX_APP_TOOL_NAMESPACE,
        tool: "request_onboarding_input",
      })
    ) {
      return this.commitNativeDynamicToolResponse(conversationId, requestId, response, (draft) =>
        mutateCodexConversationOnboardingInputResponse(draft, requestId),
      );
    }
    const native: CodexNativeUserResponse = {
      method: "item/tool/requestUserInput",
      requestId,
      response,
    };
    return this.commitNativeUserResponse(conversationId, native, (draft) =>
      mutateCodexConversationUserInputResponse(draft, requestId, answers, { now: Date.now }),
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
      return await this.sendNativeUserResponseToOwner(followerConversationId, {
        method: "mcpServer/elicitation/request",
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
    return this.commitNativeUserResponse(
      conversationId,
      { method: "mcpServer/elicitation/request", requestId, response },
      (draft) =>
        mutateCodexConversationMcpElicitationResponse(draft, requestId, response, {
          now: Date.now,
        }),
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
      return await this.sendNativeUserResponseToOwner(followerConversationId, {
        method: "item/permissions/requestApproval",
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
    return this.commitNativeUserResponse(
      conversationId,
      { method: "item/permissions/requestApproval", requestId, response },
      (draft) =>
        mutateCodexConversationPermissionResponse(draft, requestId, response, { now: Date.now }),
    );
  }

  async respondSetupCodexStep(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupCodexStepResponse,
  ): Promise<boolean> {
    return (await this.respondSetupCodexStepRequest(conversationId, requestId, response)).accepted;
  }

  private async respondSetupCodexStepRequest(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupCodexStepResponse,
  ): Promise<OwnerServerRequestReplyResult> {
    const request = this.conversationsById
      .get(conversationId)
      ?.canonicalRequests?.find((candidate) => candidate.id === requestId);
    if (
      request?.method !== "item/tool/call" ||
      !hasCodexDynamicToolIdentity(request.params, {
        namespace: CODEX_APP_TOOL_NAMESPACE,
        tool: "setup_codex_step",
      })
    ) {
      return { accepted: false };
    }
    return this.commitNativeDynamicToolResponse(conversationId, requestId, response, (draft) =>
      mutateCodexConversationSetupCodexStepResponse(draft, requestId, response),
    );
  }

  async respondOptionPicker(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
  ): Promise<boolean> {
    return (await this.respondOptionPickerRequest(conversationId, requestId, response)).accepted;
  }

  private async respondOptionPickerRequest(
    conversationId: string,
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
  ): Promise<OwnerServerRequestReplyResult> {
    const conversation = this.conversationsById.get(conversationId);
    if (
      !conversation ||
      !hasOwnerStoredInteractiveResponseTarget(conversation, requestId, "optionPicker")
    )
      return { accepted: false };
    const request = conversation.canonicalRequests?.find((candidate) => candidate.id === requestId);
    if (request?.method === "item/tool/requestOptionPicker") {
      return this.commitNativeUserResponse(
        conversationId,
        { method: request.method, requestId, response },
        (draft) => mutateCodexConversationOptionPickerResponse(draft, requestId),
      );
    }
    if (
      request?.method === "item/tool/call" &&
      hasCodexDynamicToolIdentity(request.params, {
        namespace: CODEX_APP_TOOL_NAMESPACE,
        tool: "request_option_picker",
      })
    ) {
      return this.commitNativeDynamicToolResponse(conversationId, requestId, response, (draft) =>
        mutateCodexConversationOptionPickerResponse(draft, requestId),
      );
    }
    return { accepted: false };
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

  receiveReadStateSnapshot(unreadIds: readonly string[] | null): void {
    this.savedReadState = unreadIds === null ? null : new Set(unreadIds);
    if (this.savedReadState === null) return;
    const ids = new Set([...this.conversationsById.keys(), ...this.threadSummariesById.keys()]);
    for (const id of ids) this.applyConversationUnreadState(id, this.savedReadState.has(id));
  }

  receiveReadStateChange(threadId: string, unread: boolean): void {
    if (unread) this.savedReadState?.add(threadId);
    else this.savedReadState?.delete(threadId);
    this.applyConversationUnreadState(threadId, unread);
  }

  private applyConversationUnreadState(conversationId: string, hasUnreadTurn: boolean): boolean {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return false;
    const conversation = this.conversationsById.get(normalizedConversationId);
    const summary = this.threadSummariesById.get(normalizedConversationId);
    if (!conversation && !summary) return false;
    const conversationChanged = Boolean(
      conversation &&
      (conversation.hasUnreadTurn !== hasUnreadTurn ||
        (conversation.canonicalState != null &&
          conversation.canonicalState.hasUnreadTurn !== hasUnreadTurn)),
    );
    const summaryChanged = Boolean(summary && summary.hasUnreadTurn !== hasUnreadTurn);
    if (!conversationChanged && !summaryChanged) return false;

    if (conversation && conversationChanged) {
      const nextConversation = applyStandaloneUnreadStateToSnapshot(conversation, hasUnreadTurn);
      this.applyConversationSnapshot(normalizedConversationId, nextConversation);
    }
    if (summary && summaryChanged) {
      this.applyThreadSummary({ ...summary, hasUnreadTurn });
    }
    return true;
  }

  async setConversationUnreadState(
    conversationId: string,
    hasUnreadTurn: boolean,
    origin: "user" | "turn" = "user",
  ): Promise<void> {
    const savedUnread = this.savedReadState?.has(conversationId) ?? false;
    const changed = this.applyConversationUnreadState(conversationId, hasUnreadTurn);
    if (!changed && savedUnread === hasUnreadTurn) return;
    if (hasUnreadTurn) this.savedReadState?.add(conversationId);
    else this.savedReadState?.delete(conversationId);
    await this.saveReadState(conversationId, hasUnreadTurn, origin);
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
    if (!this.historyClient.getConversation(threadId)) return false;
    this.historyClient.updateConversation(threadId, (draft) =>
      mutateCodexCanonicalPlanImplementationCompletion(draft, turnId),
    );
    return true;
  }

  resetForTests(): void {
    this.streamRecovery.dispose();
    this.cancelPendingNodexAgentAuthorizations();
    this.connection = INITIAL_CONNECTION;
    this.account = null;
    this.dictationState = DEFAULT_CODEX_DICTATION_STATE;
    this.availableModels = EMPTY_MODELS;
    this.threadSummariesByProject.clear();
    this.threadSummariesById.clear();
    this.loadedThreadSummariesByProject.clear();
    this.threadSummaryLoadsInFlightByProject.clear();
    this.cancelPendingConversationResumes();
    this.attachmentStateByThreadId.clear();
    this.interruptedTurnResumesInFlightByThreadId.clear();
    this.conversationsById.clear();
    this.asyncQuestions.clear();
    this.ownerHiddenLifecycleItemTypesByConversationId.clear();
    this.conversationVersionById.clear();
    this.streamState.resetAfterReconnect();
    this.followerMembershipByConversationId.clear();
    this.composerIntentsByThread.clear();
    this.permissionStateByScope.clear();
    this.permissionStateLoadsInFlightByScope.clear();
    this.threadStartProgressByTarget.clear();
    this.threadTitlesById.clear();
    this.threadsById.clear();
    this.projectSummaryCallbacksByProject.clear();
    this.recentConversationIds.length = 0;
    this.lastHostError = null;
    this.lastAnySnapshotById.clear();
    this.lastMetaSnapshotById.clear();
    this.lastAnyOrderKey = null;
    this.lastMetaOrderKey = null;
    this.conversationActivity.clear();
    this.ownerTextDeltaQueue.dispose();
    this.outputDeltaQueue.dispose();

    this.terminalInputBuffers.clear();
    this.bootstrapStarted = false;
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
        this.hostId,
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
        const previousConnection = this.connection;
        const nextConnection = sharedObject.value;
        if (
          nextConnection.status !== "connected" &&
          (this.nativeHostContext !== null || this.nativeHostContextLoad !== null)
        ) {
          const source = nextConnection.native ?? previousConnection.native;
          if (
            source?.transportKind === "websocket" &&
            source.sourceEpoch ===
              (this.nativeHostContext ?? this.suspendedNativeHostContext)?.sourceEpoch
          )
            this.suspendNativeConnection();
          else this.retireNativeHostContext();
        } else if (
          previousConnection.status === "connected" &&
          nextConnection.status === "connected" &&
          previousConnection.native != null &&
          nextConnection.native != null &&
          (previousConnection.native.sourceEpoch !== nextConnection.native.sourceEpoch ||
            previousConnection.native.generation !== nextConnection.native.generation ||
            previousConnection.native.transportKind !== nextConnection.native.transportKind)
        ) {
          const sameWebSocketIdentity =
            previousConnection.native.transportKind === "websocket" &&
            nextConnection.native.transportKind === "websocket" &&
            previousConnection.native.sourceEpoch === nextConnection.native.sourceEpoch;
          if (sameWebSocketIdentity) this.suspendNativeConnection();
          else this.retireNativeHostContext();
        }
        this.connection = nextConnection;
        if (this.connection.status === "connected")
          void this.refreshNativeHostContext().catch(() => {});
        for (const id of this.conversationsById.keys()) this.wakeQueuedMessages(id);
        this.notifyListeners(this.connectionCallbacks);
      }
      return;
    }

    if (sharedObject.objectType === "account") {
      if (this.account === sharedObject.value) {
        return;
      }

      this.account = sharedObject.value;
      if (this.connection.status === "connected")
        void this.refreshNativeHostContext().catch(() => {});
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

  private consumeOwnerThreadMetadataEffects(effects: readonly CodexThreadMetadataEffect[]): void {
    for (const effect of effects) {
      if (effect.type === "clearCompletedGoal") {
        void this.clearThreadGoal(effect.threadId).catch(() => {});
        continue;
      }
    }
  }

  private registerThreadMetadata(thread: Thread): void {
    this.threadsById.set(thread.id, { ...thread, turns: [] });
    for (const [id, conversation] of this.conversationsById) {
      if (this.streamState.getRole(id)?.role === "follower") continue;
      const before = conversation.canonicalState;
      if (!before) continue;
      const receipt = new CodexConversationEntityDocument()
        .withCanonicalState(before)
        .mutate((draft) =>
          mutateCodexConversationThreadMetadata(
            draft,
            thread.id,
            (id) => this.threadsById.get(id) ?? null,
          ),
        );
      if (!receipt || receipt.after === before) continue;
      this.applyCanonicalDocument(receipt.after);
      if (this.streamState.getRole(id)?.role === "owner")
        this.streamState.broadcastPatches(id, receipt.patches);
    }
    const current = this.conversationsById.get(thread.id)?.canonicalState;
    if (current) this.applyCanonicalDocument(current);
  }

  private markOwnerStreamPublishUnavailable(conversationId: string): void {
    this.ownerTextDeltaQueue.discardConversation(conversationId);
    this.outputDeltaQueue.discardConversation(conversationId);

    const conversation = this.conversationsById.get(conversationId);
    if (!conversation) {
      this.streamState.removeConversation(conversationId);
      this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
      return;
    }

    this.markConversationResumeState(conversationId, "needs_resume");
    this.streamState.removeConversation(conversationId);
    this.setConversationAttachmentState(conversationId, IDLE_LOCAL_CONVERSATION_ATTACHMENT_STATE);
  }

  private handleOwnerReducerUnavailable(conversationId: string): void {
    if (this.streamState.getRole(conversationId)?.role === "follower") {
      return;
    }

    this.markOwnerStreamPublishUnavailable(conversationId);
  }

  private applyConversationChildMembershipsUpdate(
    event: Extract<
      CodexSharedObject,
      {
        objectType: "conversationChildMemberships";
      }
    >["value"],
  ): void {
    const parentThreadId = event.parentThreadId.trim();
    if (!parentThreadId) return;

    const previous = this.childMembershipsByParentThreadId.get(parentThreadId);
    if (areConversationChildMembershipsEqual(previous, event.childMemberships)) return;
    this.childMembershipsByParentThreadId.set(parentThreadId, [...event.childMemberships]);
    this.notifyListeners(this.relationshipCallbacks.get(parentThreadId));
  }

  private applyThreadStartProgress(
    event: Extract<
      CodexSharedObject,
      {
        objectType: "threadStartProgress";
      }
    >["value"],
  ): void {
    const activeSubmission = sessionFirstSubmissionOwner
      .getSnapshot()
      .submissions.find(
        (submission) =>
          submission.targetProjectId === event.projectId &&
          submission.targetSessionId === event.sessionId,
      );
    if (activeSubmission && activeSubmission.launchId !== event.launchId) return;
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
      launchId: event.launchId,
      projectId: event.projectId,
      sessionId: event.sessionId,
      runInTarget: event.runInTarget,
      threadId: event.threadId,
      phase: event.phase,
      message: event.message,
      outputText: mergedOutput.text,
      outputCarriageReturnPending: mergedOutput.carriageReturnPending,
      outputTruncated: mergedOutput.didTruncate,
      updatedAt: event.updatedAt,
    };
    if (areThreadStartProgressStatesEqual(previous, nextState)) {
      return;
    }

    this.threadStartProgressByTarget.set(targetKey, nextState);
    this.notifyControlCallbacks();
  }

  private commitRendererFreshLaunchReady(
    launchId: string,
    projectId: string | null,
    sessionId: string,
    threadId: string,
  ): void {
    const targetKey = getThreadStartProgressTargetKey(projectId, sessionId);
    const current = this.threadStartProgressByTarget.get(targetKey);
    if (!current || current.launchId !== launchId) return;

    const firstSubmission = sessionFirstSubmissionOwner
      .getSnapshot()
      .submissions.find((submission) => submission.launchId === launchId);
    if (firstSubmission) {
      codexTurnFirstResponseTracker.markNewThreadNavigationDispatched(
        firstSubmission.clientUserMessageId,
      );
    }
    this.threadStartProgressByTarget.set(targetKey, {
      ...current,
      threadId,
      phase: "ready",
    });
    this.notifyControlCallbacks("sync");
  }

  private withCachedThreadTitle(thread: CodexThreadSummary): CodexThreadSummary {
    const projectedTitle = projectCodexMarkdownLabel(thread.threadName);
    if (projectedTitle) {
      return projectedTitle === thread.threadName
        ? thread
        : { ...thread, threadName: projectedTitle };
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
    const projectedTitle = projectCodexMarkdownLabel(conversation.threadName);
    if (projectedTitle) {
      return projectedTitle === conversation.threadName
        ? conversation
        : { ...conversation, threadName: projectedTitle };
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
    const normalizedTitle = projectCodexMarkdownLabel(title);
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
    this.manualCompactions.clear(threadId);
    this.goalHydrationTokens.delete(threadId);
    const normalizedThreadId = threadId.trim();
    if (!normalizedThreadId) {
      return;
    }
    for (const callback of this.conversationRemovedCallbacks) callback(normalizedThreadId);
    const pendingResume = this.resumeInFlightByThreadId.get(normalizedThreadId);
    this.resumeInFlightByThreadId.delete(normalizedThreadId);
    pendingResume?.cancel();
    for (const [requestId, pending] of this.pendingNodexAgentAuthorizations) {
      if (pending.threadId !== normalizedThreadId) continue;
      this.pendingNodexAgentAuthorizations.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve({ decision: "deny" });
    }

    this.threadsById.delete(normalizedThreadId);
    const changedProjectIds = new Set<string>();
    const existingSummary = this.threadSummariesById.get(normalizedThreadId);
    if (existingSummary?.projectId) {
      changedProjectIds.add(existingSummary.projectId);
    }

    this.threadSummariesById.delete(normalizedThreadId);
    this.conversationsById.delete(normalizedThreadId);
    this.conversationActivity.remove(normalizedThreadId);
    this.retention.remove(normalizedThreadId);
    this.asyncQuestions.clear(normalizedThreadId);
    this.attachmentStateByThreadId.delete(normalizedThreadId);
    for (const listener of this.attachmentCallbacks.get(normalizedThreadId) ?? []) listener();
    this.childMembershipsByParentThreadId.delete(normalizedThreadId);
    this.ownerHiddenLifecycleItemTypesByConversationId.delete(normalizedThreadId);
    this.primaryConversationRequestByThread.delete(normalizedThreadId);
    this.conversationVersionById.delete(normalizedThreadId);
    this.followerMembershipByConversationId.delete(normalizedThreadId);
    this.streamState.removeConversation(normalizedThreadId);
    this.ownerTextDeltaQueue.discardConversation(normalizedThreadId);
    this.outputDeltaQueue.discardConversation(normalizedThreadId);
    this.terminalInputBuffers.clearConversation(normalizedThreadId);
    this.composerIntentsByThread.delete(normalizedThreadId);

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

  private schedulePassiveHistoryRelease(threadId: string): void {
    this.retention.notificationHandled(threadId);
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

    const withSideConversation =
      conversation.canonicalState &&
      conversation.source?.sideConversation !== undefined &&
      conversation.canonicalState.sideConversation !== conversation.source.sideConversation
        ? {
            ...conversation,
            canonicalState: {
              ...conversation.canonicalState,
              sideConversation: conversation.source.sideConversation,
            },
          }
        : conversation;
    const normalizedConversation = normalizeConversationSnapshot(
      this.savedReadState !== null && !this.conversationsById.has(threadId)
        ? { ...withSideConversation, hasUnreadTurn: this.savedReadState.has(threadId) }
        : withSideConversation,
    );
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
    if (
      currentConversation?.turnPagination?.isLoadingOlder &&
      !nextConversation.turnPagination?.isLoadingOlder
    )
      this.schedulePassiveHistoryRelease(threadId);
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
      this.activeStreamingIds.add(threadId);
    } else {
      this.activeStreamingIds.delete(threadId);
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

    this.retention.reconcile(threadId);
    this.notifyConversationCallbacks(threadId, notifyMode);
    if (
      currentConversation &&
      (currentConversation.statusType !== nextConversation.statusType ||
        currentConversation.requests.length > nextConversation.requests.length)
    )
      this.schedulePassiveHistoryRelease(threadId);
  }

  private notifyConversationCallbacks(
    threadId: string,
    notifyMode: ConversationNotifyMode = "default",
  ): void {
    const conversation = this.conversationsById.get(threadId);
    if (!conversation) {
      return;
    }

    this.asyncQuestions.reconcile(conversation);
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
    if (this.archiveState.isSuppressed(threadId)) return;
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
    const previous = this.managers.get(manager.getHostId());
    if (previous === manager) return;
    previous?.destroy();
    this.managers.set(manager.getHostId(), manager);
    bindRendererConversationWindowActivity(manager);
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
    this.addManager(manager);
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
let conversationCoordinationConnection: ConversationCoordinationConnection | undefined;
let conversationCoordinationConsumers = 0;
function retainConversationCoordination(): () => void {
  conversationCoordinationConsumers++;
  void getConversationCoordinationHost().catch(() => {});
  return () => {
    conversationCoordinationConsumers--;
    if (conversationCoordinationConsumers > 0) return;
    conversationCoordinationConnection?.[Symbol.dispose]();
    conversationCoordinationConnection = undefined;
  };
}

function getConversationCoordinationConnection(): ConversationCoordinationConnection {
  conversationCoordinationConnection ??= connectConversationCoordination(
    (hostId) => codexAppServerRegistry.getForHostId(hostId),
    (method, event) => {
      if (method === "clientStatusChanged" || method === "ipcConnectionReset") {
        for (const manager of codexAppServerRegistry.getAll())
          manager.receiveCoordination(method, event);
        return;
      }
      const hostId = (event.params as { hostId?: unknown } | null)?.hostId;
      if (typeof hostId !== "string") return;
      codexAppServerRegistry.getForHostId(hostId).receiveCoordination(method, event);
    },
  );
  return conversationCoordinationConnection;
}

function getConversationCoordinationHost(): Promise<ConversationCoordinationHost> {
  return getConversationCoordinationConnection().ready;
}

function getDefaultLocalConversationManager(): CodexAppServerManager {
  return codexAppServerRegistry.getDefault();
}

function getLocalConversationManagerForConversation(
  conversationId: string,
  preferredHostId?: string | null,
): CodexAppServerManager {
  const normalizedHostId = preferredHostId?.trim();
  if (normalizedHostId) {
    return codexAppServerRegistry.getForHostId(normalizedHostId);
  }
  return (
    codexAppServerRegistry.getMaybeForConversationId(conversationId) ??
    getDefaultLocalConversationManager()
  );
}

let rendererClientRequestBridgeRefCount = 0;
let unsubscribeRendererClientRequests: (() => void) | null = null;
let rendererClientRequestManager: CodexAppServerManager | null = null;

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
    if (message.method !== NODEX_AGENT_AUTHORIZATION_RENDERER_METHOD)
      throw new Error(`Unsupported renderer client request method ${message.method}`);
    if (!isNodexAgentAuthorizationRequest(message.params))
      throw new Error("Invalid Nodex authorization request");
    return {
      type: "success",
      requestId: message.requestId,
      result: await manager.requestNodexAgentAuthorization(message.params),
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

let readStateConnection: ReturnType<typeof connectRendererThreadReadState> | undefined;
let readStateConnectionConsumers = 0;
function startThreadReadStateConnection(registry: CodexAppServerManagerRegistry): () => void {
  readStateConnectionConsumers += 1;
  readStateConnection ??= connectRendererThreadReadState(
    (hostId) => registry.getForHostId(hostId),
    getConversationCoordinationConnection().readStateReady,
  );
  return () => {
    readStateConnectionConsumers -= 1;
    if (readStateConnectionConsumers > 0) return;
    readStateConnection?.[Symbol.dispose]();
    readStateConnection = undefined;
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
    const stopCoordination = retainConversationCoordination();
    const stopReadState = startThreadReadStateConnection(registry);
    const stopHostBridge = startLocalConversationHostBridge();
    const stopRendererClientRequestBridge =
      startLocalConversationRendererClientRequestBridge(manager);
    manager.start();
    return () => {
      stopReadState();
      stopCoordination();
      stopRendererClientRequestBridge();
      stopHostBridge();
    };
  }, [manager, registry]);

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
  const cacheRef = useRef<{
    hasValue: boolean;
    value: T;
  }>({
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
  preferredHostId?: string | null,
): CodexAppServerManager {
  const manager = useMaybeCodexAppServerManagerForConversationId(conversationId);
  const registry = useCodexAppServerRegistry();
  const preferredManager = useMemo(() => {
    const normalizedHostId = preferredHostId?.trim();
    return normalizedHostId ? registry.getForHostId(normalizedHostId) : null;
  }, [preferredHostId, registry]);
  const defaultManager = useDefaultCodexAppServerManager();
  return manager ?? preferredManager ?? defaultManager;
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
    left.launchId === right.launchId &&
    left.sessionId === right.sessionId &&
    left.runInTarget === right.runInTarget &&
    left.threadId === right.threadId &&
    left.phase === right.phase &&
    left.message === right.message &&
    left.outputText === right.outputText &&
    left.outputCarriageReturnPending === right.outputCarriageReturnPending &&
    left.outputTruncated === right.outputTruncated &&
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
  hostId?: string | null,
): Promise<CodexConversationSnapshot | null> {
  return getLocalConversationManagerForConversation(threadId, hostId).requestThreadStreamSnapshot(
    threadId,
  );
}

export function requestLocalConversationResume(
  threadId: string,
  hostId?: string | null,
): Promise<CodexConversationSnapshot | null> {
  return getLocalConversationManagerForConversation(threadId, hostId).requestThreadStreamResume(
    threadId,
  );
}

export function markLocalConversationAsRead(
  threadId: string,
  hostId?: string | null,
): Promise<void> {
  return getLocalConversationManagerForConversation(threadId, hostId).markConversationAsRead(
    threadId,
  );
}

export function setLocalConversationThreadPresented(
  threadId: string,
  surfaceId: string,
  presented: boolean,
  hostId?: string | null,
): Promise<boolean> {
  return getLocalConversationManagerForConversation(threadId, hostId).setThreadPresented(
    threadId,
    surfaceId,
    presented,
  );
}

export function requestLocalConversationHistoryPage(
  request: CodexConversationHistoryPageRequest,
  hostId?: string | null,
): Promise<LocalHistoryPageResult> {
  return getLocalConversationManagerForConversation(request.threadId, hostId).requestHistoryPage(
    request,
  );
}

export function hydrateLocalPersistedHistoryOccurrence(
  input: CodexPersistedHistoryOccurrenceHydrateInput,
): Promise<CodexPersistedHistoryOccurrenceResolution> {
  return codexAppServerRegistry.getForHostId(input.hostId).hydratePersistedHistoryOccurrence(input);
}

export function setLocalConversationComposerIntent(
  threadId: string,
  composerIntent: CodexComposerIntent,
  hostId?: string | null,
): void {
  getLocalConversationManagerForConversation(threadId, hostId).setComposerIntent(
    threadId,
    composerIntent,
  );
}

export function consumeLocalConversationComposerIntent(
  threadId: string,
  focusNonce: number,
  hostId?: string | null,
): void {
  getLocalConversationManagerForConversation(threadId, hostId).consumeComposerIntent(
    threadId,
    focusNonce,
  );
}

export function removeLocalConversationPlanImplementationRequest(
  threadId: string,
  turnId: string,
  hostId?: string | null,
): Promise<boolean> {
  return getLocalConversationManagerForConversation(
    threadId,
    hostId,
  ).removePlanImplementationRequest(threadId, turnId);
}

export function setLocalConversationCollaborationMode(
  threadId: string,
  mode: CodexCollaborationModeKind,
  hostId?: string | null,
): Promise<CodexCollaborationModeState> {
  return getLocalConversationManagerForConversation(
    threadId,
    hostId,
  ).setLatestCollaborationModeForConversation(threadId, mode);
}

export function readLocalConversation(
  threadId: string,
  hostId?: string | null,
): CodexConversationSnapshot | null {
  return getLocalConversationManagerForConversation(threadId, hostId).readConversation(threadId);
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

export function useLocalConversationConnection(
  conversationId: string | null = null,
): CodexConnectionState {
  const manager = useCodexAppServerManagerForConversationId(conversationId);
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

function useCodexAvailableModelsForManager(manager: CodexAppServerManager): CodexModelOption[] {
  return useExternalSelector(
    (listener) => manager.subscribeControl(listener),
    () => manager.readAvailableModels(),
    areModelsEqual,
  );
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
  return useCodexPermissionStateForManager(manager, projectId);
}

function useCodexPermissionStateForManager(
  manager: CodexAppServerManager,
  projectId: string | null,
): CodexPermissionState {
  useEffect(() => {
    void manager.loadPermissionState(projectId).catch(() => {
      // main-process authority will retry on the next interaction
    });
  }, [manager, projectId]);

  return useExternalSelector(
    (listener) => manager.subscribeControl(listener),
    () => manager.readPermissionState(projectId),
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
        launchId: progress.launchId,
        projectId: progress.projectId,
        sessionId: progress.sessionId,
        runInTarget: progress.runInTarget,
        threadId: progress.threadId,
        phase: progress.phase,
        message: progress.message,
        outputText: progress.outputText,
        outputTruncated: progress.outputTruncated,
        updatedAt: progress.updatedAt,
      };
    },
    (left, right) => JSON.stringify(left) === JSON.stringify(right),
  );
}

export function useCodexAppServerControl(
  activeProjectId: string | null,
  activeConversationId: string | null = null,
  preferredHostId?: string | null,
) {
  const registry = useCodexAppServerRegistry();
  const manager = useCodexAppServerManagerForConversationId(activeConversationId, preferredHostId);
  const managerForConversation = useCallback(
    (conversationId: string) => registry.getMaybeForConversationId(conversationId) ?? manager,
    [manager, registry],
  );
  const workbenchOwner = useWorkbenchWindowOwner();
  const availableModels = useCodexAvailableModelsForManager(manager);
  const permissionState = useCodexPermissionStateForManager(manager, activeProjectId);
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
    async (
      projectId: string,
      opts?: {
        includeArchived?: boolean;
      },
    ) => manager.loadThreads(projectId, opts),
    [manager],
  );
  const loadModels = useCallback(async () => manager.loadAvailableModels(), [manager]);
  const listCollaborationModes = useCallback(
    async () => manager.listCollaborationModes(),
    [manager],
  );
  const requestThreadStreamSnapshot = useCallback(
    async (threadId: string) =>
      managerForConversation(threadId).requestThreadStreamSnapshot(threadId),
    [managerForConversation],
  );
  const readSubagentOverview = useCallback(
    async (input: CodexSubagentOverviewReadInput) =>
      managerForConversation(input.rootThreadId).readSubagentOverview(input),
    [managerForConversation],
  );
  const hydrateSelectedSubagent = useCallback(
    async (input: CodexSelectedSubagentHydrateInput) =>
      managerForConversation(input.rootThreadId).hydrateSelectedSubagent(input),
    [managerForConversation],
  );
  const refreshSelectedSubagentAuthority = useCallback(
    async (input: CodexSelectedSubagentHydrateInput) =>
      managerForConversation(input.rootThreadId).refreshSelectedSubagentAuthority(input),
    [managerForConversation],
  );

  const captureSubmissionPresentation = useCallback(
    () => readCodexSubmissionPresentation(workbenchOwner),
    [workbenchOwner],
  );

  const startThreadForSession = useCallback(
    async (
      input: CodexThreadStartForSessionInput & {
        collaborationMode?: CodexCollaborationModeKind;
      },
      submittedPresentation?: WorkbenchSubmitPresentation,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "session",
          sessionId: input.sessionId,
          launchId: input.firstSubmission.launchId,
        },
        submittedPresentation,
      );
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const requestSettings = resolveCodexDraftRequestSettings(input, resolvedSettings);
      const effectiveServiceTier = resolveCodexRequestServiceTier(
        input,
        serviceTierSettings.serviceTier,
      );
      const launchManager = input.executionHostId
        ? registry.getForHostId(input.executionHostId)
        : manager;
      const result = await launchManager.startThreadForSession({
        ...input,
        presentationTicket,
        ...requestSettings,
        ...buildCodexServiceTierRequestOverride(effectiveServiceTier),
        executionProfile: input.executionProfile ?? executionProfile ?? undefined,
      });
      if (result.kind === "started" && input.projectId !== null) {
        await launchManager.loadThreads(input.projectId);
      }
      return result;
    },
    [
      availableModels,
      executionProfile,
      manager,
      registry,
      serviceTierSettings.serviceTier,
      storedThreadSettings,
      workbenchOwner,
    ],
  );

  const startSideChat = useCallback(
    async (input: CodexSideChatStartInput, submittedPresentation?: WorkbenchSubmitPresentation) => {
      const clientUserMessageId = createOwnerClientUserMessageId();
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "side_chat",
          parentThreadId: input.parentThreadId,
          clientUserMessageId,
        },
        submittedPresentation,
      );
      const resolvedSettings = resolveCodexThreadSettings(storedThreadSettings, availableModels);
      const requestSettings = resolveCodexDraftRequestSettings(input, resolvedSettings);
      const effectiveServiceTier = resolveCodexRequestServiceTier(
        input,
        serviceTierSettings.serviceTier,
      );
      return managerForConversation(input.parentThreadId).startSideChat({
        ...input,
        presentationTicket,
        clientUserMessageId,
        ...requestSettings,
        ...buildCodexServiceTierRequestOverride(effectiveServiceTier),
      });
    },
    [
      availableModels,
      managerForConversation,
      serviceTierSettings.serviceTier,
      storedThreadSettings,
      workbenchOwner,
    ],
  );

  const discardSideChat = useCallback(
    async (threadId: string) => managerForConversation(threadId).discardSideChat(threadId),
    [managerForConversation],
  );

  const setThreadName = useCallback(
    async (threadId: string, name: string, projectId: string) =>
      managerForConversation(threadId).setThreadName(threadId, name, projectId),
    [managerForConversation],
  );
  const archiveThread = useCallback(
    async (threadId: string, projectId: string | null) =>
      managerForConversation(threadId).archiveThread(threadId, projectId),
    [managerForConversation],
  );
  const unarchiveThread = useCallback(
    async (threadId: string, projectId: string | null) =>
      managerForConversation(threadId).unarchiveThread(threadId, projectId),
    [managerForConversation],
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
      submittedPresentation?: WorkbenchSubmitPresentation,
      submissionIdentity?: RendererTurnSubmissionIdentity,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId,
        },
        submittedPresentation,
      );
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      const targetManager = managerForConversation(threadId);
      await targetManager.loadPermissionState(resolvedProjectId);
      const turnOpts: CodexTurnStartOptions = {
        permissionMode: targetManager.readPermissionMode(resolvedProjectId),
        collaborationMode: opts?.collaborationMode,
        model: opts?.model,
        reasoningEffort: opts?.reasoningEffort,
        ...(opts?.promptInput ? { promptInput: opts.promptInput } : {}),
        ...buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
      };
      return targetManager.startTurn(
        threadId,
        prompt,
        turnOpts,
        presentationTicket,
        submissionIdentity,
      );
    },
    [activeProjectId, managerForConversation, workbenchOwner],
  );

  const resumeInterruptedTurn = useCallback(
    async (
      threadId: string,
      opts?: {
        projectId?: string;
      },
      submittedPresentation?: WorkbenchSubmitPresentation,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId,
        },
        submittedPresentation,
      );
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      const targetManager = managerForConversation(threadId);
      await targetManager.loadPermissionState(resolvedProjectId);
      return await targetManager.resumeInterruptedTurn(
        threadId,
        {
          permissionMode: targetManager.readPermissionMode(resolvedProjectId),
        },
        presentationTicket,
      );
    },
    [activeProjectId, managerForConversation, workbenchOwner],
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
      submittedPresentation?: WorkbenchSubmitPresentation,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId,
        },
        submittedPresentation,
      );
      const resolvedProjectId = opts?.projectId ?? activeProjectId;
      const targetManager = managerForConversation(threadId);
      await targetManager.loadPermissionState(resolvedProjectId);
      const turnOpts: CodexTurnStartOptions = {
        permissionMode: targetManager.readPermissionMode(resolvedProjectId),
        collaborationMode: opts?.collaborationMode ?? undefined,
        ...(opts?.promptInput ? { promptInput: opts.promptInput } : {}),
        ...buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
      };
      await targetManager.enqueueQueuedFollowUp(threadId, prompt, turnOpts, presentationTicket);
    },
    [activeProjectId, managerForConversation, workbenchOwner],
  );

  const removeQueuedFollowUp = useCallback(
    async (threadId: string, followUpId: string) =>
      managerForConversation(threadId).removeQueuedFollowUp(threadId, followUpId),
    [managerForConversation],
  );
  const replaceQueuedFollowUp = useCallback(
    async (
      threadId: string,
      followUpId: string,
      expectedLedgerRevision: number,
      prompt: string,
      opts?: CodexTurnStartOptions,
      submittedPresentation?: WorkbenchSubmitPresentation,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId,
        },
        submittedPresentation,
      );
      return managerForConversation(threadId).replaceQueuedFollowUp(
        threadId,
        followUpId,
        expectedLedgerRevision,
        prompt,
        opts,
        presentationTicket,
      );
    },
    [managerForConversation, workbenchOwner],
  );
  const reorderQueuedFollowUps = useCallback(
    async (threadId: string, orderedFollowUpIds: string[]) =>
      managerForConversation(threadId).reorderQueuedFollowUps(threadId, orderedFollowUpIds),
    [managerForConversation],
  );
  const resumeQueuedFollowUps = useCallback(
    async (threadId: string) => managerForConversation(threadId).resumeQueuedFollowUps(threadId),
    [managerForConversation],
  );
  const resolveQueuedFollowUpsAfterFreshStart = useCallback(
    async (threadId: string, expectedLedgerRevision: number, resolution: "resume" | "clear") =>
      managerForConversation(threadId).resolveQueuedFollowUpsAfterFreshStart(
        threadId,
        expectedLedgerRevision,
        resolution,
      ),
    [managerForConversation],
  );
  const sendQueuedFollowUpNow = useCallback(
    async (threadId: string, followUpId: string) =>
      managerForConversation(threadId).sendQueuedFollowUpNow(threadId, followUpId),
    [managerForConversation],
  );
  const editLastUserTurn = useCallback(
    async (
      threadId: string,
      turnId: string,
      message: string,
      opts?: {
        serviceTier?: CodexServiceTier;
      },
      submittedPresentation?: WorkbenchSubmitPresentation,
    ) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId,
        },
        submittedPresentation,
      );
      return managerForConversation(threadId).editLastUserTurn(
        threadId,
        turnId,
        message,
        buildCodexServiceTierRequestOverride(opts?.serviceTier ?? null),
        presentationTicket,
      );
    },
    [managerForConversation, workbenchOwner],
  );
  const forkConversationFromTurn = useCallback(
    async (threadId: string, turnId: string, message: string) =>
      managerForConversation(threadId).forkConversationFromTurn(threadId, turnId, message),
    [managerForConversation],
  );
  const compactThread = useCallback(
    async (threadId: string) => managerForConversation(threadId).compactThread(threadId),
    [managerForConversation],
  );
  const getThreadGoal = useCallback(
    async (threadId: string) => managerForConversation(threadId).getThreadGoal(threadId),
    [managerForConversation],
  );
  const setThreadGoal = useCallback(
    async (input: CodexThreadGoalSetActionInput) =>
      managerForConversation(input.threadId).setThreadGoal(input),
    [managerForConversation],
  );
  const clearThreadGoal = useCallback(
    async (threadId: string) => managerForConversation(threadId).clearThreadGoal(threadId),
    [managerForConversation],
  );
  const dismissThreadGoalResumeConfirmation = useCallback(
    async (threadId: string) =>
      managerForConversation(threadId).dismissThreadGoalResumeConfirmation(threadId),
    [managerForConversation],
  );
  const setThreadMemoryMode = useCallback(
    async (input: { threadId: string; mode: ThreadMemoryMode }) =>
      managerForConversation(input.threadId).setThreadMemoryMode(input),
    [managerForConversation],
  );
  const uploadFeedback = useCallback(
    async (params: FeedbackUploadParams) => manager.uploadFeedback(params),
    [manager],
  );
  const cleanBackgroundTerminals = useCallback(
    async (threadId: string) => managerForConversation(threadId).cleanBackgroundTerminals(threadId),
    [managerForConversation],
  );
  const listBackgroundTerminals = useCallback(
    async (threadId: string) => managerForConversation(threadId).listBackgroundTerminals(threadId),
    [managerForConversation],
  );
  const listBackgroundProcesses = useCallback(
    async (threadId: string) => managerForConversation(threadId).listBackgroundProcesses(threadId),
    [managerForConversation],
  );
  const runBackgroundProcess = useCallback(
    async (input: CodexBackgroundProcessRunActionInput) =>
      managerForConversation(input.threadId).runBackgroundProcess(input),
    [managerForConversation],
  );
  const stopBackgroundProcess = useCallback(
    async (input: {
      threadId: string;
      processId: string | null;
      terminalSessionId: string | null;
    }) => managerForConversation(input.threadId).stopBackgroundProcess(input),
    [managerForConversation],
  );
  const terminateBackgroundTerminal = useCallback(
    async (input: { threadId: string; processId: string }) =>
      managerForConversation(input.threadId).terminateBackgroundTerminal(input),
    [managerForConversation],
  );
  const setComposerIntent = useCallback(
    (threadId: string, composerIntent: CodexComposerIntent) =>
      managerForConversation(threadId).setComposerIntent(threadId, composerIntent),
    [managerForConversation],
  );
  const consumeComposerIntent = useCallback(
    (threadId: string, focusNonce: number) =>
      managerForConversation(threadId).consumeComposerIntent(threadId, focusNonce),
    [managerForConversation],
  );
  const setConversationCollaborationMode = useCallback(
    async (threadId: string, mode: CodexCollaborationModeKind) =>
      managerForConversation(threadId).setLatestCollaborationModeForConversation(threadId, mode),
    [managerForConversation],
  );
  const setConversationThreadSettings = useCallback(
    async (threadId: string, patch: CodexConversationThreadSettingsPatch) =>
      managerForConversation(threadId).setThreadSettingsForConversation(threadId, patch),
    [managerForConversation],
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
      managerForConversation(threadId).removePlanImplementationRequest(threadId, turnId),
    [managerForConversation],
  );
  const markConversationAsRead = useCallback(
    async (conversationId: string) =>
      managerForConversation(conversationId).markConversationAsRead(conversationId),
    [managerForConversation],
  );
  const markConversationAsUnread = useCallback(
    async (conversationId: string) =>
      managerForConversation(conversationId).markConversationAsUnread(conversationId),
    [managerForConversation],
  );

  const steerTurn = useCallback(
    async (input: CodexSteerTurnInput, submittedPresentation?: WorkbenchSubmitPresentation) => {
      const presentationTicket = await captureCodexTurnPresentation(
        workbenchOwner,
        {
          kind: "thread",
          threadId: input.threadId,
        },
        submittedPresentation,
      );
      return managerForConversation(input.threadId).steerTurn({ ...input, presentationTicket });
    },
    [managerForConversation, workbenchOwner],
  );
  const interruptTurn = useCallback(
    async (threadId: string, turnId?: string) =>
      managerForConversation(threadId).interruptTurn(threadId, turnId),
    [managerForConversation],
  );
  const respondApproval = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexApprovalResponse,
      conversationId?: string | null,
    ) =>
      (conversationId ? managerForConversation(conversationId) : manager).respondApproval(
        requestId,
        response,
        conversationId,
      ),
    [manager, managerForConversation],
  );
  const respondUserInput = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      answers: Record<string, string[]>,
      conversationId?: string | null,
    ) =>
      (conversationId ? managerForConversation(conversationId) : manager).respondUserInput(
        requestId,
        answers,
        conversationId,
      ),
    [manager, managerForConversation],
  );
  const respondMcpElicitation = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexMcpServerElicitationAction | CodexMcpServerElicitationResponse,
      conversationId?: string | null,
    ) =>
      (conversationId ? managerForConversation(conversationId) : manager).respondMcpElicitation(
        requestId,
        response,
        conversationId,
      ),
    [manager, managerForConversation],
  );
  const respondPermissionRequest = useCallback(
    async (
      requestId: CodexProtocolRequestId,
      response: CodexPermissionRequestResponse,
      conversationId?: string | null,
    ) =>
      (conversationId ? managerForConversation(conversationId) : manager).respondPermissionRequest(
        requestId,
        response,
        conversationId,
      ),
    [manager, managerForConversation],
  );
  const respondNodexAgentAuthorization = useCallback(
    async (
      requestId: string,
      response: NodexAgentAuthorizationResponse,
      conversationId?: string | null,
    ) =>
      (conversationId
        ? managerForConversation(conversationId)
        : manager
      ).respondNodexAgentAuthorization(requestId, response, conversationId),
    [manager, managerForConversation],
  );
  const respondOptionPicker = useCallback(
    async (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalOptionPickerResponse,
    ) =>
      managerForConversation(conversationId).respondOptionPicker(
        conversationId,
        requestId,
        response,
      ),
    [managerForConversation],
  );
  const respondSetupCodexStep = useCallback(
    async (
      conversationId: string,
      requestId: CodexProtocolRequestId,
      response: CodexCanonicalSetupCodexStepResponse,
    ) =>
      managerForConversation(conversationId).respondSetupCodexStep(
        conversationId,
        requestId,
        response,
      ),
    [managerForConversation],
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
    captureSubmissionPresentation,
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

export function loadLocalConversationPromptRailIndex(
  input: CodexPromptRailIndexRequest,
  hostId?: string | null,
): Promise<CodexPromptRailIndexCommandResult> {
  return getLocalConversationManagerForConversation(input.threadId, hostId).loadPromptRailIndex(
    input,
  );
}
export function revealLocalConversationPromptRailTurn(
  input: CodexPromptRailRevealRequest,
): Promise<CodexPromptRailRevealCommandResult> {
  return codexAppServerRegistry.getForHostId(input.hostId).revealPromptRail(input);
}
export function prepareLocalConversationPromptRailNavigation(
  reveal: CodexPromptRailReveal,
): Promise<void> {
  return codexAppServerRegistry.getForHostId(reveal.hostId).preparePromptRailNavigation(reveal);
}
