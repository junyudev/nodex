import type { Personality, RequestId, ServerRequest } from "@nodex/codex-app-server-protocol";
import type {
  ActivePermissionProfile,
  CodexErrorInfo,
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
  Turn,
  TurnPlanStep,
  TurnStartParams,
  ToolRequestUserInputOption,
  UserInput,
} from "@nodex/codex-app-server-protocol/v2";
import type { ThreadTokenUsage } from "@nodex/codex-app-server-protocol/v2/ThreadTokenUsage";
import { isCodexProtocolThreadItem } from "../codex-protocol-thread-item";
import type { CodexQueuedFollowUp } from "../codex-queued-follow-up-state";
import { normalizeCodexServiceTier } from "../codex-service-tier";
import type { CodexItemStatus } from "../types";
import type { CodexHistoryTurnItemsPagination } from "./codex-history-topology";
import { boundCodexReasoningParts } from "./codex-reasoning-parts";

export type CodexProtocolRequestId = RequestId;
export type CodexProtocolThreadItem = ThreadItem;
export type CodexProtocolThreadItemOf<TType extends ThreadItem["type"]> = Extract<
  ThreadItem,
  { type: TType }
>;
export type CodexProtocolServerRequest = ServerRequest;
export type CodexProtocolServerRequestOf<TMethod extends ServerRequest["method"]> = Extract<
  ServerRequest,
  { method: TMethod }
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
      readonly answers: Readonly<Record<string, { readonly answers: readonly string[] }>>;
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
  readonly queueRow: CodexQueuedFollowUp;
  readonly context: {
    readonly commentAttachments: readonly unknown[];
  };
}

/** Exact live steering row stored beside generated items until it is accepted. */
export interface CodexCanonicalSteeringUserMessageItem {
  readonly type: "steeringUserMessage";
  readonly id: string;
  readonly targetTurnId: string | null;
  readonly targetTurnStartedAtMs: number | null;
  readonly status: "pending" | "accepted";
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
  { type: "contextCompaction" }
> & {
  readonly completed?: boolean;
  readonly source?: "automatic" | "manual";
};

export type CodexCanonicalImageGenerationItem = Extract<ThreadItem, { type: "imageGeneration" }> & {
  readonly src: string | null;
};

export interface CodexCanonicalCollabReceiverThread {
  readonly threadId: string;
  readonly thread: Thread | null;
}

export type CodexCanonicalCollabAgentToolCallItem = Extract<
  ThreadItem,
  { type: "collabAgentToolCall" }
> & {
  readonly receiverThreads: readonly CodexCanonicalCollabReceiverThread[];
};

/** Generated items that require app-owned display enrichment after ingress. */
export type CodexCanonicalGeneratedItem =
  | Exclude<ThreadItem, { type: "imageGeneration" | "collabAgentToolCall" | "contextCompaction" }>
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

export type CodexCanonicalTurnProtocol = Omit<
  Turn,
  "id" | "items" | "startedAt" | "completedAt"
> & {
  /** Exact live state can carry one placeholder turn before app-server binding. */
  readonly id: Turn["id"] | null;
};
export type CodexCanonicalThreadProtocol = Omit<Thread, "turns">;

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
export interface CodexCanonicalTurnSidecar {
  readonly params: CodexCanonicalTurnParams;
  readonly diff: string | null;
  readonly turnStartedAtMs: number | null;
  /** Hydrated protocol completion time; distinct from first-final-assistant timing. */
  readonly completedAtMs?: number | null;
  readonly firstTurnWorkItemStartedAtMs?: number | null;
  readonly finalAssistantStartedAtMs: number | null;
  /** Explicit lifecycle for statusless protocol items such as reasoning. */
  readonly lifecycleStatusByItemId?: Readonly<Record<string, CodexItemStatus>>;
  readonly commandExecutionStartedAtMsById?: Readonly<Record<string, number>>;
  readonly interruptedCommandExecutionItemIds?: readonly string[];
  readonly hookRuns?: readonly CodexCanonicalHookRun[];
  readonly safetyBuffering?: CodexCanonicalSafetyBufferingState;
}

export interface CodexCanonicalTurnState {
  readonly protocol: CodexCanonicalTurnProtocol;
  readonly items: readonly CodexCanonicalItem[];
  readonly sidecar: CodexCanonicalTurnSidecar;
}

export interface CodexCanonicalConversationState {
  readonly protocol: CodexCanonicalThreadProtocol;
  readonly turns: readonly CodexCanonicalTurnState[];
  readonly requests: readonly CodexCanonicalServerRequest[];
  /** App-only conversation state; never inferred from the pending request list. */
  readonly sidecar: CodexCanonicalConversationSidecar;
}

/** Reconstructs the loaded generated-protocol Thread without app-only placeholder occurrences. */
export function projectCodexCanonicalProtocolThread(
  state: CodexCanonicalConversationState,
): Thread {
  return {
    ...state.protocol,
    turns: state.turns.flatMap((turn): Thread["turns"] => {
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

export interface CodexCanonicalConversationSidecar {
  readonly hasUnreadTurn: boolean;
  readonly hydrationContext: CodexCanonicalHydrationContext | null;
  readonly latestTokenUsageInfo?: ThreadTokenUsage | null;
  readonly latestThreadSettings?: ThreadSettings | null;
  readonly previousTurnModel?: string | null;
  readonly threadGoal?: ThreadGoal | null;
  readonly completedThreadGoal?: ThreadGoal | null;
  readonly threadGoalResumeConfirmation?: ThreadGoal | null;
}

export interface CodexCanonicalHydratedPermissionContext {
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots: readonly string[];
  readonly approvalPolicy: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
}

export interface CodexCanonicalHydrationContext {
  readonly model: string;
  readonly reasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly latestModel: string;
  readonly latestReasoningEffort: NonNullable<TurnStartParams["effort"]> | null;
  readonly cwd: string | null;
  readonly latestThreadSettings: CodexCanonicalHydratedThreadSettings | null;
  readonly currentPermissions: CodexCanonicalHydratedPermissionContext;
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
  readonly approvalPolicy: NonNullable<TurnStartParams["approvalPolicy"]>;
  readonly approvalsReviewer: NonNullable<TurnStartParams["approvalsReviewer"]>;
  readonly sandboxPolicy: NonNullable<TurnStartParams["sandboxPolicy"]>;
  readonly activePermissionProfile: ActivePermissionProfile | null;
  readonly runtimeWorkspaceRoots: NonNullable<TurnStartParams["runtimeWorkspaceRoots"]>;
  readonly latestThreadSettings?: CodexCanonicalHydratedThreadSettings | null;
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

  return value * 1_000;
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
  const { items, startedAt, completedAt, ...protocol } = turn;

  return {
    protocol,
    items: items.map((item) => materializeCodexCanonicalProtocolItem(item)),
    sidecar: {
      params,
      diff: null,
      turnStartedAtMs: protocolSecondsToMilliseconds(startedAt),
      completedAtMs: protocolSecondsToMilliseconds(completedAt),
      finalAssistantStartedAtMs: protocolSecondsToMilliseconds(completedAt),
      lifecycleStatusByItemId: buildCodexInitialItemLifecycleStatusById(items, protocol.status),
    },
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

function getCodexHeartbeatUserMessage(
  items: readonly CodexCanonicalItem[],
): Extract<ThreadItem, { type: "userMessage" }> | null {
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
  if (existingItems.length > incomingItems.length) {
    items = existingItems;
    for (let index = incomingItems.length - 1; index >= 0; index -= 1) {
      const incoming = incomingItems[index];
      if (incoming?.type !== "agentMessage" || incoming.phase !== "final_answer") {
        continue;
      }
      const existing = existingItems.find(
        (item): item is Extract<ThreadItem, { type: "agentMessage" }> =>
          item.type === "agentMessage" &&
          (item.id === incoming.id ||
            (item.phase === "final_answer" && item.text === incoming.text)),
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
        } satisfies Extract<ThreadItem, { type: "agentMessage" }>;
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
    turn.protocol.id === null &&
    turn.sidecar.turnStartedAtMs === null &&
    turn.protocol.status === "completed" &&
    turn.protocol.error === null &&
    turn.items.length === 0
  );
}

function isCodexCanonicalArchivedHeartbeatTurn(turn: CodexCanonicalTurnState): boolean {
  if (
    turn.protocol.status !== "completed" ||
    turn.protocol.error !== null ||
    hasCodexHeartbeatAutomationInput(turn.sidecar.params.input) ||
    getCodexHeartbeatUserMessage(turn.items) !== null
  ) {
    return false;
  }
  return turn.items.some(
    (item) => item.type === "agentMessage" && hasCodexHeartbeatDecision(item.text),
  );
}

/** Exact `oIe`: merge one matching hydrated/live turn without flattening raw items. */
export function mergeCodexCanonicalTurnState(
  existing: CodexCanonicalTurnState,
  incoming: CodexCanonicalTurnState,
): CodexCanonicalTurnState {
  return {
    ...incoming,
    protocol: {
      ...incoming.protocol,
      durationMs: existing.protocol.durationMs ?? incoming.protocol.durationMs,
    },
    items: mergeCodexCanonicalHydratedItems(existing.items, incoming.items),
    sidecar: {
      ...incoming.sidecar,
      params: mergeCodexCanonicalTurnParams(existing.sidecar.params, incoming.sidecar.params),
      hookRuns: existing.sidecar.hookRuns?.length
        ? existing.sidecar.hookRuns
        : incoming.sidecar.hookRuns,
      safetyBuffering: incoming.sidecar.safetyBuffering ?? existing.sidecar.safetyBuffering,
      diff: incoming.sidecar.diff ?? existing.sidecar.diff,
      interruptedCommandExecutionItemIds:
        incoming.sidecar.interruptedCommandExecutionItemIds ??
        existing.sidecar.interruptedCommandExecutionItemIds,
      commandExecutionStartedAtMsById:
        existing.sidecar.commandExecutionStartedAtMsById ??
        incoming.sidecar.commandExecutionStartedAtMsById,
      turnStartedAtMs: existing.sidecar.turnStartedAtMs ?? incoming.sidecar.turnStartedAtMs,
      completedAtMs: existing.sidecar.completedAtMs ?? incoming.sidecar.completedAtMs,
      finalAssistantStartedAtMs:
        existing.sidecar.finalAssistantStartedAtMs ?? incoming.sidecar.finalAssistantStartedAtMs,
      lifecycleStatusByItemId: mergeCodexLifecycleStatusByItemId(
        existing.sidecar.lifecycleStatusByItemId,
        incoming.sidecar.lifecycleStatusByItemId,
      ),
    },
  };
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
): CodexCanonicalTurnState[] {
  const existingIds = new Set(
    existingTurns.flatMap((turn) => (turn.protocol.id === null ? [] : [turn.protocol.id])),
  );
  const incomingById = new Map(
    incomingTurns.flatMap((turn) =>
      turn.protocol.id === null ? [] : [[turn.protocol.id, turn] as const],
    ),
  );
  const merged = existingTurns.flatMap((existing) => {
    if (isCodexCanonicalPlaceholderTurn(existing)) return [];
    if (existing.protocol.id === null) return [existing];
    const incoming = incomingById.get(existing.protocol.id);
    if (incoming) return [mergeCodexCanonicalTurnState(existing, incoming)];
    return isCodexCanonicalArchivedHeartbeatTurn(existing) ? [] : [existing];
  });
  let pendingIncoming: CodexCanonicalTurnState[] = [];

  for (const incoming of incomingTurns) {
    const incomingId = incoming.protocol.id;
    if (incomingId !== null && existingIds.has(incomingId)) {
      if (pendingIncoming.length === 0) continue;
      const existingIndex = merged.findIndex((turn) => turn.protocol.id === incomingId);
      if (existingIndex !== -1) {
        merged.splice(existingIndex, 0, ...pendingIncoming);
        pendingIncoming = [];
      }
      continue;
    }
    pendingIncoming.push(incoming);
  }

  merged.push(...pendingIncoming);
  return merged;
}

/** Exact `DB` duplicate-ID fold used when installing canonical tail history. */
export function canonicalizeCodexCanonicalTurnStates(
  turns: readonly CodexCanonicalTurnState[],
): CodexCanonicalTurnState[] {
  const canonical: CodexCanonicalTurnState[] = [];
  const indexByTurnId = new Map<string, number>();
  for (const turn of turns) {
    const turnId = turn.protocol.id;
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
    state.sidecar.latestThreadSettings ??
    state.sidecar.hydrationContext?.latestThreadSettings ??
    null;
  return {
    threadId: state.protocol.id,
    input: [],
    cwd: null,
    approvalPolicy:
      latestSettings?.approvalPolicy ??
      previousTurn?.sidecar.params.approvalPolicy ??
      defaults.approvalPolicy,
    approvalsReviewer:
      latestSettings?.approvalsReviewer ??
      previousTurn?.sidecar.params.approvalsReviewer ??
      defaults.approvalsReviewer,
    sandboxPolicy:
      latestSettings?.sandboxPolicy ??
      previousTurn?.sidecar.params.sandboxPolicy ??
      defaults.sandboxPolicy,
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
    protocol: {
      id: null,
      itemsView: "full",
      status: "completed",
      error: null,
      durationMs: null,
    },
    items: [item],
    sidecar: {
      params: buildCodexCanonicalSyntheticTurnParams(state, previousTurn),
      diff: null,
      turnStartedAtMs: null,
      firstTurnWorkItemStartedAtMs: null,
      finalAssistantStartedAtMs: null,
      hookRuns: [],
    },
  };
}

/** Exact `M4e`: dedupe an app-local item, reuse the active turn, or create one. */
export function appendCodexCanonicalInProgressSyntheticItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalLifecycleSyntheticItem,
  observedAtMs: number,
): CodexCanonicalConversationState {
  if (state.turns.some((turn) => turn.items.some((entry) => entry.id === item.id))) {
    return state;
  }

  const latestTurn = state.turns.at(-1) ?? null;
  if (latestTurn?.protocol.status === "inProgress") {
    return {
      ...state,
      turns: state.turns.map((turn) =>
        turn === latestTurn ? { ...turn, items: [...turn.items, item] } : turn,
      ),
    };
  }

  return {
    ...state,
    turns: [
      ...state.turns,
      {
        protocol: {
          id: null,
          itemsView: "full",
          status: "inProgress",
          error: null,
          durationMs: null,
        },
        items: [item],
        sidecar: {
          params: buildCodexCanonicalSyntheticTurnParams(state, latestTurn),
          diff: null,
          turnStartedAtMs: observedAtMs,
          firstTurnWorkItemStartedAtMs: null,
          finalAssistantStartedAtMs: null,
          hookRuns: [],
        },
      },
    ],
  };
}

/** Exact manual-compaction cancellation: remove its now-empty local placeholder turn. */
export function removeCodexCanonicalLocalSyntheticItem(
  state: CodexCanonicalConversationState,
  itemId: string,
): CodexCanonicalConversationState {
  let changed = false;
  const turns = state.turns.flatMap((turn): CodexCanonicalTurnState[] => {
    const items = turn.items.filter((item) => item.id !== itemId);
    if (items.length === turn.items.length) return [turn];
    changed = true;
    if (turn.protocol.id === null && turn.protocol.status === "inProgress" && items.length === 0)
      return [];
    return [{ ...turn, items }];
  });
  return changed ? { ...state, turns } : state;
}

/** Exact `F4e` / `C1` / `S1`: append fork provenance or create its null-id turn. */
export function appendCodexCanonicalForkedFromConversationItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalForkedFromConversationItem,
): CodexCanonicalConversationState {
  const latestTurn = state.turns.at(-1) ?? null;
  if (latestTurn) {
    return {
      ...state,
      turns: state.turns.map((turn) =>
        turn === latestTurn
          ? {
              ...turn,
              items: [...turn.items, item],
              sidecar: {
                ...turn.sidecar,
                hookRuns: turn.sidecar.hookRuns ?? [],
              },
            }
          : turn,
      ),
    };
  }

  return {
    ...state,
    turns: [createCodexCanonicalCompletedSyntheticTurn(state, item, null)],
  };
}

/** Exact `L4e`: append to the latest turn, or force the fork-only `new-turn`. */
export function appendCodexCanonicalWorktreeInitItem(
  state: CodexCanonicalConversationState,
  item: CodexCanonicalWorktreeInitItem,
  placement: "latest-turn" | "new-turn" = "latest-turn",
): CodexCanonicalConversationState {
  const previousTurn = state.turns.at(-1) ?? null;
  if (placement === "latest-turn" && previousTurn) {
    return {
      ...state,
      turns: state.turns.map((turn) =>
        turn === previousTurn
          ? {
              ...turn,
              items: [...turn.items, item],
              sidecar: {
                ...turn.sidecar,
                hookRuns: turn.sidecar.hookRuns ?? [],
              },
            }
          : turn,
      ),
    };
  }

  return {
    ...state,
    turns: [...state.turns, createCodexCanonicalCompletedSyntheticTurn(state, item, previousTurn)],
  };
}

function canonicalizeCodexCanonicalTurnIds(
  turns: readonly CodexCanonicalTurnState[],
): CodexCanonicalTurnState[] {
  const canonical: CodexCanonicalTurnState[] = [];
  const indexByTurnId = new Map<string, number>();
  for (const turn of turns) {
    const turnId = turn.protocol.id;
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
      : input.currentTurns.findIndex((turn) => turn.protocol.id === input.oldestLoadedTurnId);
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
    sidecar: {
      ...turn.sidecar,
      params: {
        ...turn.sidecar.params,
        approvalPolicy: overlay.approvalPolicy,
        approvalsReviewer: overlay.approvalsReviewer,
        sandboxPolicy: overlay.sandboxPolicy,
        model: overlay.model,
        cwd: overlay.cwd,
        effort: overlay.effort,
      } as CodexCanonicalTurnParams,
    },
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
  const { turns, ...protocol } = thread;

  return {
    protocol,
    turns: turns.map((turn) =>
      createCodexCanonicalTurnState(turn, getRequiredTurnParams(turn.id, options.turnParamsById)),
    ),
    requests: [...(options.pendingRequests ?? [])],
    sidecar: {
      hasUnreadTurn: options.hasUnreadTurn ?? false,
      hydrationContext: options.hydrationContext ?? null,
    },
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
  const partialTurnWithoutPagination = thread.turns.find(
    (turn) => turn.itemsView !== "full" && options.turnItemsPaginationById?.[turn.id] === undefined,
  );
  if (partialTurnWithoutPagination) {
    throw new Error(
      `Cannot hydrate partial turn '${partialTurnWithoutPagination.id}' without item pagination`,
    );
  }
  const { turns, ...protocol } = thread;
  const currentPermissions = {
    activePermissionProfile: options.activePermissionProfile,
    runtimeWorkspaceRoots: [...options.runtimeWorkspaceRoots],
    approvalPolicy: options.approvalPolicy,
    approvalsReviewer: options.approvalsReviewer,
    sandboxPolicy: options.sandboxPolicy,
  } satisfies CodexCanonicalHydratedPermissionContext;
  const hydratedTurns = turns.map((turn) => {
    const firstItem = turn.items[0];
    const input: UserInput[] =
      firstItem?.type === "userMessage"
        ? firstItem.content
        : [...(options.turnItemsPaginationById?.[turn.id]?.oldestUserInput ?? [])];
    const common = {
      threadId: thread.id,
      input,
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
    return createCodexCanonicalTurnState(turn, params);
  });

  return {
    protocol,
    turns: hydratedTurns,
    requests: [...(options.pendingRequests ?? [])],
    sidecar: {
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
        currentPermissions,
      },
    },
  };
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
