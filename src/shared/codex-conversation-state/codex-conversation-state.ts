import { produce, type Draft } from "immer";
import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
  appendConversationTurnDraft,
  removeConversationTurnDraft,
} from "./codex-turn-mutation";
import { areStructurallyEqual } from "../structural-equality";
import { mergeCodexCanonicalHistoryItems } from "./codex-history-item-merge";
import {
  reconcileCodexHydratedSteering,
  relocateCodexHydratedSteering,
} from "./codex-steering-reconciliation";
import type { Personality, RequestId, ServerRequest } from "@nodex/codex-app-server-protocol";
import type {
  ActivePermissionProfile,
  CodexErrorInfo,
  EnvironmentConnectionNotification,
  GuardianApprovalReviewAction,
  GuardianApprovalReviewStatus,
  GuardianRiskLevel,
  GuardianUserAuthorization,
  HookRunSummary,
  McpElicitationSchema,
  McpServerElicitationAction,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ModelRerouteReason,
  Thread,
  ThreadGoal,
  ThreadItem,
  ThreadSettings,
  ThreadSettingsUpdateParams,
  ThreadResumeResponse,
  Turn,
  TurnEnvironmentParams,
  TurnPlanStep,
  TurnStartParams,
  ToolRequestUserInputOption,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import { projectCodexMarkdownLabel } from "../codex-markdown-text";
import type { ThreadTokenUsage } from "@nodex/codex-app-server-protocol/v2/ThreadTokenUsage";
import { isCodexProtocolThreadItem } from "../codex-protocol-thread-item";
import type { CodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import { normalizeCodexServiceTier } from "../codex-service-tier";
import type { CodexItemStatus } from "../types";
import type {
  CodexCanonicalHistoryTopology,
  CodexHistoryTurnItemsPagination,
} from "./codex-history-topology";
import { boundCodexReasoningParts } from "./codex-reasoning-parts";
import {
  mergeCodexThreadEnvironmentSelection,
  type CodexEnvironmentSelectionEvidence,
} from "./codex-environment-selection";

export type CodexProtocolRequestId = RequestId;
export type CodexProtocolThreadItem = ThreadItem;
export type CodexProtocolThreadItemOf<TType extends ThreadItem["type"]> = Extract<
  ThreadItem,
  {
    type: TType;
  }
>;
export type CodexProtocolServerRequest = ServerRequest;
export type CodexProtocolServerRequestOf<TMethod extends ServerRequest["method"]> = Extract<
  ServerRequest,
  {
    method: TMethod;
  }
>;

/** Exact 30751 request extensions not present in the generated app-server union. */
export interface CodexCanonicalOptionPickerRequest {
  readonly id: RequestId;
  readonly method: "item/tool/requestOptionPicker";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly question: string;
    readonly options: readonly {
      readonly label: string;
      readonly description?: string | null;
    }[];
    readonly allowMultiple?: boolean;
    readonly submitLabel?: string | null;
    readonly skipLabel?: string | null;
  };
}

export interface CodexCanonicalSetupContextPickerRequest {
  readonly id: RequestId;
  readonly method: "item/tool/requestSetupCodexContextPicker";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
  };
}

export interface CodexCanonicalOptionPickerResponse {
  readonly action: "submit" | "skip" | "dismiss";
  readonly selectedOptions: readonly string[];
  readonly freeformAnswer: string | null;
}

export interface CodexCanonicalSetupContextPickerResponse {
  readonly action: "continue" | "skip" | "dismiss";
  readonly selectedSources: readonly string[];
}

export type CodexCanonicalSetupCodexStepResponse =
  | {
      readonly step: "role";
      readonly action: "submit" | "skip" | "dismiss";
      readonly selectedRoles: readonly string[];
    }
  | {
      readonly step: "task";
      readonly action: "submit" | "skip" | "dismiss";
      readonly answers: Readonly<
        Record<
          string,
          {
            readonly answers: readonly string[];
          }
        >
      >;
    }
  | {
      readonly step: "context";
      readonly action: "continue" | "skip" | "dismiss";
      readonly selectedSources: readonly string[];
    };

export interface CodexCanonicalPlanImplementationRequest {
  readonly id: RequestId;
  readonly method: "item/plan/requestImplementation";
  readonly params: {
    readonly threadId: string;
    readonly turnId: string;
    readonly planContent: string;
  };
}

export type CodexCanonicalServerRequestExtension =
  | CodexCanonicalOptionPickerRequest
  | CodexCanonicalSetupContextPickerRequest
  | CodexCanonicalPlanImplementationRequest;

/**
 * Generated requests remain intact; exact private methods are isolated in one
 * explicit extension union instead of being cast into the generated protocol.
 */
export type CodexCanonicalServerRequest = ServerRequest | CodexCanonicalServerRequestExtension;

export type CodexCanonicalProtocolItem<TItem extends ThreadItem = ThreadItem> = TItem;

export type CodexCanonicalProtocolRequest<TRequest extends ServerRequest = ServerRequest> =
  TRequest;

type RequestedPermissions = PermissionsRequestApprovalParams["permissions"];
type JsonValue = McpServerElicitationRequestResponse["content"];
type CodexCanonicalJsonObject = Readonly<{
  [key: string]: JsonValue | undefined;
}>;

export type CodexCanonicalUserInputOption = Readonly<ToolRequestUserInputOption>;

/** Exact `t0` historical shape; protocol-only flags are intentionally absent. */
export interface CodexCanonicalUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: readonly CodexCanonicalUserInputOption[];
}

export type CodexCanonicalUserInputAnswers = Readonly<Record<string, readonly string[]>>;

type CodexCanonicalMcpElicitationMeta = {
  readonly riskLevel?: "low" | "high";
  readonly subtitle?: string;
};

export interface CodexCanonicalMcpToolParamDisplay {
  readonly name: string;
  readonly displayName: string;
  readonly value: JsonValue;
}

type CodexCanonicalMcpPersist = "session" | "always" | Array<"session" | "always">;

type CodexCanonicalMcpToolSuggestion = CodexCanonicalJsonObject & {
  readonly codex_approval_kind: "tool_suggestion";
  readonly suggest_type: "install" | "enable";
  readonly suggest_reason: string;
  readonly tool_id: string;
  readonly tool_name: string;
  readonly persist?: "always";
} & (
    | {
        readonly tool_type: "connector";
        readonly install_url: string;
      }
    | {
        readonly tool_type: "plugin";
        readonly install_url?: string;
        readonly remote_plugin_id?: string;
      }
  );

type CodexCanonicalMcpToolCallApproval = CodexCanonicalJsonObject & {
  readonly codex_approval_kind: "mcp_tool_call";
  readonly codex_request_type?: "approval_request";
  readonly connector_id: string;
  readonly connector_name?: string;
  readonly tool_name?: string;
  readonly tool_title?: string;
  readonly tool_params: CodexCanonicalJsonObject;
  readonly tool_params_display?: JsonValue;
  readonly persist?: CodexCanonicalMcpPersist;
};

type CodexCanonicalMcpConnectorAuthFailure = CodexCanonicalJsonObject & {
  readonly is_auth_failure: true;
  readonly connector_id: string;
  readonly connector_name: string;
  readonly install_url: string;
  readonly auth_reason?: string;
  readonly link_id?: string;
  readonly requested_scopes?: string[];
};

/**
 * Exact private result of the 30751 `OW` normalizer. Raw elicitation params stay
 * on the pending request; historical synthetic state stores only this union.
 */
export type CodexCanonicalMcpElicitation =
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "connectorAuth";
      readonly message: string;
      readonly url: string;
      readonly connector: CodexCanonicalMcpConnectorAuthFailure;
    })
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "urlAction";
      readonly message: string;
      readonly serverName: string;
      readonly url: string;
    })
  | {
      readonly kind: "unsupportedOpenAIForm";
      readonly serverName: string;
    }
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "openaiForm";
      readonly message: string;
      readonly serverName: string;
      readonly schema: JsonValue;
    })
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "toolSuggestion";
      readonly suggestion: CodexCanonicalMcpToolSuggestion;
    })
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "mcpToolCall";
      readonly message: string;
      readonly approval: CodexCanonicalMcpToolCallApproval;
      readonly toolParamsDisplay?: readonly CodexCanonicalMcpToolParamDisplay[];
    })
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "generic";
      readonly message: string;
      readonly serverName: string;
      readonly metadata: JsonValue;
      readonly persist: CodexCanonicalMcpPersist | undefined;
      readonly requestedSchema: McpElicitationSchema;
      readonly toolParams: CodexCanonicalJsonObject | null;
      readonly toolParamsDisplay?: readonly CodexCanonicalMcpToolParamDisplay[];
    })
  | (CodexCanonicalMcpElicitationMeta & {
      readonly kind: "formElicitation";
      readonly message: string;
      readonly serverName: string;
      readonly schema: McpElicitationSchema;
    });

/** Request-caused state rows are explicit local variants, never fake ThreadItem. */
export type CodexCanonicalRequestSyntheticItem =
  | {
      readonly type: "userInputResponse";
      readonly id: `user-input-response-${string}`;
      readonly requestId: RequestId;
      readonly turnId: string;
      readonly questions: readonly CodexCanonicalUserInputQuestion[];
      readonly answers: CodexCanonicalUserInputAnswers;
      readonly completed: boolean;
    }
  | {
      readonly type: "permissionRequest";
      readonly id: `permission-request-${string}`;
      readonly requestId: RequestId;
      readonly turnId: string;
      readonly reason: string | null;
      readonly permissions: RequestedPermissions;
      readonly completed: boolean;
      readonly response: PermissionsRequestApprovalResponse | null;
    }
  | {
      readonly type: "mcpServerElicitation";
      readonly id: `mcp-server-elicitation-${string}`;
      readonly requestId: RequestId;
      readonly turnId: string;
      readonly elicitation: CodexCanonicalMcpElicitation;
      readonly completed: boolean;
      readonly action: McpServerElicitationAction | null;
    };

export interface CodexCanonicalSteeringCompareKey {
  readonly rawText: string;
  readonly imageCount: number;
}

export interface CodexCanonicalSteeringRestoreMessage {
  readonly id?: string;
  readonly cwd?: string | null;
  readonly responsesapiClientMetadata?: TurnStartParams["responsesapiClientMetadata"];
  readonly queueRow?: CodexQueuedFollowUp;
  readonly context: {
    readonly commentAttachments: readonly unknown[];
    readonly workspaceRoots?: readonly string[];
    readonly collaborationMode?: TurnStartParams["collaborationMode"];
  };
}

/** Exact live steering row stored beside generated items until it is accepted. */
export interface CodexCanonicalSteeringUserMessageItem {
  readonly type: "steeringUserMessage";
  readonly id: string;
  readonly targetTurnId: string | null;
  readonly targetTurnStartedAtMs: number | null;
  readonly status: "pending" | "accepted";
  /** Correlation established by the completed server echo, independent of the command ACK. */
  readonly serverUserMessageId?: string | null;
  readonly clientUserMessageId: string | null;
  readonly input: readonly UserInput[];
  readonly attachments: readonly unknown[];
  readonly restoreMessage: CodexCanonicalSteeringRestoreMessage;
  readonly compareKey: CodexCanonicalSteeringCompareKey;
}

/** Exact marker inserted when a completed user message consumes a pending steer. */
export interface CodexCanonicalSteeredItem {
  readonly type: "steered";
  readonly id: string;
}

export interface CodexCanonicalForkedFromConversationItem {
  readonly type: "forkedFromConversation";
  readonly id: string;
  readonly sourceConversationId: string;
  readonly sourceConversationTitle: string | null;
}

export interface CodexCanonicalWorktreeInitSetup {
  readonly outcome: "completed" | "skipped";
  readonly outputText: string;
}

/** Exact app-side worktree handoff row emitted after pending worktree creation. */
export interface CodexCanonicalWorktreeInitItem {
  readonly type: "worktreeInit";
  readonly id: string;
  readonly worktreeOutputText: string;
  readonly setup: CodexCanonicalWorktreeInitSetup | null;
}

/** Exact app-side `X1` submission error row; it is not an app-server ThreadItem. */
export interface CodexCanonicalTurnErrorItem {
  readonly type: "error";
  readonly id: string;
  readonly message: string;
  readonly willRetry: boolean;
  readonly errorInfo: CodexErrorInfo | null;
  readonly additionalDetails: string | null;
}

export interface CodexCanonicalTodoListItem {
  readonly type: "todo-list";
  readonly id: string;
  readonly explanation: string | null;
  readonly plan: readonly TurnPlanStep[];
}

export interface CodexCanonicalModelReroutedItem {
  readonly type: "modelRerouted";
  readonly id: string;
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: ModelRerouteReason;
}

export interface CodexCanonicalAutomaticApprovalReviewItem {
  readonly type: "automaticApprovalReview";
  readonly id: string;
  readonly targetItemId: string | null;
  readonly action: GuardianApprovalReviewAction;
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly event: unknown | null;
  readonly status: GuardianApprovalReviewStatus;
  readonly riskLevel: GuardianRiskLevel | null;
  readonly userAuthorization: GuardianUserAuthorization | null;
  readonly rationale: string | null;
}

export interface CodexCanonicalAutoReviewInterruptionWarningItem {
  readonly type: "autoReviewInterruptionWarning";
  readonly id: string;
}

/** App-local row emitted when a remote task is created from a local turn. */
export interface CodexCanonicalRemoteTaskCreatedItem {
  readonly type: "remoteTaskCreated";
  readonly id: string;
  readonly taskId: string;
}

/** App-local row recording an in-thread personality transition. */
export interface CodexCanonicalPersonalityChangedItem {
  readonly type: "personalityChanged";
  readonly id: string;
  readonly personality: Personality;
}

/** App-local row recording an in-thread model transition. */
export interface CodexCanonicalModelChangedItem {
  readonly type: "modelChanged";
  readonly id: string;
  readonly fromModel: string;
  readonly toModel: string;
}

/** Exact app-side plan follow-up row created when a completed turn has a plan. */
export interface CodexCanonicalPlanImplementationItem {
  readonly type: "planImplementation";
  readonly id: string;
  readonly turnId: string;
  readonly planContent: string;
  readonly isCompleted: boolean;
}

/** App-side context-compaction state enriches the generated identity-only item. */
export type CodexCanonicalContextCompactionItem = Extract<
  ThreadItem,
  {
    type: "contextCompaction";
  }
> & {
  readonly completed?: boolean;
  readonly source?: "automatic" | "manual";
};
export type CodexCanonicalImageGenerationItem = Extract<
  ThreadItem,
  {
    type: "imageGeneration";
  }
> & {
  readonly src: string | null;
};

export interface CodexCanonicalCollabReceiverThread {
  readonly threadId: string;
  readonly thread: Thread | null;
}

export type CodexCanonicalCollabAgentToolCallItem = Extract<
  ThreadItem,
  {
    type: "collabAgentToolCall";
  }
> & {
  readonly receiverThreads: readonly CodexCanonicalCollabReceiverThread[];
};

/** Generated items that require app-owned display enrichment after ingress. */
export type CodexCanonicalGeneratedItem =
  | Exclude<
      ThreadItem,
      {
        type: "imageGeneration" | "collabAgentToolCall" | "contextCompaction";
      }
    >
  | CodexCanonicalImageGenerationItem
  | CodexCanonicalCollabAgentToolCallItem
  | CodexCanonicalContextCompactionItem;

export type CodexCanonicalLifecycleSyntheticItem =
  | CodexCanonicalSteeringUserMessageItem
  | CodexCanonicalSteeredItem
  | CodexCanonicalForkedFromConversationItem
  | CodexCanonicalWorktreeInitItem
  | CodexCanonicalTurnErrorItem
  | CodexCanonicalTodoListItem
  | CodexCanonicalModelReroutedItem
  | CodexCanonicalAutomaticApprovalReviewItem
  | CodexCanonicalAutoReviewInterruptionWarningItem
  | CodexCanonicalRemoteTaskCreatedItem
  | CodexCanonicalPersonalityChangedItem
  | CodexCanonicalModelChangedItem
  | CodexCanonicalPlanImplementationItem
  | CodexCanonicalContextCompactionItem
  | CodexCanonicalImageGenerationItem
  | CodexCanonicalCollabAgentToolCallItem;

export type CodexCanonicalItem =
  | CodexCanonicalGeneratedItem
  | CodexCanonicalLifecycleSyntheticItem
  | CodexCanonicalRequestSyntheticItem;

export type CodexCanonicalTurnHeader = Omit<Turn, "id" | "items" | "startedAt" | "completedAt"> & {
  /** Exact live state can carry one placeholder turn before app-server binding. */
  readonly turnId: Turn["id"] | null;
};
export interface CodexCanonicalConversationMetadata {
  readonly id: Thread["id"];
  readonly hostId: string;
  readonly sessionId: Thread["sessionId"];
  readonly ephemeral: Thread["ephemeral"];
  readonly sideConversation?: boolean;
  readonly forkedFromId: Thread["forkedFromId"];
  readonly parentThreadId: Thread["parentThreadId"];
  readonly source: Thread["source"];
  readonly threadSource: Thread["threadSource"];
  readonly agentNickname: Thread["agentNickname"];
  readonly historyMode: Thread["historyMode"];
  readonly modelProvider: Thread["modelProvider"];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly recencyAt: number;
  readonly title: string | null;
  readonly generatedTitle?: string | null;
  readonly latestModel: string;
  readonly latestReasoningEffort: Thread["reasoningEffort"];
  readonly latestCollaborationMode: NonNullable<TurnStartParams["collaborationMode"]>;
  /** App-side execution mode selected when the Thread was created. */
  readonly mode?: string | null;
  /** App-side Thread start classification used when rematerializing desktop instructions. */
  readonly threadStartKind?: string | null;
  readonly threadRuntimeStatus: Thread["status"];
  readonly rolloutPath: string;
  readonly cwd: Thread["cwd"];
  readonly gitInfo: Thread["gitInfo"];
  readonly resumeState: "needs_resume" | "resuming" | "resumed";
}

/** Converts generated seconds once, before metadata enters a manager document. */
export function createCodexCanonicalConversationMetadata(
  thread: Omit<Thread, "turns">,
  hostId: string,
  nowMs = Date.now(),
): CodexCanonicalConversationMetadata {
  const createdAt = Number.isFinite(thread.createdAt * 1000) ? thread.createdAt * 1000 : nowMs;
  const updatedAt = Number.isFinite(thread.updatedAt * 1000) ? thread.updatedAt * 1000 : createdAt;
  const recencyAt = thread.recencyAt === null ? null : thread.recencyAt * 1000;
  return {
    id: thread.id,
    hostId,
    sessionId: thread.sessionId,
    ephemeral: thread.ephemeral,
    forkedFromId: thread.forkedFromId,
    parentThreadId: thread.parentThreadId,
    source: thread.source,
    threadSource: thread.threadSource,
    agentNickname: thread.agentNickname,
    historyMode: thread.historyMode,
    modelProvider: thread.modelProvider,
    createdAt,
    updatedAt,
    recencyAt: recencyAt !== null && Number.isFinite(recencyAt) ? recencyAt : updatedAt,
    title: projectCodexMarkdownLabel(thread.name),
    latestModel: thread.model ?? "",
    latestReasoningEffort: thread.reasoningEffort,
    latestCollaborationMode: {
      mode: "default",
      settings: { model: "", reasoning_effort: null, developer_instructions: null },
    },
    threadRuntimeStatus: thread.status,
    rolloutPath: thread.path ?? "",
    cwd: thread.cwd,
    gitInfo: thread.gitInfo,
    resumeState: "resumed",
  };
}

type CodexCanonicalRequiredTurnParamKey =
  | "approvalPolicy"
  | "approvalsReviewer"
  | "model"
  | "cwd"
  | "effort"
  | "summary"
  | "personality"
  | "outputSchema"
  | "collaborationMode";

/**
 * Complete app-side turn context retained alongside generated params. The
 * required keys mirror hydrated `h$` state; private attachment payloads remain
 * generic so callers preserve their exact values without a parallel replica.
 */
type CodexCanonicalTurnParamsBase<
  TAttachment = unknown,
  TCommentAttachment = unknown,
> = TurnStartParams &
  Required<Pick<TurnStartParams, CodexCanonicalRequiredTurnParamKey>> & {
    readonly attachments: readonly TAttachment[];
    readonly commentAttachments?: readonly TCommentAttachment[];
  };

/** Exact `S1` synthetic-turn params intentionally omit attachment sidecars. */
export type CodexCanonicalSyntheticTurnParams = TurnStartParams &
  Required<Pick<TurnStartParams, CodexCanonicalRequiredTurnParamKey>> & {
    readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
    readonly permissions?: never;
    readonly runtimeWorkspaceRoots?: never;
    readonly attachments?: never;
    readonly commentAttachments?: never;
  };

export type CodexCanonicalHydratedProfileTurnParams<
  TAttachment = unknown,
  TCommentAttachment = unknown,
> = CodexCanonicalTurnParamsBase<TAttachment, TCommentAttachment> & {
  readonly permissions: string;
  readonly sandboxPolicy?: never;
  readonly runtimeWorkspaceRoots: NonNullable<TurnStartParams["runtimeWorkspaceRoots"]>;
  readonly useAppServerPermissionDefault?: never;
};

export type CodexCanonicalHydratedSandboxTurnParams<
  TAttachment = unknown,
  TCommentAttachment = unknown,
> = CodexCanonicalTurnParamsBase<TAttachment, TCommentAttachment> & {
  readonly permissions?: never;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly runtimeWorkspaceRoots?: never;
  readonly useAppServerPermissionDefault?: never;
};

/** Exact paged-resume overlay can retain a profile while adding response sandbox. */
export type CodexCanonicalResumedProfileTurnParams<
  TAttachment = unknown,
  TCommentAttachment = unknown,
> = CodexCanonicalTurnParamsBase<TAttachment, TCommentAttachment> & {
  readonly permissions: string;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly runtimeWorkspaceRoots: NonNullable<TurnStartParams["runtimeWorkspaceRoots"]>;
  readonly useAppServerPermissionDefault?: never;
};

/** Exact live `X1` stored state, which is richer than its outgoing request. */
export type CodexCanonicalLiveTurnParams<
  TAttachment = unknown,
  TCommentAttachment = unknown,
> = CodexCanonicalTurnParamsBase<TAttachment, TCommentAttachment> & {
  readonly permissions: string | null;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly runtimeWorkspaceRoots: NonNullable<TurnStartParams["runtimeWorkspaceRoots"]> | null;
  readonly useAppServerPermissionDefault: boolean;
};

export type CodexCanonicalTurnParams<TAttachment = unknown, TCommentAttachment = unknown> =
  | CodexCanonicalHydratedProfileTurnParams<TAttachment, TCommentAttachment>
  | CodexCanonicalHydratedSandboxTurnParams<TAttachment, TCommentAttachment>
  | CodexCanonicalResumedProfileTurnParams<TAttachment, TCommentAttachment>
  | CodexCanonicalLiveTurnParams<TAttachment, TCommentAttachment>
  | CodexCanonicalSyntheticTurnParams;

/** Exact `C6e` wrapper: repeated hook IDs receive a stable local run key. */
export interface CodexCanonicalHookRun {
  readonly id: string;
  readonly run: HookRunSummary;
}

export interface CodexCanonicalSafetyBufferingState {
  readonly useCases: readonly string[];
  readonly reasons: readonly string[];
  readonly showBufferingUi: boolean;
  readonly fasterModel: string | null;
}

/**
 * Mutable lifecycle/projection context absent from generated Turn/ThreadItem.
 * Optional collections preserve the exact unknown/absent merge semantics.
 */
export interface CodexCanonicalTurnContext {
  /** Stable local Turn identity when the server corrects its protocol ID during steering. */
  readonly entityKey?: string;
  readonly params: CodexCanonicalTurnParams;
  readonly diff: string | null;
  readonly turnStartedAtMs: number | null;
  /** Hydrated protocol completion time; distinct from first-final-assistant timing. */
  readonly completedAtMs?: number | null;
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs: number | null;
  readonly assistantMessageStartedAtMsById?: Readonly<Record<string, number>>;
  /** Explicit lifecycle for statusless protocol items such as reasoning. */
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
  readonly interruptedCommandExecutionItemIds?: readonly string[];
  readonly hookRuns?: readonly CodexCanonicalHookRun[];
  readonly safetyBuffering?: CodexCanonicalSafetyBufferingState;
}
export interface CodexCanonicalTurnState
  extends CodexCanonicalTurnContext, CodexCanonicalTurnHeader {
  readonly permissionParamsSource?: "inferred";
  readonly localMetadata?: unknown;
  readonly mcpAppModelContextAttachments?: unknown;
  readonly items: readonly CodexCanonicalItem[];
  readonly itemsPagination?: CodexHistoryTurnItemsPagination;
}

export interface CodexCanonicalUnconfirmedTurnSubmission {
  readonly requestId: RequestId;
  readonly method: string;
  readonly stage: "outcome-unknown";
  readonly clientUserMessageId: string;
  readonly terminal?: boolean;
}

export interface CodexCanonicalConversationState
  extends CodexCanonicalConversationContext, CodexCanonicalConversationMetadata {
  readonly workspaceKind?: "project" | "projectless" | null;
  readonly workspaceBrowserRoot?: string | null;
  readonly unconfirmedTurnSubmissions?: readonly CodexCanonicalUnconfirmedTurnSubmission[];
  readonly turnsPagination?: {
    readonly source?: "ordinary" | "compact";
    readonly olderCursor: string | null;
    readonly oldestLoadedTurnId: string | null;
    readonly isLoadingOlder: boolean;
    readonly hasLoadedOldest: boolean;
  };
  readonly paginatedHistory?: Pick<ThreadResumeResponse, "itemsBackwardsCursor"> &
    Partial<Pick<ThreadResumeResponse, "turnsBackwardsCursor">>;
  readonly turnHistory?: {
    readonly kind: "canonical";
    readonly history: CodexCanonicalHistoryTopology<CodexCanonicalTurnState>;
  };
  readonly turns: readonly CodexCanonicalTurnState[];
  readonly requests: readonly CodexCanonicalServerRequest[];
}

/** Reconstructs the loaded generated-protocol Thread without app-only placeholder occurrences. */
export function projectCodexCanonicalProtocolThread(
  state: CodexCanonicalConversationState,
  metadata: Omit<Thread, "turns">,
): Thread {
  return {
    ...metadata,
    turns: residentConversationTurns(state).flatMap((turn): Thread["turns"] => {
      if (turn.turnId === null) return [];
      return [
        {
          id: turn.turnId,
          itemsView: turn.itemsView,
          status: turn.status,
          error: turn.error,
          durationMs: turn.durationMs,
          items: turn.items.filter(isCodexCanonicalProtocolItem),
          startedAt: millisecondsToProtocolSeconds(turn.turnStartedAtMs),
          completedAt: millisecondsToProtocolSeconds(turn.completedAtMs),
        },
      ];
    }),
  };
}

/** Owner settings may precede a complete native settings notification. */
export type CodexCanonicalThreadSettings = Omit<
  ThreadSettingsUpdateParams,
  "threadId" | "model" | "effort" | "collaborationMode"
> &
  Pick<ThreadSettings, "model" | "effort" | "collaborationMode"> &
  Partial<Pick<ThreadSettings, "activePermissionProfile" | "modelProvider">>;

export interface CodexCanonicalConversationContext {
  /** Live execution permissions are independent of historical hydration and next-Turn settings. */
  readonly currentPermissions?: CodexCanonicalPermissionContext;
  /** Sticky native environments apply before workspace and permission materialization. */
  readonly environments?: readonly TurnEnvironmentParams[] | null;
  readonly environmentSelectionEvidence?: CodexEnvironmentSelectionEvidence;
  readonly connectedEnvironmentIds?: readonly EnvironmentConnectionNotification["environmentId"][];
  readonly hasUnreadTurn: boolean;
  readonly hydrationContext: CodexCanonicalHydrationContext | null;
  readonly latestTokenUsageInfo?: ThreadTokenUsage | null;
  readonly latestThreadSettings?: CodexCanonicalThreadSettings | null;
  readonly previousTurnModel?: string | null;
  readonly threadGoal?: ThreadGoal | null;
  readonly completedThreadGoal?: ThreadGoal | null;
  /** Turn that completed the goal; later prompts must not move the completion footer. */
  readonly completedThreadGoalTurnId?: string | null;
  readonly threadGoalResumeConfirmation?: ThreadGoal | null;
}

/** Live preparation can leave profile provenance or runtime roots unobserved. */
export interface CodexCanonicalPermissionContext {
  readonly activePermissionProfile?: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots?: readonly string[];
  readonly approvalPolicy: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
}

/** A native hydration response supplies both profile provenance and runtime roots. */
export interface CodexCanonicalHydratedPermissionContext extends CodexCanonicalPermissionContext {
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots: readonly string[];
}

/** History reconstruction needs concrete grants without changing the live permission context. */
export function canonicalHistoryPermissionContext(permissions: CodexCanonicalPermissionContext) {
  return {
    ...permissions,
    activePermissionProfile: permissions.activePermissionProfile ?? null,
    runtimeWorkspaceRoots: [...(permissions.runtimeWorkspaceRoots ?? [])],
  };
}

export interface CodexCanonicalHydrationContext {
  readonly model: string;
  readonly reasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly latestModel: string;
  readonly latestReasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly cwd: string | null;
  readonly latestThreadSettings: CodexCanonicalHydratedThreadSettings | null;
}

export interface CodexCanonicalHydratedThreadSettings {
  readonly cwd?: string | null;
  readonly approvalPolicy?: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer?: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly activePermissionProfile?: CodexCanonicalHydratedPermissionContext["activePermissionProfile"];
  readonly sandboxPolicy?: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly permissions?: string | null;
  readonly model?: string;
  readonly serviceTier?: TurnStartParams["serviceTier"];
  readonly effort?: NonNullable<TurnStartParams["effort"]> | null;
  readonly summary?: TurnStartParams["summary"];
  readonly multiAgentMode?: TurnStartParams["multiAgentMode"];
  readonly collaborationMode?: TurnStartParams["collaborationMode"];
  readonly personality?: TurnStartParams["personality"];
}

export interface CreateCodexCanonicalConversationStateOptions {
  readonly hostId: string;
  readonly environmentSource?: CodexEnvironmentSelectionEvidence["source"];
  readonly workspaceKind?: "project" | "projectless" | null;
  readonly workspaceBrowserRoot?: string | null;
  readonly pendingRequests?: readonly CodexCanonicalServerRequest[];
  /** Hydrated callers pass the app snapshot value; absent means the bundle default. */
  readonly hasUnreadTurn?: boolean;
  readonly hydrationContext?: CodexCanonicalHydrationContext | null;
  readonly turnParamsById: Readonly<Record<string, CodexCanonicalTurnParams>>;
}

export interface CodexCanonicalHydratedAttachment {
  readonly label: string;
  readonly path: string;
  readonly fsPath: string;
}

export interface CreateCodexCanonicalHydratedConversationStateOptions {
  readonly model: string;
  readonly reasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly cwd: string;
  readonly workspaceKind?: "project" | "projectless" | null;
  readonly workspaceBrowserRoot?: string | null;
  readonly approvalPolicy: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots: NonNullable<TurnStartParams["runtimeWorkspaceRoots"]>;
  readonly latestThreadSettings?: CodexCanonicalHydratedThreadSettings | null;
  readonly hostId: string;
  readonly environmentSource?: CodexEnvironmentSelectionEvidence["source"];
  readonly pendingRequests?: readonly CodexCanonicalServerRequest[];
  readonly hasUnreadTurn?: boolean;
  /** Required for every partial Turn so params can retain its opening user input. */
  readonly turnItemsPaginationById?: Readonly<Record<string, CodexHistoryTurnItemsPagination>>;
}

export interface ResolveCodexCanonicalHydratedPermissionContextInput {
  readonly response: CodexCanonicalHydratedPermissionContext;
  readonly previous: CodexCanonicalHydratedPermissionContext | null;
}

export interface ResolveCodexCanonicalHydratedCwdInput {
  readonly requestedCwd: string | null;
  readonly responseCwd: string | null;
  readonly threadCwd: string | null;
  readonly fallbackCwd: string | null;
}

function assertCompleteCodexCanonicalHydrationOptions(
  options: CreateCodexCanonicalHydratedConversationStateOptions,
): void {
  const hasActiveProfile =
    options.activePermissionProfile === null ||
    (typeof options.activePermissionProfile === "object" &&
      typeof options.activePermissionProfile.id === "string" &&
      options.activePermissionProfile.id.length > 0);
  if (
    typeof options.model !== "string" ||
    typeof options.cwd !== "string" ||
    (options.reasoningEffort !== null && typeof options.reasoningEffort !== "string") ||
    typeof options.approvalPolicy !== "string" ||
    typeof options.approvalsReviewer !== "string" ||
    typeof options.sandboxPolicy !== "object" ||
    options.sandboxPolicy === null ||
    !hasActiveProfile ||
    !Array.isArray(options.runtimeWorkspaceRoots) ||
    options.runtimeWorkspaceRoots.some((root) => typeof root !== "string")
  ) {
    throw new Error("Canonical hydration requires complete response context");
  }
}

function protocolSecondsToMilliseconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  return value * 1000;
}

function millisecondsToProtocolSeconds(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  return value / 1000;
}

function normalizeCodexCanonicalCwdForComparison(value: string): string {
  let normalized = value.replaceAll("\\", "/");
  while (normalized.length > 1 && normalized.endsWith("/") && !/^[A-Za-z]:\/$/.test(normalized)) {
    normalized = normalized.slice(0, -1);
  }
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

/** Exact paged-resume `d1`: preserve a requested cwd only within the response root. */
export function resolveCodexCanonicalHydratedCwd(
  input: ResolveCodexCanonicalHydratedCwdInput,
): string | null {
  const responseOrThreadCwd = input.responseCwd || input.threadCwd;
  if (input.requestedCwd && responseOrThreadCwd) {
    const requested = normalizeCodexCanonicalCwdForComparison(input.requestedCwd);
    const response = normalizeCodexCanonicalCwdForComparison(responseOrThreadCwd);
    if (requested === response || requested.startsWith(`${response}/`)) {
      return input.requestedCwd;
    }
  }

  return responseOrThreadCwd || input.requestedCwd || input.fallbackCwd || null;
}

/** Exact projectless `k1`: keep cwd inside the selected workspace-browser root. */
export function resolveCodexCanonicalProjectlessCwd(input: {
  readonly cwd: string | null;
  readonly fallbackCwd: string | null;
  readonly workspaceBrowserRoot: string | null;
  readonly projectless: boolean;
}): string | null {
  if (!input.projectless) return input.cwd ?? input.fallbackCwd;

  const browserFallback =
    input.workspaceBrowserRoot === null || input.workspaceBrowserRoot === "~"
      ? input.fallbackCwd
      : input.workspaceBrowserRoot;
  if (browserFallback === null || browserFallback === "~") {
    return input.cwd === "~" ? null : input.cwd;
  }

  const normalizedRoot = normalizeCodexCanonicalCwdForComparison(browserFallback);
  if (!normalizedRoot) return null;
  if (input.cwd === null) return browserFallback;

  const normalizedCwd = normalizeCodexCanonicalCwdForComparison(input.cwd);
  return normalizedCwd === normalizedRoot || normalizedCwd.startsWith(`${normalizedRoot}/`)
    ? input.cwd
    : browserFallback;
}

/** Exact `bf(workspaceRoots)` fallback used before a paged resume is applied. */
export function createCodexCanonicalWorkspacePermissionContext(
  runtimeWorkspaceRoots: readonly string[],
): CodexCanonicalHydratedPermissionContext {
  return {
    activePermissionProfile: {
      id: ":workspace",
      extends: null,
    },
    runtimeWorkspaceRoots: [...runtimeWorkspaceRoots],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [...runtimeWorkspaceRoots],
      networkAccess: false,
      excludeTmpdirEnvVar: false,
      excludeSlashTmp: false,
    },
  };
}

/** Exact `HQ`: merge resume permission provenance without inventing a profile. */
export function resolveCodexCanonicalHydratedPermissionContext(
  input: ResolveCodexCanonicalHydratedPermissionContextInput,
): CodexCanonicalHydratedPermissionContext {
  const previousProfile = input.previous?.activePermissionProfile ?? null;
  if (
    input.response.activePermissionProfile === null &&
    previousProfile?.id === ":danger-full-access"
  ) {
    return input.previous ?? input.response;
  }

  return {
    activePermissionProfile:
      input.response.activePermissionProfile ??
      (previousProfile && !previousProfile.id.startsWith(":") ? previousProfile : null),
    runtimeWorkspaceRoots: [...input.response.runtimeWorkspaceRoots],
    approvalPolicy: input.response.approvalPolicy,
    approvalsReviewer: input.response.approvalsReviewer,
    sandboxPolicy: input.response.sandboxPolicy,
  };
}

function getRequiredTurnParams(
  turnId: string,
  turnParamsById: Readonly<Record<string, CodexCanonicalTurnParams>>,
): CodexCanonicalTurnParams {
  const params = turnParamsById[turnId];
  if (!params) {
    throw new Error(`Missing complete canonical params for turn ${turnId}`);
  }

  return params;
}

export function createCodexCanonicalProtocolItem<TItem extends ThreadItem>(item: TItem): TItem {
  return item;
}

function isAbsoluteCodexImagePath(value: string): boolean {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value) ||
    /^\/\/[^/]+\/[^/]+/.test(value)
  );
}

function normalizeCodexImageSource(value: string): string | null {
  const source = value.trim();
  if (!source) return null;
  if (isAbsoluteCodexImagePath(source)) {
    const normalized = source.replace(/\\/g, "/");
    return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  }
  if (/^(?:data:image\/|https?:\/\/|file:\/\/|app:\/\/|\/@fs)/i.test(source)) {
    return source;
  }
  return `data:image/png;base64,${source}`;
}

/** Exact hydrated `zQe` / live `uZe` item materialization. */
export function materializeCodexCanonicalProtocolItem(
  item: ThreadItem,
  resolveCollabReceiverThread?: (threadId: string) => Thread | null,
): CodexCanonicalItem {
  if (item.type === "reasoning") {
    const summary = boundCodexReasoningParts(item.summary);
    const content = boundCodexReasoningParts(item.content);
    if (summary === item.summary && content === item.content) return item;
    return { ...item, summary, content };
  }

  if (item.type === "imageGeneration") {
    const savedSource =
      typeof item.savedPath === "string" ? normalizeCodexImageSource(item.savedPath) : null;
    return {
      ...item,
      src: savedSource ?? normalizeCodexImageSource(item.result),
    } satisfies CodexCanonicalImageGenerationItem;
  }

  if (item.type === "collabAgentToolCall") {
    return {
      ...item,
      receiverThreads: item.receiverThreadIds.map((threadId) => ({
        threadId,
        thread: resolveCollabReceiverThread?.(threadId) ?? null,
      })),
    } satisfies CodexCanonicalCollabAgentToolCallItem;
  }

  if (item.type === "contextCompaction") {
    return {
      ...item,
      completed: true,
      source: "automatic",
    } satisfies CodexCanonicalContextCompactionItem;
  }

  return item;
}

export function createCodexCanonicalProtocolRequest<TRequest extends ServerRequest>(
  request: TRequest,
): TRequest {
  return request;
}

export function createCodexCanonicalTurnState(
  turn: Turn,
  params: CodexCanonicalTurnParams,
): CodexCanonicalTurnState {
  const { id, items, startedAt, completedAt, ...header } = turn;

  return {
    ...header,
    turnId: id,
    items: items.map((item) => materializeCodexCanonicalProtocolItem(item)),
    params,
    diff: null,
    turnStartedAtMs: protocolSecondsToMilliseconds(startedAt),
    completedAtMs: protocolSecondsToMilliseconds(completedAt),
    finalAssistantStartedAtMs: null,
    lifecycleStatusByItemId: buildCodexInitialItemLifecycleStatusById(items, header.status),
  };
}

function buildCodexInitialItemLifecycleStatusById(
  items: readonly ThreadItem[],
  turnStatus: Turn["status"],
): Readonly<Record<string, CodexItemStatus>> {
  const statuses: Record<string, CodexItemStatus> = {};
  for (const item of items) {
    const status =
      "status" in item && isCodexItemStatus(item.status)
        ? item.status
        : turnStatus === "inProgress"
          ? null
          : "completed";
    if (status !== null) statuses[item.id] = status;
  }
  return statuses;
}

function isCodexItemStatus(value: unknown): value is CodexItemStatus {
  return (
    value === "inProgress" ||
    value === "completed" ||
    value === "failed" ||
    value === "declined" ||
    value === "interrupted"
  );
}

function extractCodexHeartbeatTag(text: string, tag: string): string | null {
  return RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, "i").exec(text)?.[1]?.trim() ?? null;
}

function hasCodexHeartbeatAutomationInput(input: readonly UserInput[]): boolean {
  const text = input
    .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
    .join("\n")
    .trim();
  if (!text.startsWith("<heartbeat>") || !text.endsWith("</heartbeat>")) {
    return false;
  }
  return (
    extractCodexHeartbeatTag(text, "current_time_iso") !== null &&
    extractCodexHeartbeatTag(text, "instructions") !== null
  );
}

function hasCodexHeartbeatDecision(text: string): boolean {
  const trimmed = text.trim();
  const visibleText = trimmed
    .replace(/```(?:xml)?\s*<heartbeat>[\s\S]*?<\/heartbeat>\s*```/gi, "")
    .replace(/<heartbeat>[\s\S]*?<\/heartbeat>/gi, "")
    .trim();
  if (visibleText === trimmed) return false;
  const heartbeat = Array.from(trimmed.matchAll(/<heartbeat>[\s\S]*?<\/heartbeat>/gi)).at(-1)?.[0];
  return (
    heartbeat !== undefined && /<decision>\s*(?:NOTIFY|DONT_NOTIFY)\s*<\/decision>/i.test(heartbeat)
  );
}
function getCodexHeartbeatUserMessage(items: readonly CodexCanonicalItem[]): Extract<
  ThreadItem,
  {
    type: "userMessage";
  }
> | null {
  for (const item of items) {
    if (item.type === "userMessage" && hasCodexHeartbeatAutomationInput(item.content)) {
      return item;
    }
  }
  return null;
}

function mergeCodexCanonicalHydratedItems(
  existingItems: readonly CodexCanonicalItem[],
  incomingItems: readonly CodexCanonicalItem[],
): readonly CodexCanonicalItem[] {
  let items: readonly CodexCanonicalItem[] = incomingItems;
  if (existingItems.some((item) => item.type === "steeringUserMessage")) {
    const incomingById = new Map(incomingItems.map((item) => [item.id, item]));
    items = mergeCodexCanonicalHistoryItems(
      existingItems.map((item) =>
        item.type === "agentMessage" ? (incomingById.get(item.id) ?? item) : item,
      ),
      incomingItems,
      "append",
    ).items;
  } else if (existingItems.length > incomingItems.length) {
    items = existingItems;
    for (let index = incomingItems.length - 1; index >= 0; index -= 1) {
      const incoming = incomingItems[index];
      if (incoming?.type !== "agentMessage" || incoming.phase !== "final_answer") {
        continue;
      }
      const existing = existingItems.find(
        (
          item,
        ): item is Extract<
          ThreadItem,
          {
            type: "agentMessage";
          }
        > =>
          item.type === "agentMessage" &&
          (item.id === incoming.id ||
            (incoming.delivery !== "async" &&
              item.phase === "final_answer" &&
              item.text === incoming.text)),
      );
      if (!existing) {
        items = [...existingItems, incoming];
      } else if (existing.id !== incoming.id) {
        const merged = {
          ...existing,
          ...incoming,
          id: existing.id,
          memoryCitation: incoming.memoryCitation ?? existing.memoryCitation,
          delivery: incoming.delivery ?? existing.delivery,
          questions: incoming.questions ?? existing.questions,
        } satisfies Extract<
          ThreadItem,
          {
            type: "agentMessage";
          }
        >;
        items = existingItems.map((item) => (item === existing ? merged : item));
      }
      break;
    }
  }

  const heartbeatUserMessage =
    getCodexHeartbeatUserMessage(incomingItems) ?? getCodexHeartbeatUserMessage(existingItems);
  if (heartbeatUserMessage && getCodexHeartbeatUserMessage(items) === null) {
    return [heartbeatUserMessage, ...items];
  }
  return items;
}

function mergeCodexCanonicalTurnParams(
  existing: CodexCanonicalTurnParams,
  incoming: CodexCanonicalTurnParams,
): CodexCanonicalTurnParams {
  if (
    existing.clientUserMessageId != null &&
    existing.input.length > 0 &&
    incoming.input.length === 0
  )
    return existing;
  if (
    hasCodexHeartbeatAutomationInput(incoming.input) ||
    !hasCodexHeartbeatAutomationInput(existing.input)
  ) {
    return incoming;
  }
  return {
    ...incoming,
    input: existing.input,
  } as CodexCanonicalTurnParams;
}

function isCodexCanonicalPlaceholderTurn(turn: CodexCanonicalTurnState): boolean {
  return (
    turn.turnId === null &&
    turn.turnStartedAtMs === null &&
    turn.status === "completed" &&
    turn.error === null &&
    turn.items.length === 0
  );
}

function isCodexCanonicalArchivedHeartbeatTurn(turn: CodexCanonicalTurnState): boolean {
  if (
    turn.status !== "completed" ||
    turn.error !== null ||
    hasCodexHeartbeatAutomationInput(turn.params.input) ||
    getCodexHeartbeatUserMessage(turn.items) !== null
  ) {
    return false;
  }
  return turn.items.some(
    (item) => item.type === "agentMessage" && hasCodexHeartbeatDecision(item.text),
  );
}

export interface CodexCanonicalTurnMergeOptions {
  readonly itemsPagination?: CodexHistoryTurnItemsPagination;
  readonly isResumeSnapshot?: boolean;
  readonly preserveExistingTerminalState?: boolean;
}

/** Merges matching hydrated/live Turns while retaining local work and correlated input. */
export function mergeCodexCanonicalTurnState(
  existing: CodexCanonicalTurnState,
  incoming: CodexCanonicalTurnState,
  options: CodexCanonicalTurnMergeOptions = {},
): CodexCanonicalTurnState {
  const terminalRegression = existing.status !== "inProgress" && incoming.status === "inProgress";
  const incomingPagination = incoming.itemsPagination ?? options.itemsPagination;
  let itemsPagination =
    existing.itemsPagination == null
      ? incomingPagination
      : { ...incomingPagination, ...existing.itemsPagination };
  if (options.isResumeSnapshot && incomingPagination != null) {
    const previous = existing.itemsPagination;
    const stopItemId =
      previous?.reconnect == null ? previous?.newestSnapshotItemId : previous.reconnect.stopItemId;
    const olderCursorAfterReconnect =
      previous?.reconnect == null
        ? previous?.olderCursor
        : previous.reconnect.olderCursorAfterReconnect;
    const overlaps =
      incomingPagination.summaryItemIds == null &&
      stopItemId != null &&
      incoming.items.some((item) => item.id === stopItemId);
    const cursor = overlaps ? (olderCursorAfterReconnect ?? null) : incomingPagination.olderCursor;
    const complete =
      incomingPagination.hasLoadedOldest || (overlaps && olderCursorAfterReconnect == null);
    itemsPagination = {
      ...incomingPagination,
      olderCursor: complete ? null : cursor,
      hasLoadedOldest: complete,
      reconnect:
        complete || overlaps
          ? undefined
          : {
              beforeItemId: incoming.items[0]?.id ?? null,
              stopItemId,
              olderCursorAfterReconnect: olderCursorAfterReconnect ?? undefined,
            },
    };
  }
  if (areStructurallyEqual(itemsPagination, existing.itemsPagination))
    itemsPagination = existing.itemsPagination;

  const items =
    existing.itemsPagination != null || incomingPagination != null
      ? mergeCodexCanonicalHistoryItems(
          existing.items,
          incoming.items,
          options.isResumeSnapshot ? { snapshotBeforeItemId: null } : "append",
        ).items
      : options.preserveExistingTerminalState && terminalRegression
        ? existing.items
        : mergeCodexCanonicalHydratedItems(existing.items, incoming.items);
  const merged: CodexCanonicalTurnState = {
    ...incoming,
    ...(itemsPagination == null ? {} : { itemsPagination }),
    status:
      terminalRegression && (options.preserveExistingTerminalState || itemsPagination != null)
        ? existing.status
        : incoming.status,
    error:
      terminalRegression && options.preserveExistingTerminalState ? existing.error : incoming.error,
    durationMs: existing.durationMs ?? incoming.durationMs,
    items,
    entityKey: existing.entityKey ?? incoming.entityKey,
    params: mergeCodexCanonicalTurnParams(existing.params, incoming.params),
    permissionParamsSource: existing.permissionParamsSource,
    hookRuns: existing.hookRuns?.length ? existing.hookRuns : incoming.hookRuns,
    safetyBuffering: incoming.safetyBuffering ?? existing.safetyBuffering,
    diff: incoming.diff ?? existing.diff,
    interruptedCommandExecutionItemIds:
      incoming.interruptedCommandExecutionItemIds ?? existing.interruptedCommandExecutionItemIds,
    commandExecutionStartedAtMsById:
      existing.commandExecutionStartedAtMsById ?? incoming.commandExecutionStartedAtMsById,
    assistantMessageStartedAtMsById:
      existing.assistantMessageStartedAtMsById === undefined
        ? incoming.assistantMessageStartedAtMsById
        : incoming.assistantMessageStartedAtMsById === undefined
          ? existing.assistantMessageStartedAtMsById
          : {
              ...incoming.assistantMessageStartedAtMsById,
              ...existing.assistantMessageStartedAtMsById,
            },
    turnStartedAtMs: existing.turnStartedAtMs ?? incoming.turnStartedAtMs,
    completedAtMs: existing.completedAtMs ?? incoming.completedAtMs,
    finalAssistantStartedAtMs:
      existing.finalAssistantStartedAtMs ?? incoming.finalAssistantStartedAtMs,
    lifecycleStatusByItemId: mergeCodexLifecycleStatusByItemId(
      existing.lifecycleStatusByItemId,
      incoming.lifecycleStatusByItemId,
    ),
  };
  return existing.items.some((item) => item.type === "steeringUserMessage")
    ? reconcileCodexHydratedSteering(merged, itemsPagination)
    : merged;
}

function mergeCodexLifecycleStatusByItemId(
  existing: Readonly<Record<string, CodexItemStatus>> | undefined,
  incoming: Readonly<Record<string, CodexItemStatus>> | undefined,
): Readonly<Record<string, CodexItemStatus>> {
  const merged: Record<string, CodexItemStatus> = { ...(existing ?? {}) };
  for (const [itemId, incomingStatus] of Object.entries(incoming ?? {})) {
    const existingStatus = merged[itemId];
    if (existingStatus === undefined || existingStatus === "inProgress") {
      merged[itemId] = incomingStatus;
    }
  }
  return merged;
}

/** Exact `CB`: chronology-aware merge for overlapping hydration/history turn arrays. */
export function mergeCodexCanonicalTurnStates(
  existingTurns: readonly CodexCanonicalTurnState[],
  incomingTurns: readonly CodexCanonicalTurnState[],
  optionsForTurn?: (turnId: string | null) => CodexCanonicalTurnMergeOptions,
): CodexCanonicalTurnState[] {
  const existingIds = new Set(
    existingTurns.flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  const incomingById = new Map(
    incomingTurns.flatMap((turn) => (turn.turnId === null ? [] : [[turn.turnId, turn] as const])),
  );
  const merged = existingTurns.flatMap((existing) => {
    if (isCodexCanonicalPlaceholderTurn(existing)) return [];
    if (existing.turnId === null) return [existing];
    const incoming = incomingById.get(existing.turnId);
    if (incoming)
      return [mergeCodexCanonicalTurnState(existing, incoming, optionsForTurn?.(existing.turnId))];
    return isCodexCanonicalArchivedHeartbeatTurn(existing) &&
      !existing.items.some(
        (item) => item.type === "steeringUserMessage" && item.serverUserMessageId == null,
      )
      ? []
      : [existing];
  });
  let pendingIncoming: CodexCanonicalTurnState[] = [];

  for (const incoming of incomingTurns) {
    const incomingId = incoming.turnId;
    if (incomingId !== null && existingIds.has(incomingId)) {
      if (pendingIncoming.length === 0) continue;
      const existingIndex = merged.findIndex((turn) => turn.turnId === incomingId);
      if (existingIndex !== -1) {
        merged.splice(existingIndex, 0, ...pendingIncoming);
        pendingIncoming = [];
      }
      continue;
    }
    pendingIncoming.push(incoming);
  }

  merged.push(...pendingIncoming);
  if (
    !merged.some((turn) =>
      turn.items.some(
        (item) => item.type === "steeringUserMessage" && item.targetTurnId !== turn.turnId,
      ),
    )
  )
    return merged;
  return relocateCodexHydratedSteering(
    merged,
    (turnId) => optionsForTurn?.(turnId).itemsPagination,
  ).filter((turn) => !isCodexCanonicalPlaceholderTurn(turn));
}

/** Read projection combining resident history with current live Turns; never a mutation target. */
export function conversationTurnsWithOverlay(
  state: CodexCanonicalConversationState | null | undefined,
): readonly CodexCanonicalTurnState[] {
  if (!state) return [];
  if (!state.turnHistory) return state.turns;
  return mergeCodexCanonicalTurnStates(residentConversationTurns(state), state.turns);
}

/** Exact `DB` duplicate-ID fold used when installing canonical tail history. */
export function canonicalizeCodexCanonicalTurnStates(
  turns: readonly CodexCanonicalTurnState[],
): CodexCanonicalTurnState[] {
  const canonical: CodexCanonicalTurnState[] = [];
  const indexByTurnId = new Map<string, number>();
  for (const turn of turns) {
    const turnId = turn.turnId;
    if (turnId === null) {
      canonical.push(turn);
      continue;
    }
    const existingIndex = indexByTurnId.get(turnId);
    if (existingIndex === undefined) {
      indexByTurnId.set(turnId, canonical.length);
      canonical.push(turn);
      continue;
    }
    const existing = canonical[existingIndex];
    if (existing) {
      canonical[existingIndex] = mergeCodexCanonicalTurnState(existing, turn);
    }
  }
  return canonical;
}

export function buildCodexCanonicalSyntheticTurnParams(
  state: CodexCanonicalConversationState,
  previousTurn: CodexCanonicalTurnState | null,
): CodexCanonicalSyntheticTurnParams {
  const defaults = createCodexCanonicalWorkspacePermissionContext([]);
  const latestSettings =
    state.latestThreadSettings ?? state.hydrationContext?.latestThreadSettings ?? null;
  return {
    threadId: state.id,
    input: [],
    cwd: null,
    approvalPolicy:
      latestSettings?.approvalPolicy ??
      previousTurn?.params.approvalPolicy ??
      defaults.approvalPolicy,
    approvalsReviewer:
      latestSettings?.approvalsReviewer ??
      previousTurn?.params.approvalsReviewer ??
      defaults.approvalsReviewer,
    sandboxPolicy:
      latestSettings?.sandboxPolicy ?? previousTurn?.params.sandboxPolicy ?? defaults.sandboxPolicy,
    model: null,
    effort: "minimal",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
  };
}

function createCodexCanonicalCompletedSyntheticTurn(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalLifecycleSyntheticItem,
  previousTurn: CodexCanonicalTurnState | null,
): CodexCanonicalTurnState {
  return {
    turnId: null,
    itemsView: "full",
    status: "completed",
    error: null,
    durationMs: null,
    items: [item],
    params: buildCodexCanonicalSyntheticTurnParams(state, previousTurn),
    diff: null,
    turnStartedAtMs: null,
    firstTurnWorkItemStartedAtMs: null,
    finalAssistantStartedAtMs: null,
    hookRuns: [],
  };
}

/** Exact `M4e`: dedupe an app-local item, reuse the active turn, or create one. */
export function mutateCodexCanonicalInProgressSyntheticItem(
  state: Draft<CodexCanonicalConversationState>,
  item: CodexCanonicalLifecycleSyntheticItem,
  observedAtMs: number,
): void {
  const entries = residentConversationTurnEntries(state);
  if (entries.some(({ turn }) => turn.items.some((candidate) => candidate.id === item.id))) return;
  const latest = entries.at(-1);
  if (latest?.turn.status === "inProgress") {
    conversationTurnDraft(state, latest.address)!.items.push(
      item as Draft<CodexCanonicalLifecycleSyntheticItem>,
    );
    return;
  }
  appendConversationTurnDraft(
    state,
    {
      turnId: null,
      itemsView: "full",
      status: "inProgress",
      error: null,
      durationMs: null,
      items: [item],
      params: buildCodexCanonicalSyntheticTurnParams(state, latest?.turn ?? null),
      diff: null,
      turnStartedAtMs: observedAtMs,
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      hookRuns: [],
    },
    () => globalThis.crypto.randomUUID(),
  );
}
export function appendCodexCanonicalInProgressSyntheticItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalLifecycleSyntheticItem,
  observedAtMs: number,
): CodexCanonicalConversationState {
  return produce(state, (draft) =>
    mutateCodexCanonicalInProgressSyntheticItem(draft, item, observedAtMs),
  );
}
export function mutateCodexCanonicalLocalSyntheticItemRemoval(
  state: Draft<CodexCanonicalConversationState>,
  itemId: string,
): void {
  for (const entry of [...residentConversationTurnEntries(state)].reverse()) {
    const turn = conversationTurnDraft(state, entry.address)!;
    if (!turn.items.some((item) => item.id === itemId)) continue;
    turn.items = turn.items.filter((item) => item.id !== itemId);
    if (turn.turnId === null && turn.status === "inProgress" && turn.items.length === 0)
      removeConversationTurnDraft(state, entry.address);
  }
}
export function removeCodexCanonicalLocalSyntheticItem(
  state: CodexCanonicalConversationState,
  itemId: string,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexCanonicalLocalSyntheticItemRemoval(draft, itemId));
}
export function mutateCodexCanonicalForkedFromConversationItem(
  state: Draft<CodexCanonicalConversationState>,
  item: CodexCanonicalForkedFromConversationItem,
): void {
  const latest = residentConversationTurnEntries(state).at(-1);
  if (latest) {
    const turn = conversationTurnDraft(state, latest.address)!;
    turn.hookRuns ??= [];
    turn.items.push(item as Draft<CodexCanonicalForkedFromConversationItem>);
    return;
  }
  appendConversationTurnDraft(
    state,
    createCodexCanonicalCompletedSyntheticTurn(state, item, null),
    () => globalThis.crypto.randomUUID(),
  );
}
export function appendCodexCanonicalForkedFromConversationItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalForkedFromConversationItem,
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexCanonicalForkedFromConversationItem(draft, item));
}
export function mutateCodexCanonicalWorktreeInitItem(
  state: Draft<CodexCanonicalConversationState>,
  item: CodexCanonicalWorktreeInitItem,
  placement: "latest-turn" | "new-turn" = "latest-turn",
): void {
  const latest = residentConversationTurnEntries(state).at(-1);
  if (placement === "latest-turn" && latest) {
    const turn = conversationTurnDraft(state, latest.address)!;
    turn.hookRuns ??= [];
    turn.items.push(item as Draft<CodexCanonicalWorktreeInitItem>);
    return;
  }
  appendConversationTurnDraft(
    state,
    createCodexCanonicalCompletedSyntheticTurn(state, item, latest?.turn ?? null),
    () => globalThis.crypto.randomUUID(),
  );
}
export function appendCodexCanonicalWorktreeInitItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalWorktreeInitItem,
  placement: "latest-turn" | "new-turn" = "latest-turn",
): CodexCanonicalConversationState {
  return produce(state, (draft) => mutateCodexCanonicalWorktreeInitItem(draft, item, placement));
}

function canonicalizeCodexCanonicalTurnIds(
  turns: readonly CodexCanonicalTurnState[],
): CodexCanonicalTurnState[] {
  const canonical: CodexCanonicalTurnState[] = [];
  const indexByTurnId = new Map<string, number>();
  for (const turn of turns) {
    const turnId = turn.turnId;
    if (turnId === null) {
      canonical.push(turn);
      continue;
    }
    const existingIndex = indexByTurnId.get(turnId);
    if (existingIndex === undefined) {
      indexByTurnId.set(turnId, canonical.length);
      canonical.push(turn);
      continue;
    }
    canonical[existingIndex] = turn;
  }
  return canonical;
}

/** Exact `UQe`: insert an older page at its tail anchor, then canonicalize IDs. */
export function mergeCodexCanonicalOlderTurnStates(input: {
  readonly olderTurns: readonly CodexCanonicalTurnState[];
  readonly currentTurns: readonly CodexCanonicalTurnState[];
  readonly oldestLoadedTurnId: string | null;
}): CodexCanonicalTurnState[] {
  const anchorIndex =
    input.oldestLoadedTurnId === null
      ? -1
      : input.currentTurns.findIndex((turn) => turn.turnId === input.oldestLoadedTurnId);
  const staged =
    anchorIndex === -1
      ? mergeCodexCanonicalTurnStates(input.olderTurns, input.currentTurns)
      : mergeCodexCanonicalTurnStates(
          mergeCodexCanonicalTurnStates(input.currentTurns.slice(0, anchorIndex), input.olderTurns),
          input.currentTurns.slice(anchorIndex),
        );
  return canonicalizeCodexCanonicalTurnIds(staged);
}

export interface CodexCanonicalTurnHydrationOverlay {
  readonly approvalPolicy: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly model: string;
  readonly cwd: string | null;
  readonly effort: NonNullable<TurnStartParams["effort"]> | null;
}

/** Exact paged-resume `pe`: overlay response fields without deleting prior profile fields. */
export function overlayCodexCanonicalTurnHydration(
  turns: readonly CodexCanonicalTurnState[],
  overlay: CodexCanonicalTurnHydrationOverlay,
): CodexCanonicalTurnState[] {
  return turns.map((turn) => ({
    ...turn,
    params: {
      ...turn.params,
      approvalPolicy: overlay.approvalPolicy,
      approvalsReviewer: overlay.approvalsReviewer,
      sandboxPolicy: overlay.sandboxPolicy,
      model: overlay.model,
      cwd: overlay.cwd,
      effort: overlay.effort,
    } as CodexCanonicalTurnParams,
  }));
}

export function createCodexCanonicalHookRun(
  run: HookRunSummary,
  id: string = run.id,
): CodexCanonicalHookRun {
  return { id, run };
}

export function createCodexCanonicalConversationState(
  thread: Thread,
  options: CreateCodexCanonicalConversationStateOptions,
): CodexCanonicalConversationState {
  const { turns } = thread;
  const environmentSelection = mergeCodexThreadEnvironmentSelection(
    thread,
    null,
    options.environmentSource ?? "stored",
  );

  return {
    ...createCodexCanonicalConversationMetadata(thread, options.hostId),
    ...environmentSelection,
    ...(options.workspaceKind === undefined ? {} : { workspaceKind: options.workspaceKind }),
    ...(options.workspaceBrowserRoot === undefined
      ? {}
      : { workspaceBrowserRoot: options.workspaceBrowserRoot }),
    previousTurnModel: null,
    latestTokenUsageInfo: null,
    turns: turns.map((turn) =>
      createCodexCanonicalTurnState(turn, getRequiredTurnParams(turn.id, options.turnParamsById)),
    ),
    requests: [...(options.pendingRequests ?? [])],
    hasUnreadTurn: options.hasUnreadTurn ?? false,
    hydrationContext: options.hydrationContext ?? null,
  };
}

const CODEX_RESPONSE_ANNOTATIONS_HEADING = "# Response annotations:";
const CODEX_RESPONSE_ANNOTATIONS_OPEN = "<response-annotations>";
const CODEX_RESPONSE_ANNOTATIONS_CLOSE = "</response-annotations>";
const CODEX_FILES_MENTIONED_HEADING = "# Files mentioned by the user:";
const CODEX_USER_REQUEST_HEADING = "## My request for Codex:";

function normalizeCodexHydratedAttachmentPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isAbsoluteCodexHydratedAttachmentPath(value: string): boolean {
  return (
    (value.startsWith("/") && !value.startsWith("//")) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\[^\\]+\\[^\\]+/.test(value) ||
    /^\/\/[^/]+\/[^/]+/.test(value)
  );
}

function extractCodexHydratedContext(text: string): string | null {
  const annotationsPrefix = `\n${CODEX_RESPONSE_ANNOTATIONS_HEADING}\n`;
  let contextStart = 0;

  if (text.startsWith(annotationsPrefix)) {
    const annotationsOpen = `\n${CODEX_RESPONSE_ANNOTATIONS_OPEN}\n`;
    const openIndex = text.indexOf(annotationsOpen, annotationsPrefix.length);
    if (openIndex !== -1) {
      const annotationsClose = `\n${CODEX_RESPONSE_ANNOTATIONS_CLOSE}\n`;
      const closeIndex = text.indexOf(annotationsClose, openIndex + annotationsOpen.length);
      if (closeIndex !== -1) {
        contextStart = closeIndex + annotationsClose.length;
      }
    }
  }

  const requestIndex = text.indexOf(CODEX_USER_REQUEST_HEADING, contextStart);
  return requestIndex === -1 ? null : text.slice(contextStart, requestIndex);
}

function parseCodexHydratedAttachmentLine(value: string): CodexCanonicalHydratedAttachment | null {
  const heading = value.match(/^##\s+(.+)$/)?.[1];
  if (!heading) return null;

  let separatorIndex = heading.lastIndexOf(": ");
  while (separatorIndex > 0) {
    const label = heading.slice(0, separatorIndex).trim();
    const attachmentPath = heading
      .slice(separatorIndex + 2)
      .trim()
      .replace(/\s+\((?:lines\s+\d+-\d+|line\s+\d+)\)\s*$/, "");
    const normalizedPath = normalizeCodexHydratedAttachmentPath(attachmentPath);
    if (label && isAbsoluteCodexHydratedAttachmentPath(normalizedPath)) {
      return {
        label,
        path: attachmentPath,
        fsPath: attachmentPath,
      };
    }
    separatorIndex = heading.lastIndexOf(": ", separatorIndex - 1);
  }

  return null;
}

/** Exact hydrated `d$`: recover file attachments encoded in generated user text. */
export function extractCodexCanonicalHydratedAttachments(
  input: readonly UserInput[],
): CodexCanonicalHydratedAttachment[] {
  const text = input.flatMap((entry) => (entry.type === "text" ? [entry.text] : [])).join("\n");
  const context = extractCodexHydratedContext(text);
  if (context === null) return [];
  const filesIndex = context.indexOf(CODEX_FILES_MENTIONED_HEADING);
  if (filesIndex === -1) return [];

  const attachments: CodexCanonicalHydratedAttachment[] = [];
  const lines = context.slice(filesIndex + CODEX_FILES_MENTIONED_HEADING.length).split("\n");
  for (const line of lines) {
    const candidate = line.trimStart();
    if (!candidate) continue;
    const attachment = parseCodexHydratedAttachmentLine(candidate);
    if (!attachment) break;
    attachments.push(attachment);
  }
  return attachments;
}

/** Exact hydrated `h$`: complete caller context plus ordered raw turn items. */
export function createCodexCanonicalHydratedConversationState(
  thread: Thread,
  options: CreateCodexCanonicalHydratedConversationStateOptions,
): CodexCanonicalConversationState {
  assertCompleteCodexCanonicalHydrationOptions(options);
  const { turns } = thread;
  const currentPermissions = {
    activePermissionProfile: options.activePermissionProfile,
    runtimeWorkspaceRoots: [...options.runtimeWorkspaceRoots],
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    sandboxPolicy: options.sandboxPolicy,
  } satisfies CodexCanonicalHydratedPermissionContext;
  const hydratedTurns = hydrateCodexCanonicalTurns(thread.id, turns, options);
  const environmentSelection = mergeCodexThreadEnvironmentSelection(
    thread,
    null,
    options.environmentSource ?? "stored",
  );

  return {
    ...createCodexCanonicalConversationMetadata(thread, options.hostId),
    ...environmentSelection,
    ...(options.workspaceKind === undefined ? {} : { workspaceKind: options.workspaceKind }),
    ...(options.workspaceBrowserRoot === undefined
      ? {}
      : { workspaceBrowserRoot: options.workspaceBrowserRoot }),
    previousTurnModel: null,
    latestTokenUsageInfo: null,
    turns: hydratedTurns,
    currentPermissions,
    requests: [...(options.pendingRequests ?? [])],
    hasUnreadTurn: options.hasUnreadTurn ?? false,
    hydrationContext: {
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      latestModel: options.model,
      latestReasoningEffort: options.reasoningEffort,
      cwd: options.cwd,
      latestThreadSettings: options.latestThreadSettings
        ? {
            ...options.latestThreadSettings,
            serviceTier: normalizeCodexServiceTier(options.latestThreadSettings.serviceTier),
          }
        : null,
    },
  };
}

export function hydrateCodexCanonicalTurns(
  threadId: string,
  turns: readonly Turn[],
  options: CreateCodexCanonicalHydratedConversationStateOptions,
): CodexCanonicalTurnState[] {
  const hydratedTurns = turns.map((turn) => {
    const pagination = options.turnItemsPaginationById?.[turn.id];
    const firstItem = turn.items.find((item) => item.type !== "contextCompaction");
    const hasOpeningItem =
      pagination?.hasLoadedOldest !== false && firstItem?.type === "userMessage";
    const openingInput = pagination?.oldestUserInput;
    const input: UserInput[] = Array.isArray(openingInput)
      ? openingInput
      : hasOpeningItem
        ? firstItem.content
        : [];
    const common = {
      threadId: threadId,
      input,
      clientUserMessageId:
        pagination?.oldestUserInput == null && hasOpeningItem
          ? firstItem.clientId
          : pagination?.openingUserMessageClientId,
      approvalPolicy: options.approvalPolicy,
      approvalsReviewer: options.approvalsReviewer,
      model: options.model,
      cwd: options.cwd || null,
      attachments: extractCodexCanonicalHydratedAttachments(input),
      effort: options.reasoningEffort,
      serviceTier: normalizeCodexServiceTier(options.latestThreadSettings?.serviceTier),
      summary: "none" as const,
      personality: null,
      outputSchema: null,
      collaborationMode: null,
    };

    const params: CodexCanonicalTurnParams<CodexCanonicalHydratedAttachment> =
      options.activePermissionProfile === null
        ? {
            ...common,
            sandboxPolicy: options.sandboxPolicy,
          }
        : {
            ...common,
            permissions: options.activePermissionProfile.id,
            runtimeWorkspaceRoots: [...options.runtimeWorkspaceRoots],
          };
    return {
      ...createCodexCanonicalTurnState(turn, params),
      permissionParamsSource: "inferred" as const,
      ...(pagination ? { itemsPagination: pagination } : {}),
    };
  });
  return hydratedTurns;
}

/**
 * Internal lookup key only. Protocol responses and resolution events must keep
 * using the original RequestId value.
 */
export function buildCodexCanonicalRequestIdentityKey(id: RequestId): string {
  return `${typeof id}:${id}`;
}

export function isCodexCanonicalProtocolItem(item: unknown): item is CodexCanonicalGeneratedItem {
  return isCodexProtocolThreadItem(item);
}
