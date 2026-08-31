import type { ReactNode } from "react";
import type { ThreadGoal, FeedbackUploadParams } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import type {
  McpWidgetCsp,
  McpWidgetMetadata,
} from "../../../shared/mcp-app/mcp-app-resource-contract";
import type {
  DatabasePage,
  PageRunInTarget,
  CodexAccountSnapshot,
  CodexApprovalResponse,
  CodexBackgroundTerminalRow,
  CodexCanonicalOptionPickerResponse,
  CodexCanonicalSetupCodexStepResponse,
  CodexCollaborationModeKind,
  CodexPermissionState,
  CodexComposerChatGptConversation,
  CodexComposerIntent,
  CodexComposerPlugin,
  CodexComposerSite,
  CodexComposerSkill,
  CodexCollaborationModePreset,
  CodexConnectionState,
  CodexDictationStateSnapshot,
  CodexConversationCapabilityFlags,
  CodexConversationChildMembership,
  CodexConversationItem,
  CodexUserAttachment,
  CodexConversationLiveRequest,
  CodexConversationResumeState,
  CodexConversationServerRequest,
  CodexCanonicalServerRequest,
  CodexMcpServerElicitationAction,
  CodexMcpServerElicitationResponse,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
  CodexModelOption,
  CodexPermissionMode,
  CodexPersonality,
  CodexPermissionRequestResponse,
  NodexAgentAuthorizationResponse,
  CodexProtocolRequestId,
  CodexPromptInput,
  CodexSteerTurnInput,
  CodexThreadGoalDraftInput,
  CodexThreadGoalMaterializedDraft,
  CodexThreadGoalSetActionInput,
  CodexThreadStatusType,
  CodexThreadSummary,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexServiceTier,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  GitReviewSource,
  PanelId,
  ProtocolAppInfo,
  WorktreeEnvironmentConfigRecord,
} from "../../lib/types";
import type { ReviewOpenIntent } from "@/features/review/model/review-view-state";
import type { ComposerEnterBehavior } from "../../lib/composer-enter-behavior";
import type { CodexHooksSettingsTarget } from "../../lib/codex-hooks-route";
import type { CodexTurnScopedConversationRequest } from "./conversation-request-helpers";
import type { NewChatProjectSelectorOption } from "../../lib/new-chat-project-selector";
import type { NewChatStartInTarget } from "../../lib/new-chat-start-in-selector";
import type { ThreadWorkedForTiming } from "./thread-worked-for-time";
import type { CodexExecutionProfile } from "../../../shared/codex-execution-profile";
import type { ComposerIntelligenceSelection } from "./view/composer/composer-intelligence-types";
import type { CommandShortcutPresentation } from "../../../shared/command-keybindings";
import type { LocalConversationAttachmentState } from "./conversation-attachment-state";

export interface NewChatProjectSelectorModel {
  projects: NewChatProjectSelectorOption[];
  selectedProjectId: string | null;
  disabled: boolean;
  canAddProject: boolean;
}

export interface NewChatStartInSelectorModel {
  target: NewChatStartInTarget;
  disabled: boolean;
  worktreeAvailable: boolean;
  environments: WorktreeEnvironmentConfigRecord[];
  environmentsLoading: boolean;
  environmentsError: boolean;
  selectedEnvironmentPath: string | null;
  defaultEnvironmentPath: string | null;
  environmentNeedsAttention: boolean;
  environmentRepairConfigPath: string | null;
  repositoryName?: string | null;
  additionalSourceFolderCount?: number;
}

export interface ThreadSummaryPanelAuxiliaryRow {
  id: string;
  title: string;
  status?: string | null;
  isResponseInProgress?: boolean;
  panelId?: PanelId;
  leafId?: string | null;
}

export interface ThreadSummaryPanelBrowserRow {
  id: string;
  browserTabId: string;
  workbenchTabId: string | null;
  title: string;
  displayUrl: string | null;
  url: string;
  faviconUrl: string | null;
  isAgentWorking: boolean;
  isMaterialized: boolean;
  panelId?: PanelId;
  leafId?: string | null;
}

export interface ThreadSummaryPanelBrowserRowOpenInput {
  browserTabId: string;
  rowId: string;
  panelId?: PanelId;
  leafId?: string | null;
}

export interface ThreadSummaryPanelScheduledAutomationRow {
  id: string;
  name: string;
  scheduleSummary: string | null;
  nextRunLabel: string;
}

export interface ThreadSummaryPanelScheduledAutomationOpenInput {
  automationId?: string | null;
  createInput?: CodexScheduledAutomationCreateInput | null;
  mode?: "open" | "suggested-create" | "suggested-update";
  title: string;
  updateInput?: CodexScheduledAutomationUpdateInput | null;
}

export interface ThreadSummaryPanelGitReviewOpenInput {
  source: GitReviewSource;
}

export interface ThreadSummaryPanelGitActionInput {
  action: "commit-or-push" | "create-pull-request";
}

export interface ThreadSummaryPanelComputerUsePipState {
  visible: boolean;
}

export interface ThreadTurnDiffFileSidePanelTarget {
  cwd?: string | null;
  path: string;
  title: string;
  workspaceRoot?: string | null;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ThreadSummaryPanelOutputSidePanelTarget {
  cwd?: string | null;
  path: string;
  title: string;
  workspaceRoot?: string | null;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ThreadPlanSidePanelTarget {
  planKey: string;
  threadId: string;
  turnId: string;
  itemId: string;
  content: string;
  cwd: string | null;
  hideCodeBlocks?: boolean;
}

export interface ThreadPlanSidePanelState {
  rightPanelEnabled: boolean;
  activePlanKey: string | null;
  activeRightPanelTabId: string | null;
}

export type ThreadOpenSubagentStatus = "active" | "waiting" | "done" | "unknown";

export interface ThreadSubagentDiffStats {
  linesAdded: number;
  linesRemoved: number;
}

export interface ThreadOpenSubagentPayload {
  conversationId: string;
  displayName: string;
  agentRole: string | null;
  spawnModel: string | null;
  status: ThreadOpenSubagentStatus;
  statusSummary: string | null;
  /** Directory-verified selected detail interaction eligibility. */
  canInteract?: boolean;
  showInlineActivity?: boolean;
  diffStats: ThreadSubagentDiffStats | null;
}

export interface ThreadOpenThreadContext {
  subagent?: ThreadOpenSubagentPayload;
}

export interface ThreadStageRouteInput {
  projectId: string | null;
  sessionId?: string | null;
  threadPinned?: boolean;
  threadActionShortcuts?: ThreadStageHeaderModel["shortcuts"];
  modelPickerShortcut?: CommandShortcutPresentation | null;
  projectWorkspacePath?: string | null;
  isNewThreadTab: boolean;
  newThreadTarget: {
    projectId: string | null;
    projectName: string;
    sessionId: string;
    projectDraftId?: string;
    threadTitle?: string;
    runInTarget?: PageRunInTarget;
    runInEnvironmentPath?: string | null;
    worktreeStartingState?: import("../../../shared/codex-pending-worktree").CodexPendingWorktreeStartingState;
  } | null;
  newThreadProjectSelector?: NewChatProjectSelectorModel | null;
  newThreadStartInSelector?: NewChatStartInSelectorModel | null;
  newThreadStartBlockedReason?: string | null;
  threadStartProgress: {
    runInTarget: PageRunInTarget;
    threadId?: string | null;
    phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
    message: string;
    outputText: string;
    outputTruncated: boolean;
    updatedAt: number;
  } | null;
  activeThreadId: string | null;
  activeThreadSummary: CodexThreadSummary | null;
  conversation: CodexConversationSnapshot | null;
  parentTurns: readonly CodexConversationTurn[];
  knownConversationsById: Record<string, CodexConversationSnapshot>;
  connection: CodexConnectionState;
  account: CodexAccountSnapshot | null;
  availableModels: CodexModelOption[];
  selectedExecutionProfile?: CodexExecutionProfile | null;
  collaborationModes: CodexCollaborationModePreset[];
  selectedCollaborationMode: CodexCollaborationModeKind;
  selectedModel: string;
  selectedReasoningEffort: CodexReasoningEffort;
  selectedPersonality?: CodexPersonality;
  reasoningEffortOptions: CodexReasoningEffortOption[];
  permissionMode: CodexPermissionMode;
  isQueueingEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  searchOpenTick: number;
  summarySideChatRows?: readonly ThreadSummaryPanelAuxiliaryRow[];
  summaryBrowserRows?: readonly ThreadSummaryPanelBrowserRow[];
  summaryScheduledAutomation?: ThreadSummaryPanelScheduledAutomationRow | null;
  summaryComputerUsePip?: ThreadSummaryPanelComputerUsePipState | null;
  planSidePanelState?: ThreadPlanSidePanelState | null;
  composerIntent: CodexComposerIntent | null;
  newThreadComposerIntent?: CodexComposerIntent | null;
  primaryRequest: CodexConversationLiveRequest | null;
  sideChatContext?: {
    parentThreadId: string;
    tabTitle: string;
  } | null;
}

export interface ThreadStageActions {
  onCollaborationModeChange: (mode: CodexCollaborationModeKind) => void | Promise<void>;
  onModelChange: (model: string) => void | Promise<void>;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void | Promise<void>;
  onIntelligenceSelectionChange?: (
    selection: ComposerIntelligenceSelection,
    options?: { collaborationMode?: CodexCollaborationModeKind },
  ) => Promise<void>;
  onPersonalityChange?: (personality: CodexPersonality) => void | Promise<void>;
  onPermissionModeChange: (mode: CodexPermissionMode) => void | Promise<void>;
  onQueueingEnabledChange: (enabled: boolean) => void;
  onOpenSubagentsPanel?: () => void | Promise<void>;
  onStartThreadForSession?: (input: {
    projectId: string | null;
    sessionId: string;
    projectDraftId?: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    threadGoalDraft?: CodexThreadGoalDraftInput;
    threadGoalMaterializedDraft?: CodexThreadGoalMaterializedDraft;
    runInTarget?: PageRunInTarget;
    runInEnvironmentPath?: string | null;
    worktreeStartingState?: import("../../../shared/codex-pending-worktree").CodexPendingWorktreeStartingState;
  }) => Promise<void>;
  onNewThreadStartInTargetChange?: (target: NewChatStartInTarget) => void;
  onNewThreadStartInEnvironmentChange?: (environmentPath: string | null) => void;
  onRefreshNewThreadStartInEnvironments?: () => Promise<void>;
  onOpenNewThreadLocalEnvironmentsSettings?: (configPath?: string | null) => void;
  onOpenHooksSettings?: (target: CodexHooksSettingsTarget) => void;
  onOpenVoiceSettings?: () => void;
  onNewThreadProjectChange?: (projectId: string | null) => void;
  onRequestNewChatProjectCreate?: () => void;
  onStartNewChatWithPrompt?: (input: { projectId: string | null; prompt: string }) => Promise<void>;
  onComposerCapabilitiesChanged?: () => Promise<void>;
  onSendPrompt: (
    prompt: string,
    opts?: {
      collaborationMode?: CodexCollaborationModeKind;
      promptInput?: CodexPromptInput;
      model?: string;
      reasoningEffort?: CodexReasoningEffort;
      serviceTier?: CodexServiceTier;
    },
  ) => Promise<void>;
  onOpenSideChat?: (input?: ThreadOpenSideChatInput) => Promise<void>;
  onOpenMcpAppSidePanel?: (input: ThreadMcpAppSidePanelInput) => Promise<void>;
  onOpenPlanInSidePanel?: (input: ThreadPlanSidePanelTarget) => void | Promise<void>;
  onClosePlanSidePanel?: (input: { planKey: string }) => void | Promise<void>;
  onOpenSummarySideChatRow?: (
    input: ThreadSummaryPanelAuxiliaryRowOpenInput,
  ) => void | Promise<void>;
  onOpenSummaryBrowserRow?: (input: ThreadSummaryPanelBrowserRowOpenInput) => void | Promise<void>;
  onOpenSummaryScheduledAutomation?: (
    input: ThreadSummaryPanelScheduledAutomationOpenInput,
  ) => void | Promise<void>;
  onOpenSummaryOutputInSidePanel?: (
    target: ThreadSummaryPanelOutputSidePanelTarget,
  ) => boolean | Promise<boolean>;
  onOpenSummaryGitReview?: (input: ThreadSummaryPanelGitReviewOpenInput) => void | Promise<void>;
  onStartSummaryGitAction?: (input: ThreadSummaryPanelGitActionInput) => void | Promise<void>;
  onOpenProcessManager?: () => void | Promise<void>;
  onOpenBackgroundTerminalOutput?: (row: CodexBackgroundTerminalRow) => void | Promise<void>;
  onToggleSummaryComputerUsePip?: (nextVisible: boolean) => void | Promise<void>;
  onRequestRenameThread?: () => void;
  onArchiveThread?: () => void | Promise<void>;
  onToggleThreadPin?: () => void | Promise<void>;
  onCopyConversationMarkdown?: () => Promise<void>;
  onSteerPrompt: (input: Omit<CodexSteerTurnInput, "threadId">) => Promise<void>;
  onInterruptTurn: (turnId?: string) => Promise<void>;
  onResumeInterruptedTurn?: () => Promise<void>;
  onRespondApproval: (
    requestId: CodexProtocolRequestId,
    response: CodexApprovalResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondUserInput: (
    requestId: CodexProtocolRequestId,
    answers: Record<string, string[]>,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondMcpElicitation: (
    requestId: CodexProtocolRequestId,
    response: CodexMcpServerElicitationAction | CodexMcpServerElicitationResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondPermissionRequest?: (
    requestId: CodexProtocolRequestId,
    response: CodexPermissionRequestResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondNodexAgentAuthorization?: (
    requestId: string,
    response: NodexAgentAuthorizationResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondOptionPicker?: (
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onRespondSetupCodexStep?: (
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalSetupCodexStepResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onResolvePlanImplementationRequest: (threadId: string, turnId: string) => Promise<void>;
  onEnqueueQueuedFollowUp: (
    threadId: string,
    prompt: string,
    opts?: {
      collaborationMode?: CodexCollaborationModeKind | null;
      promptInput?: CodexPromptInput;
    },
  ) => Promise<void>;
  onRemoveQueuedFollowUp: (threadId: string, followUpId: string) => Promise<void>;
  onReplaceQueuedFollowUp?: (
    threadId: string,
    followUpId: string,
    expectedLedgerRevision: number,
    prompt: string,
    opts?: {
      collaborationMode?: CodexCollaborationModeKind | null;
      promptInput?: CodexPromptInput;
    },
  ) => Promise<boolean>;
  onReorderQueuedFollowUps: (threadId: string, orderedFollowUpIds: string[]) => Promise<void>;
  onResumeQueuedFollowUps?: (threadId: string) => Promise<void>;
  onResolveQueuedFollowUpsAfterFreshStart?: (
    threadId: string,
    expectedLedgerRevision: number,
    resolution: import("../../../shared/types").CodexQueuedFollowUpFreshStartResolution,
  ) => Promise<boolean>;
  onSendQueuedFollowUpNow: (threadId: string, followUpId: string) => Promise<void>;
  onEditQueuedFollowUp: (input: {
    threadId: string;
    followUpId: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    ledgerRevision?: number;
  }) => Promise<void>;
  onEditLastUserTurn: (input: {
    threadId: string;
    turnId: string;
    message: string;
  }) => Promise<void>;
  onForkFromTurn: (input: { threadId: string; turnId: string; message: string }) => Promise<void>;
  onCompactThread?: (threadId: string) => Promise<void>;
  onGetThreadGoal?: (threadId: string) => Promise<ThreadGoal | null>;
  onSetThreadGoal?: (input: CodexThreadGoalSetActionInput) => Promise<ThreadGoal | null>;
  onClearThreadGoal?: (threadId: string) => Promise<void>;
  onDismissThreadGoalResumeConfirmation?: (threadId: string) => Promise<void>;
  onSetThreadMemoryMode?: (input: { threadId: string; mode: ThreadMemoryMode }) => Promise<void>;
  onUploadFeedback?: (params: FeedbackUploadParams) => Promise<void>;
  onOpenStatusPanel?: (threadId: string) => void;
  onToggleDesktopPet?: () => void;
  onUnarchiveThread: (threadId: string, projectId: string | null) => Promise<void>;
  onOpenTurnDiffReview?: (intent: ReviewOpenIntent) => void | Promise<void>;
  onOpenTurnDiffFileInSidePanel?: (
    target: ThreadTurnDiffFileSidePanelTarget,
  ) => void | Promise<void>;
  onConsumeComposerIntent: (threadId: string, focusNonce: number) => void;
  onConsumeNewThreadComposerIntent?: (sessionId: string, focusNonce: number) => void;
  onOpenThread: (threadId: string, context?: ThreadOpenThreadContext) => void | Promise<void>;
  onRetryThreadAttachment?: (threadId: string) => void | Promise<void>;
  onStopBackgroundAgents?: (threadIds: readonly string[]) => Promise<void>;
  onCleanBackgroundTerminals: (threadId: string) => Promise<void>;
}

export interface ThreadSummaryPanelAuxiliaryRowOpenInput {
  rowId: string;
  panelId: PanelId;
  leafId?: string | null;
}

export type ThreadOpenSideChatInput =
  | {
      kind?: "submit";
      prompt?: string;
      promptInput?: CodexPromptInput;
    }
  | {
      kind: "draft";
      draftPrompt: string;
    };

export interface ThreadRequestResponseContext {
  conversationId?: string | null;
}

export type ThreadMcpWidgetCspModel = McpWidgetCsp;
export type ThreadMcpWidgetMetadataModel = McpWidgetMetadata;

export interface ThreadMcpAppSidePanelInput {
  mcpAppId: string;
  capabilityId: string;
  title: string;
  threadId: string;
  server: string;
  tool: string;
}

export interface ThreadUserMessageActionsModel {
  canEdit: boolean;
  sentAtMs: number | null;
}

export interface ThreadAssistantMessageActionsModel {
  copyText: string | null;
  sentAtMs: number | null;
  canRate: boolean;
  canFork: boolean;
}

export interface ThreadRenderKeyedBlockFields {
  renderKey?: string;
}

export interface ThreadAssistantActionsBlockModel {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "assistantActions";
  entry: CodexConversationItem;
  actions: ThreadAssistantMessageActionsModel;
}

export interface ThreadWorkedForBlockModel extends ThreadRenderKeyedBlockFields {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "workedFor";
  status: ThreadWorkedForTiming["status"];
  startedAtMs: number;
  completedAtMs: number | null;
}

export type ThreadSubagentActivityStatus = "started" | "updated" | "interrupted" | "done";

export interface ThreadSubagentActivityInlineRowModel {
  conversationId: string;
  displayName: string;
  agentRole: string | null;
  spawnModel: string | null;
  status: ThreadOpenSubagentStatus;
  activityStatus: ThreadSubagentActivityStatus;
  statusSummary: string | null;
  diffStats: ThreadSubagentDiffStats | null;
}

export interface ThreadTurnSubagentActivityState {
  hasActivity: boolean;
  hasActiveActivity: boolean;
}

export interface ThreadTranscriptBlockModel extends ThreadRenderKeyedBlockFields {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type:
    | "userMessage"
    | "assistantMessage"
    | "reasoning"
    | "proposedPlan"
    | "todoList"
    | "exec"
    | "fileChange"
    | "turnDiff"
    | "mcpToolCall"
    | "dynamicToolCall"
    | "webSearch"
    | "hook"
    | "planImplementation"
    | "mcpServerElicitation"
    | "automationUpdate"
    | "generatedImage"
    | "imageView"
    | "permissionRequest"
    | "realtimeTranscript"
    | "streamError"
    | "systemError"
    | "remoteTaskCreated"
    | "personalityChanged"
    | "forkedFromConversation"
    | "modelChanged"
    | "modelRerouted"
    | "contextCompaction"
    | "worktreeInit"
    | "automaticApprovalReview"
    | "autoReviewInterruptionWarning"
    | "multiAgentAction"
    | "subagentActivityInlineGroup"
    | "steered"
    | "systemEvent"
    | "userInputResponse"
    | "userInput";
  entry: CodexConversationItem;
  status?: CodexConversationItem["status"];
  isTurnCancelled?: boolean;
  isMcpAppWidgetSuperseded?: boolean;
  automaticApprovalReviews?: CodexConversationItem[];
  userMessageActions?: ThreadUserMessageActionsModel;
  assistantMessageActions?: ThreadAssistantMessageActionsModel;
  assistantAfterBlocks?: ThreadBlockModel[];
  searchUnitKey?: string;
  hookFeedbackSources?: Array<
    NonNullable<CodexConversationTurn["hookRuns"]>[number]["run"]["source"]
  >;
  imageViewPaths?: string[];
  subagentActivityRows?: ThreadSubagentActivityInlineRowModel[];
  subagentActivityStatusLabel?: string;
}

export interface ThreadUserAttachmentStripBlockModel extends ThreadRenderKeyedBlockFields {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "userAttachmentStrip";
  attachments: CodexUserAttachment[];
}

export interface ThreadGeneratedImageGalleryItemModel {
  id: string;
  previewSrc?: string;
  src: string;
}

export interface ThreadGeneratedImageGalleryBlockModel extends ThreadRenderKeyedBlockFields {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "generatedImageGallery";
  images: ThreadGeneratedImageGalleryItemModel[];
  pendingImageCount: number;
}

export type ThreadAgentActivityGroupEntryModel = ThreadTranscriptBlockModel;

export interface ThreadAgentActivityGroupMcpSourceStats {
  key: string;
  logoUrl: string | null;
  logoUrlDark: string | null;
  name: string;
  nativeAppReference: unknown | null;
  count: number;
  runningCount: number;
}

export type ThreadAgentActivityCompletedSummaryPart<
  TDynamicItem = ThreadAgentActivityGroupEntryModel,
> =
  | { kind: "mcpSources"; sources: readonly ThreadAgentActivityGroupMcpSourceStats[] }
  | { kind: "loadedTools"; count: number }
  | { kind: "unnamedMcpCalls"; count: number }
  | { kind: "fileChanges"; count: number }
  | { kind: "stoppedFileCreation"; count: number }
  | { kind: "exploration" }
  | {
      kind: "visualization";
      activity: {
        kind: "create" | "update";
        isInProgress: boolean;
      };
    }
  | { kind: "commands"; count: number }
  | { kind: "webSearch" }
  | {
      kind: "dynamicToolCall";
      item: TDynamicItem;
      key: string;
    };

export interface ThreadAgentActivityCompletedHeader {
  parts: readonly ThreadAgentActivityCompletedSummaryPart[];
  iconItem: ThreadAgentActivityGroupEntryModel | null;
}

export type ThreadAgentActivityGroupHeader =
  | {
      kind: "summary";
      key: "summary";
    }
  | {
      kind: "active";
      key: string;
      item: ThreadAgentActivityGroupEntryModel;
      label: string;
    }
  | {
      kind: "thinking";
      key: "thinking";
      message: string | null;
    };

export type ThreadAgentActivityGroupActiveSummary =
  | {
      kind: "text";
      key: string;
      label: string;
    }
  | {
      kind: "fileChange";
      key: string;
      label: string;
      displayPath: string;
      additions: number;
      deletions: number;
    };

export interface ThreadAgentActivityGroupBlockModel extends ThreadRenderKeyedBlockFields {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "agentActivityGroup";
  canExpand: boolean;
  /** Immutable full group topology. Never replace this with filtered body rows. */
  entries: readonly ThreadAgentActivityGroupEntryModel[];
  /** Rows visible only inside the expanded disclosure body. */
  bodyEntries: readonly ThreadAgentActivityGroupEntryModel[];
  completedHeader: ThreadAgentActivityCompletedHeader;
  header: ThreadAgentActivityGroupHeader;
  mcpApps?: readonly ProtocolAppInfo[];
  shouldAnimateInitialCollapse: boolean;
  status?: CodexConversationItem["status"];
}

export interface ThreadPendingTurnRequestModel {
  id: string;
  turnId: string;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: CodexTurnScopedConversationRequest["type"];
  request: CodexTurnScopedConversationRequest;
}

export type ThreadRendererItemModel =
  | ThreadTranscriptBlockModel
  | ThreadWorkedForBlockModel
  | ThreadPendingTurnRequestModel;

export type ThreadAgentItemModel = ThreadTranscriptBlockModel | ThreadWorkedForBlockModel;

/** Exact v2 activity-classifier result shape. `null` is the hidden result. */
export type ThreadAgentActivityGrouping = "groupable" | "standalone";

export interface ThreadAgentActivityItem<TItem = ThreadAgentItemModel> {
  item: TItem;
  grouping: ThreadAgentActivityGrouping;
}

export type ThreadAgentActivityClassification<TItem = ThreadAgentItemModel> =
  ThreadAgentActivityItem<TItem> | null;

/** `sourceIndex` exists only between classification and final unit construction. */
export interface ThreadIndexedAgentActivityItem<TItem = ThreadAgentItemModel> {
  activityItem: ThreadAgentActivityItem<TItem>;
  sourceIndex: number;
}

export type ThreadAgentActivityUnit<TItem = ThreadAgentItemModel> =
  | {
      kind: "group";
      key: string;
      items: readonly [ThreadAgentActivityItem<TItem>, ...ThreadAgentActivityItem<TItem>[]];
    }
  | {
      kind: "standalone";
      key: string;
      item: ThreadAgentActivityItem<TItem>;
    };

export type ThreadAgentEntryModel = ThreadAgentItemModel | ThreadAgentActivityGroupBlockModel;

export type ThreadAgentRenderEntryBlockModel = ThreadAgentItemModel;

export type ThreadAgentRenderUnit = (
  | {
      kind: "entry";
      block: ThreadAgentRenderEntryBlockModel;
    }
  | {
      kind: "agentActivityGroup";
      block: ThreadAgentActivityGroupBlockModel;
    }
) & {
  targetAttributes?: Record<"data-local-conversation-item-target-ids", string>;
};

export type ThreadBlockModel =
  | ThreadTranscriptBlockModel
  | ThreadAssistantActionsBlockModel
  | ThreadGeneratedImageGalleryBlockModel
  | ThreadUserAttachmentStripBlockModel
  | ThreadWorkedForBlockModel
  | ThreadAgentActivityGroupBlockModel;

export type ThreadGlobalActivityState =
  | { type: "none" }
  | { type: "exploring" }
  | { type: "planning" }
  | { type: "thinking"; isVisible: true };

export type ThreadThinkingFallbackOwner = "none" | "group" | "standalone";

export type ThreadGlobalActivityReason =
  | "force-thinking"
  | "not-latest-turn"
  | "turn-settled"
  | "exploring"
  | "planning"
  | "blocking-request"
  | "assistant-visible-output"
  | "active-web-search"
  | "active-dynamic-summary"
  | "assistant-in-progress"
  | "active-tool"
  | "between-activities";

export interface ThreadGlobalActivityPresentation {
  state: ThreadGlobalActivityState;
  reason: ThreadGlobalActivityReason;
}

export type ThreadActivitySliceState =
  | { kind: "open"; reason: "turn-streaming" }
  | {
      kind: "closed";
      reason:
        | "not-latest-turn"
        | "turn-settled"
        | "blocking-request"
        | "safety-buffering"
        | "pending-generated-output"
        | "planning"
        | "assistant-visible-output";
    };

export interface ThreadActivitySlicePresentation {
  kind: "main";
  state: ThreadActivitySliceState;
  latestVisibleUnit: {
    key: string;
    kind: ThreadAgentActivityUnit["kind"];
  } | null;
}

export type ThreadThinkingFallbackReason =
  | "latest-open-group"
  | "global-thinking"
  | "post-assistant-thinking"
  | "global-state-suppressed"
  | "safety-buffering"
  | "pending-generated-output";

export interface ThreadThinkingFallbackPresentation {
  owner: ThreadThinkingFallbackOwner;
  reason: ThreadThinkingFallbackReason;
  /** Custom live reasoning heading. Generic `Thinking` remains a renderer fallback. */
  message: string | null;
  isVisible: boolean;
}

export interface ThreadLiveReasoningSummary {
  itemId: string;
  text: string;
}

export interface ThreadLiveActivityPresentation {
  global: ThreadGlobalActivityPresentation;
  mainSlice: ThreadActivitySlicePresentation;
  fallback: ThreadThinkingFallbackPresentation;
  reasoningSummary: ThreadLiveReasoningSummary | null;
}

export interface ThreadTurnRenderBuckets {
  preUserItems: ThreadTranscriptBlockModel[];
  userItems: ThreadTranscriptBlockModel[];
  latestAssistantMessage: ThreadTranscriptBlockModel | null;
  assistantItem: ThreadTranscriptBlockModel | null;
  systemEventItem: ThreadTranscriptBlockModel | null;
  approvalItem: ThreadPendingTurnRequestModel | null;
  userInputItem: ThreadPendingTurnRequestModel | null;
  interactiveRequestItem: ThreadPendingTurnRequestModel | null;
  permissionRequestItems: ThreadPendingTurnRequestModel[];
  mcpServerElicitationItems: ThreadTranscriptBlockModel[];
  toolOutputItems: ThreadTranscriptBlockModel[];
  todoListItem: ThreadTranscriptBlockModel | null;
  unifiedDiffItem: ThreadTranscriptBlockModel | null;
  proposedPlanItem: ThreadTranscriptBlockModel | null;
  planImplementationItem: ThreadTranscriptBlockModel | null;
  postAssistantItems: ThreadTranscriptBlockModel[];
  agentItems: ThreadAgentItemModel[];
  remoteTaskCreatedItems: ThreadTranscriptBlockModel[];
  personalityChangedItems: ThreadTranscriptBlockModel[];
  forkedFromConversationItems: ThreadTranscriptBlockModel[];
  modelChangedItems: ThreadTranscriptBlockModel[];
  modelReroutedItems: ThreadTranscriptBlockModel[];
}

export interface ThreadTurnModel {
  turnId: string | null;
  turnKey: string;
  turn: CodexConversationTurn | null;
  buckets: ThreadTurnRenderBuckets;
  leadingBlocks: ThreadBlockModel[];
  agentBodyUnits: ThreadAgentRenderUnit[];
  trailingBlocks: ThreadBlockModel[];
  blocks: ThreadBlockModel[];
  aboveComposerBlocks?: ThreadBlockModel[];
  workedForItem: ThreadWorkedForBlockModel | null;
  workedForTiming: ThreadWorkedForTiming | null;
  workedDurationMs: number | null;
  isLatestTurn: boolean;
  isStreamingTurn: boolean;
  isBlocked: boolean;
  liveActivity: ThreadLiveActivityPresentation;
  searchableText: string;
  searchUnits: ThreadSearchUnitModel[];
  hasRenderableAgentBodyUnits: boolean;
  defaultAgentBodyCollapsed: boolean;
  collapsedMessageCount: number;
}

export interface ThreadSearchUnitModel {
  key: string;
  turnId: string | null;
  turnKey: string;
  text: string;
  blockType: "userMessage" | "assistantMessage";
}

export type ThreadUserMessageNavigationOutputType =
  | "app"
  | "website"
  | "google-drive"
  | "file"
  | "image"
  | "commit"
  | "pull-request"
  | "review";

export interface ThreadUserMessageNavigationOutput {
  id: string;
  type: ThreadUserMessageNavigationOutputType;
  label: string;
}

export interface ThreadUserMessageNavigationItem {
  id: string;
  turnId: string | null;
  turnKey: string;
  ordinal: number;
  label: string;
  responsePreview: string;
  outputs: ThreadUserMessageNavigationOutput[];
  isHeartbeat: boolean;
}

export interface ThreadBodyModel {
  threadId: string | null;
  turnCount: number;
  isThreadRunning: boolean;
  activeTurnId: string | null;
  latestTurnId: string | null;
  emptyState:
    | { type: "none" }
    | { type: "newThread"; title: string; description: string }
    | { type: "noThread"; title: string; description: string }
    | { type: "emptyThread"; title: string; description: string }
    | { type: "archivedThread"; title: string; description: string }
    | {
        type: "resumingThread";
        title: string;
        description: string;
        status: CodexConversationResumeState;
      }
    | {
        type: "threadAttachmentFailed";
        title: string;
        description: string;
      };
  showThreadStartProgressPanel: boolean;
}

export interface ThreadComposerShellPendingRequestModel {
  request: CodexConversationLiveRequest;
  conversationId: string;
  surface: "activeThread" | "backgroundThread";
  actorName?: string | null;
  requestItem?: CodexConversationItem | null;
}

export interface ThreadComposerShellPendingSteerRowModel {
  steerId: string;
  threadId: string;
  turnId: string;
  prompt: string;
  displayText: string;
}

export interface ThreadComposerShellQueuedFollowUpRowModel {
  followUpId: string;
  threadId: string;
  prompt: string;
  promptInput?: CodexPromptInput;
  displayText: string;
  collaborationMode?: CodexCollaborationModeKind | null;
  pausedReason?: string | null;
  pauseKind?: "interrupted" | "failed" | null;
  isInFlight?: boolean;
  imagePreviewSource?: string | null;
  ledgerRevision?: number;
}

export interface ThreadComposerShellBackgroundAgentRowModel {
  conversationId: string;
  parentConversationId: string;
  parentTurnKey: string | null;
  displayName: string;
  actorName: string;
  agentRole: string | null;
  spawnModel: string | null;
  status: "active" | "waiting" | "done";
  statusSummary: string | null;
  lastAssistantMessage: string | null;
  lastAssistantMessageAtMs: number | null;
  recencyAtMs: number;
  showInlineActivity: boolean;
  diffStats: ThreadSubagentDiffStats | null;
  role: "childApproval" | "backgroundChild";
}

export interface ThreadComposerShellModel {
  activeRequest: ThreadComposerShellPendingRequestModel | null;
  backgroundRequest: ThreadComposerShellPendingRequestModel | null;
  pendingSteerRows: ThreadComposerShellPendingSteerRowModel[];
  queuedFollowUpRows: ThreadComposerShellQueuedFollowUpRowModel[];
  queuedFollowUpStatus?: "loading" | "ready" | "error";
  queuedFollowUpLedgerRevision?: number;
  queuedFollowUpError?: string | null;
  hasInterruptedQueuedFollowUps?: boolean;
  backgroundAgentRows: ThreadComposerShellBackgroundAgentRowModel[];
  backgroundTerminalRows: CodexBackgroundTerminalRow[];
  showRequestCards: boolean;
  showComposer: boolean;
  showApprovalMode: boolean;
}

export interface ThreadStageHeaderModel {
  projectId: string | null;
  sessionId: string | null;
  threadId: string | null;
  title: string;
  cwd: string | null;
  pinned?: boolean;
  shortcuts?: {
    togglePin?: string;
    rename?: string;
    archive?: string;
    openSideTask?: string;
    copyConversationMarkdown?: string;
  };
  showSideChatAction?: boolean;
}

export type ThreadSummaryPanelMode = "hidden" | "pinned" | "popover";

export interface ThreadBodySurfaceModel {
  projectId: string | null;
  hostId: string;
  composerScopeIdentity?: string | null;
  sessionId?: string | null;
  threadId: string | null;
  isSideChat: boolean;
  cwd: string | null;
  turns: CodexConversationTurn[];
  turnPagination?: CodexConversationTurnPagination | null;
  historyRows?: readonly import("../../../shared/codex-conversation-state/codex-history-topology").CodexHistoryRow[];
  conversationEntityGeneration?: number;
  historyTopologyGeneration?: number;
  historyMutationRevision?: number;
  historyItemWindowsByTurnId?: Readonly<
    Record<
      string,
      import("../../../shared/codex-conversation-history-page").CodexConversationHistoryItemWindowSnapshot
    >
  >;
  turnItemsPaginationById?: Readonly<
    Record<
      string,
      import("../../../shared/codex-conversation-state/codex-history-topology").CodexHistoryTurnItemsPagination
    >
  >;
  requests: CodexConversationServerRequest[];
  canonicalRequests?: CodexCanonicalServerRequest[];
  resumeState: CodexConversationResumeState | null;
  attachmentState?: LocalConversationAttachmentState;
  statusType: CodexThreadStatusType | null;
  capabilityFlags: CodexConversationCapabilityFlags;
  body: ThreadBodyModel;
  parentTurns: readonly CodexConversationTurn[];
  childMemberships: readonly CodexConversationChildMembership[];
  backgroundAgentRows?: readonly ThreadComposerShellBackgroundAgentRowModel[];
  projectWorkspacePath?: string | null;
  projectlessOutputDirectory?: string | null;
  searchOpenTick: number;
  threadStartProgress: {
    runInTarget: PageRunInTarget;
    threadId?: string | null;
    phase: "creatingWorktree" | "runningSetup" | "startingThread" | "ready" | "failed";
    message: string;
    outputText: string;
    outputTruncated: boolean;
    updatedAt: number;
  } | null;
}

export interface ThreadFooterModel {
  projectId: string | null;
  hostId: string;
  projectWorkspacePath?: string | null;
  threadId: string | null;
  cwd: string | null;
  account: CodexAccountSnapshot | null;
  conversation: CodexConversationSnapshot | null;
  resumeState: CodexConversationResumeState | null;
  attachmentState?: LocalConversationAttachmentState;
  activeTurn: CodexConversationTurn | null;
  isThreadRunning: boolean;
  isNewThreadTab: boolean;
  isCloudNewThreadTarget: boolean;
  newThreadTarget: ThreadStageRouteInput["newThreadTarget"];
  newThreadProjectSelector?: ThreadStageRouteInput["newThreadProjectSelector"];
  newThreadStartInSelector?: ThreadStageRouteInput["newThreadStartInSelector"];
  newThreadStartBlockedReason?: string | null;
  composerShell: ThreadComposerShellModel;
  body: ThreadBodyModel;
  collaborationModes: CodexCollaborationModePreset[];
  selectedCollaborationMode: CodexCollaborationModeKind;
  selectedModel: string;
  modelPickerShortcut: CommandShortcutPresentation | null;
  availableModels: CodexModelOption[];
  executionProfile?: CodexExecutionProfile | null;
  executionIdentityLocked?: boolean;
  selectedReasoningEffort: CodexReasoningEffort;
  selectedPersonality?: CodexPersonality;
  reasoningEffortOptions: CodexReasoningEffortOption[];
  permissionMode: CodexPermissionMode;
  permissionState?: CodexPermissionState;
  isQueueingEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  composerIntent: CodexComposerIntent | null;
  newThreadComposerIntent?: CodexComposerIntent | null;
  composerScopeIdentity?: string | null;
  dictation: CodexDictationStateSnapshot;
  composerPlugins?: CodexComposerPlugin[];
  composerPluginsLoading?: boolean;
  composerSkills?: CodexComposerSkill[];
  composerSkillsLoading?: boolean;
  composerApps?: readonly ProtocolAppInfo[];
  composerAppsLoading?: boolean;
  composerSites?: readonly CodexComposerSite[];
  composerSitesAvailable?: boolean;
  composerSitesLoading?: boolean;
  composerChatGptConversations?: readonly CodexComposerChatGptConversation[];
  composerChatGptConversationsAvailable?: boolean;
  composerChatGptConversationsLoading?: boolean;
}

export interface ThreadStageScreenProps {
  header?: ReactNode;
  body: ReactNode;
  footer?: ReactNode;
  floatingContent?: ReactNode;
  contentShiftX?: number;
  onReadInteraction?: () => void;
}

export interface ThreadBodyUiStateOverrides {
  collapsedAgentBodyByTurnId?: Record<string, boolean>;
}

export interface ThreadOpenPageDataState {
  loading: boolean;
  card: DatabasePage | null;
}
