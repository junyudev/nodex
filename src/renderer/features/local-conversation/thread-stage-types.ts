import type { ComposerChatKey } from "@/lib/composer-draft-intents";
import type { HookStats } from "./projection/hook-stats";
import type { ThreadSummaryPanelOutputRow } from "./projection/thread-summary-panel-output-model";
import type { WorkspaceSearchContext } from "@/lib/workspace-search-context";
import type { WorkbenchSubmitPresentation } from "../../../shared/nodex-app-tools/workbench";
import type { ReactEventHandler, ReactNode } from "react";
import type { ThreadGoal, FeedbackUploadParams } from "@nodex/codex-app-server-protocol/v2";
import type { ThreadMemoryMode } from "@nodex/codex-app-server-protocol";
import type {
  PageRunInTarget,
  CodexAccountSnapshot,
  CodexBackgroundTerminalRow,
  CodexCanonicalOptionPickerResponse,
  CodexCollaborationModeKind,
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
  CodexConversationLiveRequest,
  CodexConversationResumeState,
  CodexConversationServerRequest,
  CodexCanonicalServerRequest,
  CodexMcpServerElicitationAction,
  CodexMcpServerElicitationResponse,
  CodexConversationSnapshot,
  CodexConversationTurn,
  CodexConversationTurnPagination,
  AgentModelOption,
  CodexPersonality,
  CodexProtocolRequestId,
  CodexPromptInput,
  CodexSteerTurnInput,
  CodexThreadGoalDraftInput,
  CodexThreadGoalMaterializedDraft,
  CodexThreadGoalSetActionInput,
  ProjectSession,
  CodexThreadStatusType,
  CodexThreadSummary,
  CodexReasoningEffort,
  CodexReasoningEffortOption,
  CodexServiceTier,
  AutomationCreateInput,
  AutomationUpdateInput,
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

export interface SessionThreadCommands {
  readonly onMaterializeProjectDraft?: (input: {
    readonly projectId: string;
    readonly draftId: string;
  }) => Promise<ProjectSession>;
  readonly onCommitMaterializedProjectDraft?: (input: {
    readonly projectId: string;
    readonly draftId: string;
    readonly sessionId: string;
  }) => void;
  readonly onForkSessionFromTurn?: (input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly message: string;
    readonly collaborationMode: CodexCollaborationModeKind;
  }) => Promise<void>;
  readonly onForkSession?: (
    session: ProjectSession,
    input: {
      readonly target: "local" | "newWorktree";
      readonly sourceThreadId?: string;
    },
  ) => Promise<void>;
}

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
  environmentAvailable?: boolean;
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

export interface ThreadSummaryPanelAutomationRow {
  id: string;
  name: string;
  scheduleSummary: string | null;
  nextRunLabel: string;
}

export interface ThreadSummaryPanelAutomationOpenInput {
  proposalId?: string;
  automationId?: string | null;
  createInput?: AutomationCreateInput | null;
  mode?: "open" | "suggested-create" | "suggested-update";
  title: string;
  updateInput?: AutomationUpdateInput | null;
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
  readonly runtimeSessionId?: string;
  readonly hostId?: string;
  readonly createdTarget?: import("../../../shared/codex-created-thread-result").CodexCreatedThreadResult;
  readonly sourceRoot?: { readonly hostId: string; readonly threadId: string };
  /** A mounted source may withdraw navigation while a read is in flight. */
  readonly isSourceCurrent?: () => boolean;
  subagent?: ThreadOpenSubagentPayload;
}

/**
 * Why the composer can't send right now and how to fix it, such as an Agent that isn't signed in
 * or a worktree that could not be prepared. It describes a standing condition, so it stays until
 * the condition clears. A one-off action failure is a toast instead, and a Run failure is part of
 * the transcript.
 */
export interface ComposerNotice {
  /** Names the condition; a notice with the same key is the same notice, updated in place. */
  readonly key: string;
  /** `warning` asks for a step the person can take; `danger` reports something that broke. */
  readonly tone: "warning" | "danger";
  readonly title: string;
  /** The Agent's own explanation, such as the command or setting that fixes it. */
  readonly detail?: string | null;
  readonly actions?: readonly ComposerNoticeAction[];
}

export interface ComposerNoticeAction {
  readonly label: string;
  /** Replaces the label while `run` is pending. */
  readonly pendingLabel?: string;
  /** A rejection keeps the notice and reports why the action failed. */
  readonly run: () => void | Promise<void>;
}

/** Work the Agent left running after the tool call that started it, such as a dev server. */
export interface ConversationBackgroundTask {
  readonly id: string;
  readonly kind: "command" | "monitor" | "task";
  /** What the Agent called the work; never empty. */
  readonly label: string;
  /** The exact command or watch the Agent started, when it reported one. */
  readonly command: string | null;
  /** The delegated conversation running it; null for the chat's own work. */
  readonly owner: string | null;
  readonly startedAtMs: number | null;
  /** The Agent can end this task alone; otherwise only Stop all reaches it. */
  readonly stoppable: boolean;
  /**
   * This reader may stop the task: always for a chat on this computer; in a shared chat, as Core
   * admits stopping the Run that started it.
   */
  readonly canStop: boolean;
  /** A Stop request is in flight; the task leaves the list once it has ended. */
  readonly stopping: boolean;
}

/** The end of a background task's output, as its Agent reports it. */
export interface ConversationBackgroundTaskOutput {
  readonly text: string;
  /** Earlier output exists that is not included. */
  readonly truncated: boolean;
}

/** One conversation's live background work and how its Agent stops it. */
export interface ConversationBackgroundTasks {
  readonly tasks: readonly ConversationBackgroundTask[];
  /**
   * Stops one task, or every listed task this reader may stop when `taskId` is omitted. Absent
   * where this Device cannot stop the work at all.
   */
  readonly stop?: (taskId?: string) => Promise<void>;
  /** Null when the Agent cannot show this task's output. */
  readonly readOutput?: (taskId: string) => Promise<ConversationBackgroundTaskOutput | null>;
  /** Opens the task's full output in its own surface, where it is not shown in place. */
  readonly openOutput?: (taskId: string) => void;
  /** Opens every process the conversation runs, beyond its background tasks. */
  readonly openAll?: () => void;
}
/** Background work this Device can stop. */
export type StoppableBackgroundTasks = ConversationBackgroundTasks &
  Required<Pick<ConversationBackgroundTasks, "stop">>;

/** Capabilities vary by provider; the stage, timeline, editor and request UI are shared. */
export interface ConversationProviderPresentation {
  readonly admissionQueue?: {
    readonly runId: string;
    readonly read: () => Promise<{
      readonly position: number;
      readonly waitingSince: string;
    } | null>;
  };
  readonly runtimeMode?: import("@nodex/agent-runtime/contracts").RuntimeMode | null;
  readonly supportedRuntimeModes?: readonly import("@nodex/agent-runtime/contracts").RuntimeMode[];
  readonly defaultRuntimeMode?: import("@nodex/agent-runtime/contracts").RuntimeMode;
  /** What keeps the composer from sending, shown attached to it until it clears. */
  readonly notice?: ComposerNotice | null;
  /** Live background work of the opened conversation; subagents are listed separately. */
  readonly backgroundTasks?: ConversationBackgroundTasks | null;
  /** What an empty transcript means here, such as imported history the Agent hasn't restored. */
  readonly emptyHistory?: { readonly title: string; readonly description: string } | null;
  readonly modelCatalog?: import("@/components/shared/agent-runtime/agent-model-picker").AgentModelCatalogPresentation;
  readonly nativeIntelligence?: import("@/components/shared/agent-runtime/agent-intelligence-dropdown").AgentNativeIntelligencePresentation;
  readonly diagnostics?: () => Promise<
    import("../../../shared/claude-models").ClaudeRuntimeDiagnostics
  >;
  readonly resolveHistoryImage?: (
    reference: import("../../../shared/agent-history-images").AgentHistoryImageReference,
  ) => Promise<string>;
  readonly resolveRuntimeAttachment?: (
    reference: import("../../../shared/agent-runtime-attachments").AgentRuntimeAttachmentReference,
  ) => Promise<string>;
  readonly readToolOutput?: (
    reference: import("../../../shared/agent-tool-output").AgentToolOutputReference,
  ) => Promise<import("../../../shared/agent-tool-output").AgentToolOutput>;
  readonly controls?: {
    readonly steer?: boolean;

    readonly skills?: boolean;
    /** Native background tasks open the Tasks dialog. */
    readonly nativeTaskDetails?: boolean;
    /** Delegated subagents open the Subagents panel. */
    readonly subagents?: boolean;
    /** False where the conversation cannot run in Goal mode. */
    readonly goals?: boolean;
    readonly images?: boolean;
    /** Whether a message can carry files, images and referenced context besides its words. */
    readonly context?: boolean;
    readonly stopTask?: boolean;
  };
  /**
   * Why this reader may not stop the conversation's work, as in a hosted chat whose current Run
   * another Member asked for. The Composer still shows Stop, unavailable, with this reason.
   */
  readonly interruptUnavailableReason?: string | null;
  /** Explains unsupported or not-yet-known image capability for the selected model. */
  readonly imageInputUnavailableReason?: string | null;
  /** Queue editing uses the Agent and model already captured by that message. */
  readonly imageInputForSelection?: (
    selection: NonNullable<
      import("../../../shared/agent-runtime-api").AgentRuntimeMessage["modelSelection"]
    >,
  ) => { readonly supported: boolean; readonly unavailableReason: string | null };
  readonly skills?: readonly CodexComposerSkill[];
  readonly refreshSkills?: () => Promise<void>;
  readonly stopTask?: (taskId: string) => Promise<void>;
  readonly kind: "codex" | "claude" | "acp" | "opencode";
  /** The conversation's own speed tier, when it owns one instead of the saved default. */
  readonly serviceTier?: CodexServiceTier;
  readonly label: string;
  readonly selection: string;
  readonly commands: readonly { name: string; description: string; inputHint: string | null }[];
}

export interface ThreadStageRouteInput {
  provider?: ConversationProviderPresentation;
  readonly projectWorkspaceRoots?: readonly string[];
  projectId: string | null;
  sessionId?: string | null;
  threadPinned?: boolean;
  /** When the chat becomes unread again, if its person asked to be reminded. */
  threadRemindAt?: string | null;
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
    runInTarget?: NewChatStartInTarget["runInTarget"];
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
  availableModels: AgentModelOption[];
  selectedExecutionProfile?: CodexExecutionProfile | null;
  collaborationModes: CodexCollaborationModePreset[];
  selectedCollaborationMode: CodexCollaborationModeKind;
  selectedModel: string;
  selectedReasoningEffort: CodexReasoningEffort;
  selectedPersonality?: CodexPersonality;
  reasoningEffortOptions: CodexReasoningEffortOption[];

  isQueueingEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  searchOpenTick: number;
  summarySideChatRows?: readonly ThreadSummaryPanelAuxiliaryRow[];
  summaryBrowserRows?: readonly ThreadSummaryPanelBrowserRow[];
  summaryAutomation?: ThreadSummaryPanelAutomationRow | null;
  summaryComputerUsePip?: ThreadSummaryPanelComputerUsePipState | null;
  planSidePanelState?: ThreadPlanSidePanelState | null;
  composerIntent: CodexComposerIntent | null;
  composerChatKey?: ComposerChatKey | null;
  primaryRequest: CodexConversationLiveRequest | null;
  sideChatContext?: {
    parentThreadId: string;
    tabTitle: string;
  } | null;
}

/**
 * A sent message rewritten. The conversation rewinds to just before it and continues from what
 * this describes, so it is the whole message: its text, and `images`, every image attached to it,
 * in order. A sent image keeps its transcript source; an empty list sends none. Images written
 * into `message` are numbered after these and travel after them.
 */
export interface UserTurnEdit {
  readonly threadId: string;
  readonly turnId: string;
  readonly message: string;
  readonly images: readonly import("../../../shared/types").CodexPromptImageInput[];
}

export interface ThreadStageActions {
  onNextQueuedFollowUpPage?: () => Promise<void>;
  onPreviousQueuedFollowUpPage?: () => Promise<void>;
  onRuntimeModeChange?: (
    mode: import("@nodex/agent-runtime/contracts").RuntimeMode,
  ) => void | Promise<void>;
  onRespondApproval?: (
    requestId: string,
    response: import("./agent-approval").AgentApprovalResponse,
  ) => Promise<void>;
  onCollaborationModeChange: (mode: CodexCollaborationModeKind) => void | Promise<void>;
  onModelChange: (model: string) => void | Promise<void>;
  onReasoningEffortChange: (reasoningEffort: CodexReasoningEffort) => void | Promise<void>;
  onIntelligenceSelectionChange?: (
    selection: ComposerIntelligenceSelection,
    options?: { collaborationMode?: CodexCollaborationModeKind },
  ) => Promise<void>;
  onPersonalityChange?: (personality: CodexPersonality) => void | Promise<void>;

  onQueueingEnabledChange: (enabled: boolean) => void;
  onOpenSubagentsPanel?: () => void | Promise<void>;
  /** Native task identities select observations without entering Thread navigation. */
  onOpenTaskObservation?: (observationId: string) => void;
  onCaptureSubmissionPresentation?: () => WorkbenchSubmitPresentation;
  onStartThreadForSession?: (input: {
    submissionIdentity?: import("../conversation-launch/session-first-submission-owner").FirstSubmissionIdentity & {
      readonly acceptedAt: number;
    };
    submittedPresentation?: WorkbenchSubmitPresentation;
    presentationTicket?: import("../../../shared/nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
    projectId: string | null;
    sessionId: string;
    projectDraftId?: string;
    prompt: string;
    promptInput?: CodexPromptInput;
    threadGoalDraft?: CodexThreadGoalDraftInput;
    threadGoalMaterializedDraft?: CodexThreadGoalMaterializedDraft;
    threadGoalMaterializedHostId?: string;
    runInTarget?: PageRunInTarget;
    runInEnvironmentPath?: string | null;
    worktreeStartingState?: import("../../../shared/codex-pending-worktree").CodexPendingWorktreeStartingState;
  }) => Promise<void>;
  onNewThreadStartInTargetChange?: (target: NewChatStartInTarget) => void;
  onNewThreadStartInEnvironmentChange?: (environmentPath: string | null) => void;
  onRefreshNewThreadStartInEnvironments?: () => Promise<void>;
  onOpenNewThreadLocalEnvironmentsSettings?: (configPath?: string | null) => void;
  onOpenHooksSettings?: (target: CodexHooksSettingsTarget) => void;
  onOpenVoiceSettings?: (recordingId?: string) => void;
  onNewThreadProjectChange?: (projectId: string | null) => void;
  onRequestNewChatProjectCreate?: () => void;
  onStartNewChatWithPrompt?: (input: {
    projectId: string | null;
    prompt: string;
    isSourceCurrent?: () => boolean;
  }) => Promise<void>;
  onComposerCapabilitiesChanged?: () => Promise<void>;
  onSendPrompt: (
    prompt: string,
    opts?: {
      untrustedAppMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage;
      submittedPresentation?: WorkbenchSubmitPresentation;
      submissionIdentity?: { readonly clientUserMessageId: string };
      presentationTicket?: import("../../../shared/nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
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
  onOpenSummaryAutomation?: (input: ThreadSummaryPanelAutomationOpenInput) => void | Promise<void>;
  onOpenSummaryGitReview?: (input: ThreadSummaryPanelGitReviewOpenInput) => void | Promise<void>;
  onStartSummaryGitAction?: (input: ThreadSummaryPanelGitActionInput) => void | Promise<void>;
  onOpenProcessManager?: () => void | Promise<void>;
  onOpenBackgroundTerminalOutput?: (row: CodexBackgroundTerminalRow) => void | Promise<void>;
  onToggleSummaryComputerUsePip?: (nextVisible: boolean) => void | Promise<void>;
  onRequestRenameThread?: () => void;
  onArchiveThread?: () => void | Promise<void>;
  onToggleThreadPin?: () => void | Promise<void>;
  /** Sets or, with null, cancels the chat's reminder. */
  onSetThreadReminder?: (remindAt: string | null) => void | Promise<void>;
  onCopyConversationMarkdown?: () => Promise<void>;
  onSteerPrompt: (input: Omit<CodexSteerTurnInput, "threadId">) => Promise<void>;
  onInterruptTurn: (turnId?: string) => Promise<void>;
  onResumeInterruptedTurn?: () => Promise<void>;
  /** Continues only the exact latest failed Turn, without replaying its original request. */
  onCompactAndRetry?: (turnId: string) => Promise<void>;
  onContinueAfterFailure?: (turnId: string) => Promise<void>;
  /** Opens settings for the Agent that owns the exact latest failed Turn. */
  onManageFailedProvider?: (turnId: string) => void;
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
  onRespondOptionPicker?: (
    requestId: CodexProtocolRequestId,
    response: CodexCanonicalOptionPickerResponse,
    context?: ThreadRequestResponseContext,
  ) => Promise<void>;
  onResolvePlanImplementationRequest: (threadId: string, turnId: string) => Promise<void>;
  onEnqueueQueuedFollowUp: (
    threadId: string,
    prompt: string,
    opts?: {
      untrustedAppMessage?: import("../../../shared/codex-untrusted-app-input").CodexUntrustedAppMessage;
      collaborationMode?: CodexCollaborationModeKind | null;
      promptInput?: CodexPromptInput;
    },
  ) => Promise<void>;
  onSendCapturedFollowUp: ThreadStageActions["onEnqueueQueuedFollowUp"];
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
  onEditUserTurn: (input: UserTurnEdit) => Promise<void>;
  onForkFromTurn: (input: { threadId: string; turnId: string; message: string }) => Promise<void>;
  onForkThread?: (target: "local" | "newWorktree") => Promise<void>;
  /** Present in a fork: brings its newest finished work into the chat it was forked from. */
  onMergeForkBack?: () => Promise<void>;
  onCompactThread?: (threadId: string) => Promise<void>;
  /** Ends the conversation's context; the next message starts every Agent fresh. */
  onClearContext?: () => Promise<void>;
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
  onOpenThread: (threadId: string, context?: ThreadOpenThreadContext) => void | Promise<void>;
  onRetryThreadAttachment?: (threadId: string) => void | Promise<void>;
  /** Ends the named background terminals, or all of the conversation's when none are named. */
  onStopBackgroundTerminals: (threadId: string, processIds?: readonly string[]) => Promise<void>;
}

/** Presentation and Session metadata actions are shared without inheriting provider execution. */
export type ThreadStageHostActions = Pick<
  ThreadStageActions,
  | "onQueueingEnabledChange"
  | "onNewThreadProjectChange"
  | "onRequestNewChatProjectCreate"
  | "onStartNewChatWithPrompt"
  | "onNewThreadStartInTargetChange"
  | "onNewThreadStartInEnvironmentChange"
  | "onRefreshNewThreadStartInEnvironments"
  | "onOpenNewThreadLocalEnvironmentsSettings"
  | "onOpenVoiceSettings"
  | "onOpenSummaryBrowserRow"
  | "onOpenSummaryAutomation"
  | "onOpenSummaryGitReview"
  | "onOpenProcessManager"
  | "onOpenBackgroundTerminalOutput"
  | "onRequestRenameThread"
  | "onArchiveThread"
  | "onToggleThreadPin"
  | "onSetThreadReminder"
  | "onOpenThread"
  | "onOpenTurnDiffReview"
  | "onOpenTurnDiffFileInSidePanel"
>;

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
      promptInput?: CodexPromptInput;
    }
  | {
      kind: "selection";
      text: string;
    };

export interface ThreadRequestResponseContext {
  conversationId?: string | null;
}

export interface ThreadMcpAppSidePanelInput {
  mcpAppId: string;
  capabilityId: string;
  title: string;
  threadId: string;
  server: string;
  tool: string;
}

export interface ThreadUserMessageActionsModel {
  hookStats?: HookStats | null;
  canEdit: boolean;
  /** The person's own message cannot be edited, and why; Edit shows unavailable. */
  editUnavailableReason?: string;
  sentAtMs: number | null;
  /** The settled latest turn's closing message keeps its actions visible without hover. */
  alwaysVisible?: boolean;
}

export interface ThreadAssistantMessageActionsModel {
  showTimestampWithoutActions?: boolean;
  timestampHoverOnly?: boolean;
  /** The settled latest turn's closing message keeps its actions visible without hover. */
  alwaysVisible?: boolean;
  metadata?: import("./projection/turn-footer-metadata").TurnFooterMetadata;
  hookStats?: HookStats | null;
  copyText: string | null;
  sentAtMs: number | null;
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

/** A completed turn's confirmed deliverables, placed with its reply above the reply's actions. */
export interface ThreadTurnOutputsBlockModel {
  id: string;
  turnId: string | null;
  createdAt: number;
  updatedAt: number;
  searchableText: string;
  type: "turnOutputs";
  resources: readonly ThreadSummaryPanelOutputRow[];
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
  identityThreadId: string | null;
  canOpen: boolean;
  /** Only verified directory eligibility selects an interactive child task tab. */
  canInteract?: boolean;
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
    | "toolCall"
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
    | "delegatedTask"
    | "runtimeNotice"
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
  unavailableImages?: CodexConversationItem["unavailableImages"];
  subagentActivityAnchorItemId?: string | null;
  subagentActivityRows?: ThreadSubagentActivityInlineRowModel[];
  subagentActivityStatusLabel?: string;
  /** Consecutive delegated tasks retain their individual item addresses behind the first anchor. */
  delegatedTaskEntries?: readonly CodexConversationItem[];
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

export type ThreadAgentActivityClassification<
  TItem = ThreadAgentItemModel,
> = ThreadAgentActivityItem<TItem> | null;

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
  | ThreadTurnOutputsBlockModel
  | ThreadGeneratedImageGalleryBlockModel
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
  | "provider-recovery"
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
  /** Ends the Turn: the conversation's context was cleared after it. */
  contextClearedItems: ThreadTranscriptBlockModel[];
  modelChangedItems: ThreadTranscriptBlockModel[];
  modelReroutedItems: ThreadTranscriptBlockModel[];
}

export interface ThreadTurnModel {
  voiceWorkActivity?: "active" | "terminal";
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
  /** The reply that later work keeps inside the agent body; it stays visible when collapsed. */
  agentBodyReplyBlockId: string | null;
  defaultAgentBodyCollapsed: boolean;
  collapsedMessageCount: number;
  /** Historical automatic-review denials; a later approved retry does not erase them. */
  deniedActionCount: number;
}

export interface ThreadSearchUnitModel {
  key: string;
  /** Native source alias, independent of grouping and timeline fragment placement. */
  itemId?: string;
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
  readonly messageId?: string;
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
  request: Exclude<CodexConversationLiveRequest, { type: "approval" | "permissionRequest" }>;
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
  readonly canSendNow?: boolean;
  followUpId: string;
  threadId: string;
  prompt: string;
  promptInput?: CodexPromptInput;
  displayText: string;
  collaborationMode?: CodexCollaborationModeKind | null;
  pausedReason?: string | null;
  pauseKind?: "interrupted" | "failed" | "held" | null;
  isInFlight?: boolean;
  imagePreviewSource?: string | null;
  ledgerRevision?: number;
}

export type ThreadComposerShellBackgroundAgentRowModel =
  import("../../../shared/codex-subagent-row-model").CodexSubagentRow;

export interface ThreadComposerShellModel {
  activeRequest: ThreadComposerShellPendingRequestModel | null;
  backgroundRequest: ThreadComposerShellPendingRequestModel | null;
  pendingSteerRows: ThreadComposerShellPendingSteerRowModel[];
  queuedFollowUpRows: ThreadComposerShellQueuedFollowUpRowModel[];
  queuedFollowUpStatus?: "loading" | "ready" | "error";
  queuedFollowUpLedgerRevision?: number;
  queuedFollowUpError?: string | null;
  queuedFollowUpHasPreviousPage?: boolean;
  queuedFollowUpHasNextPage?: boolean;
  hasInterruptedQueuedFollowUps?: boolean;
  backgroundAgentRows: ThreadComposerShellBackgroundAgentRowModel[];
  showRequestCards: boolean;
  showComposer: boolean;
}

export interface ThreadStageHeaderModel {
  projectId: string | null;
  sessionId: string | null;
  threadId: string | null;
  title: string;
  cwd: string | null;
  pinned?: boolean;
  remindAt?: string | null;
  subagentName?: string | null;
  shortcuts?: {
    togglePin?: string;
    rename?: string;
    archive?: string;
    openSideTask?: string;
    copyConversationMarkdown?: string;
  };
  showSideChatAction?: boolean;
  forkDestinations?: readonly import("../../lib/session-fork").SessionForkDestination[];
}

export type ThreadSummaryPanelMode = "hidden" | "pinned" | "popover";

/**
 * Where a thread body is read. `main` is the Conversation pane. `floating` is the expanded
 * floating composer's independent view of the same thread: it opens at the newest content, owns
 * its scroll position for its mounted lifetime, never lifts a new turn to the top, omits subagent
 * lifecycle (see `SubagentActivityVisibilityContext`), and leaves conversation-wide integrations
 * (scroll restore, route navigation, message reveal, PiP anchoring) to the main body.
 */
export type ThreadBodyPresentation = "main" | "floating";

export interface ThreadBodySurfaceModel {
  composerChatKey?: ComposerChatKey | null;
  readonly skills?: readonly CodexComposerSkill[];
  parentModel?: string | null;
  projectId: string | null;
  hostId: string;
  composerScopeIdentity?: string | null;
  sessionId?: string | null;
  threadId: string | null;
  isSideChat: boolean;
  cwd: string | null;
  turns: CodexConversationTurn[];
  /** One launch presentation row survives until the normalized read owner observes its identity. */
  firstSubmissionTurn?: CodexConversationTurn | null;
  turnPagination?: CodexConversationTurnPagination | null;
  historyRows?: readonly import("../../../shared/codex-conversation-state/codex-history-topology").CodexHistoryRow[];
  history?: import("./conversation-runtime").ConversationHistoryPort;
  historyTopologyGeneration?: number;
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
  readonly runtimeMode?: import("@nodex/agent-runtime/contracts").RuntimeMode | null;
  readonly supportedRuntimeModes?: readonly import("@nodex/agent-runtime/contracts").RuntimeMode[];
  readonly defaultRuntimeMode?: import("@nodex/agent-runtime/contracts").RuntimeMode;
  readonly connectionStatus: CodexConnectionState["status"];
  provider?: ConversationProviderPresentation;
  readonly workspaceSearchContext: WorkspaceSearchContext | null;
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
  availableModels: AgentModelOption[];
  executionProfile?: CodexExecutionProfile | null;
  executionIdentityLocked?: boolean;
  selectedReasoningEffort: CodexReasoningEffort;
  selectedPersonality?: CodexPersonality;
  reasoningEffortOptions: CodexReasoningEffortOption[];

  isQueueingEnabled: boolean;
  composerEnterBehavior: ComposerEnterBehavior;
  composerIntent: CodexComposerIntent | null;
  composerChatKey?: ComposerChatKey | null;
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
  onReadInteraction?: ReactEventHandler<HTMLDivElement>;
}

export interface ThreadBodyUiStateOverrides {
  collapsedAgentBodyByTurnId?: Record<string, boolean>;
}
