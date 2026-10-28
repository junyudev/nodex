import type { OrchestrationV2HistoricalMessage } from "@t3tools/contracts";
import {
  ChatAttachment,
  CheckpointId,
  MessageId,
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2MessageDeliveryReceipt,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderSession,
  OrchestrationV2PlanArtifact,
  type OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderInstanceId,
  PositiveInt,
  ProviderUserInputAnswers,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeMode,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type {
  ProviderSelectionTransitionInput,
  ProviderSelectionTransitionPlan,
} from "./selectionTransition.ts";

export const ProviderAdapterV2RuntimePolicy = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  cwd: Schema.NullOr(Schema.String),

  reasoningEffort: Schema.optional(Schema.String),
});
export type ProviderAdapterV2RuntimePolicy = typeof ProviderAdapterV2RuntimePolicy.Type;

export const ProviderAdapterV2TurnMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdBy: OrchestrationV2ConversationMessage.fields.createdBy,
  creationSource: OrchestrationV2ConversationMessage.fields.creationSource,
  scheduledTaskId: OrchestrationV2ConversationMessage.fields.scheduledTaskId,
  senderThreadId: OrchestrationV2ConversationMessage.fields.senderThreadId,
});
export type ProviderAdapterV2TurnMessage = typeof ProviderAdapterV2TurnMessage.Type;

export const ProviderAdapterV2SessionStatus = Schema.Literals([
  "starting",
  "ready",
  "running",
  "waiting",
  "stopped",
  "error",
]);
export type ProviderAdapterV2SessionStatus = typeof ProviderAdapterV2SessionStatus.Type;

export const ProviderAdapterV2Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("app_thread.created"),
    driver: ProviderDriverKind,
    appThread: OrchestrationV2AppThread,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_session.updated"),
    driver: ProviderDriverKind,
    providerSession: OrchestrationV2ProviderSession,
  }),
  Schema.Struct({
    type: Schema.Literal("provider_thread.updated"),
    driver: ProviderDriverKind,
    providerThread: OrchestrationV2ProviderThread,
    /**
     * Set when the provider rewound its own conversation outside T3, for
     * example a Pi extension moving the session-tree leaf back. Lists every
     * native turn id still on the active branch; the ingestor rolls back
     * earlier runs whose turns fell off it.
     */
    retainedNativeTurnIds: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("provider_turn.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    providerTurn: OrchestrationV2ProviderTurn,
  }),
  Schema.Struct({
    type: Schema.Literal("node.updated"),
    driver: ProviderDriverKind,
    node: OrchestrationV2ExecutionNode,
  }),
  Schema.Struct({
    type: Schema.Literal("subagent.updated"),
    driver: ProviderDriverKind,
    subagent: OrchestrationV2Subagent,
  }),
  Schema.Struct({
    type: Schema.Literal("message.updated"),
    driver: ProviderDriverKind,
    message: OrchestrationV2ConversationMessage,
  }),
  Schema.Struct({
    type: Schema.Literal("message.delivery.updated"),
    driver: ProviderDriverKind,
    threadId: ThreadId,
    ...OrchestrationV2MessageDeliveryReceipt.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("turn_item.updated"),
    driver: ProviderDriverKind,
    turnItem: OrchestrationV2TurnItem,
  }),
  Schema.Struct({
    type: Schema.Literal("runtime_request.updated"),
    driver: ProviderDriverKind,
    threadId: Schema.optional(ThreadId),
    runtimeRequest: OrchestrationV2RuntimeRequest,
  }),
  Schema.Struct({
    type: Schema.Literal("plan.updated"),
    driver: ProviderDriverKind,
    plan: OrchestrationV2PlanArtifact,
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    status: Schema.Literals(["completed", "interrupted", "cancelled"]),
    failure: Schema.Null,
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.terminal"),
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    runOrdinal: PositiveInt,
    failureItemOrdinal: PositiveInt,
    status: Schema.Literal("failed"),
    failure: OrchestrationV2ProviderFailure,
    retry: Schema.optional(OrchestrationV2ProviderRetry),
    retryStartedAt: Schema.optional(Schema.DateTimeUtc),
    threadDisposition: Schema.Literals(["reusable", "broken"]),
  }),
]);
export type ProviderAdapterV2Event = typeof ProviderAdapterV2Event.Type;

export class ProviderAdapterCapabilitiesError extends Schema.TaggedError<ProviderAdapterCapabilitiesError>()(
  "ProviderAdapterCapabilitiesError",
  {
    driver: ProviderDriverKind,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider capabilities.`;
  }
}

export class ProviderAdapterOpenSessionError extends Schema.TaggedError<ProviderAdapterOpenSessionError>()(
  "ProviderAdapterOpenSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    /** False when another startup attempt cannot recover the captured native session. */
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterCloseSessionError extends Schema.TaggedError<ProviderAdapterCloseSessionError>()(
  "ProviderAdapterCloseSessionError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close ${this.driver} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderAdapterResumeThreadError extends Schema.TaggedError<ProviderAdapterResumeThreadError>()(
  "ProviderAdapterResumeThreadError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    providerThreadId: ProviderThreadId,
    /** False when another startup attempt cannot recover the captured native session. */
    retryable: Schema.optional(Schema.Boolean),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to resume ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterEnsureThreadError extends Schema.TaggedError<ProviderAdapterEnsureThreadError>()(
  "ProviderAdapterEnsureThreadError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to ensure ${this.driver} provider thread for app thread ${this.threadId}.`;
  }
}

export class ProviderAdapterReadThreadSnapshotError extends Schema.TaggedError<ProviderAdapterReadThreadSnapshotError>()(
  "ProviderAdapterReadThreadSnapshotError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read ${this.driver} provider thread snapshot ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterRollbackThreadError extends Schema.TaggedError<ProviderAdapterRollbackThreadError>()(
  "ProviderAdapterRollbackThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    checkpointId: Schema.optional(CheckpointId),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to roll back ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterForkThreadError extends Schema.TaggedError<ProviderAdapterForkThreadError>()(
  "ProviderAdapterForkThreadError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to fork ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterTurnStartError extends Schema.TaggedError<ProviderAdapterTurnStartError>()(
  "ProviderAdapterTurnStartError",
  {
    driver: ProviderDriverKind,
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to start run ${this.runId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterSteerRunUnsupportedError extends Schema.TaggedError<ProviderAdapterSteerRunUnsupportedError>()(
  "ProviderAdapterSteerRunUnsupportedError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
  },
) {
  override get message(): string {
    return `${this.driver} provider thread ${this.providerThreadId} does not support active-run steering.`;
  }
}

export class ProviderAdapterSteerRunError extends Schema.TaggedError<ProviderAdapterSteerRunError>()(
  "ProviderAdapterSteerRunError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    /** Unknown delivery must never be resent as another Turn. */
    delivery: Schema.optional(Schema.Literals(["not_dispatched", "rejected", "unknown"])),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to steer active run ${this.providerTurnId} on ${this.driver} provider thread ${this.providerThreadId}.`;
  }
}

export class ProviderAdapterInterruptError extends Schema.TaggedError<ProviderAdapterInterruptError>()(
  "ProviderAdapterInterruptError",
  {
    driver: ProviderDriverKind,
    providerThreadId: ProviderThreadId,
    providerTurnId: ProviderTurnId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to interrupt ${this.driver} provider turn ${this.providerTurnId}.`;
  }
}

export class ProviderAdapterRuntimeRequestResponseError extends Schema.TaggedError<ProviderAdapterRuntimeRequestResponseError>()(
  "ProviderAdapterRuntimeRequestResponseError",
  {
    driver: ProviderDriverKind,
    requestId: RuntimeRequestId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to respond to ${this.driver} runtime request ${this.requestId}.`;
  }
}

export class ProviderAdapterEventStreamError extends Schema.TaggedError<ProviderAdapterEventStreamError>()(
  "ProviderAdapterEventStreamError",
  {
    driver: ProviderDriverKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed while streaming ${this.driver} provider session ${this.providerSessionId} events.`;
  }
}

export class ProviderAdapterProtocolError extends Schema.TaggedError<ProviderAdapterProtocolError>()(
  "ProviderAdapterProtocolError",
  {
    driver: ProviderDriverKind,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
    payload: Schema.optional(Schema.Unknown),
  },
) {
  override get message(): string {
    return `${this.driver} provider protocol error: ${this.detail}.`;
  }
}

export const ProviderAdapterV2Error = Schema.Union([
  ProviderAdapterCapabilitiesError,
  ProviderAdapterOpenSessionError,
  ProviderAdapterCloseSessionError,
  ProviderAdapterResumeThreadError,
  ProviderAdapterEnsureThreadError,
  ProviderAdapterReadThreadSnapshotError,
  ProviderAdapterRollbackThreadError,
  ProviderAdapterForkThreadError,
  ProviderAdapterTurnStartError,
  ProviderAdapterSteerRunUnsupportedError,
  ProviderAdapterSteerRunError,
  ProviderAdapterInterruptError,
  ProviderAdapterRuntimeRequestResponseError,
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
]);
export type ProviderAdapterV2Error = typeof ProviderAdapterV2Error.Type;

export interface ProviderAdapterV2OpenSessionInput {
  readonly threadId: ThreadId;
  readonly providerSessionId: ProviderSessionId;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly resumeFromSession?: OrchestrationV2ProviderSession;
  /** Native thread to activate while an eager adapter opens its provider process. */
  readonly initialNativeThreadId?: string;
  /** Preserves provider item identity across eager activation of a persisted thread. */
  readonly initialProviderItemIdentityVersion?: 2;
}

export interface ProviderAdapterV2EnsureThreadInput {
  readonly threadId: ThreadId;
  /** Temporary conversations may not enter the provider's ordinary saved history. */
  readonly ephemeral?: boolean;
  /** The app thread's title, for providers that name their native sessions. */
  readonly title?: string;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  readonly providerSessionId?: ProviderSessionId;
  readonly existingProviderThread?: OrchestrationV2ProviderThread;
}

export interface ProviderAdapterV2TurnInput {
  readonly nativeInput?: import("@t3tools/contracts").OrchestrationV2Run["nativeInput"];
  readonly hostExecutionIdentity?: import("./ExecutionHost.ts").HostTurnIdentity;
  /** Trusted execution-host context supplied after Turn admission. */
  readonly hostInstructions?: string;
  /** Current Project Sources supplied by the host for this admitted Turn. */
  readonly hostSourceRoots?: readonly string[];
  readonly hostOrchestrationInstructions?: string;
  readonly appThread: OrchestrationV2AppThread;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly runOrdinal: number;
  /** Whether the current native session has an accepted turn; omitted when unknown. */
  readonly nativeThreadHasTurns?: boolean;
  readonly providerTurnOrdinal: number;
  readonly restartContinuationOfRunId?: RunId;
  readonly attemptId: RunAttemptId;
  readonly rootNodeId: NodeId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly message: ProviderAdapterV2TurnMessage;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
  /**
   * What the thread's MCP Apps want the agent to know (`ui/update-model-context`),
   * latest per app, keyed stably per app. Adapters that host apps deliver it as
   * application context; others never receive any.
   */
  readonly appContext?: ReadonlyArray<{ readonly key: string; readonly text: string }>;
}

export interface ProviderAdapterV2SteerInput {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly message: ProviderAdapterV2TurnMessage;
}

export interface ProviderAdapterV2InterruptInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  /** When true, the next `startTurn` may respawn the provider runtime (Grok Stop recovery). */
  readonly requestRuntimeRestart?: boolean;
  /** Workspace retirement requires native terminal evidence and preserves failed-stop handles. */
  readonly requireTerminalAcknowledgement?: true;
}

export interface ProviderAdapterV2RuntimeRequestResponseInput {
  readonly requestId: RuntimeRequestId;
  readonly decision?: ProviderApprovalDecision;
  readonly answers?: ProviderUserInputAnswers;
  readonly response?: unknown;
}

export interface ProviderAdapterV2ThreadSnapshot {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runtimeRequests: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly providerPayload?: unknown;
}

export interface ProviderAdapterV2ReadThreadSnapshotInput {
  readonly providerThread: OrchestrationV2ProviderThread;
}

export type ProviderAdapterV2RollbackTarget =
  | {
      readonly type: "thread_start";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: 0;
    }
  | {
      readonly type: "provider_turn";
      readonly checkpointId: CheckpointId;
      readonly appRunOrdinal: number;
      readonly providerTurn: OrchestrationV2ProviderTurn;
    };

export interface ProviderAdapterV2RollbackThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly target: ProviderAdapterV2RollbackTarget;
  readonly providerThreadTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}

export interface ProviderAdapterV2ForkThreadInput {
  readonly ephemeral?: boolean;
  readonly sourceProviderThread: OrchestrationV2ProviderThread;
  readonly sourceProviderTurns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  /** Exact persisted terminal-turn count beyond the captured source boundary. */
  readonly sourceRollbackTurnCount?: number;
  /** Reads only the next retained native turn and any unsafe boundary evidence. */
  readonly loadSourceFollowingTurns?: (input: {
    readonly nativeTurnIds: ReadonlyArray<string>;
    readonly promptPrefix: string;
    readonly continuationMarker: string;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ProviderTurn>, ProviderAdapterV2Error>;
  readonly providerTurnId?: ProviderTurnId;
  readonly targetThreadId: ThreadId;
  readonly ownerNodeId?: NodeId;
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}

/** Disposes only a verified temporary conversation after its execution has stopped. */
export interface ProviderAdapterV2DiscardThreadInput {
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
}

export interface ProviderAdapterV2EventSubscription {
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  readonly close: Effect.Effect<void>;
}

export interface ProviderAdapterV2HistoricalContext {
  readonly messages: ReadonlyArray<OrchestrationV2HistoricalMessage>;
  readonly context: string;
}

/** An MCP tool as the provider's MCP client lists it. */
export interface ProviderAdapterV2McpTool {
  readonly name: string;
  readonly _meta?: unknown;
  readonly annotations?: unknown;
}

/** MCP `CallToolResult` / `ReadResourceResult` shapes, passed through unchanged. */
export interface ProviderAdapterV2McpCallToolResult {
  readonly content: ReadonlyArray<unknown>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
  readonly _meta?: unknown;
}

export interface ProviderAdapterV2McpApps {
  readonly listTools: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
  }) => Effect.Effect<ReadonlyArray<ProviderAdapterV2McpTool>, ProviderAdapterV2Error>;
  readonly callTool: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly tool: string;
    readonly arguments: Record<string, unknown>;
  }) => Effect.Effect<ProviderAdapterV2McpCallToolResult, ProviderAdapterV2Error>;
  readonly readResource: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly server: string;
    readonly uri: string;
  }) => Effect.Effect<{ readonly contents: ReadonlyArray<unknown> }, ProviderAdapterV2Error>;
}

export interface ProviderAdapterV2SessionRuntime {
  readonly codexNative?: import("./nativeInteraction.ts").CodexNativeInteraction;
  /** Manager-observed incarnation of this native session within the daemon. */
  readonly nativeGeneration?: number;
  /** A native cancellation ended this incarnation; the manager must retire its credentials and scope. */
  readonly nativeSessionRetired?: Effect.Effect<boolean>;
  /** An unavailable captured session must fail instead of silently replacing its native identity. */
  readonly nativeResumeFailurePolicy?: "fail" | "portable-context";
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly providerSessionId: ProviderSessionId;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly events: Stream.Stream<ProviderAdapterV2Event, ProviderAdapterV2Error>;
  /**
   * Manager-owned runtimes expose a synchronous subscription so concurrent
   * provider threads receive independent copies of the process event stream.
   * Adapter runtimes may omit this and expose only their single-consumer event stream.
   */
  readonly subscribeEvents?: Effect.Effect<ProviderAdapterV2EventSubscription>;
  /**
   * Adapters whose native runtime can hold pending work outside an active
   * turn (for example Claude background tasks and their wake turns) report it
   * here so the session manager defers idle release while it is pending.
   */
  readonly hasPendingBackgroundWork?: Effect.Effect<boolean>;
  /**
   * Per-provider-thread pending work for root-run ingestion stop gates. When
   * present, RunExecutionService uses only this probe (never the session-wide
   * hasPendingBackgroundWork) so sibling native threads cannot pin an
   * unrelated root subscription open.
   */
  readonly hasPendingBackgroundWorkForThread?: (
    providerThread: Pick<OrchestrationV2ProviderThread, "id" | "nativeThreadRef">,
  ) => Effect.Effect<boolean>;
  /**
   * Capacity for the requested model/options, independent of native thread usage.
   * `cwd` is the thread's working directory, for providers whose project config
   * can change a model's limits.
   */
  readonly getModelContextWindow?: (
    modelSelection: ModelSelection,
    cwd?: string | null,
  ) => number | undefined;
  /** Whether an option-only change preserves measured native usage and capacity.
   * Compaction thresholds are still discarded. Unknown transitions invalidate usage.
   */
  readonly canReuseContextUsage?: (previous: ModelSelection, next: ModelSelection) => boolean;
  readonly ensureThread: (
    input: ProviderAdapterV2EnsureThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  readonly resumeThread: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly pendingDeliveryMessageIds?: ReadonlyArray<MessageId>;
    readonly threadId?: ThreadId;
    readonly modelSelection?: ModelSelection;
    readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
  }) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
  /** False means the native protocol explicitly does not support history injection. */
  readonly injectHistory?: (
    input: ProviderAdapterV2HistoricalContext & {
      readonly providerThread: OrchestrationV2ProviderThread;
    },
  ) => Effect.Effect<boolean, ProviderAdapterV2Error>;
  readonly startTurn: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly compactThread?: (
    input: ProviderAdapterV2TurnInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly steerTurn: (
    input: ProviderAdapterV2SteerInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly stopTask?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly taskId: string;
    readonly kind?: OrchestrationV2PendingBackgroundTask["kind"];
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  /** Bounded native output tail; absence means this provider cannot read it. */
  readonly readTaskOutput?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly taskId: string;
  }) => Effect.Effect<
    { readonly text: string; readonly truncated: boolean; readonly totalBytes: number } | null,
    ProviderAdapterV2Error
  >;
  readonly interruptTurn: (
    input: ProviderAdapterV2InterruptInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  /** Stops one native child through its owning runtime; the owner keeps running. */
  readonly stopSubagent?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly nativeTaskId: string;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  /**
   * Lets a runtime shared by several app threads unload one provider thread's
   * native state (and its MCP servers) when that app thread detaches, while
   * the runtime keeps serving the others. A later resume reloads it.
   */
  readonly unloadThread?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
  }) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly respondToRuntimeRequest: (
    input: ProviderAdapterV2RuntimeRequestResponseInput,
  ) => Effect.Effect<void, ProviderAdapterV2Error>;
  readonly readThreadSnapshot: (
    input: ProviderAdapterV2ReadThreadSnapshotInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  /**
   * Providers that accept product feedback for a thread (#7949, Codex → OpenAI)
   * expose it here; absent means the driver has no feedback channel.
   */
  readonly uploadFeedback?: (input: {
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly reason?: string;
  }) => Effect.Effect<{ readonly feedbackId: string }, ProviderAdapterV2Error>;
  /**
   * MCP Apps host operations through the provider's own MCP client, for
   * drivers whose protocol exposes them (Codex). Absent means apps from this
   * provider are not interactive and their tool calls stay plain tool rows.
   */
  readonly mcpApps?: ProviderAdapterV2McpApps;
  readonly rollbackThread: (
    input: ProviderAdapterV2RollbackThreadInput,
  ) => Effect.Effect<ProviderAdapterV2ThreadSnapshot, ProviderAdapterV2Error>;
  readonly forkThread: (
    input: ProviderAdapterV2ForkThreadInput,
  ) => Effect.Effect<OrchestrationV2ProviderThread, ProviderAdapterV2Error>;
}

export class ProviderAdapterV2 extends Context.Service<
  ProviderAdapterV2,
  {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly getCapabilities: () => Effect.Effect<
      OrchestrationV2ProviderCapabilities,
      ProviderAdapterV2Error
    >;
    readonly planSelectionTransition: (
      input: ProviderSelectionTransitionInput,
    ) => Effect.Effect<ProviderSelectionTransitionPlan, ProviderAdapterV2Error>;
    readonly discardThread?: (
      input: ProviderAdapterV2DiscardThreadInput,
    ) => Effect.Effect<void, ProviderAdapterV2Error>;
    readonly openSession: (
      input: ProviderAdapterV2OpenSessionInput,
    ) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderAdapterV2Error, Scope.Scope>;
  }
>()("@t3tools/provider-core/server/ProviderAdapter/ProviderAdapterV2") {}
