import { OrchestrationV2SideChatCapture } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { providerThreadActivatesThread } from "@t3tools/provider-core/contextUsage";
import {
  MAX_PENDING_MESSAGE_DELIVERIES,
  PENDING_MESSAGE_DELIVERY_PREDICATE,
} from "./MessageDelivery.ts";
import { projectTurnItemForWire, projectThreadProjectionForWire } from "./WireProjection.ts";
import {
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
} from "./RestartBackgroundNote.ts";
import { retainPublicThreadControlClosure } from "./PublicThreadProjection.ts";
import * as Stream from "effect/Stream";
import { makeThreadFind, findProjectedThreadItems } from "./ThreadFind.ts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
} from "@t3tools/contracts";
import {
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import type {
  OrchestrationV2AppThread,
  ModelSelection,
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  PlanId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
} from "@t3tools/contracts";
import {
  hasImportedThreadHistory,
  ChatImageAttachment,
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2HistoricalMessage as OrchestrationV2HistoricalMessageSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  orchestrationV2RunWorkStartedAt,
  isOrchestrationV2WorkActive,
  RunId,
  ProviderSessionId,
  ProviderThreadId,
  MessageId,
  RuntimeRequestId,
  CheckpointScopeId,
  CheckpointId,
  ThreadId,
  TurnItemId,
  NodeId,
} from "@t3tools/contracts";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2SupersededInterrupt,
  isRunVisibleAtHistoryRevision,
} from "@t3tools/shared/orchestrationV2Timeline";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import {
  attachmentTokenAllowance,
  CONVERSATION_SUMMARY_CHAR_CAP,
  CONVERSATION_SUMMARY_HEADER,
  handoffCoverage,
  historicalMessage,
  HISTORY_IMAGE_CONTEXT,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import {
  OPEN_DELIVERY_RUN_PREDICATE,
  recoveryCandidateThreadIds,
} from "./ProjectionRecoveryQueries.ts";
import {
  isThreadHistoryUserTurn,
  isConversationHistoryItem,
  isThreadHistoryTurnStart,
  decodeThreadHistoryCursor,
  THREAD_HISTORY_MAX_RAW_TURNS,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  OLDER_THREAD_USER_TURN_LIMIT,
} from "./threadHistoryPaging.ts";
import {
  THREAD_PROMPT_INDEX_PROMPT_CHARACTERS,
  THREAD_PROMPT_INDEX_RESPONSE_CHARACTERS,
  boundThreadPromptText,
  selectThreadPromptIndexSlots,
  type ThreadPromptIndex,
} from "./threadPromptIndex.ts";

export class ProjectionStoreApplyEventError extends Schema.TaggedError<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreSetupError extends Schema.TaggedError<ProjectionStoreSetupError>()(
  "ProjectionStoreSetupError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to initialize orchestration projection store.";
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreProjectReadError extends Schema.TaggedError<ProjectionStoreProjectReadError>()(
  "ProjectionStoreProjectReadError",
  { projectId: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreSetupError,
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreReadError,
  ProjectionStoreProjectReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export type ProjectionRecoveryKind =
  | "queued-runs"
  | "runtime"
  | "subagent-results"
  | "delegated-completions";

/** Persisted state needed for limit recovery, without transcript or fork history. */
export type ProjectionLimitRecoveryCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "usageLimitResetAt"
  | "archivedAt"
  | "settledOverride"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
  | "snoozedUntil"
>;

/** The thread fields pull request sync reads, for a thread with at least one link. */
export type ProjectionThreadPullRequests = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pullRequests"
>;

/**
 * Thread activity needed by settlement, without transcript or fork history.
 * Settlement always loads `latestUserAuthoredMessageAt`, so it is required here.
 */
export type ProjectionSettlementCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "branch"
  | "worktreePath"
  | "pullRequests"
  | "linkedPullRequest"
  | "branchPullRequest"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "status"
  | "activityRunStartedAt"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
> &
  Pick<OrchestrationV2AppThread, "lastSnoozeWakeAt"> & {
    readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  };

const ProjectionCheckpointContext = Schema.Struct({
  runs: Schema.Array(
    OrchestrationV2RunJsonSchema.mapFields(({ id, ordinal, status }) => ({ id, ordinal, status })),
  ),
  checkpointScopes: Schema.Array(
    OrchestrationV2CheckpointScopeJsonSchema.mapFields(({ id, runId, kind, cwd }) => ({
      id,
      runId,
      kind,
      cwd,
    })),
  ),
  checkpoints: Schema.Array(
    OrchestrationV2CheckpointJsonSchema.mapFields(
      ({ id, scopeId, runId, ordinalWithinScope, appRunOrdinal, status, ref }) => ({
        id,
        scopeId,
        runId,
        ordinalWithinScope,
        appRunOrdinal,
        status,
        ref,
      }),
    ),
  ),
});
export type ProjectionCheckpointContext = typeof ProjectionCheckpointContext.Type;
const decodeCheckpointContext = Schema.decodeUnknownEffect(ProjectionCheckpointContext);

export type ProjectionBaselineCheckpoint = Pick<
  OrchestrationV2Checkpoint,
  "ordinalWithinScope" | "status" | "runId" | "appRunOrdinal" | "nodeId" | "parentCheckpointId"
>;

/** Durable capture targets, without transcript or checkpoint file payloads. */
export interface ProjectionCheckpointCaptureContext {
  readonly run: OrchestrationV2Run | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  /** Checkpoint metadata at the thread start and the previous Run's ordinal, the only baselines. */
  readonly baselineCheckpoints: ReadonlyArray<ProjectionBaselineCheckpoint>;
}

/** Exact durable targets used by interrupt, restart, and steering effects. */
export interface ProjectionProviderControlContext {
  readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
  readonly attempt: OrchestrationV2ThreadProjection["attempts"][number] | undefined;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  readonly run: OrchestrationV2Run | undefined;
}

export interface ProjectionProviderControlTarget {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId?: RunAttemptId;
  readonly messageId?: MessageId;
}

export interface ProjectionExecutionRetirementContext {
  readonly thread: OrchestrationV2AppThread;
  readonly run: OrchestrationV2Run | undefined;
  readonly attempt: OrchestrationV2RunAttempt | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly cohortParentRunId: RunId;
  readonly deliveryRunId: RunId | null;
  readonly hasProviderBinding: boolean;
  readonly isRetirementTarget: boolean;
}

export type ProjectionRuntimeRecoveryState = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "attempts"
  | "nodes"
  | "subagents"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "messages"
  | "turnItems"
>;

export type ProjectionHostProviderThread = Pick<
  OrchestrationV2ProviderThread,
  "id" | "providerSessionId" | "providerInstanceId" | "nativeThreadRef"
> & { readonly hasPendingBackgroundWork: boolean };

/** Captured identity proof; transcript and task bodies never participate. */
export interface ProjectionHostToolAuthorityContext {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    | "id"
    | "projectId"
    | "activeProviderThreadId"
    | "runtimeMode"
    | "interactionMode"
    | "lineage"
    | "forkedFrom"
    | "archivedAt"
    | "deletedAt"
  >;
  readonly runs: ReadonlyArray<
    Pick<
      OrchestrationV2Run,
      | "id"
      | "userMessageId"
      | "ordinal"
      | "activeAttemptId"
      | "providerThreadId"
      | "providerInstanceId"
      | "rootNodeId"
      | "delegatedTaskId"
      | "status"
      | "requestedAt"
    >
  >;
  readonly providerThreads: ReadonlyArray<ProjectionHostProviderThread>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "runAttemptId" | "status" | "nativeTurnRef">
  >;
  readonly subagents: ReadonlyArray<
    Pick<OrchestrationV2Subagent, "origin" | "status" | "providerThreadId">
  >;
}

export type ProjectionPendingUserInputs = Pick<
  OrchestrationV2ThreadProjection,
  "runtimeRequests" | "nodes" | "turnItems"
>;

export type ProjectionThreadProviderContext = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerSessions" | "providerThreads"
>;
export interface ProjectionRuntimeResponseContext {
  readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined;
  readonly node: OrchestrationV2ThreadProjection["nodes"][number] | undefined;
  readonly item: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  readonly session: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
}

export interface ProjectionRecordFilter {
  readonly nodeIds?: ReadonlyArray<NodeId>;
  readonly subagentIds?: ReadonlyArray<NodeId>;
  /** Tasks spawned by these Runs, through the thread/run task index. */
  readonly subagentRunIds?: ReadonlyArray<RunId>;
  readonly providerThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly attemptIds?: ReadonlyArray<RunAttemptId>;
  readonly providerTurnAttemptIds?: ReadonlyArray<RunAttemptId>;
  readonly contextTransferThreadIds?: ReadonlyArray<ThreadId>;
  readonly contextTransferSourceThreadId?: ThreadId;
  readonly contextTransferTargetThreadId?: ThreadId;
  readonly contextTransferTypes?: readonly OrchestrationV2ThreadProjection["contextTransfers"][number]["type"][];
  readonly contextTransferStatuses?: readonly OrchestrationV2ThreadProjection["contextTransfers"][number]["status"][];
  readonly contextTransferRunIds?: ReadonlyArray<RunId>;
  readonly contextTransferLimit?: number;
  readonly runLimit?: number;
  readonly runOrder?: "asc" | "desc" | "completed-desc";
  readonly resultOriginalRunId?: RunId;
  readonly excludeMonitorRuns?: boolean;
  readonly runStatuses?: ReadonlyArray<OrchestrationV2Run["status"]>;
  readonly runHasCheckpoint?: boolean;
  readonly runCheckpointId?: CheckpointId;
  readonly runDelegatedTaskId?: NodeId;
  /** Runs whose delegated-completion cohort has an outstanding delivery (partial index). */
  readonly runOpenDelivery?: boolean;
  readonly excludeHeldRuns?: boolean;
  readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
  readonly turnItemRunId?: RunId;
  readonly messageIds?: ReadonlyArray<MessageId>;
  readonly messageRunIds?: ReadonlyArray<RunId>;
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
  readonly runIds?: ReadonlyArray<RunId>;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly turnItemIds?: ReadonlyArray<TurnItemId>;
  readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
}

/** Control decisions select real row heads; conversation bodies are read only for the addressed input. */
export interface ProjectionMessageDispatchInput {
  readonly threadId: ThreadId;
  readonly messageId?: MessageId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runIds: ReadonlyArray<RunId>;
  readonly taskIds: ReadonlyArray<NodeId>;
  readonly includeWorkStartedAt?: boolean;
}

function historicalSummaryLine(message: OrchestrationV2HistoricalMessage): string {
  const compact = (text: string) => {
    const value = text.replace(/\s+/g, " ").trim();
    return value.length <= 240 ? value : `${value.slice(0, 237)}...`;
  };
  if (message.kind === "command_execution")
    return `- Command: ${compact(message.text.slice("Command: ".length).split("\nExit code: ")[0] ?? "")}`;
  if (message.kind === "file_change")
    return `- File change: ${message.text.slice("File change: ".length)}`;
  return `- ${message.role === "user" ? "User" : "Assistant"}: ${compact(message.text)}`;
}

export interface ProjectionHandoffHistoryInput {
  /** Complete conversation prefixes include captured fork ancestry; local, targeted, and incremental reads do not. */
  readonly scope: "conversation" | "local";
  readonly threadId: ThreadId;
  readonly runOrdinalFrom?: number;
  readonly runOrdinalTo?: number;
  /** Read a source prefix captured at this conversation revision. */
  readonly historyRevision?: number | undefined;
  /**
   * Read the conversation as it stood when Run `runOrdinalTo` finished, as a fork or merge-back
   * source does: only context clears before that Run apply. Other reads continue the current
   * context, which begins after the latest retained clear.
   */
  readonly asOfRunOrdinalTo?: boolean;
  readonly runStatuses?: readonly OrchestrationV2Run["status"][];
  readonly runIds?: readonly RunId[];
  readonly includeImported?: boolean;
  readonly excludeItemIds?: readonly TurnItemId[];
  readonly budget: number;
  readonly includeSummary?: boolean;
  /** A newest-first text summary has its own 32k-character budget, independent of intact replay. */
  readonly includeConversationSummary?: boolean;
  /** Retry input missing from the current native transcript. */
  readonly missingFromProviderThreadId?: ProviderThreadId;
  readonly excludeDelivered?: {
    readonly providerThreadId: ProviderThreadId;
    readonly nativeThreadId: string;
  };
}
/** Incremental and failed-attempt queries address local Runs, never the fork base. */
function includesInheritedHandoffHistory(input: ProjectionHandoffHistoryInput): boolean {
  return (
    input.scope === "conversation" &&
    (input.runOrdinalFrom ?? 1) <= 1 &&
    input.runIds === undefined &&
    input.missingFromProviderThreadId === undefined
  );
}

export interface ProjectionHandoffHistory {
  readonly history: NonNullable<OrchestrationV2ContextHandoff["history"]>;
  readonly context: string;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly fromProviderThreadIds: readonly ProviderThreadId[];
  /** All source items; replayable text count is history.messages.length + history.omittedItems. */
  readonly sourceItemCount: number;
  readonly sourceRunCount: number;
  readonly sourceSelections: readonly {
    readonly providerInstanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  }[];
  readonly summary?: { readonly lines: readonly string[]; readonly omittedItems: number };
  readonly conversationSummary?: {
    readonly sections: readonly { readonly label: "User" | "Assistant"; readonly body: string }[];
    readonly omittedItems: number;
    readonly truncatedItems: number;
  };
}

function conversationSummaryFromItems(
  items: readonly OrchestrationV2TurnItem[],
): NonNullable<ProjectionHandoffHistory["conversationSummary"]> {
  const messages = items.flatMap((item) => {
    if (
      item.type !== "user_message" &&
      item.type !== "assistant_message" &&
      item.type !== "dynamic_tool"
    )
      return [];
    const message = historicalMessage(item);
    return message === null ? [] : [message];
  });
  const sections: Array<{ label: "User" | "Assistant"; body: string }> = [];
  let remaining = CONVERSATION_SUMMARY_CHAR_CAP - CONVERSATION_SUMMARY_HEADER.length - 2;
  let truncatedItems = 0;
  for (const message of messages.slice(-256).toReversed()) {
    const label = message.role === "user" ? "User" : "Assistant";
    if (remaining <= label.length + 2) break;
    const characters = Array.from(message.text);
    const truncated = characters.length + label.length + 2 > remaining;
    const bodyBudget = remaining - label.length - 2 - (truncated ? 4 : 0);
    if (bodyBudget < 0) break;
    sections.unshift({
      label,
      body: `${truncated ? "... " : ""}${characters.slice(bodyBudget === 0 ? characters.length : -bodyBudget).join("")}`,
    });
    remaining -= characters.length + label.length + 4;
    if (truncated) truncatedItems++;
  }
  return { sections, omittedItems: messages.length - sections.length, truncatedItems };
}

export type ProjectionSubagentOverviewItem = Pick<
  OrchestrationV2Subagent,
  | "id"
  | "threadId"
  | "runId"
  | "parentNodeId"
  | "origin"
  | "driver"
  | "providerInstanceId"
  | "providerThreadId"
  | "childThreadId"
  | "title"
  | "model"
  | "modelSelection"
  | "status"
  | "startedAt"
  | "completedAt"
  | "updatedAt"
> & {
  readonly childRunId: RunId | null;
  readonly resultAvailable: boolean;
};
export interface ProjectionSubagentOverviewPage {
  readonly items: readonly ProjectionSubagentOverviewItem[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Every task in this section, loaded or not. */
  readonly totalCount: number;
}
export interface ProjectionSubagentOverview {
  readonly active: ProjectionSubagentOverviewPage;
  readonly terminal: ProjectionSubagentOverviewPage;
}
export interface ProjectionSubagentOverviewInput {
  readonly threadId: ThreadId;
  /** An addressed task lookup uses the same metadata projection without loading task bodies. */
  readonly taskId?: NodeId;
  readonly activeCursor?: string;
  readonly terminalCursor?: string;
}
export interface ProjectionProjectProviderBindings {
  readonly snapshotSequence: number;
  readonly items: readonly {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
  }[];
  readonly nextCursor: string | null;
}

export interface ProjectionExecutionActorPage {
  readonly items: readonly {
    readonly threadId: ThreadId;
    readonly activeRunId: RunId | null;
    readonly providerSessionId: ProviderSessionId | null;
  }[];
  readonly nextCursor: string | null;
}
export interface ProjectionExecutionHandoffPage {
  readonly items: readonly {
    readonly threadId: ThreadId;
    readonly operationId: string;
    readonly recoveryRequired: boolean;
  }[];
  readonly nextCursor: string | null;
}

export interface ProjectionProjectExecutionActivity {
  readonly snapshotSequence: number;
  readonly executionHandoff?: { readonly threadId: ThreadId; readonly operationId: string } | null;
  readonly run: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly status: OrchestrationV2Run["status"];
  } | null;
  readonly runtimeRequest: {
    readonly threadId: ThreadId;
    readonly requestId: RuntimeRequestId;
  } | null;
  readonly nativeBackground: { readonly threadId: ThreadId; readonly taskId: NodeId } | null;
}
export interface ProjectionProjectRoots {
  readonly threadIds: readonly ThreadId[];
  readonly nextCursor: string | null;
}
export interface ProjectionQueuedRunPage {
  readonly snapshotSequence: number;
  readonly entries: readonly {
    readonly runId: string;
    readonly userMessageId: string;
    readonly userItemId: string | null;
    readonly queuePosition: number;
    readonly held: boolean;
    readonly requestedAt: string;
  }[];
  readonly nextCursor: string | null;
  readonly nextRunId: string | null;
}
export interface ProjectionRunOutcome {
  readonly runId: RunId;
  readonly status: OrchestrationV2Run["status"];
  readonly completedAt: string | null;
  readonly finalAssistantItemId: TurnItemId | null;
}
export type ProjectionRunOutcomeQuery = { readonly threadId: ThreadId } & (
  | { readonly runId: RunId; readonly messageId?: never }
  | { readonly messageId: MessageId; readonly runId?: never }
);
type SubagentOverviewPhase = "active" | "terminal";
const encodeSubagentOverviewCursor = (
  threadId: ThreadId,
  phase: SubagentOverviewPhase,
  updatedAt: string,
  id: string,
) =>
  Buffer.from(JSON.stringify({ t: threadId, p: phase, u: updatedAt, i: id })).toString("base64url");
const decodeSubagentOverviewCursor = (
  cursor: string,
  threadId: ThreadId,
  phase: SubagentOverviewPhase,
) => {
  if (cursor.length > 2048) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.t !== threadId ||
      candidate.p !== phase ||
      typeof candidate.u !== "string" ||
      candidate.u.length > 40 ||
      typeof candidate.i !== "string" ||
      candidate.i.length === 0 ||
      candidate.i.length > 512
    )
      return null;
    return { updatedAt: candidate.u, id: candidate.i };
  } catch {
    return null;
  }
};
export type ProjectionRecordField = Exclude<
  keyof OrchestrationV2ThreadProjection,
  "thread" | "updatedAt" | "visibleTurnItems"
>;
export type ProjectionRecords<K extends ProjectionRecordField> = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | K
>;

export interface ProjectionTimelinePageOptions {
  readonly afterPosition?: number;
  readonly beforePosition?: number;
  readonly beforeItem?: {
    readonly sourceThreadId: ThreadId;
    readonly sourceItemId: TurnItemId;
  };
  readonly afterItem?: {
    readonly sourceThreadId: ThreadId;
    readonly sourceItemId: TurnItemId;
  };
  readonly order?: "oldest_first" | "newest_first";
  readonly itemId?: TurnItemId;
  readonly itemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly view?: "messages" | "activity";
  readonly limit: number;
}
export interface ProjectionTimelinePage {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly totalItems: number;
  readonly hasMore: boolean;
}
export type ProjectionTimelineMetadataItem = Omit<OrchestrationV2ProjectedTurnItem, "item"> & {
  readonly metadata?: {
    readonly messageId: string | null;
    readonly createdBy: "user" | "agent" | "system" | null;
    readonly creationSource: string | null;
    readonly senderThreadId: string | null;
    readonly title: string | null;
  };
  readonly item: Pick<OrchestrationV2TurnItem, "id" | "runId" | "type" | "status" | "updatedAt">;
};
const visibleItemMetadata = (
  item: OrchestrationV2TurnItem,
  message: OrchestrationV2ConversationMessage | undefined,
): NonNullable<ProjectionTimelineMetadataItem["metadata"]> => ({
  messageId: "messageId" in item ? item.messageId : null,
  createdBy: message?.createdBy ?? ("createdBy" in item ? item.createdBy : null),
  creationSource:
    message?.creationSource ?? ("creationSource" in item ? item.creationSource : null),
  senderThreadId: message?.senderThreadId ?? null,
  title: item.title,
});

export interface ProjectionVisibleTurnItemRecord {
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
  readonly visibility: "local" | "inherited" | "synthetic";
  readonly item: OrchestrationV2TurnItem;
  readonly metadata: ProjectionTimelineMetadataItem["metadata"];
}

export interface ProjectionTimelineMetadataPage {
  readonly items: ReadonlyArray<ProjectionTimelineMetadataItem>;
  readonly totalItems: number;
  readonly hasMore: boolean;
  /** False when an explicitly requested source item is no longer visible. */
  readonly anchorFound: boolean;
}

/** Shared ordering and filtering for metadata and hydrated history windows. */
function selectTimelineRows<
  Row extends Pick<
    ProjectionTimelineMetadataItem,
    "position" | "sourceItemId" | "sourceThreadId"
  > & {
    readonly item: { readonly type: OrchestrationV2TurnItem["type"] };
  },
>(
  rows: ReadonlyArray<Row>,
  options: ProjectionTimelinePageOptions,
): {
  readonly items: ReadonlyArray<Row>;
  readonly totalItems: number;
  readonly hasMore: boolean;
  readonly anchorFound: boolean;
} {
  const positionOf = (anchor: ProjectionTimelinePageOptions["beforeItem"]) =>
    anchor === undefined
      ? null
      : rows.find(
          (row) =>
            row.sourceThreadId === anchor.sourceThreadId &&
            row.sourceItemId === anchor.sourceItemId,
        )?.position;
  const before = positionOf(options.beforeItem);
  const after = positionOf(options.afterItem);
  if (before === undefined || after === undefined)
    return { items: [], totalItems: rows.length, hasMore: false, anchorFound: false };
  const beforePosition = Math.min(
    options.beforePosition ?? Number.POSITIVE_INFINITY,
    before ?? Number.POSITIVE_INFINITY,
  );
  const afterPosition = Math.max(options.afterPosition ?? -1, after ?? -1);
  const matching = rows.filter((row) =>
    options.itemId === undefined
      ? row.position > afterPosition &&
        row.position < beforePosition &&
        (options.itemTypes === undefined || options.itemTypes.includes(row.item.type)) &&
        (options.view === "activity" ||
          ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
      : row.sourceItemId === options.itemId,
  );
  const ordered = options.order === "newest_first" ? matching.toReversed() : matching;
  return {
    items: ordered.slice(0, options.limit),
    totalItems: rows.length,
    hasMore: matching.length > options.limit,
    anchorFound: true,
  };
}

export interface ShellSnapshotOptions {
  readonly location?: "active" | "archive";
  /**
   * Reads only this project's threads. Fork sources in other projects still
   * load, so visible item counts match the unscoped snapshot.
   */
  readonly projectId?: ProjectId;
  /**
   * For background sweeps, not clients: skips settled threads before any of
   * their run, item or session rows are read.
   */
  readonly unsettledOnly?: boolean;
}

export function turnStartFactsFromProjection(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
): ProjectionTurnStartFacts {
  const run = projection.runs.find((r) => r.id === runId);
  const work =
    run === undefined
      ? []
      : pendingRestartCancelledBackgroundWork({
          runs: projection.runs,
          providerTurns: projection.providerTurns,
          attempts: projection.attempts,
          run,
          compactionMessageIds: new Set(
            projection.messages
              .filter(
                (m) => m.attachments.length === 0 && m.text.trim().toLowerCase() === "/compact",
              )
              .map((m) => m.id),
          ),
        });
  const provider = projection.providerThreads.find((p) => p.id === run?.providerThreadId);
  return {
    hasConversation: projection.messages.some(
      (m) =>
        m.role === "user" &&
        (m.text.trim().toLowerCase() !== "/compact" || m.attachments.length > 0),
    ),
    nextTurnItemOrdinal: Math.max(0, ...projection.turnItems.map((i) => i.ordinal)) + 1,
    providerTurnOrdinal:
      Math.max(
        0,
        ...projection.providerTurns
          .filter((t) => t.providerThreadId === run?.providerThreadId)
          .map((t) => t.ordinal),
      ) + 1,
    uncertainDelivery: projection.contextHandoffs.some(
      (h) =>
        h.toProviderThreadId === provider?.id &&
        h.delivery?.nativeThreadId === provider?.nativeThreadRef?.nativeId &&
        h.delivery?.status === "pending",
    ),
    omittedHandoffCount: 0,
    restartNoteState: {
      continuation:
        run !== undefined &&
        isRestartNoteContinuation(
          run,
          projection.runs,
          projection.providerTurns,
          projection.attempts,
        ),
      work: work.slice(0, 10),
      totalWork: work.length,
    },
  };
}

function nativeContextEstimateFromProjection(
  projection: OrchestrationV2ThreadProjection,
  input: { runId: RunId; providerThreadId: ProviderThreadId; nativeThreadId: string },
): number {
  const handoffs = projection.contextHandoffs.filter(
    (h) =>
      h.toProviderThreadId === input.providerThreadId &&
      h.delivery?.nativeThreadId === input.nativeThreadId &&
      h.delivery?.status !== "pending",
  );
  const delivered = new Set(handoffs.flatMap((h) => h.delivery?.itemIds ?? []));
  const covered = new Set([
    ...delivered,
    ...handoffs.flatMap((h) => h.delivery?.omittedItemIds ?? []),
  ]);
  const accepted = projection.attempts.filter(
    (a) =>
      a.providerThreadId === input.providerThreadId &&
      projection.providerTurns.some((t) => t.runAttemptId === a.id),
  );
  const missing = new Set(
    projection.runs
      .filter(
        (r) =>
          r.providerThreadId === input.providerThreadId &&
          ["failed", "interrupted"].includes(r.status) &&
          !projection.providerTurns.some((t) => t.runAttemptId === r.activeAttemptId),
      )
      .map((r) => r.id),
  );
  return projection.turnItems.reduce((sum, item) => {
    if (
      item.runId === input.runId ||
      (item.runId !== null && missing.has(item.runId) && !delivered.has(item.id)) ||
      (item.providerThreadId !== input.providerThreadId && !delivered.has(item.id))
    )
      return sum;
    const run = projection.runs.find((r) => r.id === item.runId);
    if (run?.status === "rolled_back") return sum;
    const nativeAttachments =
      item.type === "user_message" &&
      item.providerThreadId === input.providerThreadId &&
      item.runId !== null &&
      (accepted.some((a) => a.runId === item.runId && a.nativeThreadId === input.nativeThreadId) ||
        (accepted.some((a) => a.runId === item.runId && a.nativeThreadId === undefined) &&
          !covered.has(item.id) &&
          !handoffs.some(
            (h) =>
              h.strategy === "full_thread_summary" &&
              h.fromProviderThreadIds.includes(input.providerThreadId) &&
              run !== undefined &&
              run.ordinal >= h.coveredRunOrdinals.from &&
              run.ordinal <= h.coveredRunOrdinals.to,
          )))
        ? attachmentTokenAllowance(item.attachments)
        : 0;
    const historical = historicalMessage(item);
    return sum + (historical === null ? 0 : Buffer.byteLength(historical.text)) + nativeAttachments;
  }, 0);
}

export interface ProjectionTurnStartFacts {
  readonly hasConversation: boolean;
  readonly nextTurnItemOrdinal: number;
  readonly providerTurnOrdinal: number;
  readonly uncertainDelivery: boolean;
  readonly omittedHandoffCount: number;
  readonly restartNoteState: {
    readonly continuation: boolean;
    readonly work: NonNullable<OrchestrationV2Run["restartCancelledBackgroundWork"]>;
    readonly totalWork: number;
  };
}

export interface ProjectionStoreV2Shape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly getThreadAttachmentIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionStoreV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ProjectionStoreV2Error>;
  /** Each local Run's opening prompt and latest reply, read without materializing history. */
  readonly getThreadPromptIndex: (
    threadId: ThreadId,
  ) => Effect.Effect<ThreadPromptIndex, ProjectionStoreV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error>;
  /** Visible identities and control fields without reading any item body. */
  readonly getTimelineMetadataPage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelineMetadataPage, ProjectionStoreV2Error>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getNextTurnItemOrdinal: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** One persisted turn item, or null when the thread has no such item. */
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
  /** One visible local or captured fork item, resolved without materializing a timeline. */
  readonly getVisibleTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
    readonly sourceThreadId?: ThreadId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
  /** Canonical visible item and provenance, resolved together at the owner boundary. */
  readonly getVisibleTurnItemRecord: (
    input: Parameters<ProjectionStoreV2Shape["getVisibleTurnItem"]>[0],
  ) => Effect.Effect<ProjectionVisibleTurnItemRecord | null, ProjectionStoreV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>;
  readonly getMessageDispatchProjection: (
    input: ProjectionMessageDispatchInput,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly getSubagentCount: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;

  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>;
  /**
   * Runs the shell snapshot's SQL reads and returns the step that decodes them.
   * Callers that combine the shell with other reads run this inside their own
   * transaction and the returned decode after it commits, so the shared
   * connection is not held while thousands of rows are converted.
   */
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>,
    ProjectionStoreV2Error
  >;
  /** Indexed task lookup across all Session trees; no transcript hydration. */
  readonly getTaskOwner: (taskId: NodeId) => Effect.Effect<ThreadId | null, ProjectionStoreV2Error>;
  readonly getThreadCounts: (
    threadId: ThreadId,
  ) => Effect.Effect<
    { readonly runCount: number; readonly pendingRequestCount: number },
    ProjectionStoreV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
  /** Durable Run result, including rollback settlement; no live provider or body read. */
  readonly getRunOutcome: (
    query: ProjectionRunOutcomeQuery,
  ) => Effect.Effect<ProjectionRunOutcome | null, ProjectionStoreV2Error>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>;
  readonly getLimitRecoveryCandidates: (options: {
    readonly now: DateTime.Utc;
    readonly autoResume: boolean;
    readonly snooze: boolean;
  }) => Effect.Effect<ReadonlyArray<ProjectionLimitRecoveryCandidate>, ProjectionStoreV2Error>;
  /** Every candidate, or only `threadId` when a sweep checks one thread. */
  readonly getSettlementCandidates: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error>;
  /**
   * Active (not deleted, not archived) threads with at least one pull request
   * link, in shell snapshot order, or only `threadId` when given. Skips run,
   * message and item reads.
   */
  readonly getThreadsWithPullRequests: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequests>, ProjectionStoreV2Error>;
  readonly getTurnStartContext: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    Pick<
      OrchestrationV2ThreadProjection,
      | "thread"
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "messages"
      | "checkpointScopes"
      | "contextHandoffs"
      | "contextTransfers"
      | "turnItems"
    > &
      ProjectionTurnStartFacts,
    ProjectionStoreV2Error
  >;
  /** Native-incarnation proofs are SQL scalars, never historical attempt payloads. */
  readonly hasNativeTurns: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly nativeThreadId: string;
    readonly sameNativeThread: boolean;
  }) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getNativeContextEstimate: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly providerThreadId: ProviderThreadId;
    readonly nativeThreadId: string;
  }) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** Address only the item identities being considered for this delivery. */
  readonly getDeliveredHandoffItemIds: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly nativeThreadId: string;
    readonly itemIds: ReadonlyArray<TurnItemId>;
  }) => Effect.Effect<ReadonlyArray<TurnItemId>, ProjectionStoreV2Error>;
  /** Native-child routing resolves exact source identities without loading a historic roster. */
  readonly getRelatedNativeThread: (input: {
    readonly threadId: ThreadId;
    readonly providerThreadId: ProviderThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly nativeThreadId: string;
    readonly address: {
      /** An explicit task lifecycle event may resume an ongoing child. */
      readonly subagentId?: NodeId;
      readonly threadId?: ThreadId;
      readonly providerThreadId?: ProviderThreadId;
    };
  }) => Effect.Effect<
    {
      readonly subagentId: NodeId;
      readonly threadId: ThreadId;
      readonly providerThreadId: ProviderThreadId | null;
      readonly sourceRunId: RunId;
    } | null,
    ProjectionStoreV2Error
  >;
  readonly getNativeForkBoundary: (
    threadId: ThreadId,
    runId: RunId,
    following?: {
      readonly nativeTurnIds: ReadonlyArray<string>;
      readonly promptPrefix: string;
      readonly continuationMarker: string;
    },
  ) => Effect.Effect<
    {
      readonly providerThread: OrchestrationV2ProviderThread | null;
      readonly providerTurn: OrchestrationV2ProviderTurn | null;
      readonly followingProviderTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
      readonly rollbackTurnCount: number;
      readonly nativeIncarnationMatches: boolean;
      readonly sourceRunOrdinal: number | null;
    },
    ProjectionStoreV2Error
  >;
  /** Select metadata before reading intact historical text; no Run payloads or transcript snapshots. */
  readonly getSideChatThreadIds: Effect.Effect<readonly ThreadId[], ProjectionStoreV2Error>;
  readonly getSideChatContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionHandoffHistory | null, ProjectionStoreV2Error>;
  readonly getHandoffHistory: (
    input: ProjectionHandoffHistoryInput,
  ) => Effect.Effect<ProjectionHandoffHistory, ProjectionStoreV2Error>;
  readonly getLastDeliveredRun: (
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
  ) => Effect.Effect<OrchestrationV2Run | null, ProjectionStoreV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly getRuntimeRecoveryProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionRuntimeRecoveryState, ProjectionStoreV2Error>;
  readonly getHostToolAuthorityContext: (
    threadId: ThreadId,
    runId?: RunId | null,
    providerThreadId?: ProviderThreadId,
  ) => Effect.Effect<ProjectionHostToolAuthorityContext, ProjectionStoreV2Error>;
  readonly getThreadSubagentOverview: (
    input: ProjectionSubagentOverviewInput,
  ) => Effect.Effect<ProjectionSubagentOverview, ProjectionStoreV2Error>;
  readonly getProjectProviderSessionBindings: (
    projectId: ProjectId,
    cursor?: string,
  ) => Effect.Effect<ProjectionProjectProviderBindings, ProjectionStoreV2Error>;
  readonly getExecutionActors: (
    rootThreadId: ThreadId,
    cursor?: string,
  ) => Effect.Effect<ProjectionExecutionActorPage, ProjectionStoreV2Error>;
  readonly getExecutionHandoffs: (
    cursor?: string,
  ) => Effect.Effect<ProjectionExecutionHandoffPage, ProjectionStoreV2Error>;
  /** Detach projections remove their binding before physical cleanup acknowledges completion. */
  readonly getExecutionDetachBarrier: (
    rootThreadId: ThreadId,
  ) => Effect.Effect<string | null, ProjectionStoreV2Error>;
  readonly getExecutionRetirementContext: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<ProjectionExecutionRetirementContext, ProjectionStoreV2Error>;
  readonly getProjectExecutionActivity: (
    projectId: ProjectId,
  ) => Effect.Effect<ProjectionProjectExecutionActivity, ProjectionStoreV2Error>;
  readonly getProjectRoots: (
    projectId: ProjectId,
    cursor?: string,
  ) => Effect.Effect<ProjectionProjectRoots, ProjectionStoreV2Error>;
  readonly getQueuedRunPage: (
    threadId: ThreadId,
    cursor?: string,
  ) => Effect.Effect<ProjectionQueuedRunPage, ProjectionStoreV2Error>;
  readonly getQueuedRunPreview: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    {
      readonly threadId: string;
      readonly runId: string;
      readonly messageId: string;
      readonly text: string;
      readonly images: ReadonlyArray<Omit<ChatImageAttachment, "source">>;
    } | null,
    ProjectionStoreV2Error
  >;
  /** A Run's user message while the Run remains in the conversation (not rolled back). */
  readonly getRunUserMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | null, ProjectionStoreV2Error>;
  /** First own admitted user turn; inherited history and queued-only messages do not name it. */
  readonly getOpeningRequest: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | null, ProjectionStoreV2Error>;
  readonly getPendingNativeUserInputs: (
    threadId: ThreadId,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error>;
  readonly getPlan: (
    threadId: ThreadId,
    planId: PlanId,
  ) => Effect.Effect<OrchestrationV2PlanArtifact | undefined, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest: (
    threadId: ThreadId,
    requestId: TurnItemId,
    resultId: TurnItemId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getRuntimeRequest: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<
    OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined,
    ProjectionStoreV2Error
  >;
  readonly getProviderControlContext: (
    threadId: ThreadId,
    target: ProjectionProviderControlTarget,
  ) => Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error>;
  readonly getPendingMessageDeliveryIds: (
    threadId: ThreadId,
    providerThreadId: ProviderThreadId,
  ) => Effect.Effect<ReadonlyArray<MessageId>, ProjectionStoreV2Error>;
  /** The loaded root and its last native turn; retirement never reads historical cohorts. */
  readonly getProviderRetirementContext: (
    threadId: ThreadId,
    providerSessionId: ProviderSessionId,
    providerThreadId?: ProviderThreadId,
  ) => Effect.Effect<
    Pick<ProjectionProviderControlContext, "providerThread" | "providerTurn">,
    ProjectionStoreV2Error
  >;
  readonly getRunningTurnContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<ProjectionProviderControlContext, "run" | "providerThread" | "providerTurn">,
    ProjectionStoreV2Error
  >;
  readonly getThreadProviderContext: (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error>;
  readonly getRuntimeResponseContext: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error>;
  readonly getCheckpointCaptureContext: (
    threadId: ThreadId,
    target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
  ) => Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error>;
  readonly getRunMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, ProjectionStoreV2Error>;
  readonly canStartQueuedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getRecoveryThreadIds: (
    kind: ProjectionRecoveryKind,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly getUnreadableThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: {
      /** Hard item bound, including histories with user-turn anchors. */
      readonly rowLimit: number;
      /** Control observers never traverse inherited history or decode transcript bodies. */
      readonly controlOnly?: boolean | undefined;
      /** User-turn window, with extra anchors for the inclusive cursor and has-more check. */
      readonly userTurnLimit?: number | undefined;
      readonly anchorItemId?: TurnItemId | undefined;
      readonly anchorThreadId?: ThreadId | undefined;
      readonly anchorOrdinal?: number | undefined;
      readonly exclusiveAnchor?: boolean | undefined;
      readonly historyOnly?: boolean | undefined;
      readonly requiredRunId?: RunId | undefined;
      readonly requiredRequestId?: RuntimeRequestId | undefined;
    },
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
      /** Proven omitted prefix; no lookahead transcript body is decoded. */
      readonly hasEarlierHistory?: boolean | undefined;
      readonly latestLocalTurnOrdinal?: number | null | undefined;
    },
    ProjectionStoreV2Error
  >;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

export const ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION = 2;

function needsRecovery(
  projection: OrchestrationV2ThreadProjection,
  kind: ProjectionRecoveryKind,
  parent?: Pick<OrchestrationV2ThreadProjection, "subagents" | "contextTransfers">,
): boolean {
  if (projection.thread.deletedAt !== null) return false;
  switch (kind) {
    case "queued-runs":
      return (
        projection.thread.archivedAt === null &&
        projection.runs.some((run) => run.status === "queued") &&
        !projection.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      );
    case "delegated-completions":
      return projection.runs.some((run) => run.delegatedCompletion?.delivery != null);
    case "subagent-results": {
      const parentThreadId = projection.thread.lineage.parentThreadId;
      // Only a child with an app-owned task still awaiting its result can need delivery.
      return (
        projection.thread.lineage.relationshipToParent === "subagent" &&
        parentThreadId !== null &&
        projection.thread.forkedFrom?.type === "node" &&
        (parent?.subagents ?? []).some(
          (task) =>
            task.origin === "app_owned" &&
            task.result === null &&
            task.childThreadId === projection.thread.id,
        ) &&
        ((parent?.subagents ?? []).some(
          (task) =>
            task.origin === "app_owned" &&
            task.result === null &&
            task.childThreadId === projection.thread.id &&
            projection.runs.some(
              (run) =>
                run.delegatedTaskId === task.id &&
                ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  run.status,
                ),
            ),
        ) ||
          (["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
            latestUnheldRun(projection.runs)?.status ?? "idle",
          ) &&
            ![...projection.contextTransfers, ...(parent?.contextTransfers ?? [])].some(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === projection.thread.id &&
                transfer.targetThreadId === parentThreadId,
            )))
      );
    }
    case "runtime":
      return (
        projection.runs.some(
          (run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status) ||
            (run.status === "queued" && run.queueHeld !== true),
        ) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.subagents.some(
          (subagent) =>
            subagent.origin === "provider_native" &&
            ["pending", "running", "waiting"].includes(subagent.status),
        ) ||
        projection.providerSessions.some(
          (session) => session.status !== "stopped" && session.status !== "error",
        ) ||
        projection.providerThreads.some(
          (thread) =>
            thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        ) ||
        projection.turnItems.some(
          (item) =>
            ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
            ["pending", "running", "waiting"].includes(item.status) &&
            !projection.runs.some((run) => run.id === item.runId && run.status === "rolled_back"),
        )
      );
  }
}

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function upsertProviderTurn(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
  const current = turns.find((turn) => turn.id === next.id);
  return upsertById(turns, {
    ...next,
    ...((next.tokenUsage ?? current?.tokenUsage) === undefined
      ? {}
      : { tokenUsage: next.tokenUsage ?? current?.tokenUsage }),
  });
}

/** A stale run snapshot must not erase fields that other events recorded on the run. */
function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  if (current === undefined) return next;
  return {
    ...next,
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}

function preserveCompletionDelivery(
  current: OrchestrationV2Subagent | undefined,
  next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
  if (next.completionDelivery !== undefined || current?.completionDelivery === undefined) {
    return next;
  }
  return { ...next, completionDelivery: current.completionDelivery };
}

export function emptyProjection(
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

/** Mirror the SQL field patches without replacing any conversation or tool bodies. */
function applyExecutionRetired(
  projection: OrchestrationV2ThreadProjection,
  event: Extract<OrchestrationV2DomainEvent, { readonly type: "run.execution-retired" }>,
): OrchestrationV2ThreadProjection {
  const { runId, attemptId, providerThreadId, cohortParentRunId, deliveryRunId } = event.payload;
  const now = event.occurredAt;
  const run = projection.runs.find((candidate) => candidate.id === runId);
  const delivery = projection.runs.find(
    (candidate) => candidate.id === deliveryRunId && candidate.status === "queued",
  );
  const ownedNodes = new Set(
    projection.nodes.filter((node) => node.runId === runId).map((node) => node.id),
  );
  const hasCohort = projection.subagents.some(
    (task) => task.runId === cohortParentRunId && task.origin === "app_owned",
  );
  return withLocalVisibleTurnItems({
    ...projection,
    runs: projection.runs.map((candidate) => {
      const retired =
        candidate.id === runId &&
        (candidate.status === "preparing" ||
          candidate.status === "starting" ||
          candidate.status === "running" ||
          candidate.status === "waiting");
      const cancelled = candidate.id === delivery?.id;
      const stopCohort =
        candidate.id === cohortParentRunId &&
        (candidate.delegatedCompletion !== undefined || hasCohort);
      return {
        ...candidate,
        ...(retired ? { status: "interrupted" as const, completedAt: now } : {}),
        ...(cancelled
          ? { status: "cancelled" as const, queuePosition: null, completedAt: now }
          : {}),
        ...(stopCohort
          ? {
              delegatedCompletion: {
                disposition:
                  candidate.delegatedCompletion?.disposition === "disposed"
                    ? ("disposed" as const)
                    : ("stopped" as const),
                nextGeneration: candidate.delegatedCompletion?.nextGeneration ?? 1,
                delivery: null,
              },
            }
          : {}),
      };
    }),
    attempts: projection.attempts.map((attempt) => {
      if (attempt.id === delivery?.activeAttemptId)
        return { ...attempt, status: "cancelled" as const, completedAt: now };
      if (
        attempt.id !== attemptId ||
        attempt.runId !== runId ||
        (attempt.status !== "pending" && attempt.status !== "running")
      )
        return attempt;
      return { ...attempt, status: "interrupted" as const, completedAt: now };
    }),
    nodes: projection.nodes.map((node) => {
      if (node.id === delivery?.rootNodeId)
        return { ...node, status: "cancelled" as const, completedAt: now };
      if (node.runId !== runId || !isOrchestrationV2WorkActive(node.status)) return node;
      return { ...node, status: "interrupted" as const, completedAt: now };
    }),
    providerTurns: projection.providerTurns.map((turn) =>
      ((turn.runAttemptId === attemptId && attemptId !== null) || ownedNodes.has(turn.nodeId)) &&
      (turn.status === "pending" || turn.status === "running")
        ? { ...turn, status: "interrupted" as const, completedAt: now }
        : turn,
    ),
    providerThreads: projection.providerThreads.map((thread) =>
      thread.id === providerThreadId &&
      thread.status === "active" &&
      thread.lastRunOrdinal === run?.ordinal
        ? { ...thread, status: "idle" as const, updatedAt: now }
        : thread,
    ),
    subagents: projection.subagents.map((task) => {
      const interrupted =
        task.runId === runId &&
        task.origin === "provider_native" &&
        isOrchestrationV2WorkActive(task.status);
      const dispose =
        task.runId === cohortParentRunId &&
        task.origin === "app_owned" &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "delivered" &&
        task.completionDelivery?.state !== "disposed";
      return {
        ...task,
        ...(interrupted ? { status: "interrupted" as const, completedAt: now } : {}),
        ...(dispose
          ? { completionDelivery: { state: "disposed" as const, observedByRunId: null } }
          : {}),
        ...(interrupted || dispose ? { updatedAt: now } : {}),
      };
    }),
    turnItems: projection.turnItems.map((item) => {
      if (item.runId !== runId) return item;
      const interrupted = isOrchestrationV2WorkActive(item.status);
      const streaming = "streaming" in item && item.streaming;
      if (!interrupted && !streaming) return item;
      return {
        ...item,
        ...(interrupted ? { status: "interrupted" as const, completedAt: now } : {}),
        ...(streaming ? { streaming: false } : {}),
        updatedAt: now,
      };
    }),
    messages: projection.messages.map((message) =>
      message.runId === runId && message.streaming
        ? { ...message, streaming: false, updatedAt: now }
        : message,
    ),
    runtimeRequests: projection.runtimeRequests.map((request) =>
      request.status === "pending" && ownedNodes.has(request.nodeId)
        ? {
            ...request,
            status: "cancelled" as const,
            resolvedAt: now,
            responseCapability: {
              type: "not_resumable" as const,
              reason: "The run was interrupted.",
            },
          }
        : request,
    ),
  });
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    thread: {
      ...projection.thread,
      updatedAt: event.occurredAt,
    },
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "background-work.stop-requested":
      return base;
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return {
        ...base,
        thread: event.payload,
      };
    // Visited tracking is read state, not activity: skip the updatedAt bump so
    // viewing a thread does not surface it as recently active.
    case "thread.visited":
    case "thread.marked-unread":
      return {
        ...projection,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return withLocalVisibleTurnItems({
        ...base,
        runs: upsertById(
          base.runs,
          preserveRunRecordedFields(
            base.runs.find((run) => run.id === event.payload.id),
            event.payload,
          ),
        ),
      });
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run.execution-retired":
      return applyExecutionRetired(base, event);
    case "run-attempt.created":
    case "run-attempt.updated":
      return withLocalVisibleTurnItems({
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      });
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertById(
          base.subagents,
          preserveCompletionDelivery(
            base.subagents.find((task) => task.id === event.payload.id),
            event.payload,
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertById(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      // Closed native histories are audit records. Late native notifications cannot revive them.
      if (
        base.providerThreads.some(
          (thread) => thread.id === event.payload.id && thread.status === "closed",
        )
      )
        return base;
      return {
        ...base,
        thread: providerThreadActivatesThread(event.payload, base.thread.id)
          ? {
              ...base.thread,
              activeProviderThreadId: event.payload.id,
            }
          : base.thread,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.delivery.updated":
      return withLocalVisibleTurnItems({
        ...base,
        messages: base.messages.map((message) =>
          message.id !== event.payload.messageId ||
          (message.delivery === "accepted" && event.payload.delivery !== "accepted")
            ? message
            : { ...message, delivery: event.payload.delivery, updatedAt: event.occurredAt },
        ),
        turnItems: base.turnItems.map((item) =>
          item.type !== "user_message" ||
          item.messageId !== event.payload.messageId ||
          (item.delivery === "accepted" && event.payload.delivery !== "accepted")
            ? item
            : {
                ...item,
                delivery: event.payload.delivery,
                ...(event.payload.nativeItemRef === undefined
                  ? {}
                  : { nativeItemRef: event.payload.nativeItemRef }),
                updatedAt: event.occurredAt,
              },
        ),
      });
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return withLocalVisibleTurnItems({
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      });
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "checkpoint.rollback-requested":
      return base;
    case "side-chat.context-captured":
      return base;
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
    case "context-transfer.created":
    case "context-transfer.updated":
      return {
        ...base,
        contextTransfers: upsertById(base.contextTransfers, event.payload),
      };
  }
}

/**
 * Replay state for entities whose persisted projection is shared across thread bindings.
 *
 * Provider sessions are process-scoped: one session row can be bound to several app
 * threads. Updating that row changes what every bound thread reads, even though the
 * application event itself belongs to one thread stream. Keeping the binding index here
 * makes in-memory replay match the normalized SQL projection without scanning every
 * thread for every session event.
 */
export interface ProjectionReplayState {
  readonly projections: Map<ThreadId, OrchestrationV2ThreadProjection>;
  readonly providerSessionThreadIds: Map<ProviderSessionId, ReadonlySet<ThreadId>>;
  readonly executionRetirementTargets: Map<
    ThreadId,
    ReadonlyMap<
      RunId,
      {
        readonly threadId: ThreadId;
        readonly runId: RunId;
        readonly operationId: string;
      }
    >
  >;
}

function makeProjectionReplayState(): ProjectionReplayState {
  return {
    projections: new Map(),
    providerSessionThreadIds: new Map(),
    executionRetirementTargets: new Map(),
  };
}

function applyToProjectionReplayState(
  state: ProjectionReplayState,
  event: OrchestrationV2DomainEvent,
): boolean {
  if (event.type === "thread.created" && !state.projections.has(event.threadId)) {
    state.projections.set(event.threadId, emptyProjection(event));
    return true;
  }

  const current = state.projections.get(event.threadId);
  if (current === undefined) {
    return false;
  }

  if (
    event.type === "thread.metadata-updated" &&
    event.payload.lineage.rootThreadId === event.threadId
  ) {
    const hold = event.payload.executionHandoff;
    if (hold == null) state.executionRetirementTargets.delete(event.threadId);
    else if (current.thread.executionHandoff == null) {
      const targets = new Map<RunId, { threadId: ThreadId; runId: RunId; operationId: string }>();
      for (const projection of state.projections.values()) {
        if (projection.thread.lineage.rootThreadId !== event.threadId) continue;
        const runIds = new Set<RunId>();
        for (const run of projection.runs) {
          if (["preparing", "starting", "running", "waiting"].includes(run.status))
            runIds.add(run.id);
          if (run.status !== "queued") continue;
          const parentId = projection.messages.find((message) => message.id === run.userMessageId)
            ?.delegatedCompletion?.parentRunId;
          if (parentId !== undefined) runIds.add(parentId);
        }
        for (const item of [...projection.turnItems, ...projection.subagents]) {
          if (item.runId !== null && isOrchestrationV2WorkActive(item.status))
            runIds.add(item.runId);
        }
        for (const run of projection.runs) {
          if (!runIds.has(run.id)) continue;
          targets.set(run.id, {
            threadId: projection.thread.id,
            runId: run.id,
            operationId: hold.operationId,
          });
        }
      }
      state.executionRetirementTargets.set(event.threadId, targets);
    }
  }
  if (event.type === "run.execution-retired") {
    const rootId = current.thread.lineage.rootThreadId;
    const targets = state.executionRetirementTargets.get(rootId);
    if (targets?.get(event.payload.runId)?.operationId === event.payload.operationId) {
      const nextTargets = new Map(targets);
      nextTargets.delete(event.payload.runId);
      state.executionRetirementTargets.set(rootId, nextTargets);
    }
  }

  let next = applyToProjection(current, event);
  if (event.type === "provider-session.updated") {
    const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id);
    if (boundThreadIds?.has(event.threadId) !== true) {
      // The SQL projection updates the global session row but does not implicitly
      // create a thread binding for an update event.
      next = { ...next, providerSessions: current.providerSessions };
    }
  }
  state.projections.set(event.threadId, next);
  if (
    event.type === "thread.metadata-updated" &&
    event.payload.lineage.rootThreadId === event.payload.id &&
    current.thread.projectId !== event.payload.projectId
  ) {
    for (const [threadId, projection] of state.projections) {
      if (threadId === event.threadId || projection.thread.lineage.rootThreadId !== event.threadId)
        continue;
      state.projections.set(threadId, {
        ...projection,
        thread: { ...projection.thread, projectId: event.payload.projectId },
      });
    }
  }

  switch (event.type) {
    case "provider-session.attached": {
      const boundThreadIds = new Set(state.providerSessionThreadIds.get(event.payload.id) ?? []);
      boundThreadIds.add(event.threadId);
      state.providerSessionThreadIds.set(event.payload.id, boundThreadIds);
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.updated": {
      const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id) ?? [];
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.detached": {
      const boundThreadIds = new Set(
        state.providerSessionThreadIds.get(event.payload.providerSessionId) ?? [],
      );
      boundThreadIds.delete(event.threadId);
      if (boundThreadIds.size === 0) {
        state.providerSessionThreadIds.delete(event.payload.providerSessionId);
      } else {
        state.providerSessionThreadIds.set(event.payload.providerSessionId, boundThreadIds);
      }
      break;
    }
  }

  return true;
}

type PayloadRow = {
  readonly payload_json: string;
};

type ShellThreadRow = {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly forked_from_run_source_thread_id: string | null;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly latest_run_requested_at: string | null;
  readonly latest_run_started_at: string | null;
  readonly latest_run_completed_at: string | null;
  readonly active_run_id: string | null;
  readonly activity_run_status: string | null;
  readonly activity_run_started_at: string | null;
  readonly last_error: string | null;
  readonly terminal_failure_payload_json: string | null;
  readonly blocking_run_id: string | null;
  readonly blocking_run_requested_at: string | null;
  readonly blocking_run_started_at: string | null;
  readonly blocking_run_completed_at: string | null;
  readonly blocking_failure_payload_json: string | null;
  readonly pending_request_payload_json: string | null;
  readonly pending_secret_request_payload_json: string | null;
  readonly latest_user_message_at: string | null;
  readonly latest_user_authored_message_at: string | null;
  readonly has_actionable_proposed_plan: number;
  readonly item_count: number;
  readonly runless_item_count: number;
};

type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
  readonly status: OrchestrationV2Run["status"];
  readonly rolled_back_at_revision: number | null;
};

type SettlementThreadRow = Pick<
  ShellThreadRow,
  | "thread_id"
  | "payload_json"
  | "latest_run_id"
  | "latest_run_status"
  | "latest_run_requested_at"
  | "latest_run_started_at"
  | "latest_run_completed_at"
  | "latest_user_message_at"
  | "latest_user_authored_message_at"
>;

type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};

const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const encodeRunPayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema));
const encodeRestartCancelledBackgroundWork = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.restartCancelledBackgroundWork),
);
const encodeRunAttemptPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const encodeNodePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const encodeSubagentPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const encodeProviderSessionPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const encodeProviderThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const encodeProviderTurnPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const encodeRuntimeRequestPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const encodeMessagePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const encodePlanPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
const encodeTurnItemPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const encodeCheckpointScopePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const encodeCheckpointPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const encodeContextHandoffPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const encodeContextTransferPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const decodeHostAuthorityThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2AppThreadJsonSchema.mapFields((fields) => ({
      id: fields.id,
      projectId: fields.projectId,
      activeProviderThreadId: fields.activeProviderThreadId,
      runtimeMode: fields.runtimeMode,
      interactionMode: fields.interactionMode,
      lineage: fields.lineage,
      forkedFrom: fields.forkedFrom,
      archivedAt: fields.archivedAt,
      deletedAt: fields.deletedAt,
    })),
  ),
);
const decodeHostAuthorityRun = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2RunJsonSchema.mapFields((fields) => ({
      id: fields.id,
      userMessageId: fields.userMessageId,
      ordinal: fields.ordinal,
      activeAttemptId: fields.activeAttemptId,
      providerThreadId: fields.providerThreadId,
      providerInstanceId: fields.providerInstanceId,
      rootNodeId: fields.rootNodeId,
      delegatedTaskId: fields.delegatedTaskId,
      status: fields.status,
      requestedAt: fields.requestedAt,
    })),
  ),
);
const decodeHostAuthorityProvider = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      ...OrchestrationV2ProviderThreadJsonSchema.mapFields((fields) => ({
        id: fields.id,
        providerSessionId: fields.providerSessionId,
        providerInstanceId: fields.providerInstanceId,
        nativeThreadRef: fields.nativeThreadRef,
      })).fields,
      hasPendingBackgroundWork: Schema.Boolean,
    }),
  ),
);
const decodeHostAuthorityTurn = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2ProviderTurnJsonSchema.mapFields((fields) => ({
      id: fields.id,
      runAttemptId: fields.runAttemptId,
      status: fields.status,
      nativeTurnRef: fields.nativeTurnRef,
    })),
  ),
);
const decodeHostAuthorityChild = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2SubagentJsonSchema.mapFields((fields) => ({
      origin: fields.origin,
      status: fields.status,
      providerThreadId: fields.providerThreadId,
    })),
  ),
);

const decodeSubagentOverview = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    OrchestrationV2SubagentJsonSchema.mapFields((fields) => ({
      id: fields.id,
      threadId: fields.threadId,
      runId: fields.runId,
      parentNodeId: fields.parentNodeId,
      origin: fields.origin,
      driver: fields.driver,
      providerInstanceId: fields.providerInstanceId,
      providerThreadId: fields.providerThreadId,
      childThreadId: fields.childThreadId,
      title: fields.title,
      model: fields.model,
      modelSelection: fields.modelSelection,
      status: fields.status,
      startedAt: fields.startedAt,
      completedAt: fields.completedAt,
      updatedAt: fields.updatedAt,
      childRunId: Schema.NullOr(RunId),
      resultAvailable: Schema.Boolean,
    })),
  ),
);
const decodeRunPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
const decodeRunAttemptPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const decodeNodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const decodeProviderSessionPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const decodeProviderThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const decodeProviderTurnPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const decodeRuntimeRequestPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const decodeMessagePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const decodePlanArtifact = Schema.decodeUnknownEffect(OrchestrationV2PlanArtifactSchema);
const decodePlanPayload = (json: string) => decodePlanArtifact(parseEncodedPayload(json));
const decodeTurnItemPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const decodeCheckpointScopePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const decodeCheckpointPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const decodeContextHandoffPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const decodeContextTransferPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
const isProjectionStoreReadError = Schema.is(ProjectionStoreReadError);

function parseEncodedPayload(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : String(value);
}

function nullableStringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

function booleanInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

const decodeRows =
  <A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
  (rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
    Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStoreReadError({
            threadId,
            cause,
          }),
      ),
    );

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems.filter(isVisible).map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position }));
}

function makeForkMarkerTurnItem(input: {
  readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

export function isTurnItemAtOrBeforeRun(input: {
  readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
  readonly itemRunId: OrchestrationV2TurnItem["runId"];
  readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
  readonly sourceRunOrdinal: number;
}): boolean {
  if (input.itemRunId === null) {
    return hasImportedThreadHistory(input.historyOrigin);
  }
  const ordinal = input.runOrdinalById.get(input.itemRunId);
  return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
  readonly sourceHistoryRevision?: number | undefined;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = new Map(
    input.sourceProjection.runs
      .filter((run) => isRunVisibleAtHistoryRevision(run, input.sourceHistoryRevision))
      .map((run) => [run.id, run.ordinal]),
  );
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems.filter((item) => {
      if (
        isOrchestrationV2SupersededInterrupt({
          item,
          attempts: input.sourceProjection.attempts,
          items: input.sourceProjection.turnItems,
        })
      ) {
        return false;
      }
      return isTurnItemAtOrBeforeRun({
        historyOrigin: input.sourceProjection.thread.historyOrigin,
        itemRunId: item.runId,
        runOrdinalById,
        sourceRunOrdinal: sourceRun.ordinal,
      });
    }),
  );

  return [...inheritedPrefix, ...localPrefix];
}

function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
  readonly localItems?: ReadonlyArray<OrchestrationV2ProjectedTurnItem> | undefined;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = input.projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run" || input.sourceProjection === null) {
    return localVisibleTurnItems(input.projection);
  }

  const inherited = visibleTurnItemsThroughRun({
    sourceProjection: input.sourceProjection,
    sourceRunId: forkedFrom.runId,
    sourceHistoryRevision: forkedFrom.sourceHistoryRevision,
  });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = (input.localItems ?? activeLocalTurnItems(input.projection)).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems([
    ...inherited,
    {
      visibility: "synthetic",
      sourceThreadId: forkedFrom.threadId,
      sourceItemId: markerItem.id,
      item: markerItem,
    },
    ...local,
  ]);
}

/**
 * An agent waiting on a secret is waiting on the user just like a question,
 * so the shell reports it as pending user input. Secret requests have no
 * runtime request of their own; this stands one in for the shell summary
 * only, keyed by the card's turn item.
 */
function secretRequestAsPendingInput(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2ThreadShell["pendingRuntimeRequest"] {
  if (item?.type !== "secret_request") return null;
  return {
    id: RuntimeRequestId.make(item.id),
    kind: "user_input",
    createdAt: item.startedAt ?? item.updatedAt,
  };
}

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(
      projection.runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(projection.runs);
  const activeRun =
    projection.runs
      .filter(isInterruptibleRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    projection.runs
      .filter(isActivityRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const pendingRuntimeRequest =
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0] ??
    secretRequestAsPendingInput(
      projection.turnItems
        .filter((item) => item.type === "secret_request" && item.status === "waiting")
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0] ?? null,
    );
  const userMessages = projection.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestUserMessage = userMessages[0] ?? null;
  const pendingBackgroundTasks = derivePendingBackgroundWork({
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
  });
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    ...(projection.thread.executionLocation === undefined
      ? {}
      : { executionLocation: projection.thread.executionLocation }),
    ...(projection.thread.executionHandoff === undefined
      ? {}
      : { executionHandoff: projection.thread.executionHandoff }),
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest:
      pendingRuntimeRequest === null
        ? null
        : {
            id: pendingRuntimeRequest.id,
            kind: pendingRuntimeRequest.kind,
            createdAt: pendingRuntimeRequest.createdAt,
          },
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    pendingBackgroundTasks: [...pendingBackgroundTasks],
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    goal: activeProviderGoalForShell(
      projection.providerThreads,
      projection.thread.activeProviderThreadId,
    ),
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    lastVisitedAt: projection.thread.lastVisitedAt,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
  };
}

/**
 * Provider instances that have owned this thread's root conversation, oldest
 * first. Subagent provider threads carry an owner node and are excluded so a
 * delegated Codex child does not make a Claude thread look handed off.
 */
function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

/** The native goal lives on the provider thread that currently owns the conversation. */
function activeProviderGoalForShell(
  providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
  return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}

type ShellRunState = Pick<OrchestrationV2Run, "ordinal" | "status" | "rolledBackAtRevision">;

type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly latestRunRequestedAt: DateTime.Utc | null;
  readonly latestRunStartedAt: DateTime.Utc | null;
  readonly latestRunCompletedAt: DateTime.Utc | null;
  readonly activeRunId: RunId | null;
  readonly activityRunStatus: ShellActivityRunStatus | null;
  readonly activityRunStartedAt: DateTime.Utc | null;
  readonly lastError: string | null;
  readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
  readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
  readonly pendingRuntimeRequest: OrchestrationV2ThreadShell["pendingRuntimeRequest"];
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
  readonly goal: OrchestrationV2ThreadShell["goal"];
  readonly itemCount: number;
  readonly runlessItemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runById: ReadonlyMap<RunId, ShellRunState>;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

function shellStatusFromStoredRunStatus(status: string | null): OrchestrationV2ShellThreadStatus {
  switch (status) {
    case null:
      return "idle";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return "failed";
  }
}

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
  readonly sourceHistoryRevision?: number | undefined;
}): number {
  const runOrdinal = input.state.runById.get(input.runId)?.ordinal;
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = hasImportedThreadHistory(input.state.thread.historyOrigin)
    ? input.state.runlessItemCount
    : 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const run = input.state.runById.get(runId);
    if (
      run !== undefined &&
      run.ordinal <= runOrdinal &&
      isRunVisibleAtHistoryRevision(run, input.sourceHistoryRevision)
    ) {
      count += itemCount;
    }
  }
  return count;
}

/**
 * Threads that some shell row forks from at a run. Only these need run
 * ordinals and per-run item counts, to count the inherited prefix, so a thread
 * nobody forked from never pays for a scan of its run history.
 */
function shellForkSourceIds(
  rows: ReadonlyArray<{ readonly forked_from_run_source_thread_id: string | null }>,
): ReadonlyArray<ThreadId> {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.forked_from_run_source_thread_id === null
          ? []
          : [ThreadId.make(row.forked_from_run_source_thread_id)],
      ),
    ),
  ];
}

function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = state.thread.forkedFrom;
  if (forkedFrom?.type !== "run") {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const sourceForkedFrom = sourceState.thread.forkedFrom;
  const inheritedPrefixCount =
    sourceForkedFrom?.type === "run"
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({
      state: sourceState,
      runId: forkedFrom.runId,
      sourceHistoryRevision: forkedFrom.sourceHistoryRevision,
    }) +
    1 +
    state.itemCount
  );
}

function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
}): OrchestrationV2ThreadShell {
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    providerInstanceId: input.state.thread.providerInstanceId,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    branch: input.state.thread.branch,
    worktreePath: input.state.thread.worktreePath,
    ...(input.state.thread.executionLocation === undefined
      ? {}
      : { executionLocation: input.state.thread.executionLocation }),
    ...(input.state.thread.executionHandoff === undefined
      ? {}
      : { executionHandoff: input.state.thread.executionHandoff }),
    pullRequests: threadPullRequestsOf(input.state.thread),
    ...(input.state.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: input.state.thread.linkedPullRequest }),
    ...(input.state.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.state.thread.branchPullRequest }),
    ...(input.state.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: input.state.thread.activeOrderKey }),
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    ...(input.state.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: input.state.thread.historyOrigin }),
    latestRunId: input.state.latestRunId,
    latestRunRequestedAt: input.state.latestRunRequestedAt,
    latestRunStartedAt: input.state.latestRunStartedAt,
    latestRunCompletedAt: input.state.latestRunCompletedAt,
    activeRunId: input.state.activeRunId,
    activityRunStatus: input.state.activityRunStatus,
    activityRunStartedAt: input.state.activityRunStartedAt,
    status: input.state.latestRunStatus,
    lastError: input.state.lastError,
    lastErrorClass: input.state.lastErrorClass,
    usageLimitResetAt: input.state.usageLimitResetAt,
    pendingRuntimeRequest:
      input.state.pendingRuntimeRequest === null
        ? null
        : {
            id: input.state.pendingRuntimeRequest.id,
            kind: input.state.pendingRuntimeRequest.kind,
            createdAt: input.state.pendingRuntimeRequest.createdAt,
          },
    latestVisibleMessage: null,
    latestUserMessageAt: input.state.latestUserMessageAt,
    latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
    hasActionableProposedPlan: input.state.hasActionableProposedPlan,
    pendingBackgroundTasks: input.state.pendingBackgroundTasks,
    providerInstanceHistory: input.state.providerInstanceHistory,
    goal: input.state.goal,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
    archivedAt: input.state.thread.archivedAt,
    settledOverride: input.state.thread.settledOverride,
    settledAt: input.state.thread.settledAt,
    unsettledAt: input.state.thread.unsettledAt ?? null,
    snoozedUntil: input.state.thread.snoozedUntil ?? null,
    snoozedAt: input.state.thread.snoozedAt ?? null,
    pinnedAt: input.state.thread.pinnedAt ?? null,

    autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: input.state.thread.pinOrderKey ?? null,
    lastVisitedAt: input.state.thread.lastVisitedAt,
    titleRegeneration: input.state.thread.titleRegeneration ?? null,
    limitRecovery: input.state.thread.limitRecovery ?? null,
    deletedAt: input.state.thread.deletedAt,
  };
}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const capturedRunVisibility = (revision: number | null | Statement.Fragment) => sql`
      (run.status IS NULL OR run.status <> 'rolled_back'
        OR (${revision} IS NOT NULL
          AND json_extract(run.payload_json, '$.rolledBackAtRevision') > ${revision}))
    `;

    // For run upserts: a snapshot without `path` keeps the value another event recorded there.
    const keepRecordedRunField = (payload: Statement.Fragment, path: string) => sql`
      CASE
        WHEN json_type(excluded.payload_json, ${path}) IS NULL
          AND json_type(orchestration_v2_projection_runs.payload_json, ${path}) IS NOT NULL
        THEN json_set(
          ${payload},
          ${path},
          json_extract(orchestration_v2_projection_runs.payload_json, ${path})
        )
        ELSE ${payload}
      END
    `;

    const insertAttachmentRefs = (
      ownerId: string,
      threadId: ThreadId,
      runId: RunId | null,
      attachmentIds: ReadonlyArray<string>,
    ) =>
      Effect.forEach(
        new Set(attachmentIds),
        (attachmentId) => sql`
          INSERT OR IGNORE INTO orchestration_v2_projection_attachment_refs(
            owner_id, attachment_id, thread_id, run_id)
          VALUES (${ownerId}, ${attachmentId}, ${threadId}, ${runId})
        `,
        { discard: true },
      );

    const apply: ProjectionStoreV2Shape["apply"] = (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "thread.created":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.deleted":
          case "thread.settled":
          case "thread.unsettled":
          case "thread.snoozed":
          case "thread.unsnoozed":
          case "thread.auto-settle-set":
          case "thread.pinned":
          case "thread.unpinned":
          case "thread.pin-reordered":
          case "thread.active-reordered":
          case "thread.visited":
          case "thread.marked-unread":
          case "thread.metadata-updated":
          case "thread.pull-request-synced":
          case "thread.interaction-mode-updated":
          case "thread.model-selection-updated":
          case "thread.provider-switched": {
            if (event.type === "thread.deleted")
              yield* sql`DELETE FROM orchestration_v2_side_chat_contexts WHERE thread_id = ${event.threadId}`;
            const previousProject =
              event.type === "thread.metadata-updated" &&
              event.payload.lineage.rootThreadId === event.payload.id
                ? yield* sql<{
                    readonly project_id: string;
                    readonly execution_handoff_id: string | null;
                  }>`SELECT project_id, json_extract(payload_json, '$.executionHandoff.operationId') AS execution_handoff_id
                    FROM orchestration_v2_projection_threads WHERE thread_id = ${event.payload.id} LIMIT 1`
                : [];
            const payloadJson = yield* encodeThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            if (
              event.type === "thread.metadata-updated" &&
              event.payload.lineage.rootThreadId === event.threadId
            ) {
              const hold = event.payload.executionHandoff;
              if (hold == null)
                yield* sql`DELETE FROM orchestration_v2_execution_retirement_targets WHERE root_thread_id = ${event.threadId}`;
              else if (previousProject[0]?.execution_handoff_id == null)
                yield* sql`
                  WITH actors AS (
                    SELECT thread_id FROM orchestration_v2_projection_threads
                    WHERE json_extract(payload_json, '$.lineage.rootThreadId') = ${event.threadId}
                  ), targets AS (
                    SELECT r.thread_id, r.run_id FROM actors a
                    JOIN orchestration_v2_projection_runs r ON r.thread_id = a.thread_id
                    WHERE r.status IN ('preparing', 'starting', 'running', 'waiting')
                    UNION
                    SELECT i.thread_id, i.run_id FROM actors a
                    JOIN orchestration_v2_projection_turn_items i ON i.thread_id = a.thread_id
                    WHERE i.status IN ('pending', 'running', 'waiting') AND i.run_id IS NOT NULL
                    UNION
                    SELECT s.thread_id, s.run_id FROM actors a
                    JOIN orchestration_v2_projection_subagents s ON s.thread_id = a.thread_id
                    WHERE s.status IN ('pending', 'running', 'waiting') AND s.run_id IS NOT NULL
                    UNION
                    SELECT r.thread_id, json_extract(m.payload_json, '$.delegatedCompletion.parentRunId')
                    FROM actors a
                    JOIN orchestration_v2_projection_runs r ON r.thread_id = a.thread_id AND r.status = 'queued'
                    JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
                    WHERE json_extract(m.payload_json, '$.delegatedCompletion.parentRunId') IS NOT NULL
                  )
                  INSERT OR IGNORE INTO orchestration_v2_execution_retirement_targets
                    (root_thread_id, thread_id, run_id, operation_id)
                  SELECT ${event.threadId}, targets.thread_id, targets.run_id, ${hold.operationId}
                  FROM targets JOIN orchestration_v2_projection_runs r
                    ON r.run_id = targets.run_id AND r.thread_id = targets.thread_id
                  WHERE NOT EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_threads root
                      WHERE root.thread_id = ${event.threadId}
                        AND json_extract(root.payload_json, '$.executionHandoff.operationId') IS NOT NULL
                    )
                `;
            }
            if (previousProject[0] && previousProject[0].project_id !== event.payload.projectId)
              yield* sql`
                UPDATE orchestration_v2_projection_threads
                SET project_id = ${event.payload.projectId},
                    payload_json = json_set(payload_json, '$.projectId', ${event.payload.projectId})
                WHERE json_extract(payload_json, '$.lineage.rootThreadId') = ${event.payload.id}
              `;
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id,
                project_id,
                title,
                default_provider,
                provider_instance_id,
                runtime_mode,
                interaction_mode,
                active_provider_thread_id,
                created_at,
                updated_at,
                archived_at,
                deleted_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.projectId},
                ${event.payload.title},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.runtimeMode},
                ${event.payload.interactionMode},
                ${event.payload.activeProviderThreadId},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${nullableStringField(payload, "archivedAt")},
                ${nullableStringField(payload, "deletedAt")},
                ${payloadJson}
              )
              ON CONFLICT(thread_id)
              DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                default_provider = excluded.default_provider,
                provider_instance_id = excluded.provider_instance_id,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                active_provider_thread_id = excluded.active_provider_thread_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "run.created":
          case "run.updated": {
            const payloadJson = yield* encodeRunPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id,
                thread_id,
                ordinal,
                provider,
                provider_instance_id,
                provider_thread_id,
                status,
                requested_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.ordinal},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.status},
                ${stringField(payload, "requestedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(run_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                ordinal = excluded.ordinal,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                status = excluded.status,
                requested_at = excluded.requested_at,
                completed_at = excluded.completed_at,
                payload_json = ${keepRecordedRunField(
                  keepRecordedRunField(sql`excluded.payload_json`, "$.delegatedCompletion"),
                  "$.restartCancelledBackgroundWork",
                )}
            `;
            break;
          }
          case "run.background-work-cancelled": {
            // Only this field changes, so a concurrent lifecycle write is never regressed.
            const workJson = yield* encodeRestartCancelledBackgroundWork(
              event.payload.restartCancelledBackgroundWork,
            );
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(
                payload_json,
                '$.restartCancelledBackgroundWork',
                json(${workJson})
              )
              WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "run.execution-retired": {
            const { runId, attemptId, providerThreadId, cohortParentRunId, deliveryRunId } =
              event.payload;
            const now = DateTime.formatIso(event.occurredAt);
            // Update only lifecycle fields on the exact execution. Bodies never cross the
            // control boundary, and unrelated held/queued runs retain their original rows.
            yield* sql`
              UPDATE orchestration_v2_projection_run_attempts
              SET status = 'cancelled',
                  payload_json = json_set(payload_json, '$.status', 'cancelled', '$.completedAt', ${now})
              WHERE thread_id = ${event.threadId} AND attempt_id IN (
                SELECT json_extract(payload_json, '$.activeAttemptId')
                FROM orchestration_v2_projection_runs
                WHERE run_id = ${deliveryRunId} AND thread_id = ${event.threadId} AND status = 'queued'
              )
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_nodes
              SET status = 'cancelled', completed_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'cancelled', '$.completedAt', ${now})
              WHERE thread_id = ${event.threadId} AND node_id IN (
                SELECT json_extract(payload_json, '$.rootNodeId')
                FROM orchestration_v2_projection_runs
                WHERE run_id = ${deliveryRunId} AND thread_id = ${event.threadId} AND status = 'queued'
              )
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET status = 'cancelled', completed_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'cancelled',
                    '$.queuePosition', NULL, '$.completedAt', ${now})
              WHERE run_id = ${deliveryRunId} AND thread_id = ${event.threadId} AND status = 'queued'
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET status = 'interrupted', completed_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'interrupted', '$.completedAt', ${now})
              WHERE run_id = ${runId} AND thread_id = ${event.threadId}
                AND status IN ('preparing', 'starting', 'running', 'waiting')
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_run_attempts
              SET status = 'interrupted',
                  payload_json = json_set(payload_json, '$.status', 'interrupted', '$.completedAt', ${now})
              WHERE attempt_id = ${attemptId} AND thread_id = ${event.threadId} AND run_id = ${runId}
                AND status IN ('pending', 'running')
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_nodes
              SET status = 'interrupted', completed_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'interrupted', '$.completedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${runId}
                AND status IN ('pending', 'running', 'waiting')
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_provider_turns
              SET status = 'interrupted', completed_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'interrupted', '$.completedAt', ${now})
              WHERE thread_id = ${event.threadId} AND status IN ('pending', 'running')
                AND (run_attempt_id = ${attemptId} OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_nodes n
                  WHERE n.node_id = orchestration_v2_projection_provider_turns.node_id
                    AND n.thread_id = ${event.threadId} AND n.run_id = ${runId}
                ))
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_provider_threads
              SET status = 'idle', updated_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'idle', '$.updatedAt', ${now})
              WHERE provider_thread_id = ${providerThreadId} AND thread_id = ${event.threadId}
                AND status = 'active' AND last_run_ordinal = (
                  SELECT ordinal FROM orchestration_v2_projection_runs
                  WHERE run_id = ${runId} AND thread_id = ${event.threadId}
                )
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_subagents
              SET status = 'interrupted', completed_at = ${now}, updated_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'interrupted',
                    '$.completedAt', ${now}, '$.updatedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${runId} AND origin = 'provider_native'
                AND status IN ('pending', 'running', 'waiting')
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_turn_items
              SET status = 'interrupted', updated_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'interrupted',
                    '$.completedAt', ${now}, '$.updatedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${runId}
                AND status IN ('pending', 'running', 'waiting')
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_messages
              SET streaming = 0, updated_at = ${now},
                  payload_json = json_set(payload_json, '$.streaming', json('false'), '$.updatedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${runId} AND streaming = 1
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_turn_items INDEXED BY orchestration_v2_execution_streaming_items_idx
              SET updated_at = ${now},
                  payload_json = json_set(payload_json, '$.streaming', json('false'), '$.updatedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${runId}
                AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.streaming') END = 1
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_runtime_requests
              SET status = 'cancelled', resolved_at = ${now},
                  payload_json = json_set(payload_json, '$.status', 'cancelled', '$.resolvedAt', ${now},
                    '$.responseCapability', json_object('type', 'not_resumable', 'reason', 'The run was interrupted.'))
              WHERE thread_id = ${event.threadId} AND status = 'pending' AND EXISTS (
                SELECT 1 FROM orchestration_v2_projection_nodes n
                WHERE n.node_id = orchestration_v2_projection_runtime_requests.node_id
                  AND n.thread_id = ${event.threadId} AND n.run_id = ${runId}
              )
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(payload_json, '$.delegatedCompletion', json_object(
                'disposition', CASE WHEN json_extract(payload_json, '$.delegatedCompletion.disposition') = 'disposed'
                  THEN 'disposed' ELSE 'stopped' END,
                'nextGeneration', COALESCE(json_extract(payload_json, '$.delegatedCompletion.nextGeneration'), 1),
                'delivery', NULL))
              WHERE run_id = ${cohortParentRunId} AND thread_id = ${event.threadId}
                AND (json_type(payload_json, '$.delegatedCompletion') IS NOT NULL OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_subagents
                  WHERE thread_id = ${event.threadId} AND run_id = ${cohortParentRunId} AND origin = 'app_owned'
                ))
            `;
            yield* sql`
              UPDATE orchestration_v2_projection_subagents
              SET updated_at = ${now}, payload_json = json_set(payload_json,
                '$.completionDelivery', json_object('state', 'disposed', 'observedByRunId', NULL), '$.updatedAt', ${now})
              WHERE thread_id = ${event.threadId} AND run_id = ${cohortParentRunId} AND origin = 'app_owned'
                AND CASE WHEN json_valid(payload_json) THEN
                  COALESCE(json_extract(payload_json, '$.completionDelivery.state'), 'pending')
                  NOT IN ('acknowledged', 'delivered', 'disposed') ELSE 0 END
            `;
            yield* sql`
              DELETE FROM orchestration_v2_execution_retirement_targets
              WHERE root_thread_id = (
                SELECT json_extract(payload_json, '$.lineage.rootThreadId')
                FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}
              ) AND thread_id = ${event.threadId} AND run_id = ${runId}
                AND operation_id = ${event.payload.operationId}
            `;
            break;
          }
          case "run-attempt.created":
          case "run-attempt.updated": {
            const payloadJson = yield* encodeRunAttemptPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id,
                thread_id,
                run_id,
                attempt_ordinal,
                root_node_id,
                provider,
                provider_instance_id,
                provider_thread_id,
                provider_turn_id,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.runId},
                ${event.payload.attemptOrdinal},
                ${event.payload.rootNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(attempt_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                attempt_ordinal = excluded.attempt_ordinal,
                root_node_id = excluded.root_node_id,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "node.updated": {
            const payloadJson = yield* encodeNodePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_nodes (
                node_id,
                thread_id,
                run_id,
                parent_node_id,
                root_node_id,
                kind,
                status,
                provider_thread_id,
                provider_turn_id,
                runtime_request_id,
                checkpoint_scope_id,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.rootNodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.runtimeRequestId},
                ${event.payload.checkpointScopeId},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(node_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                root_node_id = excluded.root_node_id,
                kind = excluded.kind,
                status = excluded.status,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                runtime_request_id = excluded.runtime_request_id,
                checkpoint_scope_id = excluded.checkpoint_scope_id,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "subagent.updated": {
            const payloadJson = yield* encodeSubagentPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_subagents (
                subagent_id,
                thread_id,
                run_id,
                parent_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_thread_id,
                child_thread_id,
                origin,
                status,
                started_at,
                completed_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.childThreadId},
                ${event.payload.origin},
                ${event.payload.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(subagent_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                child_thread_id = excluded.child_thread_id,
                origin = excluded.origin,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at,
                payload_json = CASE
                  WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
                    AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
                  THEN json_set(
                    excluded.payload_json,
                    '$.completionDelivery',
                    json_extract(
                      orchestration_v2_projection_subagents.payload_json,
                      '$.completionDelivery'
                    )
                  )
                  ELSE excluded.payload_json
                END
            `;
            break;
          }
          case "provider-session.attached":
          case "provider-session.updated": {
            const payloadJson = yield* encodeProviderSessionPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_sessions (
                provider_session_id,
                thread_id,
                provider,
                driver,
                provider_instance_id,
                status,
                model,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.status},
                ${event.payload.model},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_session_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                status = excluded.status,
                model = excluded.model,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (event.type === "provider-session.attached") {
              yield* sql`
                INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
                  provider_session_id,
                  thread_id
                )
                VALUES (${event.payload.id}, ${event.threadId})
              `;
            }
            break;
          }
          case "provider-session.detached": {
            yield* sql`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${event.payload.providerSessionId}
                AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "provider-thread.updated": {
            const retired = yield* sql<{ provider_thread_id: string }>`
              SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id = ${event.payload.id} AND status = 'closed' LIMIT 1`;
            if (retired.length > 0) break;
            const payloadJson = yield* encodeProviderThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            const hostIdentityJson = JSON.stringify({
              id: event.payload.id,
              providerSessionId: event.payload.providerSessionId,
              providerInstanceId: event.payload.providerInstanceId,
              nativeThreadRef: payload.nativeThreadRef,
              hasPendingBackgroundWork: (event.payload.pendingBackgroundTasks?.length ?? 0) > 0,
            });
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_threads (
                provider_thread_id,
                thread_id,
                owner_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_session_id,
                status,
                first_run_ordinal,
                last_run_ordinal,
                updated_at,
                host_identity_json,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.appThreadId},
                ${event.payload.ownerNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerSessionId},
                ${event.payload.status},
                ${event.payload.firstRunOrdinal},
                ${event.payload.lastRunOrdinal},
                ${stringField(payload, "updatedAt")},
                ${hostIdentityJson},
                ${payloadJson}
              )
              ON CONFLICT(provider_thread_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                owner_node_id = excluded.owner_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_session_id = excluded.provider_session_id,
                status = excluded.status,
                first_run_ordinal = excluded.first_run_ordinal,
                last_run_ordinal = excluded.last_run_ordinal,
                updated_at = excluded.updated_at,
                host_identity_json = excluded.host_identity_json,
                payload_json = excluded.payload_json
            `;
            if (
              event.payload.appThreadId !== null &&
              providerThreadActivatesThread(event.payload, event.payload.appThreadId)
            ) {
              const threadRows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_threads
                WHERE thread_id = ${event.payload.appThreadId}
                LIMIT 1
              `;
              const threadRow = threadRows[0];
              if (threadRow !== undefined) {
                const thread = yield* decodeThreadPayload(threadRow.payload_json);
                const updatedThread = {
                  ...thread,
                  activeProviderThreadId: event.payload.id,
                  updatedAt: event.payload.updatedAt,
                };
                const updatedThreadPayloadJson = yield* encodeThreadPayload(updatedThread);
                yield* sql`
                  UPDATE orchestration_v2_projection_threads
                  SET
                    active_provider_thread_id = ${event.payload.id},
                    updated_at = ${stringField(parseEncodedPayload(updatedThreadPayloadJson), "updatedAt")},
                    payload_json = ${updatedThreadPayloadJson}
                  WHERE thread_id = ${event.payload.appThreadId}
                `;
              }
            }
            break;
          }
          case "provider-turn.updated": {
            const existingRows =
              event.payload.tokenUsage === undefined
                ? yield* sql<PayloadRow>`
                    SELECT payload_json
                    FROM orchestration_v2_projection_provider_turns
                    WHERE provider_turn_id = ${event.payload.id}
                    LIMIT 1
                  `
                : [];
            const existing = existingRows[0];
            const providerTurn =
              existing === undefined
                ? event.payload
                : upsertProviderTurn(
                    [yield* decodeProviderTurnPayload(existing.payload_json)],
                    event.payload,
                  )[0]!;
            const payloadJson = yield* encodeProviderTurnPayload(providerTurn);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_turns (
                provider_turn_id,
                thread_id,
                provider_thread_id,
                node_id,
                run_attempt_id,
                ordinal,
                status,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${providerTurn.providerThreadId},
                ${providerTurn.nodeId},
                ${providerTurn.runAttemptId},
                ${providerTurn.ordinal},
                ${providerTurn.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_turn_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider_thread_id = excluded.provider_thread_id,
                node_id = excluded.node_id,
                run_attempt_id = excluded.run_attempt_id,
                ordinal = excluded.ordinal,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "runtime-request.updated": {
            const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runtime_requests (
                runtime_request_id,
                thread_id,
                node_id,
                provider_turn_id,
                kind,
                status,
                created_at,
                resolved_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.nodeId},
                ${event.payload.providerTurnId},
                ${event.payload.kind},
                ${event.payload.status},
                ${stringField(payload, "createdAt")},
                ${nullableStringField(payload, "resolvedAt")},
                ${payloadJson}
              )
              ON CONFLICT(runtime_request_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                node_id = excluded.node_id,
                provider_turn_id = excluded.provider_turn_id,
                kind = excluded.kind,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = excluded.resolved_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "message.delivery.updated": {
            const { messageId, delivery, nativeItemRef } = event.payload;
            const updatedAt = DateTime.formatIso(event.occurredAt);
            yield* sql`
              UPDATE orchestration_v2_projection_messages
              SET payload_json = json_set(payload_json, '$.delivery', ${delivery}, '$.updatedAt', ${updatedAt}),
                  updated_at = ${updatedAt}
              WHERE thread_id = ${event.threadId} AND message_id = ${messageId} AND role = 'user'
                AND (${delivery} = 'accepted' OR COALESCE(json_extract(payload_json, '$.delivery'), 'pending') != 'accepted')
            `;
            const itemId = derive.userTurnItem({ messageId });
            const nativeRefJson =
              nativeItemRef === undefined ? null : JSON.stringify(nativeItemRef);
            yield* sql`
              UPDATE orchestration_v2_projection_turn_items
              SET payload_json = json_set(
                    CASE WHEN ${nativeRefJson} IS NULL THEN payload_json
                      ELSE json_set(payload_json, '$.nativeItemRef', json(${nativeRefJson})) END,
                    '$.delivery', ${delivery}, '$.updatedAt', ${updatedAt}),
                  updated_at = ${updatedAt}
              WHERE thread_id = ${event.threadId} AND turn_item_id = ${itemId} AND type = 'user_message'
                AND (${delivery} = 'accepted' OR COALESCE(json_extract(payload_json, '$.delivery'), 'pending') != 'accepted')
            `;
            break;
          }
          case "message.updated": {
            const payloadJson = yield* encodeMessagePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_messages (
                message_id,
                thread_id,
                run_id,
                node_id,
                role,
                streaming,
                created_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.role},
                ${booleanInt(event.payload.streaming)},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(message_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                role = excluded.role,
                streaming = excluded.streaming,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            // Discovery retains bounded text and semantic message recency; Thread metadata
            // changes do not move a conversation through recent Session windows.
            if (
              (event.payload.role === "user" || event.payload.role === "assistant") &&
              event.payload.notification === undefined
            ) {
              yield* sql`UPDATE orchestration_v2_projection_threads
                SET conversation_recency_at = MAX(COALESCE(conversation_recency_at, ''), ${stringField(payload, "updatedAt")})
                WHERE thread_id = ${event.payload.threadId}`;
            }
            if (event.payload.role === "user" && event.payload.notification === undefined) {
              yield* sql`UPDATE orchestration_v2_projection_threads
                SET conversation_preview = ${Array.from(event.payload.text.slice(0, 1024)).slice(0, 512).join("")},
                  conversation_preview_at = ${stringField(payload, "createdAt")},
                  conversation_preview_id = ${event.payload.id}
                WHERE thread_id = ${event.payload.threadId} AND (
                  conversation_preview_id IS NULL OR conversation_preview_id = ${event.payload.id}
                  OR conversation_preview_at > ${stringField(payload, "createdAt")}
                  OR (conversation_preview_at = ${stringField(payload, "createdAt")} AND conversation_preview_id > ${event.payload.id}))`;
            }
            // Shared attachment files are deleted only after their last live reference.
            if (event.payload.role === "user" || event.payload.attachments.length > 0) {
              yield* sql`
                DELETE FROM orchestration_v2_projection_attachment_refs
                WHERE owner_id = ${event.payload.id}
              `;
              yield* insertAttachmentRefs(
                event.payload.id,
                event.payload.threadId,
                event.payload.runId,
                event.payload.attachments.map((attachment) => attachment.id),
              );
            }
            break;
          }
          case "plan.updated": {
            const payloadJson = yield* encodePlanPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_plans (
                plan_id,
                thread_id,
                run_id,
                node_id,
                kind,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(plan_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                kind = excluded.kind,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "turn-item.updated": {
            const payloadJson = yield* encodeTurnItemPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            const historical = historicalMessage(event.payload);
            const historicalTextBytes =
              historical === null ? 0 : Buffer.byteLength(historical.text);
            const nativeAttachmentAllowance =
              event.payload.type === "user_message"
                ? attachmentTokenAllowance(event.payload.attachments)
                : 0;
            yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                provider_turn_id,
                parent_item_id,
                ordinal,
                type,
                status,
                updated_at,
                historical_text_bytes,
                native_attachment_allowance,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.parentItemId},
                ${event.payload.ordinal},
                ${event.payload.type},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${historicalTextBytes},
                ${nativeAttachmentAllowance},
                ${payloadJson}
              )
              ON CONFLICT(turn_item_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                parent_item_id = excluded.parent_item_id,
                ordinal = excluded.ordinal,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                historical_text_bytes = excluded.historical_text_bytes,
                native_attachment_allowance = excluded.native_attachment_allowance,
                payload_json = excluded.payload_json
            `;
            if (event.payload.type === "dynamic_tool" && event.payload.status === "completed") {
              if (event.payload.attachments !== undefined)
                yield* sql`DELETE FROM orchestration_v2_projection_attachment_refs WHERE owner_id = ${event.payload.id}`;
              yield* insertAttachmentRefs(
                event.payload.id,
                event.payload.threadId,
                event.payload.runId,
                [
                  ...(event.payload.attachments ?? []).map((attachment) => attachment.id),
                  ...threadHtmlRenderAttachmentIds(event.payload.threadId, [event.payload]),
                ],
              );
            }
            break;
          }
          case "checkpoint-scope.created": {
            const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoint_scopes (
                scope_id,
                thread_id,
                run_id,
                node_id,
                parent_scope_id,
                provider_thread_id,
                kind,
                ordinal_within_parent,
                advances_app_run_count,
                created_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentScopeId},
                ${event.payload.providerThreadId},
                ${event.payload.kind},
                ${event.payload.ordinalWithinParent},
                ${booleanInt(event.payload.advancesAppRunCount)},
                ${stringField(payload, "createdAt")},
                ${payloadJson}
              )
              ON CONFLICT(scope_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_scope_id = excluded.parent_scope_id,
                provider_thread_id = excluded.provider_thread_id,
                kind = excluded.kind,
                ordinal_within_parent = excluded.ordinal_within_parent,
                advances_app_run_count = excluded.advances_app_run_count,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.captured": {
            const payloadJson = yield* encodeCheckpointPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoints (
                checkpoint_id,
                thread_id,
                scope_id,
                run_id,
                node_id,
                parent_checkpoint_id,
                ordinal_within_scope,
                app_run_ordinal,
                status,
                captured_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.scopeId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentCheckpointId},
                ${event.payload.ordinalWithinScope},
                ${event.payload.appRunOrdinal},
                ${event.payload.status},
                ${stringField(payload, "capturedAt")},
                ${payloadJson}
              )
              ON CONFLICT(checkpoint_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                scope_id = excluded.scope_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_checkpoint_id = excluded.parent_checkpoint_id,
                ordinal_within_scope = excluded.ordinal_within_scope,
                app_run_ordinal = excluded.app_run_ordinal,
                status = excluded.status,
                captured_at = excluded.captured_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.rollback-requested":
            break;
          case "side-chat.context-captured": {
            const payload = yield* Schema.encodeEffect(
              Schema.fromJsonString(OrchestrationV2SideChatCapture),
            )(event.payload);
            yield* sql`INSERT INTO orchestration_v2_side_chat_contexts(thread_id, payload_json) VALUES (${event.threadId}, ${payload})
              ON CONFLICT(thread_id) DO NOTHING`;
            break;
          }
          case "context-handoff.updated": {
            const payloadJson = yield* encodeContextHandoffPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_handoffs (
                context_handoff_id,
                thread_id,
                target_run_id,
                to_provider_thread_id,
                strategy,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.targetRunId},
                ${event.payload.toProviderThreadId},
                ${event.payload.strategy},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_handoff_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                target_run_id = excluded.target_run_id,
                to_provider_thread_id = excluded.to_provider_thread_id,
                strategy = excluded.strategy,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "context-transfer.created":
          case "context-transfer.updated": {
            const payloadJson = yield* encodeContextTransferPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_transfers (
                context_transfer_id,
                source_thread_id,
                target_thread_id,
                target_run_id,
                type,
                status,
                source_provider,
                target_provider,
                source_provider_instance_id,
                target_provider_instance_id,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.sourceThreadId},
                ${event.payload.targetThreadId},
                ${event.payload.targetRunId},
                ${event.payload.type},
                ${event.payload.status},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_transfer_id)
              DO UPDATE SET
                source_thread_id = excluded.source_thread_id,
                target_thread_id = excluded.target_thread_id,
                target_run_id = excluded.target_run_id,
                type = excluded.type,
                status = excluded.status,
                source_provider = excluded.source_provider,
                target_provider = excluded.target_provider,
                source_provider_instance_id = excluded.source_provider_instance_id,
                target_provider_instance_id = excluded.target_provider_instance_id,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
        }

        if (
          event.type !== "thread.created" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.settled" &&
          event.type !== "thread.unsettled" &&
          event.type !== "thread.snoozed" &&
          event.type !== "thread.unsnoozed" &&
          event.type !== "thread.auto-settle-set" &&
          event.type !== "thread.pinned" &&
          event.type !== "thread.unpinned" &&
          event.type !== "thread.pin-reordered" &&
          event.type !== "thread.visited" &&
          event.type !== "thread.marked-unread" &&
          event.type !== "thread.metadata-updated" &&
          event.type !== "thread.interaction-mode-updated" &&
          event.type !== "thread.model-selection-updated" &&
          event.type !== "thread.provider-switched"
        ) {
          const rows = yield* sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_threads
            WHERE thread_id = ${event.threadId}
            LIMIT 1
          `;
          const row = rows[0];
          if (row !== undefined) {
            const thread = yield* decodeThreadPayload(row.payload_json);
            const updatedThread = { ...thread, updatedAt: event.occurredAt };
            const payloadJson = yield* encodeThreadPayload(updatedThread);
            yield* sql`
              UPDATE orchestration_v2_projection_threads
              SET
                updated_at = ${stringField(parseEncodedPayload(payloadJson), "updatedAt")},
                payload_json = ${payloadJson}
              WHERE thread_id = ${event.threadId}
            `;
          }
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreApplyEventError({
              eventType: event.type,
              cause,
            }),
        ),
      );

    const readCanonicalProjection = (
      threadId: ThreadId,
      window?: {
        readonly rowLimit: number;
        readonly controlOnly?: boolean | undefined;
        readonly maxEncodedBytes?: number | undefined;
        readonly allowOversizedFirst?: boolean | undefined;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly anchorOrdinal?: number | undefined;
        readonly exclusiveAnchor?: boolean | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly requiredRequestId?: RuntimeRequestId | undefined;
        readonly requiredHistoryRevision?: number | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly historyOnly?: boolean | undefined;
      },
      fields?: ReadonlyArray<ProjectionRecordField>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const threadRow = threadRows[0];
        if (!threadRow) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }

        const boundedTurnItemRows =
          fields !== undefined && !fields.includes("turnItems")
            ? []
            : window === undefined
              ? yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId}
                  ${filter?.turnItemTypes === undefined ? sql`` : sql`AND type IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemTypes)}))`}
                  ${filter?.turnItemIds === undefined ? sql`` : sql`AND turn_item_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemIds)}))`}
                  ${filter?.turnItemStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemStatuses)}))`}
                  ${filter?.turnItemRunId === undefined ? sql`` : sql`AND run_id = ${filter.turnItemRunId}`}
                  ${filter?.turnItemRunIds === undefined ? sql`` : sql`AND (run_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemRunIds.filter((id): id is RunId => id !== null))})) OR (${filter.turnItemRunIds.includes(null) ? 1 : 0} = 1 AND run_id IS NULL))`}
                ORDER BY ordinal ASC, turn_item_id ASC
              `
              : yield* sql<PayloadRow>`
                WITH eligible AS NOT MATERIALIZED (
                  SELECT item.rowid AS item_rowid, item.payload_json, item.ordinal, item.turn_item_id,
                    item.run_id, item.node_id, item.type
                  FROM orchestration_v2_projection_turn_items AS item
                  LEFT JOIN orchestration_v2_projection_runs AS run
                    ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.ordinal <= COALESCE(
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${threadId}
                          AND turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ),
                      ${window.anchorOrdinal ?? 9223372036854775807n}
                    )
                    AND (${window.exclusiveAnchor === true ? 1 : 0} = 0
                      OR item.ordinal < COALESCE((
                        SELECT ordinal FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${threadId} AND turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ), ${window.anchorOrdinal ?? 9223372036854775807n})
                      OR item.turn_item_id < ${window.anchorItemId ?? null})
                    AND ${capturedRunVisibility(window.requiredRunId === undefined ? null : (window.requiredHistoryRevision ?? null))}
                    AND (
                      ${window.requiredRunId ?? null} IS NOT NULL
                      OR NOT (
                          item.type = 'user_message'
                          AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
                          AND run.status IS 'cancelled'
                      )
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NULL
                      OR (
                        item.run_id IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM orchestration_v2_projection_threads AS source_thread
                          WHERE source_thread.thread_id = item.thread_id
                            AND json_extract(source_thread.payload_json, '$.historyOrigin') IN ('v1_import', 'native_import')
                        )
                      )
                      OR run.ordinal <= (
                        SELECT required_run.ordinal
                        FROM orchestration_v2_projection_runs AS required_run
                        WHERE required_run.thread_id = item.thread_id
                          AND required_run.run_id = ${window.requiredRunId ?? null}
                        LIMIT 1
                      )
                    )
                    AND NOT (
                      item.type = 'run_interrupt_result'
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_run_attempts AS attempt
                        WHERE attempt.run_id = item.run_id
                          AND attempt.root_node_id = item.node_id
                          AND attempt.status = 'superseded'
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS request
                        WHERE request.thread_id = item.thread_id
                          AND request.run_id = item.run_id
                          AND request.type = 'run_interrupt_request'
                      )
                    )
                ), turn_anchors AS (
                  SELECT ordinal, payload_json
                  FROM eligible
                  WHERE type = 'user_message'
                    AND json_extract(payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
                    AND ${window.userTurnLimit ?? null} IS NOT NULL
                  ORDER BY ordinal DESC
                  LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 1}
                ), user_anchors AS (
                  SELECT ordinal
                  FROM turn_anchors
                  WHERE json_extract(payload_json, '$.createdBy') = 'user'
                  ORDER BY ordinal DESC
                  LIMIT ${(window.userTurnLimit ?? 0) + 1}
                ), boundary AS (
                  SELECT CASE
                    WHEN COUNT(*) >= ${(window.userTurnLimit ?? 0) + 1} THEN MIN(ordinal)
                    WHEN (SELECT COUNT(*) FROM turn_anchors) >= ${THREAD_HISTORY_MAX_RAW_TURNS + 1}
                      THEN (SELECT MIN(ordinal) FROM turn_anchors)
                    ELSE -1
                  END AS ordinal
                  FROM user_anchors
                ), candidates AS MATERIALIZED (
                  -- Choose and sort rows by ID, then fetch payloads in that
                  -- order. A turn window can hold megabytes of tool output, and
                  -- carrying it through the union and sort cost about a second.
                  SELECT item_rowid, ordinal, turn_item_id, run_id, type
                  FROM eligible
                  WHERE ordinal > (SELECT ordinal FROM boundary)
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT ${Math.min(window.rowLimit, THREAD_HISTORY_PAGE_POLICY.maxItems)}
                ), costs AS (
                  SELECT candidates.*,
                    length(CAST(CASE WHEN item.type = 'subagent'
                      THEN json_set(json_remove(item.payload_json, '$.prompt', '$.result', '$.progress'), '$.prompt', '', '$.result', NULL)
                      ELSE item.payload_json END AS BLOB)) AS payload_bytes
                  FROM candidates
                  CROSS JOIN orchestration_v2_projection_turn_items AS item
                    ON item.rowid = candidates.item_rowid
                ), budgeted AS (
                  SELECT costs.*,
                    ROW_NUMBER() OVER (ORDER BY ordinal DESC, turn_item_id DESC) AS page_row,
                    SUM(payload_bytes) OVER (ORDER BY ordinal DESC, turn_item_id DESC) AS page_bytes
                  FROM costs
                ), selected AS (
                  -- One oversized item remains whole. Older omitted outputs
                  -- never cross the SQL boundary or reach the JSON decoder.
                  SELECT * FROM budgeted
                  WHERE (page_row = 1 AND ${window.allowOversizedFirst === false ? 0 : 1} = 1)
                    OR page_bytes <= ${window.maxEncodedBytes ?? THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes}
                ), retained AS MATERIALIZED (
                  SELECT item_rowid, ordinal, turn_item_id FROM selected
                  UNION
                  SELECT request.rowid AS item_rowid, request.ordinal, request.turn_item_id
                  FROM orchestration_v2_projection_turn_items AS request
                  WHERE request.run_id IN (
                      SELECT run_id FROM selected
                      WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
                    )
                    AND request.type = 'run_interrupt_request'
                  ORDER BY ordinal ASC, turn_item_id ASC
                )
                -- CROSS JOIN keeps the sorted IDs as the outer loop, so SQLite
                -- skips sorting again once the payloads are attached. Carry the
                -- rowid through selection to avoid a second string-key index lookup.
                SELECT CASE WHEN item.type = 'subagent'
                  THEN json_set(json_remove(item.payload_json, '$.prompt', '$.result', '$.progress'), '$.prompt', '', '$.result', NULL)
                  ELSE item.payload_json END AS payload_json
                FROM retained
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  ON item.rowid = retained.item_rowid
                ORDER BY retained.ordinal ASC, retained.turn_item_id ASC
              `;
        // Reuse the decoded items for cohort IDs and the resulting projection.
        // Parsing these rows separately duplicates every retained tool output.
        const turnItems = yield* decodeRows(decodeTurnItemPayload, threadId)(boundedTurnItemRows);
        const cohortJson = (field: string) =>
          JSON.stringify(
            turnItems.flatMap((payload) => {
              const value = nullableStringField(payload, field);
              return value === null ? [] : [value];
            }),
          );
        const cohortRunIds = cohortJson("runId");
        // Public windows retain one foreground Run and only visible task/request
        // identities. A Run is not a task-page selector: it can own 10k tasks.
        // Context occupancy is a control head, independent of which transcript rows
        // are visible. Select one accepted root report for the current native identity.
        const usageHeads =
          window === undefined || window.historyOnly === true
            ? []
            : yield* sql<{ provider_turn_id: string; attempt_id: string; run_id: string }>`
            SELECT t.provider_turn_id, a.attempt_id, a.run_id
            FROM orchestration_v2_projection_provider_turns t
            JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id
            JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
            JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
            WHERE t.thread_id = ${threadId}
              AND p.provider_thread_id = (SELECT active_provider_thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId})
              AND p.status <> 'closed' AND r.status <> 'rolled_back'
              AND a.provider_thread_id = t.provider_thread_id AND a.root_node_id = t.node_id
              AND json_extract(a.payload_json, '$.nativeThreadId') = json_extract(p.payload_json, '$.nativeThreadRef.nativeId')
              AND json_extract(t.payload_json, '$.tokenUsage') IS NOT NULL
            ORDER BY json_extract(t.payload_json, '$.tokenUsage.updatedAt') DESC, t.ordinal DESC LIMIT 1
          `;
        const usageHead = usageHeads[0];
        const publicRunIds =
          window === undefined
            ? cohortRunIds
            : encodeIdList([
                ...turnItems.flatMap((item) => (item.runId === null ? [] : [item.runId])),
                ...usageHeads.map((head) => head.run_id),
                ...(window.historyOnly === true
                  ? []
                  : (yield* sql<{ run_id: string }>`
            SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
              AND status IN ('queued','preparing','starting','running','waiting')
            ORDER BY CASE WHEN status = 'queued' THEN 1 ELSE 0 END,ordinal DESC LIMIT 1`).map(
                      (row) => row.run_id,
                    )),
                ...(window.requiredRunId === undefined ? [] : [window.requiredRunId]),
                ...(window.requiredRequestId === undefined
                  ? []
                  : (yield* sql<{ run_id: string | null }>`
                    SELECT node.run_id FROM orchestration_v2_projection_runtime_requests AS request
                    JOIN orchestration_v2_projection_nodes AS node ON node.node_id = request.node_id
                    WHERE request.thread_id = ${threadId} AND request.runtime_request_id = ${window.requiredRequestId}
                    LIMIT 1`).flatMap((row) => (row.run_id === null ? [] : [row.run_id]))),
                ...(window.controlOnly === true
                  ? (yield* sql<{ run_id: string }>`
                SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
                ORDER BY ordinal DESC LIMIT 1`).map((row) => row.run_id)
                  : []),
              ]);
        const publicTaskIds =
          window === undefined
            ? "[]"
            : encodeIdList([
                ...turnItems.flatMap((item) => (item.type === "subagent" ? [item.subagentId] : [])),
                ...(window.historyOnly === true
                  ? []
                  : (yield* sql<{ subagent_id: string }>`
            SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}
              AND CASE WHEN status IN ('completed','failed','cancelled','interrupted') THEN 'terminal' ELSE 'active' END = 'active'
            ORDER BY updated_at DESC,subagent_id DESC LIMIT 4`).map((row) => row.subagent_id)),
              ]);
        const publicRequestIds =
          window === undefined
            ? "[]"
            : encodeIdList([
                ...(window.requiredRequestId === undefined ? [] : [window.requiredRequestId]),
                ...turnItems.flatMap((item) =>
                  item.type === "approval_request" || item.type === "user_input_request"
                    ? [item.requestId]
                    : [],
                ),
                ...(window.historyOnly === true
                  ? []
                  : (yield* sql<{ runtime_request_id: string }>`
            SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId}
              AND status IN ('pending','waiting') ORDER BY created_at DESC,runtime_request_id DESC LIMIT 32
          `).map((row) => row.runtime_request_id)),
              ]);
        // A run can contain thousands of completed nodes. Load the visible
        // nodes and live control dependencies, then walk only their ancestors.
        const cohortNodeIds =
          window === undefined ||
          (fields !== undefined &&
            fields.every(
              (field) => field === "runs" || field === "attempts" || field === "turnItems",
            ))
            ? cohortJson("nodeId")
            : encodeIdList(
                (yield* sql<{ readonly node_id: string }>`
            WITH RECURSIVE retained(node_id) AS (
              SELECT value FROM json_each(${cohortJson("nodeId")})
              UNION
              SELECT node_id FROM (
                SELECT node_id FROM orchestration_v2_projection_nodes
                WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
                LIMIT 4
              )
              UNION
              SELECT root_node_id FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND attempt_id IN (
                SELECT json_extract(payload_json, '$.activeAttemptId') FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id IN (SELECT value FROM json_each(${publicRunIds})))
              UNION
              SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND run_id IN (SELECT value FROM json_each(${publicRunIds}))
              UNION
              SELECT node_id FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND runtime_request_id IN (SELECT value FROM json_each(${publicRequestIds}))
              UNION
              SELECT parent_node_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND subagent_id IN (SELECT value FROM json_each(${publicTaskIds}))
              UNION
              SELECT parent.parent_node_id FROM orchestration_v2_projection_nodes AS parent
              INNER JOIN retained ON parent.node_id = retained.node_id
              WHERE parent.thread_id = ${threadId} AND parent.parent_node_id IS NOT NULL
              LIMIT 1024
            )
            -- Sort IDs before fetching bodies, so large payloads never enter
            -- SQLite's temporary sort. The node read restores this order by key.
            SELECT retained.node_id
            FROM retained
            LEFT JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.node_id AND node.thread_id = ${threadId}
            WHERE retained.node_id IS NOT NULL
            ORDER BY COALESCE(node.started_at, ''), retained.node_id ASC
          `).map((row) => row.node_id),
              );
        const cohortProviderThreadIds = cohortJson("providerThreadId");
        const cohortProviderTurnIds = cohortJson("providerTurnId");
        const cohortMessageIds = cohortJson("messageId");
        const cohortPlanIds = cohortJson("planId");
        const cohortCheckpointIds = cohortJson("checkpointId");
        const cohortHandoffIds = cohortJson("contextHandoffId");
        const publicProviderThreadIds =
          window === undefined
            ? cohortProviderThreadIds
            : encodeIdList(
                (yield* sql<{ id: string }>`
          SELECT value AS id FROM json_each(${cohortProviderThreadIds})
          UNION SELECT provider_thread_id AS id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND run_id IN (SELECT value FROM json_each(${publicRunIds}))
          UNION SELECT provider_thread_id AS id FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId} AND subagent_id IN (SELECT value FROM json_each(${publicTaskIds}))
          UNION SELECT json_extract(payload_json, '$.activeProviderThreadId') AS id
            FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
        `).flatMap((row) => (row.id === null ? [] : [row.id])),
              );

        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          planRows,
          checkpointScopeRows,
          checkpointRows,
          contextHandoffRows,
          contextTransferRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRow.payload_json),
          fields !== undefined && !fields.includes("runs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runs
              ${filter?.runOpenDelivery === true ? sql`INDEXED BY orchestration_v2_runs_open_delivery_idx` : sql``}
            WHERE ${filter?.runIds === undefined ? sql`thread_id = ${threadId}` : sql`+thread_id = ${threadId}`}
              ${filter?.runIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))`}
              ${filter?.runStatuses === undefined ? sql`` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.runStatuses)}))`}
              ${filter?.runHasCheckpoint !== true ? sql`` : sql`AND json_extract(payload_json, '$.checkpointId') IS NOT NULL`}
              ${filter?.runCheckpointId === undefined ? sql`` : sql`AND run_id = (SELECT run_id FROM orchestration_v2_projection_checkpoints WHERE thread_id = ${threadId} AND checkpoint_id = ${filter.runCheckpointId})`}
              ${filter?.runDelegatedTaskId === undefined ? sql`` : sql`AND json_extract(payload_json, '$.delegatedTaskId') = ${filter.runDelegatedTaskId}`}
              ${filter?.runOpenDelivery !== true ? sql`` : sql`AND ${sql.literal(OPEN_DELIVERY_RUN_PREDICATE)}`}
              ${filter?.excludeHeldRuns !== true ? sql`` : sql`AND NOT (status = 'queued' AND COALESCE(json_extract(payload_json, '$.queueHeld'), 0) = 1)`}
              ${filter?.resultOriginalRunId === undefined ? sql`` : sql`AND (run_id = ${filter.resultOriginalRunId} OR json_extract(payload_json, '$.startedAt') IS NOT NULL)`}
              ${filter?.excludeMonitorRuns !== true ? sql`` : sql`AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages message WHERE message.message_id = json_extract(orchestration_v2_projection_runs.payload_json, '$.userMessageId') AND json_extract(message.payload_json, '$.notification.source.kind') = 'monitor')`}
            ORDER BY ${filter?.runOrder === "completed-desc" ? sql`(completed_at IS NULL) DESC, completed_at DESC, ordinal DESC` : filter?.runOrder === "desc" ? sql`ordinal DESC` : sql`ordinal ASC`}
              ${filter?.runLimit === undefined ? sql`` : sql`LIMIT ${Math.max(1, Math.min(128, Math.trunc(filter.runLimit)))}`}
          `
              : sql<PayloadRow>`
            SELECT json_remove(payload_json, '$.delegatedCompletion', '$.restartCancelledBackgroundWork') AS payload_json
            FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId}
              AND run_id IN (SELECT value FROM json_each(${publicRunIds}))
            ORDER BY ordinal ASC
          `,
          fields !== undefined && !fields.includes("attempts")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              ${filter?.attemptIds === undefined ? sql`` : sql`AND attempt_id IN (SELECT value FROM json_each(${encodeIdList(filter.attemptIds)}))`}
            ORDER BY run_id ASC, attempt_ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId} AND attempt_id IN (
              SELECT attempt_id FROM (SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                WHERE thread_id = ${threadId}
                  AND (root_node_id IN (SELECT value FROM json_each(${cohortJson("nodeId")}))
                    OR attempt_id IN (SELECT json_extract(payload_json, '$.activeAttemptId')
                      FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
                        AND run_id IN (SELECT value FROM json_each(${publicRunIds}))))
                ORDER BY run_id ASC, attempt_ordinal ASC LIMIT 512)
              UNION SELECT ${usageHead?.attempt_id ?? null})
            ORDER BY run_id ASC, attempt_ordinal ASC
          `,
          fields !== undefined && !fields.includes("nodes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId}
              ${filter?.nodeIds === undefined ? sql`` : sql`AND node_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeIds)}))`}
            ORDER BY COALESCE(started_at, ''), node_id ASC
              `
              : sql<PayloadRow & { readonly position: number }>`
            -- Keep retained IDs outermost so SQLite looks up each node by its
            -- primary key instead of scanning every historical node in the thread.
            SELECT node.payload_json, retained.key AS position
            FROM json_each(${cohortNodeIds}) AS retained
            CROSS JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.value
            WHERE node.thread_id = ${threadId}
          `.pipe(
                  Effect.map((rows) =>
                    rows.toSorted((left, right) => left.position - right.position),
                  ),
                ),
          fields !== undefined && !fields.includes("subagents")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_subagents
            WHERE ${filter?.subagentIds === undefined ? sql`thread_id = ${threadId}` : sql`+thread_id = ${threadId}`}
              ${filter?.subagentIds === undefined ? sql`` : sql`AND subagent_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentIds)}))`}
              ${filter?.subagentRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.subagentRunIds)}))`}
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `
              : sql<PayloadRow>`
            SELECT json_set(json_remove(payload_json, '$.prompt', '$.result', '$.progress', '$.workflow', '$.completionDelivery'),
              '$.prompt', '', '$.result', NULL) AS payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
              AND subagent_id IN (SELECT value FROM json_each(${publicTaskIds}))
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `,
          fields !== undefined && !fields.includes("providerSessions")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `
              : sql<PayloadRow>`
            SELECT DISTINCT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            LEFT JOIN orchestration_v2_projection_provider_threads AS threads
              ON threads.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
              AND threads.provider_thread_id IN (SELECT value FROM json_each(${publicProviderThreadIds}))
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
            LIMIT 512
          `,
          fields !== undefined && !fields.includes("providerThreads")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_threads AS provider_thread
            WHERE ${
              filter?.providerThreadIds === undefined
                ? sql`(thread_id = ${threadId}
               OR owner_node_id IN (
                 SELECT node_id
                 FROM orchestration_v2_projection_nodes
                 WHERE thread_id = ${threadId}
               )
               OR provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE thread_id = ${threadId}
                   AND provider_thread_id IS NOT NULL
               ))`
                : // Addressed reads prove ownership per row through indexes, not the Thread's lists.
                  sql`provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerThreadIds)}))
              AND (+provider_thread.thread_id = ${threadId}
               OR EXISTS (
                 SELECT 1 FROM orchestration_v2_projection_nodes AS node
                 WHERE node.node_id = provider_thread.owner_node_id AND node.thread_id = ${threadId}
               )
               OR EXISTS (
                 SELECT 1 FROM orchestration_v2_projection_subagents AS task
                 WHERE task.provider_thread_id = provider_thread.provider_thread_id
                   AND task.thread_id = ${threadId}
               ))`
            }
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id IN (SELECT value FROM json_each(${publicProviderThreadIds}))
            ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
            LIMIT 512
          `,
          fields !== undefined && !fields.includes("providerTurns")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
              ${filter?.providerTurnAttemptIds === undefined ? sql`` : sql`AND run_attempt_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnAttemptIds)}))`}
            ORDER BY provider_thread_id ASC, ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} AND provider_turn_id IN (
              SELECT provider_turn_id FROM (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns
                WHERE thread_id = ${threadId}
                  AND (provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds}))
                    OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
                ORDER BY ordinal DESC, provider_turn_id DESC LIMIT 512)
              UNION SELECT ${usageHead?.provider_turn_id ?? null})
            ORDER BY ordinal DESC, provider_turn_id DESC
          `,
          fields !== undefined && !fields.includes("runtimeRequests")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
            ORDER BY created_at ASC, runtime_request_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
              AND runtime_request_id IN (SELECT value FROM json_each(${publicRequestIds}))
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          fields !== undefined && !fields.includes("messages")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_messages
                WHERE ${filter?.messageIds === undefined && filter?.messageRunIds === undefined ? sql`thread_id = ${threadId}` : sql`+thread_id = ${threadId}`}
                  ${filter?.messageIds === undefined ? sql`` : sql`AND message_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageIds)}))`}
                  ${filter?.messageRoles === undefined ? sql`` : sql`AND role IN (SELECT value FROM json_each(${encodeIdList(filter.messageRoles)}))`}
                  ${filter?.messageRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageRunIds)}))`}
                ORDER BY created_at ASC, message_id ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_messages AS message
                WHERE message.thread_id = ${threadId}
                  AND (
                    message.message_id IN (
                      SELECT value FROM json_each(${cohortMessageIds})
                    )
                    OR message.message_id IN (
                      SELECT json_extract(payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND run_id IN (SELECT value FROM json_each(${publicRunIds}))
                    )
                  )
                ORDER BY created_at ASC, message_id ASC
              `,
          fields !== undefined && !fields.includes("plans")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} ORDER BY plan_id ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans AS plan
                WHERE plan.thread_id = ${threadId}
                  AND (
                    plan.plan_id IN (SELECT plan_id FROM orchestration_v2_projection_plans
                      WHERE thread_id = ${threadId} AND status = 'active' ORDER BY rowid DESC LIMIT 1)
                    OR plan.plan_id IN (
                      SELECT value FROM json_each(${cohortPlanIds})
                    )
                  )
                ORDER BY plan_id ASC
              `,
          fields !== undefined && !fields.includes("checkpointScopes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
              AND node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
            ORDER BY ordinal_within_parent ASC, scope_id ASC
            LIMIT 512
          `,
          fields !== undefined && !fields.includes("checkpoints")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
              AND (checkpoint_id IN (SELECT checkpoint_id FROM orchestration_v2_projection_checkpoints
                  WHERE thread_id = ${threadId} AND status IN ('pending','capturing') ORDER BY rowid DESC LIMIT 4)
                OR checkpoint_id IN (SELECT value FROM json_each(${cohortCheckpointIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY scope_id ASC, ordinal_within_scope ASC
            LIMIT 512
          `,
          fields !== undefined && !fields.includes("contextHandoffs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_context_handoffs
                WHERE thread_id = ${threadId} ORDER BY rowid ASC
              `
              : sql<PayloadRow>`
                SELECT json_set(json_remove(payload_json, '$.history', '$.delivery'), '$.summaryText', '') AS payload_json
                FROM orchestration_v2_projection_context_handoffs AS handoff
                WHERE handoff.thread_id = ${threadId}
                  AND (
                    handoff.context_handoff_id IN (SELECT context_handoff_id FROM orchestration_v2_projection_context_handoffs
                      WHERE thread_id = ${threadId} AND status IN ('pending','ready') ORDER BY rowid DESC LIMIT 1)
                    OR handoff.context_handoff_id IN (
                      SELECT value FROM json_each(${cohortHandoffIds})
                    )
                  )
                ORDER BY rowid ASC
              `,
          fields !== undefined && !fields.includes("contextTransfers")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_transfers
            WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
              ${filter?.contextTransferThreadIds === undefined ? sql`` : sql`AND (source_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferThreadIds)})) OR target_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferThreadIds)})))`}
              ${filter?.contextTransferSourceThreadId === undefined ? sql`` : sql`AND source_thread_id = ${filter.contextTransferSourceThreadId}`}
              ${filter?.contextTransferTargetThreadId === undefined ? sql`` : sql`AND target_thread_id = ${filter.contextTransferTargetThreadId}`}
              ${filter?.contextTransferTypes === undefined ? sql`` : sql`AND type IN ${sql.in(filter.contextTransferTypes)}`}
              ${filter?.contextTransferStatuses === undefined ? sql`` : sql`AND status IN ${sql.in(filter.contextTransferStatuses)}`}
              ${filter?.contextTransferRunIds === undefined ? sql`` : sql`AND (json_extract(payload_json, '$.sourcePoint.runId') IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferRunIds)})) OR json_extract(payload_json, '$.targetRunId') IN (SELECT value FROM json_each(${encodeIdList(filter.contextTransferRunIds)})))`}
            ORDER BY rowid ${filter?.contextTransferLimit === undefined ? sql`ASC` : sql`DESC`}
              ${filter?.contextTransferLimit === undefined ? sql`` : sql`LIMIT ${Math.max(1, Math.min(128, Math.trunc(filter.contextTransferLimit)))}`}
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_transfers
            WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
              AND json_extract(payload_json, '$.contextHandoffId') IN
                  (SELECT value FROM json_each(${cohortHandoffIds}))
            ORDER BY rowid ASC
            LIMIT 16
          `,
        ]);

        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          plans,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodePlanPayload, threadId)(planRows),
          decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
          decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
          decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
          decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
        ]);
        // A metadata read must preserve message ordering without decoding tool output.
        const messageOrdinals = new Map<string, number>();
        if (fields !== undefined && fields.includes("messages") && messages.length > 1) {
          const rows = yield* sql<{ message_id: string; ordinal: number }>`
            SELECT json_extract(payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
            FROM orchestration_v2_projection_turn_items
            WHERE thread_id = ${threadId} AND type IN ('user_message', 'assistant_message')
            GROUP BY json_extract(payload_json, '$.messageId')
          `;
          for (const row of rows) messageOrdinals.set(row.message_id, row.ordinal);
        }
        const orderedMessages = sortMessagesByTurnItemOrder(messages, turnItems, messageOrdinals);
        const projection = {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages: orderedMessages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
          visibleTurnItems: [],
          updatedAt: thread.updatedAt,
        } satisfies OrchestrationV2ThreadProjection;
        return projection;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({
                threadId,
                cause,
              }),
        ),
      );

    const readProjection = (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
      window?: {
        readonly rowLimit: number;
        readonly controlOnly?: boolean | undefined;
        readonly maxEncodedBytes?: number | undefined;
        readonly allowOversizedFirst?: boolean | undefined;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly anchorOrdinal?: number | undefined;
        readonly exclusiveAnchor?: boolean | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly requiredRequestId?: RuntimeRequestId | undefined;
        readonly requiredHistoryRevision?: number | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly historyOnly?: boolean | undefined;
        readonly historyAnchor?:
          | {
              readonly threadId: ThreadId;
              readonly itemId: TurnItemId;
              readonly ordinal?: number | undefined;
            }
          | undefined;
      },
    ): Effect.Effect<
      {
        readonly projection: OrchestrationV2ThreadProjection;
        readonly hasEarlierHistory: boolean;
      },
      ProjectionStoreV2Error
    > =>
      Effect.gen(function* () {
        const historyAnchor = window?.historyAnchor;
        const markerIsAnchor = historyAnchor?.itemId === `turn-item:fork:${threadId}`;
        const anchorPrecedesLocal =
          historyAnchor !== undefined && (historyAnchor.threadId !== threadId || markerIsAnchor);
        const localWindow =
          window?.suppressLocal === true || anchorPrecedesLocal
            ? { ...window, rowLimit: 0, anchorItemId: undefined }
            : window;
        // Ancestors contribute admitted history and its visibility evidence.
        // They never hydrate unrelated active/control state or a whole index.
        const projection = yield* readCanonicalProjection(
          threadId,
          localWindow,
          window?.controlOnly === true
            ? [
                "runs",
                "attempts",
                "nodes",
                "subagents",
                "providerSessions",
                "providerThreads",
                "providerTurns",
                "runtimeRequests",
              ]
            : window !== undefined && (seenThreadIds.size > 0 || window.historyOnly === true)
              ? ["runs", "attempts", "turnItems"]
              : undefined,
        );
        if (window?.controlOnly === true) return { projection, hasEarlierHistory: false };
        // SQL already applies the captured fork revision; only interrupt visibility
        // remains here, without reinterpreting the source's current Run status.
        const localProjection =
          window?.requiredRunId === undefined
            ? withLocalVisibleTurnItems(projection)
            : {
                ...projection,
                visibleTurnItems: renumberVisibleTurnItems(
                  inheritedVisibleTurnItemsFromLocalItems(
                    projection.turnItems.filter(
                      (item) =>
                        !isOrchestrationV2SupersededInterrupt({
                          item,
                          attempts: projection.attempts,
                          items: projection.turnItems,
                        }),
                    ),
                  ),
                ),
              };
        const oldestLocal = localProjection.visibleTurnItems[0];
        const omittedOversized =
          localWindow === undefined ||
          localWindow.rowLimit === 0 ||
          oldestLocal !== undefined ||
          localWindow.allowOversizedFirst !== false
            ? []
            : yield* sql<{ readonly present: number }>`
            SELECT 1 AS present FROM orchestration_v2_projection_turn_items AS item
            LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
            WHERE item.thread_id = ${threadId}
              AND item.ordinal <= COALESCE((SELECT ordinal FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId} AND turn_item_id = ${localWindow.anchorItemId ?? null} LIMIT 1), ${localWindow.anchorOrdinal ?? 9223372036854775807n})
              AND (${localWindow.exclusiveAnchor === true ? 1 : 0} = 0 OR item.ordinal < COALESCE((SELECT ordinal FROM orchestration_v2_projection_turn_items
                WHERE thread_id = ${threadId} AND turn_item_id = ${localWindow.anchorItemId ?? null} LIMIT 1), ${localWindow.anchorOrdinal ?? 9223372036854775807n}) OR item.turn_item_id < ${localWindow.anchorItemId ?? null})
              AND ${capturedRunVisibility(localWindow.requiredRunId === undefined ? null : (localWindow.requiredHistoryRevision ?? null))}
              AND (${localWindow.requiredRunId ?? null} IS NULL OR run.ordinal <= (SELECT ordinal FROM orchestration_v2_projection_runs
                WHERE thread_id = ${threadId} AND run_id = ${localWindow.requiredRunId ?? null} LIMIT 1)
                OR (item.run_id IS NULL AND ${hasImportedThreadHistory(projection.thread.historyOrigin) ? 1 : 0} = 1))
            LIMIT 1
          `;
        const prefix =
          localWindow === undefined || localWindow.rowLimit === 0 || oldestLocal === undefined
            ? []
            : yield* sql<{ readonly present: number }>`
            SELECT 1 AS present
            FROM orchestration_v2_projection_turn_items AS item
            LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
            WHERE item.thread_id = ${threadId}
              AND (item.ordinal < ${oldestLocal.item.ordinal}
                OR (item.ordinal = ${oldestLocal.item.ordinal} AND item.turn_item_id < ${oldestLocal.sourceItemId}))
              AND ${capturedRunVisibility(localWindow.requiredRunId === undefined ? null : (localWindow.requiredHistoryRevision ?? null))}
              AND (${localWindow.requiredRunId ?? null} IS NULL
                OR (item.run_id IS NULL AND ${hasImportedThreadHistory(projection.thread.historyOrigin) ? 1 : 0} = 1)
                OR run.ordinal <= (SELECT ordinal FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId} AND run_id = ${localWindow.requiredRunId ?? null} LIMIT 1))
            LIMIT 1
          `;
        const forkedFrom = projection.thread.forkedFrom;
        if (
          projection.thread.sideChat ||
          forkedFrom?.type !== "run" ||
          seenThreadIds.has(forkedFrom.threadId)
        ) {
          if (historyAnchor !== undefined && historyAnchor.threadId !== threadId)
            return yield* new ProjectionStoreReadError({
              threadId,
              cause: "History cursor is outside this Thread's lineage.",
            });
          return {
            projection: localProjection,
            hasEarlierHistory: prefix.length > 0 || omittedOversized.length > 0,
          };
        }
        // Finish a partial local suffix before attaching its inherited prefix.
        if (prefix.length > 0 || omittedOversized.length > 0)
          return { projection: localProjection, hasEarlierHistory: true };

        const includeMarker = !(window?.exclusiveAnchor === true && anchorPrecedesLocal);
        const marker = makeForkMarkerTurnItem({
          targetProjection: projection,
          sourceThreadId: forkedFrom.threadId,
          sourceRunId: forkedFrom.runId,
        });
        const local = localProjection.visibleTurnItems;
        const remainingRows =
          window === undefined
            ? undefined
            : Math.max(
                0,
                Math.min(window.rowLimit, THREAD_HISTORY_PAGE_POLICY.maxItems) -
                  local.length -
                  (includeMarker ? 1 : 0),
              );
        const remainingBytes =
          window === undefined
            ? undefined
            : Math.max(
                0,
                (window.maxEncodedBytes ?? THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes) -
                  Buffer.byteLength(JSON.stringify(local.map((row) => row.item)), "utf8") -
                  (includeMarker ? Buffer.byteLength(JSON.stringify(marker), "utf8") : 0),
              );
        const remainingTurns =
          window?.userTurnLimit === undefined
            ? undefined
            : Math.max(
                0,
                window.userTurnLimit -
                  local.filter((row) => isThreadHistoryUserTurn(row.item)).length,
              );
        if (
          window !== undefined &&
          (remainingRows === 0 || remainingBytes === 0 || remainingTurns === 0)
        ) {
          const rows =
            includeMarker && local.length < window.rowLimit
              ? [
                  {
                    visibility: "synthetic" as const,
                    sourceThreadId: forkedFrom.threadId,
                    sourceItemId: marker.id,
                    item: marker,
                  },
                  ...local,
                ]
              : local;
          return {
            projection: { ...projection, visibleTurnItems: renumberVisibleTurnItems(rows) },
            hasEarlierHistory: true,
          };
        }
        const sourceWindow =
          window === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const anchorBelongsToSource =
                  !markerIsAnchor && historyAnchor?.threadId === forkedFrom.threadId;
                const boundary = yield* sql<{
                  readonly ordinal: number;
                  readonly turn_item_id: string | null;
                }>`
            WITH fork_run AS (
              SELECT ordinal FROM orchestration_v2_projection_runs
              WHERE thread_id = ${forkedFrom.threadId} AND run_id = ${forkedFrom.runId} LIMIT 1
            ), fork_boundary AS (
              SELECT (SELECT item.ordinal FROM orchestration_v2_projection_turn_items AS item
                WHERE item.run_id = run.run_id ORDER BY item.ordinal DESC LIMIT 1) AS ordinal
              FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = ${forkedFrom.threadId}
                AND run.ordinal <= (SELECT ordinal FROM fork_run)
                AND ${capturedRunVisibility(forkedFrom.sourceHistoryRevision ?? null)}
                AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item WHERE item.run_id = run.run_id LIMIT 1)
              ORDER BY run.ordinal DESC LIMIT 1
            ), effective_boundary AS (
              SELECT COALESCE((SELECT ordinal FROM fork_boundary),
                (SELECT ordinal FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${forkedFrom.threadId} AND run_id IS NULL
                    AND EXISTS (SELECT 1 FROM orchestration_v2_projection_threads
                      WHERE thread_id = ${forkedFrom.threadId} AND json_extract(payload_json, '$.historyOrigin') IN ('v1_import', 'native_import'))
                  ORDER BY ordinal DESC, turn_item_id DESC LIMIT 1), -1) AS ordinal
            )
            SELECT ordinal, (SELECT turn_item_id FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${forkedFrom.threadId} AND ordinal <= effective_boundary.ordinal
              ORDER BY ordinal DESC, turn_item_id DESC LIMIT 1) AS turn_item_id
            FROM effective_boundary
          `;
                const boundaryOrdinal = boundary[0]?.ordinal ?? -1;
                const boundaryId = boundary[0]?.turn_item_id;
                const cursorOrdinal = anchorBelongsToSource ? historyAnchor.ordinal : undefined;
                const cursorIsWithinBoundary =
                  cursorOrdinal === undefined || cursorOrdinal <= boundaryOrdinal;
                const deeperAnchor =
                  !markerIsAnchor &&
                  historyAnchor !== undefined &&
                  historyAnchor.threadId !== threadId &&
                  historyAnchor.threadId !== forkedFrom.threadId;
                return {
                  rowLimit: remainingRows!,
                  maxEncodedBytes: remainingBytes!,
                  userTurnLimit: remainingTurns,
                  allowOversizedFirst:
                    window.allowOversizedFirst !== false && local.length === 0 && !includeMarker,
                  requiredRunId: forkedFrom.runId,
                  requiredHistoryRevision: forkedFrom.sourceHistoryRevision,
                  historyOnly: true,
                  suppressLocal: boundaryId === null || boundaryId === undefined || deeperAnchor,
                  anchorItemId:
                    anchorBelongsToSource && cursorIsWithinBoundary
                      ? historyAnchor.itemId
                      : boundaryId === null || boundaryId === undefined
                        ? undefined
                        : TurnItemId.make(boundaryId),
                  anchorOrdinal:
                    anchorBelongsToSource && cursorIsWithinBoundary
                      ? (cursorOrdinal ?? boundaryOrdinal)
                      : boundaryOrdinal,
                  exclusiveAnchor:
                    anchorBelongsToSource && cursorIsWithinBoundary
                      ? window.exclusiveAnchor
                      : false,
                  historyAnchor:
                    historyAnchor === undefined ||
                    historyAnchor.threadId === threadId ||
                    markerIsAnchor
                      ? undefined
                      : historyAnchor,
                };
              });
        const source = yield* readProjection(
          forkedFrom.threadId,
          new Set([...seenThreadIds, threadId]),
          sourceWindow,
        );
        const visibleTurnItems =
          window?.exclusiveAnchor === true && anchorPrecedesLocal
            ? renumberVisibleTurnItems(
                source.projection.visibleTurnItems.map((row) => ({
                  ...row,
                  visibility: "inherited" as const,
                })),
              )
            : buildVisibleTurnItems({
                projection,
                sourceProjection: source.projection,
                ...(window === undefined ? {} : { localItems: localProjection.visibleTurnItems }),
              });
        return {
          projection: { ...projection, visibleTurnItems },
          hasEarlierHistory: source.hasEarlierHistory,
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getLimitRecoveryCandidates = Effect.fn("ProjectionStore.getLimitRecoveryCandidates")(
      function* (options: Parameters<ProjectionStoreV2Shape["getLimitRecoveryCandidates"]>[0]) {
        // Indexed latest-run and root-error lookups avoid reading run histories,
        // counting transcript items, or walking fork ancestors on scheduler ticks.
        const rows = yield* sql<{
          readonly payload_json: string;
          readonly run_id: string;
          readonly completed_at: string | null;
          readonly failure_payload_json: string;
          readonly last_error: string | null;
        }>`
          SELECT t.payload_json, r.run_id, r.completed_at,
            item.payload_json AS failure_payload_json,
            (
              SELECT json_extract(session.payload_json, '$.lastError')
              -- Keep bindings outermost: one provider instance can hold every session.
              FROM orchestration_v2_projection_provider_session_bindings binding
              CROSS JOIN orchestration_v2_projection_provider_sessions session
                ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = t.thread_id
                AND session.provider_instance_id = t.provider_instance_id
              ORDER BY session.updated_at DESC, session.provider_session_id DESC
              LIMIT 1
            ) AS last_error
          FROM orchestration_v2_projection_threads t
          INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
            SELECT latest.run_id FROM orchestration_v2_projection_runs latest
            WHERE latest.thread_id = t.thread_id
              AND latest.status <> 'queued'
              AND NOT (
                latest.status = 'cancelled'
                AND json_extract(latest.payload_json, '$.startedAt') IS NULL
              )
            -- latestExecutedRun: the run that ended last (runRanAfter).
            ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
              latest.ordinal DESC, latest.run_id DESC
            LIMIT 1
          ) AND r.status = 'failed'
          INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
            SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
            WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
              AND error.type = 'error' AND error.status = 'failed'
              AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
            ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
            LIMIT 1
          )
          WHERE t.deleted_at IS NULL
            AND json_extract(t.payload_json, '$.archivedAt') IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
            AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
            AND json_extract(item.payload_json, '$.failure.resetAt') IS NOT NULL
            AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(COALESCE(r.completed_at, json_extract(t.payload_json, '$.updatedAt')))
            AND (
              (
                json_extract(t.payload_json, '$.limitRecovery.runId') IS r.run_id
                AND json_extract(t.payload_json, '$.limitRecovery.resetAt') IS json_extract(item.payload_json, '$.failure.resetAt')
                AND json_extract(t.payload_json, '$.limitRecovery.autoResume') = 1
                AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) <= julianday(${DateTime.formatIso(options.now)})
                AND (
                  json_extract(t.payload_json, '$.snoozedUntil') IS NULL
                  OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(options.now)})
                )
              )
              OR (
                (
                  json_extract(t.payload_json, '$.limitRecovery.runId') IS NOT r.run_id
                  OR json_extract(t.payload_json, '$.limitRecovery.resetAt') IS NOT json_extract(item.payload_json, '$.failure.resetAt')
                )
                AND (
                  ${booleanInt(options.autoResume)}
                  OR (${booleanInt(options.snooze)} AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(options.now)}))
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
          ORDER BY t.thread_id
        `;
        const candidates: Array<ProjectionLimitRecoveryCandidate> = [];
        for (const row of rows) {
          const thread = yield* decodeThreadPayload(row.payload_json);
          const item = yield* decodeTurnItemPayload(row.failure_payload_json);
          const summary = threadErrorSummary(
            item.type === "error" ? item.failure : null,
            row.last_error,
          );
          if (summary.lastErrorClass !== "usage_limit") continue;
          candidates.push({
            id: thread.id,
            status: "failed",
            lastErrorClass: summary.lastErrorClass,
            usageLimitResetAt: summary.usageLimitResetAt,
            latestRunId: RunId.make(row.run_id),
            latestRunCompletedAt:
              row.completed_at === null ? null : DateTime.makeUnsafe(row.completed_at),
            updatedAt: thread.updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: thread.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: thread.limitRecovery ?? null,
            snoozedUntil: thread.snoozedUntil ?? null,
          });
        }
        return candidates;
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    const getRecoveryThreadIds = Effect.fn("ProjectionStore.getRecoveryThreadIds")(
      function* (kind: ProjectionRecoveryKind) {
        const candidates = recoveryCandidateThreadIds(sql, kind);
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            AND thread_id IN (${candidates})
            ${kind === "queued-runs" ? sql`AND archived_at IS NULL` : sql``}
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return rows.map((row) => ThreadId.make(row.thread_id));
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // Decode every canonical row once. Full thread reads repeat shared sessions,
    // provider threads, transfers, and inherited fork histories for each owner.
    const getUnreadableThreadIds = Effect.fn("ProjectionStore.getUnreadableThreadIds")(
      function* () {
        const actualThreadIds = new Set<ThreadId>();
        const unreadable = new Set<ThreadId>();
        const forkChildren = new Map<ThreadId, Array<ThreadId>>();
        const tables: ReadonlyArray<{
          readonly name: string;
          readonly id: string;
          readonly decode: (payload: string, entityId: string) => Effect.Effect<unknown, unknown>;
        }> = [
          {
            name: "threads",
            id: "thread_id",
            decode: (payload: string, entityId: string) =>
              decodeThreadPayload(payload).pipe(
                Effect.tap((thread) =>
                  Effect.sync(() => {
                    if (thread.forkedFrom?.type !== "run") return;
                    const sourceId = thread.forkedFrom.threadId;
                    const children = forkChildren.get(sourceId) ?? [];
                    children.push(ThreadId.make(entityId));
                    forkChildren.set(sourceId, children);
                  }),
                ),
              ),
          },
          { name: "runs", id: "run_id", decode: (payload) => decodeRunPayload(payload) },
          {
            name: "run_attempts",
            id: "attempt_id",
            decode: (payload) => decodeRunAttemptPayload(payload),
          },
          { name: "nodes", id: "node_id", decode: (payload) => decodeNodePayload(payload) },
          {
            name: "subagents",
            id: "subagent_id",
            decode: (payload) => decodeSubagentPayload(payload),
          },
          {
            name: "provider_sessions",
            id: "provider_session_id",
            decode: (payload) => decodeProviderSessionPayload(payload),
          },
          {
            name: "provider_threads",
            id: "provider_thread_id",
            decode: (payload) => decodeProviderThreadPayload(payload),
          },
          {
            name: "provider_turns",
            id: "provider_turn_id",
            decode: (payload) => decodeProviderTurnPayload(payload),
          },
          {
            name: "runtime_requests",
            id: "runtime_request_id",
            decode: (payload) => decodeRuntimeRequestPayload(payload),
          },
          {
            name: "messages",
            id: "message_id",
            decode: (payload) => decodeMessagePayload(payload),
          },
          { name: "plans", id: "plan_id", decode: decodePlanPayload },
          {
            name: "turn_items",
            id: "turn_item_id",
            decode: (payload) => decodeTurnItemPayload(payload),
          },
          {
            name: "checkpoint_scopes",
            id: "scope_id",
            decode: (payload) => decodeCheckpointScopePayload(payload),
          },
          {
            name: "checkpoints",
            id: "checkpoint_id",
            decode: (payload) => decodeCheckpointPayload(payload),
          },
          {
            name: "context_handoffs",
            id: "context_handoff_id",
            decode: (payload) => decodeContextHandoffPayload(payload),
          },
          {
            name: "context_transfers",
            id: "context_transfer_id",
            decode: (payload) => decodeContextTransferPayload(payload),
          },
        ];
        const pageSize = 500;
        for (const table of tables) {
          let afterRowId = 0;
          while (true) {
            const rows = yield* sql<{
              readonly row_id: number;
              readonly entity_id: string;
              readonly thread_id: string | null;
              readonly target_thread_id: string | null;
              readonly payload_json: string;
            }>`
              SELECT rowid AS row_id, ${sql(table.id)} AS entity_id,
                ${sql(table.name === "context_transfers" ? "source_thread_id" : "thread_id")} AS thread_id,
                ${table.name === "context_transfers" ? sql`target_thread_id` : sql`NULL`} AS target_thread_id,
                payload_json
              FROM ${sql(`orchestration_v2_projection_${table.name}`)}
              WHERE rowid > ${afterRowId}
              ORDER BY rowid ASC LIMIT ${pageSize}
            `;
            for (const row of rows) {
              if (table.name === "threads") actualThreadIds.add(ThreadId.make(row.entity_id));
              const decoded = yield* Effect.exit(
                Effect.suspend(() => table.decode(row.payload_json, row.entity_id)),
              );
              if (decoded._tag === "Success") continue;
              if (table.name === "provider_sessions") {
                const bindings = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
                  WHERE provider_session_id = ${row.entity_id}
                `;
                for (const binding of bindings) unreadable.add(ThreadId.make(binding.thread_id));
              } else {
                if (row.thread_id !== null) unreadable.add(ThreadId.make(row.thread_id));
                if (row.target_thread_id !== null)
                  unreadable.add(ThreadId.make(row.target_thread_id));
              }
              if (table.name === "provider_threads") {
                const owners = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_nodes
                  WHERE node_id = (
                    SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
                    WHERE provider_thread_id = ${row.entity_id}
                  )
                  UNION
                  SELECT thread_id FROM orchestration_v2_projection_subagents
                  WHERE provider_thread_id = ${row.entity_id}
                `;
                for (const owner of owners) unreadable.add(ThreadId.make(owner.thread_id));
              }
            }
            if (rows.length < pageSize) break;
            afterRowId = rows[rows.length - 1]!.row_id;
            yield* Effect.yieldNow;
          }
        }
        // A full fork projection also reads its source. Propagate decode failures
        // and missing sources through the same ancestry without loading history.
        const pending = [
          ...unreadable,
          ...[...forkChildren.keys()].filter((sourceId) => !actualThreadIds.has(sourceId)),
        ];
        for (let index = 0; index < pending.length; index += 1) {
          for (const childId of forkChildren.get(pending[index]!) ?? []) {
            if (unreadable.has(childId)) continue;
            unreadable.add(childId);
            pending.push(childId);
          }
        }
        return [...unreadable].filter((threadId) => actualThreadIds.has(threadId)).sort();
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // SQLite trim defaults to ASCII spaces; compact recognition uses JavaScript trim.
    const javascriptTrimWhitespace =
      " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

    // Startup reads one execution plus exact native/model heads. Historical proofs
    // stay in SQL; completed tool bodies and unrelated user prompts never cross this seam.
    const getTurnStartContext: ProjectionStoreV2Shape["getTurnStartContext"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const currentRuns =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id = ${runId}`.pipe(
                Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
              );
            const run = currentRuns[0];
            const providerId = run?.providerThreadId ?? null;
            const previousNative =
              yield* sql<PayloadRow>`SELECT r.payload_json FROM orchestration_v2_projection_runs r
          JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = r.provider_thread_id
          WHERE r.thread_id = ${threadId} AND r.ordinal < ${run?.ordinal ?? 0}
            AND p.owner_node_id IS NULL AND json_extract(p.payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
          ORDER BY r.ordinal DESC LIMIT 1`.pipe(
                Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
              );
            const previousStarted =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND provider_thread_id = ${providerId} AND ordinal < ${run?.ordinal ?? 0}
            AND json_extract(payload_json, '$.startedAt') IS NOT NULL
          ORDER BY ordinal DESC LIMIT 1`.pipe(
                Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
              );
            const providerTurns =
              yield* sql<PayloadRow>`SELECT t.payload_json FROM orchestration_v2_projection_provider_turns t
          JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
          JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = t.provider_thread_id
          WHERE t.thread_id = ${threadId} AND t.provider_thread_id = ${providerId}
            AND a.provider_thread_id = t.provider_thread_id AND a.root_node_id = t.node_id
            AND json_extract(a.payload_json, '$.nativeThreadId') = json_extract(p.payload_json, '$.nativeThreadRef.nativeId')
            AND json_extract(t.payload_json, '$.tokenUsage') IS NOT NULL
          ORDER BY json_extract(t.payload_json, '$.tokenUsage.updatedAt') DESC, t.ordinal DESC LIMIT 1`.pipe(
                Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)),
              );
            const attempts =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
          WHERE thread_id = ${threadId} AND attempt_id IN ${sql.in([run?.activeAttemptId ?? null, ...providerTurns.map((t) => t.runAttemptId)])}
          ORDER BY attempt_ordinal ASC`.pipe(
                Effect.flatMap(decodeRows(decodeRunAttemptPayload, threadId)),
              );
            const telemetryRuns =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id IN ${sql.in(attempts.filter((a) => a.id !== run?.activeAttemptId).map((a) => a.runId))}`.pipe(
                Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
              );
            const handoffHeads = yield* sql<{ ids_json: string; total: number }>`WITH eligible AS (
          SELECT h.context_handoff_id AS id, h.target_run_id, h.rowid AS position, length(CAST(h.payload_json AS BLOB)) AS bytes
          FROM orchestration_v2_projection_context_handoffs h INDEXED BY orchestration_v2_ready_handoff_bytes_idx
          WHERE h.thread_id = ${threadId} AND h.status = 'ready'
            AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_threads p
              WHERE p.provider_thread_id = ${providerId} AND h.to_provider_thread_id = p.provider_thread_id
                AND json_extract(h.payload_json,'$.delivery.nativeThreadId') = json_extract(p.payload_json,'$.nativeThreadRef.nativeId')
                AND json_extract(h.payload_json,'$.delivery.status') <> 'pending')
            AND (h.target_run_id = ${runId} OR (h.to_provider_thread_id = ${providerId} AND EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_messages m
                ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
              WHERE r.run_id = h.target_run_id AND (r.status IN ('failed','interrupted')
                OR (r.status = 'completed' AND COALESCE(json_type(h.payload_json, '$.delivery'),'null') = 'null'
                  AND lower(trim(json_extract(m.payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact'
                  AND json_array_length(m.payload_json, '$.attachments') = 0)))))
          ), heads AS (SELECT * FROM eligible ORDER BY (target_run_id = ${runId}) DESC, position DESC LIMIT 256),
          admitted AS (SELECT *, SUM(CASE WHEN bytes <= 262144 THEN bytes ELSE 0 END)
            OVER(ORDER BY (target_run_id = ${runId}) DESC, position DESC) AS cumulative FROM heads)
          SELECT (SELECT COUNT(*) FROM eligible) AS total,
            (SELECT json_group_array(id) FROM admitted WHERE bytes <= 262144 AND cumulative <= 262144) AS ids_json`;
            const handoffIds = JSON.parse(handoffHeads[0]?.ids_json ?? "[]") as string[];
            const contextHandoffs =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_context_handoffs
          WHERE thread_id = ${threadId} AND context_handoff_id IN ${sql.in(handoffIds)} ORDER BY rowid ASC`.pipe(
                Effect.flatMap(decodeRows(decodeContextHandoffPayload, threadId)),
              );
            const omittedHandoffCount = (handoffHeads[0]?.total ?? 0) - contextHandoffs.length;
            const handoffRuns =
              yield* sql<PayloadRow>`SELECT json_remove(payload_json, '$.restartCancelledBackgroundWork', '$.delegatedCompletion') AS payload_json
          FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
            AND run_id IN ${sql.in(contextHandoffs.map((h) => h.targetRunId))}`.pipe(
                Effect.flatMap(decodeRows(decodeRunPayload, threadId)),
              );
            const runs = [
              ...new Map(
                [
                  ...handoffRuns,
                  ...previousNative,
                  ...previousStarted,
                  ...telemetryRuns,
                  ...currentRuns,
                ].map((r) => [r.id, r]),
              ).values(),
            ].sort((a, b) => a.ordinal - b.ordinal);
            const nodes =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`.pipe(
                Effect.flatMap(decodeRows(decodeNodePayload, threadId)),
              );
            const checkpointScopes =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
          WHERE thread_id = ${threadId} AND scope_id IN ${sql.in(nodes.flatMap((n) => (n.checkpointScopeId === null ? [] : [n.checkpointScopeId])))}`.pipe(
                Effect.flatMap(decodeRows(decodeCheckpointScopePayload, threadId)),
              );
            const providerThreads =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${threadId} AND provider_thread_id IN ${sql.in([providerId, previousNative[0]?.providerThreadId ?? null, thread.activeProviderThreadId])}`.pipe(
                Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)),
              );
            const providerSessions =
              yield* sql<PayloadRow>`SELECT s.payload_json FROM orchestration_v2_projection_provider_sessions s
          JOIN orchestration_v2_projection_provider_session_bindings b ON b.provider_session_id = s.provider_session_id
          WHERE b.thread_id = ${threadId} AND s.provider_session_id IN ${sql.in(providerThreads.filter((p) => p.id === providerId).map((p) => p.providerSessionId))}`.pipe(
                Effect.flatMap(decodeRows(decodeProviderSessionPayload, threadId)),
              );
            const subagents: ReadonlyArray<OrchestrationV2Subagent> = [];
            const contextTransfers =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_context_transfers
          WHERE target_thread_id = ${threadId} AND target_run_id = ${runId} AND type = 'fork' AND status = 'pending'
            AND json_extract(payload_json, '$.resolution') IS NULL ORDER BY rowid ASC LIMIT 1`.pipe(
                Effect.flatMap(decodeRows(decodeContextTransferPayload, threadId)),
              );
            const messages =
              yield* sql<PayloadRow>`SELECT CASE WHEN message_id = ${run?.userMessageId ?? null} THEN payload_json
            ELSE json_set(json_remove(payload_json, '$.context', '$.delegatedCompletion'), '$.text', '/compact', '$.attachments', json('[]')) END AS payload_json
          FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND (
            message_id = ${run?.userMessageId ?? null} OR message_id IN ${sql.in(handoffRuns.filter((r) => r.status === "completed").map((r) => r.userMessageId))})`.pipe(
                Effect.flatMap(decodeRows(decodeMessagePayload, threadId)),
              );
            const facts = yield* sql<{
              has_conversation: number;
              next_item: number;
              next_turn: number;
              uncertain: number;
            }>`
          SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND role = 'user'
            AND (lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) <> '/compact'
              OR json_array_length(payload_json, '$.attachments') > 0)) AS has_conversation,
          (SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}) AS next_item,
          (SELECT COALESCE(MAX(ordinal),0)+1 FROM orchestration_v2_projection_provider_turns WHERE provider_thread_id = ${providerId}) AS next_turn,
          EXISTS(SELECT 1 FROM orchestration_v2_projection_context_handoffs h
            JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = h.to_provider_thread_id
            WHERE h.thread_id = ${threadId} AND h.to_provider_thread_id = ${providerId}
              AND json_extract(h.payload_json, '$.delivery.status') = 'pending'
              AND json_extract(h.payload_json, '$.delivery.nativeThreadId') = json_extract(p.payload_json, '$.nativeThreadRef.nativeId')) AS uncertain`;
            const restart = yield* readRestartNoteState(threadId, runId);
            return {
              thread,
              runs,
              attempts,
              nodes,
              subagents,
              providerThreads,
              providerTurns,
              checkpointScopes,
              contextHandoffs,
              contextTransfers,
              turnItems: [],
              providerSessions,
              messages,
              omittedHandoffCount,
              hasConversation: facts[0]?.has_conversation === 1,
              nextTurnItemOrdinal: facts[0]?.next_item ?? 1,
              providerTurnOrdinal: facts[0]?.next_turn ?? 1,
              uncertainDelivery: facts[0]?.uncertain === 1,
              restartNoteState: restart,
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const readRestartNoteState = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
      const existingWork = yield* sql<{
        present: number;
      }>`SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND json_array_length(payload_json,'$.restartCancelledBackgroundWork') > 0) AS present`;
      if (existingWork[0]?.present !== 1) return { continuation: false, work: [], totalWork: 0 };
      const rows = yield* sql<{ continuation: number; work_json: string; total: number }>`
        WITH RECURSIVE r AS (
          SELECT run_id AS id, ordinal, provider_thread_id AS provider, status, completed_at,
            json_extract(payload_json, '$.activeAttemptId') AS active,
            json_extract(payload_json, '$.restartContinuationOfRunId') AS parent,
            json_extract(payload_json, '$.restartCancelledBackgroundWork') AS work,
            EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m
              WHERE m.message_id = json_extract(k.payload_json, '$.userMessageId')
                AND lower(trim(json_extract(m.payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact'
                AND json_array_length(m.payload_json, '$.attachments') = 0) AS compact
          FROM orchestration_v2_projection_runs k WHERE thread_id = ${threadId}
        ), completed AS (
          SELECT DISTINCT a.run_id, t.run_attempt_id, t.provider_thread_id FROM orchestration_v2_projection_provider_turns t
            LEFT JOIN orchestration_v2_projection_run_attempts a ON a.attempt_id = t.run_attempt_id
            WHERE t.thread_id = ${threadId} AND t.status = 'completed'
        ), chain(origin, source) AS (
          SELECT id, parent FROM r WHERE parent IS NOT NULL
          UNION
          SELECT chain.origin, r.parent FROM chain JOIN r ON r.id = chain.source
            WHERE r.parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM completed c WHERE c.run_id = r.id OR c.run_attempt_id = r.active)
        ), notes AS (
          SELECT DISTINCT chain.origin FROM chain JOIN r ON r.id = chain.source WHERE json_array_length(r.work) > 0
        ), current AS (SELECT * FROM r WHERE id = ${runId}), prompted AS (
          SELECT r.* FROM r, current WHERE r.provider = current.provider AND r.id <> current.id AND r.active IS NOT NULL
            AND r.status <> 'rolled_back' AND r.compact = 0 AND (r.parent IS NULL OR EXISTS(SELECT 1 FROM notes WHERE origin = r.id))
            AND EXISTS(SELECT 1 FROM completed c WHERE (c.run_id = r.id OR c.run_attempt_id = r.active) AND c.provider_thread_id = current.provider)
        ), pending AS (
          SELECT r.* FROM r, current WHERE r.provider = current.provider AND current.parent IS NULL AND current.compact = 0
            AND json_array_length(r.work) > 0
            AND (COALESCE(current.completed_at,'9999') > COALESCE(r.completed_at,'9999')
              OR (current.completed_at IS r.completed_at AND current.ordinal > r.ordinal)
              OR (current.completed_at = r.completed_at AND current.ordinal > r.ordinal))
            AND NOT EXISTS(SELECT 1 FROM completed c WHERE c.run_id = current.id AND c.run_attempt_id IS NOT current.active AND c.provider_thread_id = current.provider)
            AND NOT EXISTS(SELECT 1 FROM prompted p WHERE COALESCE(p.completed_at,'9999') > COALESCE(r.completed_at,'9999')
              OR (p.completed_at IS r.completed_at AND p.ordinal > r.ordinal)
              OR (p.completed_at = r.completed_at AND p.ordinal > r.ordinal))
        ), work AS (
          SELECT j.value, ROW_NUMBER() OVER(PARTITION BY COALESCE(json_extract(j.value,'$.id'), json_extract(j.value,'$.kind') || char(0) || json_extract(j.value,'$.label'))
            ORDER BY pending.ordinal, CAST(j.key AS INTEGER)) AS duplicate, pending.ordinal, CAST(j.key AS INTEGER) AS position
          FROM pending, json_each(pending.work) j
        ) SELECT EXISTS(SELECT 1 FROM notes WHERE origin = ${runId}) AS continuation,
          (SELECT COUNT(*) FROM work WHERE duplicate = 1) AS total,
          (SELECT json_group_array(json(value)) FROM (SELECT json_object('kind',json_extract(value,'$.kind'),'label',substr(json_extract(value,'$.label'),1,160)) AS value FROM work WHERE duplicate = 1 ORDER BY ordinal, position LIMIT 10)) AS work_json`;
      const row = rows[0];
      return {
        continuation: row?.continuation === 1,
        work: JSON.parse(row?.work_json ?? "[]") as NonNullable<
          OrchestrationV2Run["restartCancelledBackgroundWork"]
        >,
        totalWork: row?.total ?? 0,
      };
    });

    const hasNativeTurns: ProjectionStoreV2Shape["hasNativeTurns"] = (input) => {
      const accepted = sql`a.thread_id = ${input.threadId} AND a.provider_thread_id = ${input.providerThreadId}
        AND EXISTS(SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id = a.run_id AND r.status <> 'rolled_back')
        AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t
          WHERE t.thread_id = ${input.threadId} AND t.run_attempt_id = a.attempt_id)`;
      return sql<{ present: number }>`SELECT (
        EXISTS(SELECT 1 FROM orchestration_v2_projection_run_attempts a WHERE ${accepted}
          AND json_extract(a.payload_json,'$.nativeThreadId') = ${input.nativeThreadId})
        OR (${input.sameNativeThread ? 1 : 0}
          AND EXISTS(SELECT 1 FROM orchestration_v2_projection_run_attempts a WHERE ${accepted}
            AND json_extract(a.payload_json,'$.nativeThreadId') IS NULL)
          AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_run_attempts a WHERE ${accepted}
            AND json_extract(a.payload_json,'$.nativeThreadId') IS NOT NULL))) AS present`.pipe(
        Effect.map((rows) => rows[0]?.present === 1),
        Effect.mapError(controlReadError(input.threadId)),
      );
    };

    const getDeliveredHandoffItemIds: ProjectionStoreV2Shape["getDeliveredHandoffItemIds"] = (
      input,
    ) =>
      sql<{
        item_id: string;
      }>`SELECT value AS item_id FROM json_each(${encodeIdList(input.itemIds)}) candidate
        WHERE EXISTS(SELECT 1 FROM orchestration_v2_projection_context_handoffs h INDEXED BY orchestration_v2_handoff_delivery_metadata_idx
          WHERE h.thread_id = ${input.threadId} AND h.to_provider_thread_id = ${input.providerThreadId}
            AND json_extract(h.payload_json,'$.delivery.nativeThreadId') = ${input.nativeThreadId}
            AND json_extract(h.payload_json,'$.delivery.status') <> 'pending'
            AND EXISTS(SELECT 1 FROM json_each(json_extract(h.payload_json,'$.delivery.itemIds')) delivered WHERE delivered.value = candidate.value))`.pipe(
        Effect.map((rows) => rows.map((row) => TurnItemId.make(row.item_id))),
        Effect.mapError(controlReadError(input.threadId)),
      );

    const getNativeContextEstimate: ProjectionStoreV2Shape["getNativeContextEstimate"] = (input) =>
      sql<{ estimate: number }>`WITH settled AS (
        SELECT json_extract(payload_json,'$.delivery.itemIds') AS item_ids,
          json_extract(payload_json,'$.delivery.omittedItemIds') AS omitted_ids,
          json_extract(payload_json,'$.fromProviderThreadIds') AS from_ids,
          json_extract(payload_json,'$.coveredRunOrdinals.from') AS covered_from,
          json_extract(payload_json,'$.coveredRunOrdinals.to') AS covered_to, strategy
          FROM orchestration_v2_projection_context_handoffs INDEXED BY orchestration_v2_handoff_delivery_metadata_idx
        WHERE thread_id = ${input.threadId} AND to_provider_thread_id = ${input.providerThreadId}
          AND json_extract(payload_json,'$.delivery.nativeThreadId') = ${input.nativeThreadId}
          AND json_extract(payload_json,'$.delivery.status') <> 'pending'
      ), delivered AS (SELECT DISTINCT j.value AS id FROM settled h, json_each(h.item_ids) j),
      covered AS (SELECT id FROM delivered UNION SELECT j.value FROM settled h, json_each(h.omitted_ids) j),
      accepted AS (
        SELECT a.run_id, json_extract(a.payload_json,'$.nativeThreadId') AS native_id
        FROM orchestration_v2_projection_run_attempts a INDEXED BY orchestration_v2_attempt_native_identity_idx WHERE a.thread_id = ${input.threadId} AND a.provider_thread_id = ${input.providerThreadId}
          AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t WHERE t.thread_id = ${input.threadId} AND t.run_attempt_id = a.attempt_id)
      ), items AS (
        SELECT i.turn_item_id, i.run_id, i.provider_thread_id, i.type,
          i.historical_text_bytes, i.native_attachment_allowance, r.ordinal AS run_ordinal
        FROM orchestration_v2_projection_turn_items i INDEXED BY orchestration_v2_native_item_occupancy_idx LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = i.run_id
        WHERE i.thread_id = ${input.threadId} AND (i.run_id IS NULL OR i.run_id <> ${input.runId})
          AND (r.status IS NULL OR r.status <> 'rolled_back')
          AND (i.provider_thread_id = ${input.providerThreadId} OR EXISTS(SELECT 1 FROM delivered d WHERE d.id = i.turn_item_id))
          AND (r.run_id IS NULL OR NOT(COALESCE(r.provider_thread_id = ${input.providerThreadId},0) AND r.status IN ('failed','interrupted')
            AND NOT EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t WHERE t.thread_id = ${input.threadId} AND t.run_attempt_id = json_extract(r.payload_json,'$.activeAttemptId'))
            AND NOT EXISTS(SELECT 1 FROM delivered d WHERE d.id = i.turn_item_id)))
      ) SELECT COALESCE(SUM(items.historical_text_bytes + CASE WHEN items.type = 'user_message'
        AND items.provider_thread_id = ${input.providerThreadId} AND items.run_id IS NOT NULL
        AND (EXISTS(SELECT 1 FROM accepted a WHERE a.run_id = items.run_id AND a.native_id = ${input.nativeThreadId})
          OR (EXISTS(SELECT 1 FROM accepted a WHERE a.run_id = items.run_id AND a.native_id IS NULL)
            AND NOT EXISTS(SELECT 1 FROM covered c WHERE c.id = items.turn_item_id)
            AND NOT EXISTS(SELECT 1 FROM settled h WHERE h.strategy = 'full_thread_summary'
              AND EXISTS(SELECT 1 FROM json_each(h.from_ids) p WHERE p.value = ${input.providerThreadId})
              AND items.run_ordinal BETWEEN h.covered_from AND h.covered_to)))
        THEN items.native_attachment_allowance ELSE 0 END),0) AS estimate FROM items`.pipe(
        Effect.map((rows) => rows[0]?.estimate ?? 0),
        Effect.mapError(controlReadError(input.threadId)),
      );

    const getRelatedNativeThread: ProjectionStoreV2Shape["getRelatedNativeThread"] = (input) => {
      if (
        input.address.subagentId === undefined &&
        input.address.threadId === undefined &&
        input.address.providerThreadId === undefined
      )
        return Effect.succeed(null);
      return sql<{
        subagent_id: string;
        child_thread_id: string | null;
        provider_thread_id: string | null;
        run_id: string;
      }>`SELECT s.subagent_id, s.child_thread_id, s.provider_thread_id, r.run_id
        FROM orchestration_v2_projection_subagents s
        LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = s.run_id
        LEFT JOIN orchestration_v2_projection_provider_threads child ON child.provider_thread_id = s.provider_thread_id
        WHERE s.thread_id = ${input.threadId} AND s.origin = 'provider_native'
          AND ${input.address.subagentId === undefined ? sql`s.status = 'completed'` : sql`1`}
          AND ${input.address.subagentId !== undefined ? sql`s.subagent_id = ${input.address.subagentId}` : input.address.providerThreadId === undefined ? sql`s.child_thread_id = ${input.address.threadId ?? null}` : sql`s.provider_thread_id = ${input.address.providerThreadId}`}
          AND (child.provider_thread_id IS NULL OR child.provider_session_id = ${input.providerSessionId})
          AND r.provider_thread_id = ${input.providerThreadId}
          AND EXISTS(SELECT 1 FROM orchestration_v2_projection_run_attempts a
            WHERE a.run_id = r.run_id AND a.provider_thread_id = ${input.providerThreadId}
              AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t WHERE t.thread_id = ${input.threadId} AND t.run_attempt_id = a.attempt_id)
              AND (json_extract(a.payload_json,'$.nativeThreadId') = ${input.nativeThreadId}
                OR (json_extract(a.payload_json,'$.nativeThreadId') IS NULL AND NOT EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_run_attempts identified
                  WHERE identified.thread_id = ${input.threadId} AND identified.provider_thread_id = ${input.providerThreadId}
                    AND json_extract(identified.payload_json,'$.nativeThreadId') IS NOT NULL
                    AND EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_turns t WHERE t.thread_id = ${input.threadId} AND t.run_attempt_id = identified.attempt_id)))))
          ORDER BY s.subagent_id ASC LIMIT 1`.pipe(
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined
            ? null
            : {
                subagentId: NodeId.make(row.subagent_id),
                threadId:
                  row.child_thread_id === null
                    ? input.threadId
                    : ThreadId.make(row.child_thread_id),
                providerThreadId:
                  row.provider_thread_id === null
                    ? null
                    : ProviderThreadId.make(row.provider_thread_id),
                sourceRunId: RunId.make(row.run_id),
              };
        }),
        Effect.mapError(controlReadError(input.threadId)),
      );
    };

    const getNativeForkBoundary: ProjectionStoreV2Shape["getNativeForkBoundary"] = (
      threadId,
      runId,
      following,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const runRows = yield* sql<{
              provider_thread_id: string | null;
              active_id: string | null;
              ordinal: number;
              native_id: string | null;
              status: OrchestrationV2Run["status"];
            }>`
              SELECT r.provider_thread_id, r.ordinal, r.status, json_extract(r.payload_json,'$.activeAttemptId') AS active_id,
                json_extract(a.payload_json,'$.nativeThreadId') AS native_id
              FROM orchestration_v2_projection_runs r LEFT JOIN orchestration_v2_projection_run_attempts a
                ON a.attempt_id = json_extract(r.payload_json,'$.activeAttemptId')
              WHERE r.thread_id = ${threadId} AND r.run_id = ${runId}`;
            const source = runRows[0];
            const threads =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE thread_id = ${threadId} AND provider_thread_id = ${source?.provider_thread_id ?? null}`.pipe(
                Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)),
              );
            const turns =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND (run_attempt_id = ${source?.active_id ?? null}
            OR provider_turn_id = (SELECT provider_turn_id FROM orchestration_v2_projection_run_attempts WHERE attempt_id = ${source?.active_id ?? null}))
          ORDER BY (run_attempt_id = ${source?.active_id ?? null}) DESC, ordinal DESC LIMIT 1`.pipe(
                Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)),
              );
            const turn = turns[0];
            const count = yield* sql<{
              count: number;
            }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_turns
          WHERE provider_thread_id = ${source?.provider_thread_id ?? null} AND ordinal > ${turn?.ordinal ?? Number.MAX_SAFE_INTEGER}
            AND status IN ('completed','interrupted','failed','cancelled') AND json_extract(payload_json,'$.nativeTurnRef') IS NOT NULL`;
            const nativeId = threads[0]?.nativeThreadRef?.nativeId;
            const nativeIncarnationMatches =
              nativeId != null &&
              source?.native_id === nativeId &&
              source.status !== "rolled_back" &&
              threads[0]?.status !== "closed";
            const followingProviderTurns =
              following === undefined || !nativeIncarnationMatches || turn === undefined
                ? []
                : yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
                  WHERE provider_turn_id IN (
                    SELECT (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns
                      WHERE provider_thread_id = ${source?.provider_thread_id ?? null} AND ordinal > ${turn.ordinal}
                        AND json_extract(payload_json,'$.nativeTurnRef.nativeId') IN
                          (SELECT value FROM json_each(${encodeIdList(following.nativeTurnIds)}))
                      ORDER BY ordinal ASC LIMIT 1)
                    UNION SELECT (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns
                      WHERE provider_thread_id = ${source?.provider_thread_id ?? null} AND ordinal > ${turn.ordinal}
                        AND (json_extract(payload_json,'$.nativeTurnRef.nativeId') IS NULL
                          OR (substr(json_extract(payload_json,'$.nativeTurnRef.nativeId'),1,${following.promptPrefix.length}) != ${following.promptPrefix}
                            AND instr(json_extract(payload_json,'$.nativeTurnRef.nativeId'),${following.continuationMarker}) = 0))
                      ORDER BY ordinal ASC LIMIT 1))
                  ORDER BY ordinal ASC`.pipe(
                    Effect.flatMap(decodeRows(decodeProviderTurnPayload, threadId)),
                  );
            return {
              providerThread: nativeIncarnationMatches ? (threads[0] ?? null) : null,
              nativeIncarnationMatches,
              sourceRunOrdinal: source?.ordinal ?? null,
              providerTurn: turn ?? null,
              followingProviderTurns,
              rollbackTurnCount: count[0]?.count ?? 0,
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getSideChatContext: ProjectionStoreV2Shape["getSideChatContext"] = (threadId) =>
      sql<{
        payload_json: string;
      }>`SELECT captured.payload_json FROM orchestration_v2_side_chat_contexts captured
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = captured.thread_id
        WHERE captured.thread_id = ${threadId} AND json_extract(thread.payload_json, '$.sideChat.contextCleared') IS NULL`.pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2SideChatCapture))(
                rows[0].payload_json,
              )
            : Effect.succeed(null),
        ),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getHandoffHistory: ProjectionStoreV2Shape["getHandoffHistory"] = (requested) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { threadId } = requested;
            yield* requireThread(threadId);
            const threadRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
            const thread = yield* decodeThreadPayload(threadRows[0]!.payload_json);
            // The conversation's context begins after its latest retained clear. Nothing before
            // it, including captured fork ancestry or imported history, reaches another Agent.
            const floor = yield* sql<{ ordinal: number | null }>`
              SELECT MAX(runs.ordinal) AS ordinal
              FROM orchestration_v2_projection_turn_items AS items
              INNER JOIN orchestration_v2_projection_runs AS runs ON runs.run_id = items.run_id
              WHERE items.thread_id = ${threadId} AND items.type = 'context_cleared'
                AND (runs.status <> 'rolled_back' OR (${requested.historyRevision ?? null} IS NOT NULL
                  AND json_extract(runs.payload_json, '$.rolledBackAtRevision') > ${requested.historyRevision ?? null}))
                AND runs.ordinal < ${
                  requested.asOfRunOrdinalTo === true
                    ? (requested.runOrdinalTo ?? Number.MAX_SAFE_INTEGER)
                    : Number.MAX_SAFE_INTEGER
                }`.pipe(Effect.map((rows) => rows[0]?.ordinal ?? 0));
            const input =
              floor === 0
                ? requested
                : {
                    ...requested,
                    runOrdinalFrom: Math.max(requested.runOrdinalFrom ?? 1, floor + 1),
                    includeImported: false,
                  };
            const captured =
              floor === 0 && includesInheritedHandoffHistory(input) && thread.capturedContext
                ? ((yield* getSideChatContext(threadId)) ?? undefined)
                : undefined;
            // A full prefix includes each captured fork prefix. Read only ancestry metadata,
            // then apply the same global item/body budget across every source.
            const inherited =
              thread.capturedContext || !includesInheritedHandoffHistory(input)
                ? []
                : yield* sql<{
                    thread_id: string;
                    max_run_ordinal: number;
                    history_revision: number | null;
                    depth: number;
                    imported: number;
                    floor: number;
                  }>`
                WITH RECURSIVE sources(thread_id, max_run_ordinal, history_revision, depth, visited, floor) AS (
                  SELECT ${threadId}, 0, NULL, 0, json_array(${threadId}), 0
                  UNION ALL
                  SELECT source.thread_id, boundary.ordinal, json_extract(child.payload_json, '$.forkedFrom.sourceHistoryRevision'), sources.depth + 1,
                    json_insert(sources.visited, '$[#]', source.thread_id),
                    -- A source's own clear before the fork boundary ends what the fork inherits.
                    (SELECT COALESCE(MAX(cleared_run.ordinal), 0)
                      FROM orchestration_v2_projection_turn_items AS cleared
                      INNER JOIN orchestration_v2_projection_runs AS cleared_run ON cleared_run.run_id = cleared.run_id
                      WHERE cleared.thread_id = source.thread_id AND cleared.type = 'context_cleared'
                        AND cleared_run.ordinal < boundary.ordinal
                        AND (cleared_run.status <> 'rolled_back'
                          OR (json_extract(child.payload_json, '$.forkedFrom.sourceHistoryRevision') IS NOT NULL
                            AND json_extract(cleared_run.payload_json, '$.rolledBackAtRevision')
                              > json_extract(child.payload_json, '$.forkedFrom.sourceHistoryRevision'))))
                  FROM sources
                  INNER JOIN orchestration_v2_projection_threads AS child ON child.thread_id = sources.thread_id
                  INNER JOIN orchestration_v2_projection_threads AS source
                    ON source.thread_id = json_extract(child.payload_json, '$.forkedFrom.threadId')
                  INNER JOIN orchestration_v2_projection_runs AS boundary ON boundary.thread_id = source.thread_id
                    AND boundary.run_id = json_extract(child.payload_json, '$.forkedFrom.runId')
                  WHERE json_extract(child.payload_json, '$.forkedFrom.type') = 'run'
                    AND sources.depth < 128 AND sources.floor = 0
                    AND NOT EXISTS (SELECT 1 FROM json_each(sources.visited) WHERE value = source.thread_id)
                ) SELECT sources.thread_id, sources.max_run_ordinal, sources.history_revision, sources.depth,
                  json_extract(thread.payload_json, '$.historyOrigin') IN ('v1_import', 'native_import') AS imported,
                  sources.floor
                FROM sources INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = sources.thread_id
                WHERE sources.depth > 0 ORDER BY sources.depth DESC`;
            if (inherited.some((source) => source.depth === 128))
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Context handoff exceeds the fork ancestry bound.",
              });
            const sourceIds = [threadId, ...inherited.map((source) => source.thread_id)];
            const sourceDepth =
              inherited.length === 0
                ? sql`${0}`
                : sql`CASE items.thread_id
              ${sql.join(" ", false)(inherited.map((source) => sql`WHEN ${source.thread_id} THEN ${source.depth}`))} ELSE 0 END`;
            const chronological =
              inherited.length === 0
                ? sql`items.ordinal ASC, items.turn_item_id ASC`
                : sql`${sourceDepth} DESC, items.ordinal ASC, items.turn_item_id ASC`;
            const reverseChronological =
              inherited.length === 0
                ? sql`items.ordinal DESC, items.turn_item_id DESC`
                : sql`${sourceDepth} ASC, items.ordinal DESC, items.turn_item_id DESC`;
            // Only indexed identities, ordinals and status participate in range selection.
            const localRunPredicate = sql`
          runs.thread_id = ${threadId}
          AND (runs.status <> 'rolled_back' OR (${input.historyRevision ?? null} IS NOT NULL
            AND json_extract(runs.payload_json, '$.rolledBackAtRevision') > ${input.historyRevision ?? null}))
          AND runs.ordinal >= ${input.runOrdinalFrom ?? 1}
          AND runs.ordinal <= ${input.runOrdinalTo ?? Number.MAX_SAFE_INTEGER}
          AND ${input.runStatuses === undefined ? sql`1` : sql`runs.status IN ${sql.in(input.runStatuses)}`}
          AND ${input.runIds === undefined ? sql`1` : sql`runs.run_id IN ${sql.in(input.runIds)}`}
          AND ${
            input.missingFromProviderThreadId === undefined
              ? sql`1`
              : sql`
            runs.provider_thread_id = ${input.missingFromProviderThreadId}
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns AS turns
              WHERE turns.thread_id = ${threadId}
                AND turns.run_attempt_id = json_extract(runs.payload_json, '$.activeAttemptId'))`
          }
        `;
            const runPredicate = sql.or([
              localRunPredicate,
              ...inherited.map(
                (source) =>
                  sql`runs.thread_id = ${source.thread_id} AND runs.ordinal <= ${source.max_run_ordinal}
                    AND runs.ordinal > ${source.floor}
                    AND (runs.status <> 'rolled_back' OR (${source.history_revision} IS NOT NULL
                      AND json_extract(runs.payload_json, '$.rolledBackAtRevision') > ${source.history_revision}))`,
              ),
            ]);
            const importedSourceIds = [
              ...(input.includeImported === true ? [threadId] : []),
              ...inherited
                .filter((source) => source.imported === 1 && source.floor === 0)
                .map((source) => source.thread_id),
            ];
            const itemPredicate = sql`
          items.thread_id IN ${sql.in(sourceIds)}
          AND (items.run_id IN (SELECT runs.run_id FROM orchestration_v2_projection_runs AS runs
            WHERE ${runPredicate}) OR ${importedSourceIds.length === 0 ? sql`0` : sql`(items.run_id IS NULL AND items.thread_id IN ${sql.in(importedSourceIds)})`})
          AND ${input.excludeItemIds === undefined || input.excludeItemIds.length === 0 ? sql`1` : sql`items.turn_item_id NOT IN ${sql.in(input.excludeItemIds)}`}
          AND ${
            input.excludeDelivered === undefined
              ? sql`1`
              : sql`NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_context_handoffs AS handoffs INDEXED BY orchestration_v2_handoff_delivery_metadata_idx
            WHERE handoffs.thread_id = ${threadId}
              AND handoffs.to_provider_thread_id = ${input.excludeDelivered.providerThreadId}
              AND json_extract(handoffs.payload_json, '$.delivery.nativeThreadId') = ${input.excludeDelivered.nativeThreadId}
              AND COALESCE(json_extract(handoffs.payload_json, '$.delivery.status'), '') <> 'pending'
              AND (EXISTS (SELECT 1 FROM json_each(json_extract(handoffs.payload_json, '$.delivery.itemIds')) WHERE value = items.turn_item_id)
                OR EXISTS (SELECT 1 FROM json_each(json_extract(handoffs.payload_json, '$.delivery.omittedItemIds')) WHERE value = items.turn_item_id)))`
          }
        `;
            const mediaTool = sql`items.type = 'dynamic_tool' AND
              (COALESCE(json_array_length(items.payload_json,'$.unavailableImages'),0) > 0
                OR COALESCE(json_array_length(items.payload_json,'$.attachments'),0) > 0)`;
            const conversational = sql`(items.type IN ('user_message','assistant_message') OR (${mediaTool}))`;
            const supported = sql`(items.type IN ('user_message','assistant_message','command_execution','error','run_interrupt_result','file_change','proposed_plan') OR (${mediaTool}))`;
            const range = yield* sql<{
              first_ordinal: number | null;
              last_ordinal: number | null;
              run_count: number;
            }>`
          SELECT MIN(CASE WHEN runs.thread_id = ${threadId} THEN runs.ordinal END) AS first_ordinal,
            MAX(CASE WHEN runs.thread_id = ${threadId} THEN runs.ordinal END) AS last_ordinal, COUNT(*) AS run_count
          FROM orchestration_v2_projection_runs AS runs WHERE ${runPredicate}
        `;
            const coveredRunOrdinals = {
              from: range[0]?.first_ordinal ?? 1,
              to: range[0]?.last_ordinal ?? 1,
            };
            const budget = Math.max(0, Math.min(64_000, Math.floor(input.budget)));
            if ((range[0]?.run_count ?? 0) === 0 && importedSourceIds.length === 0) {
              if (captured !== undefined) {
                const selected = selectHistory({
                  messages: captured.history.messages,
                  coverage: captured.history.coverage,
                  omittedItems: captured.history.omittedItems,
                  budget,
                });
                return {
                  ...captured,
                  history: {
                    ...captured.history,
                    messages: selected.messages,
                    omittedItems: selected.omittedItems,
                    ...(captured.history.omittedItemIds === undefined
                      ? {}
                      : {
                          omittedItemIds: [
                            ...captured.history.omittedItemIds,
                            ...selected.omittedItemIds,
                          ],
                        }),
                  },
                  context: selected.context,
                };
              }
              const coverage = handoffCoverage({
                threadId,
                coveredRunOrdinals,
                sourceItemRange: { first: null, last: null },
              });

              const selected = selectHistory({ messages: [], coverage, budget });
              return {
                history: { messages: [], coverage, omittedItems: 0, omittedItemIds: [] },
                context: selected.context,
                coveredRunOrdinals,
                fromProviderThreadIds: [],
                sourceItemCount: 0,
                sourceRunCount: 0,
                sourceSelections: [],
              };
            }
            const counts = yield* sql<{
              total: number;
              historical: number;
              conversational: number;
            }>`
          SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ${supported} THEN 1 ELSE 0 END), 0) AS historical,
            COALESCE(SUM(CASE WHEN ${conversational} THEN 1 ELSE 0 END),0) AS conversational
          FROM orchestration_v2_projection_turn_items AS items WHERE ${itemPredicate}
        `;
            const first = yield* sql<{ id: string }>`SELECT items.turn_item_id AS id
          FROM orchestration_v2_projection_turn_items AS items WHERE ${itemPredicate}
          ORDER BY ${chronological} LIMIT 1`;
            const last = yield* sql<{ id: string }>`SELECT items.turn_item_id AS id
          FROM orchestration_v2_projection_turn_items AS items WHERE ${itemPredicate}
          ORDER BY ${reverseChronological} LIMIT 1`;
            const coverage = handoffCoverage({
              threadId,
              coveredRunOrdinals,
              sourceItemRange: { first: first[0]?.id ?? null, last: last[0]?.id ?? null },
            });
            const providers = yield* sql<{
              id: string;
            }>`SELECT DISTINCT runs.provider_thread_id AS id
          FROM orchestration_v2_projection_runs AS runs WHERE ${runPredicate}
            AND runs.provider_thread_id IS NOT NULL LIMIT 129`;
            if (providers.length > 128)
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Context handoff exceeds the live provider identity bound.",
              });
            const selections = yield* sql<{
              instance_id: string;
              model: string;
            }>`SELECT DISTINCT runs.provider_instance_id AS instance_id,
          json_extract(runs.payload_json, '$.modelSelection.model') AS model
          FROM orchestration_v2_projection_runs AS runs WHERE ${runPredicate} LIMIT 129`;
            if (selections.length > 128)
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Context handoff exceeds the model selection bound.",
              });
            const contentText = sql`CASE items.type
          WHEN 'user_message' THEN json_extract(items.payload_json, '$.text')
          WHEN 'assistant_message' THEN json_extract(items.payload_json, '$.text')
          WHEN 'command_execution' THEN 'Command: ' || json_extract(items.payload_json, '$.input') || char(10) ||
            'Exit code: ' || COALESCE(json_extract(items.payload_json, '$.exitCode'), 'unknown') || char(10) || COALESCE(json_extract(items.payload_json, '$.output'), '')
          WHEN 'error' THEN json_extract(items.payload_json, '$.failure.message')
          WHEN 'run_interrupt_result' THEN json_extract(items.payload_json, '$.message')
          WHEN 'file_change' THEN 'File change: ' || json_extract(items.payload_json, '$.fileName')
          WHEN 'proposed_plan' THEN json_extract(items.payload_json, '$.markdown')
          WHEN 'dynamic_tool' THEN CASE WHEN json_extract(items.payload_json,'$.toolName') = 'imageView'
            THEN 'Viewed image.' ELSE COALESCE(json_extract(items.payload_json,'$.toolName'),'Tool image.') END END`;
            const imageText = sql`COALESCE((SELECT group_concat(line, char(10)) FROM (
              SELECT ${HISTORY_IMAGE_CONTEXT.availablePrefix} || json_extract(value,'$.name') ||
                ${HISTORY_IMAGE_CONTEXT.availableSeparator} || json_extract(value,'$.id') ||
                ${HISTORY_IMAGE_CONTEXT.availableSuffix} AS line
              FROM json_each(items.payload_json,'$.attachments') WHERE json_extract(value,'$.type') = 'image'
              UNION ALL
              SELECT ${HISTORY_IMAGE_CONTEXT.unavailablePrefix} || json_extract(value,'$.name') ||
                ${HISTORY_IMAGE_CONTEXT.unavailableSuffix} AS line
              FROM json_each(items.payload_json,'$.unavailableImages')
            )), '')`;
            const text = sql`COALESCE(${contentText},'') || CASE WHEN ${imageText} = '' THEN ''
              ELSE CASE WHEN COALESCE(${contentText},'') = '' THEN '' ELSE char(10) END || ${imageText} END`;
            const messageJson = sql`json_object('role', CASE WHEN items.type = 'user_message' THEN 'user' ELSE 'assistant' END,
          'text', ${text}, 'threadId', items.thread_id, 'runId', items.run_id,
          'itemId', items.turn_item_id, 'providerThreadId', items.provider_thread_id,
          'status', items.status, 'kind', items.type)`;
            type Candidate = { id: string; ordinal: number; depth: number; bytes: number };
            const readHead = (user: boolean, descending: boolean) => sql<Candidate>`
          SELECT items.turn_item_id AS id, items.ordinal, ${sourceDepth} AS depth,
            length(CAST(${messageJson} AS BLOB)) AS bytes
          FROM orchestration_v2_projection_turn_items AS items WHERE ${itemPredicate} AND ${supported}
            AND (CASE WHEN items.type = 'user_message' THEN 1 ELSE 0 END) = ${user ? 1 : 0}
          ORDER BY ${descending ? reverseChronological : chronological} LIMIT 1`;
            const readBodies = budget > 0 && (counts[0]?.historical ?? 0) > 0;
            const latestUser = readBodies ? yield* readHead(true, true) : [];
            const latestAssistant = readBodies ? yield* readHead(false, true) : [];
            const firstUser = readBodies ? yield* readHead(true, false) : [];
            const tail = !readBodies
              ? []
              : yield* sql<Candidate>`SELECT items.turn_item_id AS id, items.ordinal, ${sourceDepth} AS depth,
          length(CAST(${messageJson} AS BLOB)) AS bytes
          FROM orchestration_v2_projection_turn_items AS items WHERE ${itemPredicate} AND ${supported}
          ORDER BY ${reverseChronological} LIMIT 256`;
            let remaining = budget * 4;
            const candidates = new Map<string, Candidate>();
            for (const row of [...latestUser, ...latestAssistant, ...firstUser, ...tail]) {
              if (candidates.has(row.id) || row.bytes > budget || row.bytes > remaining) continue;
              candidates.set(row.id, row);
              remaining -= row.bytes;
            }
            // No oversized item text or unrelated native/tool payload can cross this read boundary.
            const messages =
              candidates.size === 0
                ? []
                : yield* sql<{
                    payload_json: string;
                    run_status: OrchestrationV2Run["status"] | null;
                  }>`
          SELECT ${messageJson} AS payload_json,
            (SELECT runs.status FROM orchestration_v2_projection_runs AS runs WHERE runs.run_id = items.run_id) AS run_status
          FROM orchestration_v2_projection_turn_items AS items
          WHERE items.thread_id IN ${sql.in(sourceIds)} AND items.turn_item_id IN ${sql.in([...candidates.keys()])}
            AND length(CAST(${messageJson} AS BLOB)) <= ${budget}
          ORDER BY ${chronological}
        `.pipe(
                    Effect.flatMap((rows) =>
                      Effect.forEach(rows, (row) =>
                        Schema.decodeUnknownEffect(OrchestrationV2HistoricalMessageSchema)({
                          ...JSON.parse(row.payload_json),
                          ...(row.run_status === null ? {} : { runStatus: row.run_status }),
                        }),
                      ),
                    ),
                  );
            const total = counts[0]?.historical ?? 0;
            const knownItemIds = new Set(
              [...latestUser, ...latestAssistant, ...firstUser, ...tail].map((row) => row.id),
            );
            const selected = selectHistory({
              messages,
              coverage,
              budget,
              omittedItems: total - messages.length,
              priorityItemIds: [
                latestUser[0]?.id ?? null,
                latestAssistant[0]?.id ?? null,
                firstUser[0]?.id ?? null,
              ],
            });
            const auxiliary =
              input.includeSummary !== true || budget === 0
                ? []
                : yield* sql<{ ordinal: number; depth: number; id: string; line: string }>`
              SELECT items.ordinal, ${sourceDepth} AS depth, items.turn_item_id AS id, CASE items.type
                WHEN 'checkpoint' THEN '- Checkpoint: ' || COALESCE(json_array_length(items.payload_json, '$.files'), 0) || ' files'
                WHEN 'handoff' THEN '- Handoff: ' || substr(COALESCE(json_extract(items.payload_json, '$.summary'), json_extract(items.payload_json, '$.strategy')), 1, 240)
              END AS line FROM orchestration_v2_projection_turn_items AS items
              WHERE ${itemPredicate} AND items.type IN ('checkpoint','handoff')
              ORDER BY ${reverseChronological} LIMIT 256`;
            const auxiliaryCount =
              input.includeSummary !== true
                ? 0
                : ((yield* sql<{ total: number }>`
              SELECT COUNT(*) AS total FROM orchestration_v2_projection_turn_items AS items
              WHERE ${itemPredicate} AND items.type IN ('checkpoint','handoff')`)[0]?.total ?? 0);
            const summaryCandidates = [
              ...selected.messages.map((message) => ({
                id: message.itemId,
                ordinal: candidates.get(message.itemId)!.ordinal,
                depth: candidates.get(message.itemId)!.depth,
                line: historicalSummaryLine(message),
              })),
              ...auxiliary,
            ].sort(
              (left, right) =>
                right.depth - left.depth ||
                left.ordinal - right.ordinal ||
                left.id.localeCompare(right.id),
            );
            let summaryRemaining = budget;
            const summaryLines: string[] = [];
            for (const row of summaryCandidates) {
              const bytes = Buffer.byteLength(row.line) + 1;
              if (bytes > summaryRemaining) continue;
              summaryLines.push(row.line);
              summaryRemaining -= bytes;
            }
            const conversationSections =
              input.includeConversationSummary !== true
                ? []
                : yield* sql<{ payload_json: string; truncated: number }>`
              WITH recent AS MATERIALIZED (
                SELECT items.turn_item_id AS id, items.ordinal, ${sourceDepth} AS depth, items.type
                FROM orchestration_v2_projection_turn_items AS items
                WHERE ${itemPredicate} AND ${conversational}
                ORDER BY ${reverseChronological} LIMIT 256
              ), sizes AS (
                SELECT recent.*, CASE recent.type WHEN 'user_message' THEN 'User' ELSE 'Assistant' END AS label,
                  length(${text}) AS chars
                FROM recent JOIN orchestration_v2_projection_turn_items AS items ON items.turn_item_id = recent.id
              ), positioned AS (
                SELECT *, COALESCE(SUM(chars + length(label) + 4) OVER (
                  ORDER BY depth ASC, ordinal DESC, id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING),0) AS preceding_chars
                FROM sizes
              ), admitted AS (
                SELECT *, MIN(chars, ${CONVERSATION_SUMMARY_CHAR_CAP - CONVERSATION_SUMMARY_HEADER.length - 2} - preceding_chars - length(label) - 2
                  - CASE WHEN chars + length(label) + 2 > ${CONVERSATION_SUMMARY_CHAR_CAP - CONVERSATION_SUMMARY_HEADER.length - 2} - preceding_chars THEN 4 ELSE 0 END) AS admitted_chars
                FROM positioned WHERE preceding_chars + length(label) + 2 < ${CONVERSATION_SUMMARY_CHAR_CAP - CONVERSATION_SUMMARY_HEADER.length - 2}
              ), bodies AS (
                SELECT admitted.ordinal, admitted.depth, admitted.id, admitted_chars < chars AS truncated,
                  json_object('label', label, 'body', CASE WHEN admitted_chars < chars THEN '... ' ELSE '' END ||
                    substr(${text}, chars - admitted_chars + 1, admitted_chars)) AS payload_json
                FROM admitted JOIN orchestration_v2_projection_turn_items AS items ON items.turn_item_id = admitted.id
                WHERE admitted_chars >= 0
              ), bounded AS (
                SELECT *, SUM(length(CAST(payload_json AS BLOB))) OVER (ORDER BY depth ASC,ordinal DESC,id DESC) AS body_bytes FROM bodies
              ) SELECT payload_json, truncated FROM bounded WHERE body_bytes <= 262144 ORDER BY depth DESC,ordinal ASC,id ASC`;
            const combined =
              captured === undefined
                ? selected
                : selectHistory({
                    messages: [...captured.history.messages, ...selected.messages],
                    coverage: `${captured.history.coverage}\n${coverage}`,
                    omittedItems: captured.history.omittedItems + selected.omittedItems,
                    budget: input.budget,
                  });
            return {
              history: {
                messages: combined.messages,
                coverage,
                omittedItems: combined.omittedItems,
                ...(captured === undefined && total === knownItemIds.size
                  ? {
                      omittedItemIds: [...knownItemIds].filter(
                        (id) => !selected.messages.some((message) => message.itemId === id),
                      ) as TurnItemId[],
                    }
                  : {}),
              },
              context: combined.context,
              coveredRunOrdinals,
              fromProviderThreadIds: providers.map((row) => row.id as ProviderThreadId),
              sourceItemCount: (counts[0]?.total ?? 0) + (captured?.sourceItemCount ?? 0),
              sourceRunCount: (range[0]?.run_count ?? 0) + (captured?.sourceRunCount ?? 0),
              ...(input.includeConversationSummary === true
                ? {
                    conversationSummary: {
                      sections: conversationSections.map(
                        (row) =>
                          JSON.parse(row.payload_json) as {
                            label: "User" | "Assistant";
                            body: string;
                          },
                      ),
                      omittedItems: (counts[0]?.conversational ?? 0) - conversationSections.length,
                      truncatedItems: conversationSections.filter((row) => row.truncated === 1)
                        .length,
                    },
                  }
                : {}),
              ...(input.includeSummary === true
                ? {
                    summary: {
                      lines: summaryLines,
                      omittedItems: total + auxiliaryCount - summaryLines.length,
                    },
                  }
                : {}),
              sourceSelections: selections.map((row) => ({
                providerInstanceId: row.instance_id as ProviderInstanceId,
                modelSelection: {
                  instanceId: row.instance_id as ProviderInstanceId,
                  model: row.model,
                },
              })),
            };
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new ProjectionStoreReadError({ threadId: requested.threadId, cause }),
          ),
        );

    const getLastDeliveredRun: ProjectionStoreV2Shape["getLastDeliveredRun"] = (
      threadId,
      providerThreadId,
    ) =>
      sql<PayloadRow>`SELECT runs.payload_json FROM orchestration_v2_projection_runs AS runs
        WHERE runs.thread_id = ${threadId} AND runs.provider_thread_id = ${providerThreadId}
          AND (runs.status = 'completed' OR (runs.status IN ('failed','interrupted')
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_turns AS turns
              WHERE turns.thread_id = ${threadId}
                AND turns.run_attempt_id = json_extract(runs.payload_json, '$.activeAttemptId'))))
        ORDER BY runs.ordinal DESC LIMIT 1`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined ? Effect.succeed(null) : decodeRunPayload(rows[0].payload_json),
        ),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getThreadProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
      readProjection(threadId, new Set()).pipe(Effect.map((read) => read.projection));

    const getHostToolAuthorityContext: ProjectionStoreV2Shape["getHostToolAuthorityContext"] = (
      threadId,
      runId,
      providerThreadId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const threadRows = yield* sql<PayloadRow>`
          SELECT json_object('id', thread_id,
            'projectId', json_extract(payload_json, '$.projectId'),
            'activeProviderThreadId', json_extract(payload_json, '$.activeProviderThreadId'),
            'runtimeMode', json_extract(payload_json, '$.runtimeMode'),
            'interactionMode', json_extract(payload_json, '$.interactionMode'),
            'lineage', json_extract(payload_json, '$.lineage'),
            'forkedFrom', json_extract(payload_json, '$.forkedFrom'),
            'archivedAt', json_extract(payload_json, '$.archivedAt'),
            'deletedAt', json_extract(payload_json, '$.deletedAt')) AS payload_json
          FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
        `;
            if (threadRows[0] === undefined)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const thread = yield* decodeHostAuthorityThread(threadRows[0].payload_json);
            const runRows =
              runId === null
                ? []
                : yield* sql<PayloadRow>`
          SELECT json_patch(json_object('id', run_id, 'ordinal', ordinal, 'status', status,
            'activeAttemptId', json_extract(payload_json, '$.activeAttemptId'),
            'userMessageId', json_extract(payload_json, '$.userMessageId'),
            'providerThreadId', provider_thread_id,
            'providerInstanceId', json_extract(payload_json, '$.providerInstanceId'),
            'rootNodeId', json_extract(payload_json, '$.rootNodeId'),
            'requestedAt', requested_at),
            CASE WHEN json_extract(payload_json, '$.delegatedTaskId') IS NULL THEN '{}'
              ELSE json_object('delegatedTaskId', json_extract(payload_json, '$.delegatedTaskId')) END) AS payload_json
          FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
            AND ((${runId ?? null} IS NULL AND status = 'running') OR run_id = ${runId ?? null})
          ORDER BY ordinal DESC LIMIT 1
        `;
            const runs = yield* decodeRows(decodeHostAuthorityRun, threadId)(runRows);
            const run = runs[0];
            const providerRows = yield* sql<PayloadRow>`
          SELECT host_identity_json AS payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${providerThreadId ?? run?.providerThreadId ?? thread.activeProviderThreadId} LIMIT 1
        `;
            const providerThreads = yield* decodeRows(
              decodeHostAuthorityProvider,
              threadId,
            )(providerRows);
            const turnRows =
              run === undefined
                ? []
                : yield* sql<PayloadRow>`
          SELECT json_object('id', provider_turn_id, 'runAttemptId', run_attempt_id, 'status', status,
            'nativeTurnRef', json_extract(payload_json, '$.nativeTurnRef')) AS payload_json
          FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND provider_thread_id = ${providerThreadId ?? run?.providerThreadId ?? thread.activeProviderThreadId}
            AND run_attempt_id = ${run.activeAttemptId}
          ORDER BY ordinal DESC LIMIT 1
        `;
            const subagentRows = yield* sql<PayloadRow>`
          SELECT json_object('origin', origin, 'status', status,
            'providerThreadId', provider_thread_id) AS payload_json
          FROM orchestration_v2_projection_subagents
          WHERE thread_id = ${threadId} AND provider_thread_id = ${providerThreadId ?? run?.providerThreadId ?? thread.activeProviderThreadId}
            AND origin = 'provider_native' AND status IN ('pending','running','waiting')
          LIMIT 1
        `;
            return {
              thread,
              runs,
              providerThreads,
              providerTurns: yield* decodeRows(decodeHostAuthorityTurn, threadId)(turnRows),
              subagents: yield* decodeRows(decodeHostAuthorityChild, threadId)(subagentRows),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRuntimeRecoveryProjection: ProjectionStoreV2Shape["getRuntimeRecoveryProjection"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          `;
        if (threadRows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          turnItemRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRows[0].payload_json),
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = ${threadId}
                AND (
                  run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  OR run.run_id = (
                    SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
                    WHERE latest.thread_id = ${threadId}
                    ORDER BY latest.ordinal DESC LIMIT 1
                  )
                  -- Retain the latest run for each provider thread with lost
                  -- background work, including owners used before a handoff.
                  OR run.run_id IN (
                    SELECT (
                      SELECT ended.run_id FROM orchestration_v2_projection_runs AS ended
                      WHERE ended.thread_id = ${threadId}
                        AND ended.provider_thread_id = roster.provider_thread_id
                        AND ended.status NOT IN ('queued', 'rolled_back')
                      ORDER BY ended.completed_at IS NULL DESC, ended.completed_at DESC,
                        ended.ordinal DESC
                      LIMIT 1
                    )
                    FROM orchestration_v2_projection_provider_threads AS roster
                    WHERE roster.thread_id = ${threadId}
                      AND CASE WHEN json_valid(roster.payload_json)
                        THEN json_array_length(roster.payload_json, '$.pendingBackgroundTasks') > 0
                        ELSE 0 END
                  )
                  OR run.run_id IN (
                    SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                      AND item.run_id IS NOT NULL
                  )
                )
              ORDER BY run.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT attempt.payload_json
              FROM orchestration_v2_projection_run_attempts AS attempt
              WHERE attempt.thread_id = ${threadId}
                AND attempt.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
              ORDER BY attempt.run_id ASC, attempt.attempt_ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT node.payload_json FROM orchestration_v2_projection_nodes AS node
              WHERE node.thread_id = ${threadId}
                AND node.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  (node.run_id IS NULL AND node.kind = 'root_turn')
                  OR node.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT item.node_id FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT json_extract(item.payload_json, '$.subagentId')
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT subagent_id FROM orchestration_v2_projection_subagents
                    WHERE thread_id = ${threadId} AND origin = 'provider_native'
                      AND status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
            `,
          sql<PayloadRow>`
              SELECT subagent.payload_json FROM orchestration_v2_projection_subagents AS subagent
              WHERE subagent.thread_id = ${threadId}
                AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  subagent.origin = 'provider_native'
                  OR subagent.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR subagent.subagent_id IN (
                    SELECT json_extract(item.payload_json, '$.subagentId')
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId} AND item.type = 'subagent'
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
            `,
          sql<PayloadRow>`
              SELECT DISTINCT session.payload_json
              FROM orchestration_v2_projection_provider_sessions AS session
              JOIN orchestration_v2_projection_provider_session_bindings AS binding
                ON binding.provider_session_id = session.provider_session_id
              WHERE binding.thread_id = ${threadId}
                AND (
                  session.status NOT IN ('stopped', 'error')
                  OR session.provider_session_id IN (
                    SELECT provider_thread.provider_session_id
                    FROM orchestration_v2_projection_provider_threads AS provider_thread
                    WHERE provider_thread.provider_thread_id IN (
                      SELECT run.provider_thread_id
                      FROM orchestration_v2_projection_runs AS run
                      WHERE run.thread_id = ${threadId}
                        AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                  )
                )
              ORDER BY session.updated_at ASC, session.provider_session_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_thread.payload_json
              FROM orchestration_v2_projection_provider_threads AS provider_thread
              WHERE (
                  provider_thread.thread_id = ${threadId}
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS owner
                    WHERE owner.node_id = provider_thread.owner_node_id
                      AND owner.thread_id = ${threadId}
                  )
                  OR EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_subagents AS subagent
                    WHERE subagent.provider_thread_id = provider_thread.provider_thread_id
                      AND subagent.thread_id = ${threadId}
                  )
                )
                AND (
                  provider_thread.status = 'active'
                  OR CASE WHEN json_valid(provider_thread.payload_json)
                    THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
                  OR provider_thread.provider_thread_id IN (
                    SELECT run.provider_thread_id FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${threadId}
                      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR provider_thread.provider_thread_id IN (
                    SELECT item.provider_thread_id
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(provider_thread.first_run_ordinal, 0), provider_thread.provider_thread_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_turn.payload_json
              FROM orchestration_v2_projection_provider_turns AS provider_turn
              WHERE provider_turn.thread_id = ${threadId}
                AND provider_turn.status IN ('pending', 'starting', 'running', 'waiting')
                AND provider_turn.run_attempt_id IN (
                  SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                  WHERE thread_id = ${threadId}
                    AND run_id IN (
                      SELECT run_id FROM orchestration_v2_projection_runs
                      WHERE thread_id = ${threadId}
                        AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    )
                )
              ORDER BY provider_turn.provider_thread_id ASC, provider_turn.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status = 'pending'
              ORDER BY created_at ASC, runtime_request_id ASC
            `,
          sql<PayloadRow>`
              SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
              WHERE message.thread_id = ${threadId} AND message.streaming = 1
                AND message.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
              ORDER BY message.created_at ASC, message.message_id ASC
            `,
          sql<PayloadRow>`
              SELECT item.payload_json FROM orchestration_v2_projection_turn_items AS item
              WHERE item.thread_id = ${threadId}
                AND item.status IN ('pending', 'running', 'waiting')
                AND (
                  item.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                  OR (
                    item.run_id IS NULL
                    AND item.node_id IN (
                      SELECT node_id FROM orchestration_v2_projection_nodes
                      WHERE thread_id = ${threadId}
                        AND run_id IS NULL
                        AND kind = 'root_turn'
                        AND status IN ('pending', 'running', 'waiting')
                    )
                  )
                )
              ORDER BY item.ordinal ASC, item.turn_item_id ASC
            `,
        ]);
        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodeTurnItemPayload, threadId)(turnItemRows),
        ]);
        return {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        } satisfies ProjectionRuntimeRecoveryState;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getThread: ProjectionStoreV2Shape["getThread"] = (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
        `;
        if (rows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        return yield* decodeThreadPayload(rows[0].payload_json);
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const requireThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
      `;
        if (rows.length === 0) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      });
    const controlReadError = (threadId: ThreadId) => (cause: unknown) =>
      isProjectionStoreThreadNotFoundError(cause)
        ? cause
        : new ProjectionStoreReadError({ threadId, cause });

    const getExecutionRetirementContext: ProjectionStoreV2Shape["getExecutionRetirementContext"] = (
      threadId,
      runId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const runRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId}`;
            const run =
              runRows[0] === undefined
                ? undefined
                : yield* decodeRunPayload(runRows[0].payload_json);
            const [attemptRows, nodeRows, providerRows, facts] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts WHERE thread_id = ${threadId} AND attempt_id = ${run?.activeAttemptId ?? null}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId} AND provider_thread_id = ${run?.providerThreadId ?? null}`,
              sql<{
                parent_run_id: string;
                delivery_run_id: string | null;
                has_binding: number;
                is_target: number;
              }>`WITH parent AS (
            SELECT COALESCE((SELECT json_extract(payload_json,'$.delegatedCompletion.parentRunId') FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND message_id = ${run?.userMessageId ?? null}),${runId}) AS id)
            SELECT parent.id AS parent_run_id, (SELECT message.run_id FROM orchestration_v2_projection_messages message
              WHERE message.thread_id = ${threadId} AND message.message_id = (SELECT json_extract(payload_json,'$.delegatedCompletion.delivery.messageId')
                FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = parent.id)) AS delivery_run_id,
              EXISTS(SELECT 1 FROM orchestration_v2_projection_provider_session_bindings WHERE thread_id = ${threadId}) AS has_binding,
              EXISTS(SELECT 1 FROM orchestration_v2_execution_retirement_targets target
                JOIN orchestration_v2_projection_threads root ON root.thread_id = target.root_thread_id
                WHERE target.thread_id = ${threadId} AND target.run_id = ${runId}
                  AND json_extract(root.payload_json,'$.executionHandoff.operationId') = target.operation_id) AS is_target FROM parent`,
            ]);
            return {
              thread,
              run,
              attempt:
                attemptRows[0] === undefined
                  ? undefined
                  : yield* decodeRunAttemptPayload(attemptRows[0].payload_json),
              rootNode:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              providerThread:
                providerRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
              cohortParentRunId: RunId.make(facts[0]!.parent_run_id),
              deliveryRunId:
                facts[0]!.delivery_run_id === null ? null : RunId.make(facts[0]!.delivery_run_id),
              hasProviderBinding: facts[0]!.has_binding === 1,
              isRetirementTarget: facts[0]!.is_target === 1,
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getExecutionActors: ProjectionStoreV2Shape["getExecutionActors"] = (
      rootThreadId,
      cursor,
    ) =>
      Effect.gen(function* () {
        const anchor = cursor
          ? yield* Effect.try(
              () => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
            )
          : null;
        if (
          anchor !== null &&
          (!Array.isArray(anchor) ||
            anchor.length !== 3 ||
            anchor[0] !== rootThreadId ||
            anchor.some((v) => typeof v !== "string"))
        )
          return yield* new ProjectionStoreReadError({
            threadId: rootThreadId,
            cause: "Invalid execution actor cursor",
          });
        const after = anchor as [string, string, string] | null;
        const rows = yield* sql<{
          thread_id: string;
          active_run_id: string | null;
          provider_session_id: string | null;
        }>`
          SELECT t.thread_id,
            COALESCE((SELECT target.run_id FROM orchestration_v2_execution_retirement_targets target
              WHERE target.root_thread_id = ${rootThreadId} AND target.thread_id = t.thread_id ORDER BY target.run_id LIMIT 1),
              (SELECT run_id FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
                AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1)) AS active_run_id,
            COALESCE(b.provider_session_id, (SELECT p.provider_session_id FROM orchestration_v2_projection_runs r
              JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = r.provider_thread_id
              WHERE r.thread_id = t.thread_id AND r.run_id = COALESCE(
                (SELECT target.run_id FROM orchestration_v2_execution_retirement_targets target WHERE target.root_thread_id = ${rootThreadId}
                  AND target.thread_id = t.thread_id ORDER BY target.run_id LIMIT 1),
                (SELECT run_id FROM orchestration_v2_projection_runs active WHERE active.thread_id = t.thread_id
                  AND active.status IN ('preparing','starting','running','waiting') ORDER BY ordinal DESC LIMIT 1))
                AND json_extract(p.payload_json,'$.nativeThreadRef') IS NOT NULL)) AS provider_session_id
          FROM orchestration_v2_projection_threads t
          LEFT JOIN orchestration_v2_projection_provider_session_bindings b ON b.thread_id = t.thread_id
          WHERE json_extract(t.payload_json,'$.lineage.rootThreadId') = ${rootThreadId}
            AND (${after === null ? 1 : 0} = 1 OR t.thread_id > ${after?.[1] ?? ""}
              OR (t.thread_id = ${after?.[1] ?? ""} AND COALESCE(b.provider_session_id,'') > ${after?.[2] ?? ""}))
          ORDER BY t.thread_id, b.provider_session_id LIMIT 65`;
        const admitted = rows.slice(0, 64);
        const last = admitted.at(-1);
        return {
          items: admitted.map((row) => ({
            threadId: ThreadId.make(row.thread_id),
            activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
            providerSessionId:
              row.provider_session_id === null
                ? null
                : ProviderSessionId.make(row.provider_session_id),
          })),
          nextCursor:
            rows.length > 64 && last
              ? Buffer.from(
                  JSON.stringify([rootThreadId, last.thread_id, last.provider_session_id ?? ""]),
                ).toString("base64url")
              : null,
        };
      }).pipe(Effect.mapError(controlReadError(rootThreadId)));

    const getExecutionDetachBarrier: ProjectionStoreV2Shape["getExecutionDetachBarrier"] = (
      rootThreadId,
    ) =>
      sql<{ effect_id: string }>`SELECT e.effect_id FROM orchestration_v2_projection_threads t
        CROSS JOIN orchestration_v2_effect_outbox e ON e.thread_id = t.thread_id
        WHERE json_extract(t.payload_json,'$.lineage.rootThreadId') = ${rootThreadId}
          AND e.effect_type = 'provider-session.detach' AND e.status IN ('pending','running','failed','cancelled')
        LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.effect_id ?? null),
        Effect.mapError(controlReadError(rootThreadId)),
      );

    const getExecutionHandoffs: ProjectionStoreV2Shape["getExecutionHandoffs"] = (cursor) =>
      sql<{ thread_id: string; operation_id: string; recovery_required: number }>`
        SELECT thread_id, json_extract(payload_json,'$.executionHandoff.operationId') AS operation_id,
          json_extract(payload_json,'$.executionHandoff.recoveryRequired') AS recovery_required
        FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json,'$.executionHandoff.operationId') IS NOT NULL
          AND thread_id > ${cursor ?? ""} ORDER BY thread_id LIMIT 65`.pipe(
        Effect.map((rows) => ({
          items: rows.slice(0, 64).map((r) => ({
            threadId: ThreadId.make(r.thread_id),
            operationId: r.operation_id,
            recoveryRequired: r.recovery_required === 1,
          })),
          nextCursor: rows.length > 64 ? rows[63]!.thread_id : null,
        })),
        Effect.mapError(
          (cause) =>
            new ProjectionStoreReadError({ threadId: ThreadId.make("execution-handoffs"), cause }),
        ),
      );

    const getProjectProviderSessionBindings: ProjectionStoreV2Shape["getProjectProviderSessionBindings"] =
      (projectId, cursor) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const anchor =
                cursor === undefined
                  ? null
                  : yield* Effect.try(() => {
                      const value: unknown = JSON.parse(
                        Buffer.from(cursor, "base64url").toString("utf8"),
                      );
                      if (
                        !Array.isArray(value) ||
                        value.length !== 3 ||
                        value[0] !== projectId ||
                        value.some((part) => typeof part !== "string")
                      )
                        throw new Error("Invalid provider binding continuation");
                      return value as [string, string, string];
                    });
              const watermark = yield* sql<{
                sequence: number;
              }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events WHERE application_event_version = 2`;
              const rows = yield* sql<{ thread_id: string; provider_session_id: string }>`
          SELECT thread.thread_id, binding.provider_session_id
          FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_provider_session_bindings AS binding ON binding.thread_id = thread.thread_id
          WHERE thread.project_id = ${projectId}
            AND (${anchor === null ? 1 : 0} = 1 OR thread.thread_id > ${anchor?.[1] ?? null}
              OR (thread.thread_id = ${anchor?.[1] ?? null} AND binding.provider_session_id > ${anchor?.[2] ?? null}))
          ORDER BY thread.thread_id, binding.provider_session_id LIMIT 65`;
              const admitted = rows.slice(0, 64);
              const last = admitted.at(-1);
              return {
                snapshotSequence: watermark[0]?.sequence ?? 0,
                items: admitted.map((row) => ({
                  threadId: ThreadId.make(row.thread_id),
                  providerSessionId: ProviderSessionId.make(row.provider_session_id),
                })),
                nextCursor:
                  rows.length > admitted.length && last
                    ? Buffer.from(
                        JSON.stringify([projectId, last.thread_id, last.provider_session_id]),
                      ).toString("base64url")
                    : null,
              };
            }),
          )
          .pipe(
            Effect.mapError((cause) => new ProjectionStoreProjectReadError({ projectId, cause })),
          );

    const getProjectRoots: ProjectionStoreV2Shape["getProjectRoots"] = (projectId, cursor) =>
      Effect.gen(function* () {
        const anchor =
          cursor === undefined
            ? ""
            : yield* Effect.try(() => {
                const value: unknown = JSON.parse(
                  Buffer.from(cursor, "base64url").toString("utf8"),
                );
                if (
                  !Array.isArray(value) ||
                  value.length !== 2 ||
                  value[0] !== projectId ||
                  typeof value[1] !== "string"
                )
                  throw new Error("Invalid Project root continuation");
                return value[1];
              });
        const rows = yield* sql<{ thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE project_id = ${projectId} AND thread_id > ${anchor}
            AND thread_id = json_extract(payload_json, '$.lineage.rootThreadId')
          ORDER BY thread_id LIMIT 201`;
        const threadIds = rows.slice(0, 200).map((row) => ThreadId.make(row.thread_id));
        const last = threadIds.at(-1);
        return {
          threadIds,
          nextCursor:
            rows.length > 200 && last !== undefined
              ? Buffer.from(JSON.stringify([projectId, last])).toString("base64url")
              : null,
        };
      }).pipe(
        Effect.mapError((cause) => new ProjectionStoreProjectReadError({ projectId, cause })),
      );

    const getQueuedRunPage: ProjectionStoreV2Shape["getQueuedRunPage"] = (threadId, cursor) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const anchor =
              cursor === undefined
                ? null
                : yield* Effect.try(() => {
                    const value: unknown = JSON.parse(
                      Buffer.from(cursor, "base64url").toString("utf8"),
                    );
                    if (
                      !Array.isArray(value) ||
                      value.length !== 4 ||
                      value[0] !== threadId ||
                      !Number.isSafeInteger(value[1]) ||
                      !Number.isSafeInteger(value[2]) ||
                      typeof value[3] !== "string"
                    )
                      throw new Error("Invalid queue continuation");
                    return value as [string, number, number, string];
                  });
            const watermark = yield* sql<{
              sequence: number;
            }>`SELECT COALESCE(MAX(sequence),0) AS sequence FROM orchestration_events WHERE application_event_version = 2`;
            const rows = yield* sql<{
              run_id: string;
              ordinal: number;
              user_message_id: string;
              user_item_id: string | null;
              queue_position: number;
              held: number;
              requested_at: string;
            }>`
          SELECT run.run_id, run.ordinal, json_extract(run.payload_json,'$.userMessageId') AS user_message_id,
            COALESCE(json_extract(run.payload_json,'$.queuePosition'),run.ordinal) AS queue_position,
            COALESCE(json_extract(run.payload_json,'$.queueHeld'),0) AS held, run.requested_at,
            (SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = run.thread_id AND item.run_id = run.run_id AND item.type = 'user_message'
                AND json_extract(item.payload_json,'$.messageId') = json_extract(run.payload_json,'$.userMessageId')
              ORDER BY item.turn_item_id LIMIT 1) AS user_item_id
          FROM orchestration_v2_projection_runs run
          WHERE run.thread_id = ${threadId} AND run.status = 'queued'
            AND (${anchor === null ? 1 : 0} = 1 OR (COALESCE(json_extract(run.payload_json,'$.queuePosition'),run.ordinal),run.ordinal,run.run_id)
              > (${anchor?.[1] ?? 0},${anchor?.[2] ?? 0},${anchor?.[3] ?? ""}))
          ORDER BY COALESCE(json_extract(run.payload_json,'$.queuePosition'),run.ordinal),run.ordinal,run.run_id LIMIT 26`;
            const admitted = rows.slice(0, 25);
            const last = admitted.at(-1);
            return {
              snapshotSequence: watermark[0]?.sequence ?? 0,
              entries: admitted.map((row) => ({
                runId: row.run_id,
                userMessageId: row.user_message_id,
                userItemId: row.user_item_id,
                queuePosition: row.queue_position,
                held: row.held === 1,
                requestedAt: row.requested_at,
              })),
              nextCursor:
                rows.length > 25 && last
                  ? Buffer.from(
                      JSON.stringify([threadId, last.queue_position, last.ordinal, last.run_id]),
                    ).toString("base64url")
                  : null,
              nextRunId: rows[25]?.run_id ?? null,
            };
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));
    const decodeQueuedImages = Schema.decodeUnknownEffect(Schema.Array(ChatImageAttachment));
    const getQueuedRunPreview: ProjectionStoreV2Shape["getQueuedRunPreview"] = (threadId, runId) =>
      sql<{
        thread_id: string;
        run_id: string;
        message_id: string;
        text: string;
        images_json: string;
      }>`
      SELECT message.thread_id, run.run_id, message.message_id, substr(json_extract(message.payload_json,'$.text'),1,2048) AS text,
      (SELECT json_group_array(json_object('type','image','id',json_extract(image.value,'$.id'),
        'name',json_extract(image.value,'$.name'),'mimeType',json_extract(image.value,'$.mimeType'),
        'sizeBytes',json_extract(image.value,'$.sizeBytes')))
        FROM (SELECT value FROM json_each(message.payload_json,'$.attachments')
          WHERE json_extract(value,'$.type') = 'image' LIMIT 32) image) AS images_json
      FROM orchestration_v2_projection_runs run JOIN orchestration_v2_projection_messages message
        ON message.message_id = json_extract(run.payload_json,'$.userMessageId') AND message.thread_id = run.thread_id
      WHERE run.thread_id = ${threadId} AND run.run_id = ${runId} AND run.status = 'queued' AND message.role = 'user' LIMIT 1`.pipe(
        Effect.flatMap((rows) => {
          const row = rows[0];
          if (!row) return Effect.succeed(null);
          const images =
            row.images_json === "[]"
              ? Effect.succeed([])
              : decodeQueuedImages(parseEncodedPayload(row.images_json));
          return images.pipe(
            Effect.map((images) => ({
              threadId: row.thread_id,
              runId: row.run_id,
              messageId: row.message_id,
              text: row.text.slice(0, 2048),
              images,
            })),
          );
        }),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getRunUserMessage: ProjectionStoreV2Shape["getRunUserMessage"] = (threadId, runId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`SELECT message.payload_json
        FROM orchestration_v2_projection_runs run JOIN orchestration_v2_projection_messages message
          ON message.message_id = json_extract(run.payload_json,'$.userMessageId') AND message.thread_id = run.thread_id
        WHERE run.thread_id = ${threadId} AND run.run_id = ${runId} AND run.status != 'rolled_back'
          AND message.role = 'user' LIMIT 1`;
        if (!rows[0]) return null;
        if (Buffer.byteLength(rows[0].payload_json) > 15 * 1024 * 1024)
          return yield* Effect.fail(new Error("User message exceeds the detail budget"));
        return yield* decodeMessagePayload(rows[0].payload_json);
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const getOpeningRequest: ProjectionStoreV2Shape["getOpeningRequest"] = (threadId) =>
      Effect.gen(function* () {
        // Projection rows are inserted in event publication order; upserts retain their rowid.
        // Display ordinals differ for queued turns and cannot identify the opening request.
        const rows = yield* sql<PayloadRow>`SELECT message.payload_json
          FROM orchestration_v2_projection_turn_items item
          JOIN orchestration_v2_projection_messages message
            ON message.message_id = json_extract(item.payload_json, '$.messageId')
              AND message.thread_id = item.thread_id
          WHERE item.thread_id = ${threadId} AND item.type = 'user_message'
            AND json_extract(item.payload_json, '$.inputIntent') IN ('turn_start','queued_turn')
            AND message.role = 'user'
          ORDER BY item.rowid ASC LIMIT 1`;
        if (!rows[0]) return null;
        if (Buffer.byteLength(rows[0].payload_json) > 15 * 1024 * 1024)
          return yield* Effect.fail(new Error("Opening request exceeds the detail budget"));
        return yield* decodeMessagePayload(rows[0].payload_json);
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const getProjectExecutionActivity: ProjectionStoreV2Shape["getProjectExecutionActivity"] = (
      projectId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const watermark = yield* sql<{ snapshot_sequence: number | null }>`
          SELECT MAX(sequence) AS snapshot_sequence FROM orchestration_events WHERE application_event_version = 2`;
            const handoffs = yield* sql<{ thread_id: string; operation_id: string }>`
              SELECT thread_id,json_extract(payload_json,'$.executionHandoff.operationId') AS operation_id
              FROM orchestration_v2_projection_threads WHERE project_id = ${projectId}
                AND json_extract(payload_json,'$.executionHandoff.operationId') IS NOT NULL LIMIT 1`;
            const runs = yield* sql<{
              thread_id: string;
              run_id: string;
              status: OrchestrationV2Run["status"];
            }>`
          SELECT run.thread_id,run.run_id,run.status FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_runs AS run ON run.thread_id = thread.thread_id
          WHERE thread.project_id = ${projectId} AND run.status IN ('queued','preparing','starting','running','waiting') LIMIT 1`;
            const requests = yield* sql<{ thread_id: string; runtime_request_id: string }>`
          SELECT request.thread_id,request.runtime_request_id FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_runtime_requests AS request ON request.thread_id = thread.thread_id
          WHERE thread.project_id = ${projectId} AND request.status IN ('pending','waiting') LIMIT 1`;
            const tasks = yield* sql<{ thread_id: string; subagent_id: string }>`
          SELECT task.thread_id,task.subagent_id FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_subagents AS task ON task.thread_id = thread.thread_id
          WHERE thread.project_id = ${projectId} AND task.origin = 'provider_native'
            AND task.status IN ('pending','running','waiting') LIMIT 1`;
            const nativeRosters =
              tasks.length > 0
                ? []
                : yield* sql<{ thread_id: string; task_id: string }>`
          SELECT thread.thread_id,json_extract(provider.payload_json,'$.pendingBackgroundTasks[0].taskId') AS task_id
          FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_provider_threads AS provider ON provider.thread_id = thread.thread_id
          WHERE thread.project_id = ${projectId} AND json_array_length(provider.payload_json,'$.pendingBackgroundTasks') > 0 LIMIT 1`;
            const ownedRosters =
              tasks.length > 0 || nativeRosters.length > 0
                ? []
                : yield* sql<{ thread_id: string; task_id: string }>`
          SELECT thread.thread_id,json_extract(provider.payload_json,'$.pendingBackgroundTasks[0].taskId') AS task_id
          FROM orchestration_v2_projection_threads AS thread
          CROSS JOIN orchestration_v2_projection_nodes AS node ON node.thread_id = thread.thread_id
          CROSS JOIN orchestration_v2_projection_provider_threads AS provider ON provider.owner_node_id = node.node_id
          WHERE thread.project_id = ${projectId} AND json_array_length(provider.payload_json,'$.pendingBackgroundTasks') > 0 LIMIT 1`;
            const run = runs[0];
            const request = requests[0];
            const task = tasks[0];
            const nativeRoster = nativeRosters[0] ?? ownedRosters[0];
            return {
              executionHandoff: handoffs[0]
                ? {
                    threadId: ThreadId.make(handoffs[0].thread_id),
                    operationId: handoffs[0].operation_id,
                  }
                : null,
              snapshotSequence: watermark[0]?.snapshot_sequence ?? 0,
              run:
                run === undefined
                  ? null
                  : {
                      threadId: ThreadId.make(run.thread_id),
                      runId: RunId.make(run.run_id),
                      status: run.status,
                    },
              runtimeRequest:
                request === undefined
                  ? null
                  : {
                      threadId: ThreadId.make(request.thread_id),
                      requestId: RuntimeRequestId.make(request.runtime_request_id),
                    },
              nativeBackground:
                task === undefined
                  ? nativeRoster === undefined
                    ? null
                    : {
                        threadId: ThreadId.make(nativeRoster.thread_id),
                        taskId: NodeId.make(nativeRoster.task_id),
                      }
                  : {
                      threadId: ThreadId.make(task.thread_id),
                      taskId: NodeId.make(task.subagent_id),
                    },
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) => new ProjectionStoreProjectReadError({ projectId, cause })),
        );

    const getThreadSubagentOverview: ProjectionStoreV2Shape["getThreadSubagentOverview"] = (
      input,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(input.threadId);
            const readPage = (
              phase: SubagentOverviewPhase,
              cursor: string | undefined,
              limit: number,
            ) =>
              Effect.gen(function* () {
                const anchor =
                  cursor === undefined
                    ? null
                    : decodeSubagentOverviewCursor(cursor, input.threadId, phase);
                if (cursor !== undefined && anchor === null)
                  return yield* new ProjectionStoreReadError({
                    threadId: input.threadId,
                    cause: new Error("Invalid task overview cursor"),
                  });
                const inPhase = sql`thread_id = ${input.threadId}
              ${input.taskId === undefined ? sql`` : sql`AND subagent_id = ${input.taskId}`}
              AND CASE WHEN status IN ('completed','failed','cancelled','interrupted') THEN 'terminal' ELSE 'active' END = ${phase}`;
                const [counted] = yield* sql<{ total: number }>`
            SELECT COUNT(*) AS total FROM orchestration_v2_projection_subagents WHERE ${inPhase}`;
                const totalCount = counted?.total ?? 0;
                const ids = yield* sql<{ subagent_id: string; updated_at: string }>`
            SELECT subagent_id, updated_at FROM orchestration_v2_projection_subagents
            WHERE ${inPhase}
              AND (${anchor?.updatedAt ?? null} IS NULL OR updated_at < ${anchor?.updatedAt ?? null}
                OR (updated_at = ${anchor?.updatedAt ?? null} AND subagent_id < ${anchor?.id ?? null}))
            ORDER BY updated_at DESC, subagent_id DESC LIMIT ${limit + 1}`;
                const admitted = ids.slice(0, limit);
                if (admitted.length === 0)
                  return { items: [], nextCursor: null, hasMore: false, totalCount };
                const rows = yield* sql<PayloadRow>`SELECT json_patch(json_object(
            'id', task.subagent_id, 'threadId', task.thread_id, 'runId', task.run_id,
            'parentNodeId', task.parent_node_id, 'origin', task.origin, 'driver', task.driver,
            'providerInstanceId', task.provider_instance_id, 'providerThreadId', task.provider_thread_id,
            'childThreadId', task.child_thread_id, 'title', substr(json_extract(task.payload_json, '$.title'), 1, 512),
            'model', substr(json_extract(task.payload_json, '$.model'), 1, 256), 'status', task.status,
            'startedAt', task.started_at, 'completedAt', task.completed_at, 'updatedAt', task.updated_at,
            'childRunId', (SELECT run_id FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = task.child_thread_id ORDER BY ordinal DESC LIMIT 1),
            'resultAvailable', json(CASE WHEN json_type(task.payload_json, '$.result') IS NOT NULL
              AND json_type(task.payload_json, '$.result') <> 'null' THEN 'true' ELSE 'false' END)),
            CASE WHEN json_type(task.payload_json, '$.modelSelection') = 'object' THEN json_object('modelSelection', json_object(
              'instanceId', json_extract(task.payload_json, '$.modelSelection.instanceId'),
              'model', substr(json_extract(task.payload_json, '$.modelSelection.model'), 1, 256))) ELSE '{}' END) AS payload_json
            FROM orchestration_v2_projection_subagents AS task WHERE task.thread_id = ${input.threadId}
              AND ${sql.in(
                "subagent_id",
                admitted.map((row) => row.subagent_id),
              )}
            ORDER BY task.updated_at DESC, task.subagent_id DESC`;
                const items = yield* decodeRows(decodeSubagentOverview, input.threadId)(rows);
                const last = admitted.at(-1)!;
                const hasMore = ids.length > limit;
                return {
                  items,
                  hasMore,
                  totalCount,
                  nextCursor: hasMore
                    ? encodeSubagentOverviewCursor(
                        input.threadId,
                        phase,
                        last.updated_at,
                        last.subagent_id,
                      )
                    : null,
                };
              });
            return {
              active: yield* readPage("active", input.activeCursor, 4),
              terminal: yield* readPage("terminal", input.terminalCursor, 10),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(input.threadId)));

    const getPendingNativeUserInputs: ProjectionStoreV2Shape["getPendingNativeUserInputs"] = (
      threadId,
      providerTurnId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND kind = 'user_input' AND status = 'pending'
        `;
            const runtimeRequests = (yield* decodeRows(
              decodeRuntimeRequestPayload,
              threadId,
            )(rows)).filter((request) => request.responseCapability.type !== "message");
            if (runtimeRequests.length === 0) return { runtimeRequests, nodes: [], turnItems: [] };
            const nodeRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND ${sql.in(
            "node_id",
            runtimeRequests.map((request) => request.nodeId),
          )}
        `;
            const itemRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND type = 'user_input_request'
        `;
            const requestIds = new Set(runtimeRequests.map((request) => request.id));
            return {
              runtimeRequests,
              nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
              turnItems: (yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows)).filter(
                (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
              ),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getPlan: ProjectionStoreV2Shape["getPlan"] = (threadId, planId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_plans
          WHERE thread_id = ${threadId} AND plan_id = ${planId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodePlanPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const hasUnpairedRunInterruptRequest: ProjectionStoreV2Shape["hasUnpairedRunInterruptRequest"] =
      (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ pending: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${requestId}
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${resultId}
        ) AS pending
      `;
          return rows[0]?.pending === 1;
        }).pipe(Effect.mapError(controlReadError(threadId)));

    const getRuntimeRequest: ProjectionStoreV2Shape["getRuntimeRequest"] = (threadId, requestId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND runtime_request_id = ${requestId}
        `;
            return rows[0] === undefined
              ? undefined
              : yield* decodeRuntimeRequestPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getProviderRetirementContext: ProjectionStoreV2Shape["getProviderRetirementContext"] = (
      threadId,
      providerSessionId,
      providerThreadId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE (provider_thread_id = ${providerThreadId ?? null}
             OR (provider_thread_id = (SELECT active_provider_thread_id FROM orchestration_v2_projection_threads
               WHERE thread_id = ${threadId}) AND ${providerThreadId === undefined ? 1 : 0} = 1))
          AND thread_id = ${threadId} AND provider_session_id = ${providerSessionId} LIMIT 1`;
            const providerThread =
              rows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(rows[0].payload_json);
            if (
              providerThread === undefined ||
              providerThread.appThreadId !== threadId ||
              providerThread.providerSessionId !== providerSessionId
            )
              return { providerThread: undefined, providerTurn: undefined };
            const turnRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND provider_thread_id = ${providerThread.id}
          ORDER BY ordinal DESC LIMIT 1`;
            return {
              providerThread,
              providerTurn:
                turnRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getPendingMessageDeliveryIds: ProjectionStoreV2Shape["getPendingMessageDeliveryIds"] = (
      threadId,
      providerThreadId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const messages = yield* sql<{ message_id: string }>`
          SELECT message_id FROM orchestration_v2_projection_messages INDEXED BY orchestration_v2_messages_pending_delivery_idx
          WHERE thread_id = ${threadId} AND ${sql.literal(PENDING_MESSAGE_DELIVERY_PREDICATE)}
          ORDER BY message_id LIMIT ${MAX_PENDING_MESSAGE_DELIVERIES}`;
            if (messages.length === 0) return [];
            const byItemId = new Map(
              messages.map((row) => {
                const messageId = MessageId.make(row.message_id);
                return [derive.userTurnItem({ messageId }), messageId] as const;
              }),
            );
            const items = yield* sql<{
              turn_item_id: string;
            }>`SELECT turn_item_id FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND provider_thread_id = ${providerThreadId}
            AND turn_item_id IN (SELECT value FROM json_each(${encodeIdList([...byItemId.keys()])}))`;
            return items.flatMap((item) => {
              const id = byItemId.get(TurnItemId.make(item.turn_item_id));
              return id === undefined ? [] : [id];
            });
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getProviderControlContext: ProjectionStoreV2Shape["getProviderControlContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            // Match the full projection's ownership scope, but fetch only the target
            // records. Transcript items and fork ancestors are never read here.
            const [threadRows, turnRows, attemptRows, messageRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${target.providerThreadId} AND (
              thread_id = ${threadId}
              OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId})
            )`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} AND provider_turn_id = ${target.providerTurnId}`,
              target.attemptId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND attempt_id = ${target.attemptId}`,
              target.messageId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND message_id = ${target.messageId}`,
            ]);
            const providerThread =
              threadRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(threadRows[0].payload_json);
            const providerTurn =
              turnRows[0] === undefined
                ? undefined
                : yield* decodeProviderTurnPayload(turnRows[0].payload_json);
            const attempt =
              attemptRows[0] === undefined
                ? undefined
                : yield* decodeRunAttemptPayload(attemptRows[0].payload_json);
            const message =
              messageRows[0] === undefined
                ? undefined
                : yield* decodeMessagePayload(messageRows[0].payload_json);
            let run: OrchestrationV2Run | undefined;
            if (target.messageId !== undefined && providerTurn !== undefined) {
              const rows =
                yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.activeAttemptId') IS ${providerTurn.runAttemptId}
            ORDER BY ordinal ASC LIMIT 1`;
              if (rows[0] !== undefined) run = yield* decodeRunPayload(rows[0].payload_json);
            }
            return { providerThread, providerTurn, attempt, message, run };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunningTurnContext: ProjectionStoreV2Shape["getRunningTurnContext"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND status = 'running' ORDER BY ordinal ASC LIMIT 1`;
            const run =
              rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
            if (run === undefined)
              return { run, providerThread: undefined, providerTurn: undefined };
            const threadRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${run.providerThreadId}`;
            const turnRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE provider_thread_id = ${run.providerThreadId}
            AND run_attempt_id = ${run.activeAttemptId}
            AND node_id = ${run.rootNodeId}
            AND status = 'running'`;
            return {
              run,
              providerThread:
                threadRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(threadRows[0].payload_json),
              providerTurn:
                turnRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getThreadProviderContext: ProjectionStoreV2Shape["getThreadProviderContext"] = (
      threadId,
      targetInstanceId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const sessionRows = yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId}
          ORDER BY session.updated_at ASC, session.provider_session_id ASC
        `;
            const threadRows =
              targetInstanceId === undefined
                ? []
                : yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${thread.activeProviderThreadId}
             OR provider_thread_id = (
               SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
               WHERE thread_id = ${threadId} AND owner_node_id IS NULL
                 AND provider_instance_id = ${targetInstanceId}
               ORDER BY updated_at DESC, provider_thread_id ASC LIMIT 1
             )
          ORDER BY updated_at ASC, provider_thread_id ASC
        `;
            return {
              thread,
              providerSessions: yield* decodeRows(
                decodeProviderSessionPayload,
                threadId,
              )(sessionRows),
              providerThreads: yield* decodeRows(decodeProviderThreadPayload, threadId)(threadRows),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRuntimeResponseContext: ProjectionStoreV2Shape["getRuntimeResponseContext"] = (
      threadId,
      requestId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const request = yield* getRuntimeRequest(threadId, requestId);
            if (request === undefined)
              return { request, node: undefined, item: undefined, session: undefined };
            const nodeRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId}`;
            const itemRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId} AND type IN ('approval_request', 'user_input_request')
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ORDER BY ordinal ASC LIMIT 1`;
            const sessionRows =
              request.responseCapability.type !== "live"
                ? []
                : yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId} AND session.provider_session_id = ${request.responseCapability.providerSessionId}`;
            return {
              request,
              node:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              item:
                itemRows[0] === undefined
                  ? undefined
                  : yield* decodeTurnItemPayload(itemRows[0].payload_json),
              session:
                sessionRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getCheckpointContext: ProjectionStoreV2Shape["getCheckpointContext"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const threads = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} LIMIT 1
          `;
            if (threads.length === 0) {
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            }
            // Checkpoint diffs need no transcript or fork ancestry. Select just the
            // metadata columns so large run/checkpoint JSON payloads stay in SQLite.
            const [runs, checkpointScopes, checkpoints] = yield* Effect.all([
              sql`
              SELECT run_id AS id, ordinal, status
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
              ORDER BY ordinal ASC
            `,
              sql`
              SELECT scope_id AS id, run_id AS "runId", kind,
                json_extract(payload_json, '$.cwd') AS cwd
              FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId}
              ORDER BY ordinal_within_parent ASC, scope_id ASC
            `,
              sql`
              SELECT checkpoint_id AS id, scope_id AS "scopeId", run_id AS "runId",
                ordinal_within_scope AS "ordinalWithinScope", app_run_ordinal AS "appRunOrdinal", status,
                json_extract(payload_json, '$.ref') AS ref
              FROM orchestration_v2_projection_checkpoints
              WHERE thread_id = ${threadId}
              ORDER BY scope_id ASC, ordinal_within_scope ASC
            `,
            ]);
            return yield* decodeCheckpointContext({ runs, checkpointScopes, checkpoints });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getCheckpointCaptureContext: ProjectionStoreV2Shape["getCheckpointCaptureContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const runRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id = ${target.runId}`;
            const run =
              runRows[0] === undefined
                ? undefined
                : yield* decodeRunPayload(runRows[0].payload_json);
            const [nodeRows, scopeRows, providerRows, baselineRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${run?.providerThreadId ?? null}
              AND (thread_id = ${threadId}
                OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
                OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
              sql<{
                readonly ordinal_within_scope: number;
                readonly status: OrchestrationV2Checkpoint["status"];
                readonly run_id: RunId | null;
                readonly app_run_ordinal: number | null;
                readonly node_id: NodeId;
                readonly parent_checkpoint_id: CheckpointId | null;
              }>`SELECT ordinal_within_scope, status, run_id, app_run_ordinal, node_id,
              parent_checkpoint_id FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}
              AND ordinal_within_scope IN (0, ${Math.max(0, (run?.ordinal ?? 1) - 1)})`,
            ]);
            return {
              run,
              rootNode:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              scope:
                scopeRows[0] === undefined
                  ? undefined
                  : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json),
              providerThread:
                providerRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
              baselineCheckpoints: baselineRows.map((row) => ({
                ordinalWithinScope: row.ordinal_within_scope,
                status: row.status,
                runId: row.run_id,
                appRunOrdinal: row.app_run_ordinal,
                nodeId: row.node_id,
                parentCheckpointId: row.parent_checkpoint_id,
              })),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunMessage: ProjectionStoreV2Shape["getRunMessage"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
          JOIN orchestration_v2_projection_runs AS run
            ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
          WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
            AND message.thread_id = ${threadId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodeMessagePayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const canStartQueuedRun: ProjectionStoreV2Shape["canStartQueuedRun"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<{ readonly ready: number }>`
          SELECT 1 AS ready FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = ${threadId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND status = 'queued')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND (status IN ('preparing', 'starting', 'running', 'waiting')
                  OR (status = 'queued' AND json_extract(payload_json, '$.queueHeld') = 1)))`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getMessageCount: ProjectionStoreV2Shape["getMessageCount"] = (threadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const getNextTurnItemOrdinal: ProjectionStoreV2Shape["getNextTurnItemOrdinal"] = (threadId) =>
      sql<{ ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => (rows[0]?.ordinal ?? 0) + 1),
        Effect.mapError(controlReadError(threadId)),
      );

    const getTurnItem: ProjectionStoreV2Shape["getTurnItem"] = ({ threadId, itemId }) =>
      sql<{ payload_json: string }>`SELECT payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(null)
            : decodeTurnItemPayload(rows[0].payload_json),
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getVisibleTurnItemRecord: ProjectionStoreV2Shape["getVisibleTurnItemRecord"] = ({
      threadId,
      itemId,
      sourceThreadId,
    }) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Forks capture Run membership, including source Runs withdrawn only afterward.
            // Resolve only this identity and ancestry; omitted output never decodes.
            const lineage = sql`WITH RECURSIVE visible_sources(thread_id, max_run_ordinal, local, history_revision) AS (
          SELECT thread_id, 0, 1, NULL FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
          UNION
          SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId'), COALESCE((
            SELECT ordinal FROM orchestration_v2_projection_runs
            WHERE thread_id = json_extract(thread.payload_json, '$.forkedFrom.threadId')
              AND run_id = json_extract(thread.payload_json, '$.forkedFrom.runId') LIMIT 1), -1), 0,
            json_extract(thread.payload_json, '$.forkedFrom.sourceHistoryRevision')
          FROM orchestration_v2_projection_threads AS thread
          INNER JOIN visible_sources ON visible_sources.thread_id = thread.thread_id
          WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
        )`;
            const rows = yield* sql<
              PayloadRow & {
                readonly local: number;
                readonly message_id: string | null;
                readonly created_by: "user" | "agent" | "system" | null;
                readonly creation_source: string | null;
                readonly sender_thread_id: string | null;
              }
            >`${lineage}
          SELECT item.payload_json, source.local,
            json_extract(item.payload_json, '$.messageId') AS message_id,
            COALESCE(json_extract(message.payload_json, '$.createdBy'), json_extract(item.payload_json, '$.createdBy')) AS created_by,
            COALESCE(json_extract(message.payload_json, '$.creationSource'), json_extract(item.payload_json, '$.creationSource')) AS creation_source,
            json_extract(message.payload_json, '$.senderThreadId') AS sender_thread_id
          FROM visible_sources AS source
          INNER JOIN orchestration_v2_projection_turn_items AS item ON item.thread_id = source.thread_id
          INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = item.thread_id
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = item.run_id
          LEFT JOIN orchestration_v2_projection_messages AS message ON message.thread_id = item.thread_id
            AND message.message_id = json_extract(item.payload_json, '$.messageId')
          WHERE item.turn_item_id = ${itemId}
            AND (${sourceThreadId ?? null} IS NULL OR item.thread_id = ${sourceThreadId ?? null})
            AND ((source.local = 1 AND (run.status IS NULL OR run.status <> 'rolled_back')
                AND NOT (item.type = 'user_message' AND run.status IS 'cancelled'
                  AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'))
              OR (source.local = 0 AND source.max_run_ordinal >= 0
                AND ${capturedRunVisibility(sql`source.history_revision`)}
                AND (run.ordinal <= source.max_run_ordinal
                  OR (item.run_id IS NULL AND json_extract(thread.payload_json, '$.historyOrigin') IN ('v1_import', 'native_import')))))
            AND NOT (item.type = 'run_interrupt_result'
              AND EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts AS attempt
                WHERE attempt.run_id = item.run_id AND attempt.root_node_id = item.node_id AND attempt.status = 'superseded')
              AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS request
                WHERE request.thread_id = item.thread_id AND request.run_id = item.run_id AND request.type = 'run_interrupt_request'))
          LIMIT 1
        `;
            if (rows[0]) {
              const row = rows[0];
              const item = yield* decodeTurnItemPayload(row.payload_json);
              return {
                sourceThreadId: item.threadId,
                sourceItemId: item.id,
                visibility: row.local === 1 ? ("local" as const) : ("inherited" as const),
                item,
                metadata: {
                  messageId: row.message_id,
                  createdBy: row.created_by,
                  creationSource: row.creation_source,
                  senderThreadId: row.sender_thread_id,
                  title: item.title,
                },
              };
            }
            const marker = yield* sql<PayloadRow>`${lineage}
          SELECT thread.payload_json FROM visible_sources AS source
          INNER JOIN orchestration_v2_projection_threads AS thread ON thread.thread_id = source.thread_id
          WHERE ${itemId} = 'turn-item:fork:' || thread.thread_id
            AND json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
            AND (${sourceThreadId ?? null} IS NULL OR json_extract(thread.payload_json, '$.forkedFrom.threadId') = ${sourceThreadId ?? null})
          LIMIT 1
        `;
            if (!marker[0]) return null;
            const thread = yield* decodeThreadPayload(marker[0].payload_json);
            if (thread.forkedFrom?.type !== "run") return null;
            const item = makeForkMarkerTurnItem({
              targetProjection: { thread },
              sourceThreadId: thread.forkedFrom.threadId,
              sourceRunId: thread.forkedFrom.runId,
            });
            return {
              sourceThreadId: thread.forkedFrom.threadId,
              sourceItemId: item.id,
              visibility: "synthetic" as const,
              item,
              metadata: {
                title: item.title,
                messageId: null,
                createdBy: null,
                creationSource: null,
                senderThreadId: null,
              },
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getVisibleTurnItem: ProjectionStoreV2Shape["getVisibleTurnItem"] = (input) =>
      getVisibleTurnItemRecord(input).pipe(Effect.map((record) => record?.item ?? null));

    // Every attachment visible in the Thread: its own references and those captured from fork
    // sources up to each fork point. Shared files are removed only after their last live user.
    const getThreadAttachmentIds: ProjectionStoreV2Shape["getThreadAttachmentIds"] = (threadId) =>
      sql<{ readonly attachment_id: string }>`
        WITH RECURSIVE visible_sources(thread_id, max_run_ordinal) AS (
          SELECT ${threadId}, NULL
          UNION
          SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId'), COALESCE((
            SELECT ordinal FROM orchestration_v2_projection_runs
            WHERE run_id = json_extract(thread.payload_json, '$.forkedFrom.runId')), -1)
          FROM orchestration_v2_projection_threads AS thread
          INNER JOIN visible_sources ON visible_sources.thread_id = thread.thread_id
          WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
        )
        SELECT DISTINCT ref.attachment_id
        FROM visible_sources AS source
        INNER JOIN orchestration_v2_projection_attachment_refs AS ref
          ON ref.thread_id = source.thread_id
        LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = ref.run_id
        WHERE source.max_run_ordinal IS NULL OR run.ordinal IS NULL
          OR run.ordinal <= source.max_run_ordinal
      `.pipe(
        Effect.map((rows) => rows.map((row) => row.attachment_id)),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"] = (
      threadId,
      fields,
      filter,
    ) =>
      sql.withTransaction(readCanonicalProjection(threadId, undefined, fields, filter)).pipe(
        Effect.map(
          (projection) =>
            Object.fromEntries([
              ["thread", projection.thread],
              ...fields.map((field) => [field, projection[field]]),
            ]) as ProjectionRecords<(typeof fields)[number]>,
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getMessageDispatchProjection: ProjectionStoreV2Shape["getMessageDispatchProjection"] = (
      input,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { threadId } = input;
            const thread = yield* getThread(threadId);
            const transferRows = yield* sql<PayloadRow>`SELECT payload_json
          FROM orchestration_v2_projection_context_transfers
          WHERE target_thread_id = ${threadId} AND status = 'pending'
            AND type IN ('fork', 'merge_back') ORDER BY rowid ASC LIMIT 129`;
            if (transferRows.length > 128)
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Too many pending context transfers.",
              });
            const contextTransfers = yield* decodeRows(
              decodeContextTransferPayload,
              threadId,
            )(transferRows);
            const activeProviderRows = yield* sql<PayloadRow>`SELECT payload_json
          FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${thread.activeProviderThreadId} LIMIT 1`;
            const activeProvider =
              activeProviderRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(activeProviderRows[0].payload_json);
            const instance = input.providerInstanceId ?? thread.modelSelection.instanceId;
            // Handoff history has its own SQL budget; control intake always selects row heads.
            const activeRows = yield* sql<{ run_id: string }>`SELECT run_id
          FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
            AND status IN ('preparing','starting','running','waiting') ORDER BY ordinal ASC LIMIT 129`;
            if (activeRows.length > 128)
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Too many simultaneous foreground Runs.",
              });
            const heads = yield* sql<{ run_id: string }>`
          SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status <> 'queued'
              AND NOT (status = 'cancelled' AND json_extract(payload_json,'$.startedAt') IS NULL)
            ORDER BY completed_at IS NULL DESC, completed_at DESC, ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'completed' ORDER BY ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status IN ('completed','failed','interrupted') ORDER BY ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND ${input.includeWorkStartedAt === true ? sql`json_extract(payload_json,'$.startedAt') IS NOT NULL` : sql`0`}
            ORDER BY json_extract(payload_json,'$.startedAt') DESC, ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status = 'queued'
            ORDER BY COALESCE(json_extract(payload_json,'$.queuePosition'),ordinal) DESC LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_runs_held_queue_idx
            WHERE thread_id = ${threadId} AND status = 'queued' AND json_extract(payload_json,'$.queueHeld') = 1 LIMIT 1)
          UNION SELECT run_id FROM (SELECT run_id FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND status <> 'queued'
            ORDER BY completed_at IS NULL DESC, completed_at DESC, ordinal DESC LIMIT 1)
          UNION SELECT run_id FROM orchestration_v2_projection_messages
            WHERE thread_id = ${threadId} AND message_id = ${input.messageId ?? null} AND run_id IS NOT NULL`;
            const runIds = [
              ...new Set([
                ...input.runIds,
                ...activeRows.map((row) => row.run_id),
                ...heads.map((row) => row.run_id),
              ]),
            ];
            const runRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id IN (SELECT value FROM json_each(${encodeIdList(runIds)}))
          ORDER BY ordinal ASC`;
            const runs = yield* decodeRows(decodeRunPayload, threadId)(runRows);
            const providerRows = yield* sql<PayloadRow>`SELECT payload_json
          FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id IN (
            SELECT value FROM json_each(${encodeIdList(runs.flatMap((run) => (run.providerThreadId === null ? [] : [run.providerThreadId])))})
            UNION SELECT ${thread.activeProviderThreadId}
            UNION SELECT provider_thread_id FROM (SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}
                AND provider_instance_id = ${instance} AND owner_node_id IS NULL AND status <> 'closed'
              ORDER BY COALESCE(last_run_ordinal,0) DESC, updated_at DESC LIMIT 1)
            UNION SELECT provider_thread_id FROM (SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads WHERE thread_id = ${threadId}
                AND provider_instance_id = ${instance} AND owner_node_id IS NULL AND status <> 'closed'
              ORDER BY updated_at DESC LIMIT 1)) ORDER BY first_run_ordinal, provider_thread_id`;
            const providerThreads = yield* decodeRows(
              decodeProviderThreadPayload,
              threadId,
            )(providerRows);
            const selectedRuns = encodeIdList(runs.map((run) => run.id));
            const attemptRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
          WHERE thread_id = ${threadId} AND attempt_id IN (
            SELECT json_extract(run.payload_json,'$.activeAttemptId') FROM orchestration_v2_projection_runs run
              WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns}))
            UNION SELECT (SELECT attempt_id FROM orchestration_v2_projection_run_attempts attempt
              WHERE attempt.thread_id = ${threadId} AND attempt.run_id = run.run_id
              ORDER BY attempt_ordinal DESC LIMIT 1) FROM orchestration_v2_projection_runs run
              WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns}))) ORDER BY run_id, attempt_ordinal`;
            const nodeRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json,'$.rootNodeId')
            FROM orchestration_v2_projection_runs WHERE run_id IN (SELECT value FROM json_each(${selectedRuns})))`;
            const turnRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND provider_turn_id IN (
            SELECT (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns turn
              WHERE turn.thread_id = ${threadId} AND turn.run_attempt_id = json_extract(run.payload_json,'$.activeAttemptId')
                AND turn.node_id = json_extract(run.payload_json,'$.rootNodeId') ORDER BY ordinal DESC LIMIT 1)
              FROM orchestration_v2_projection_runs run WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns}))
            UNION SELECT (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns turn
              WHERE turn.thread_id = ${threadId} AND turn.run_attempt_id = json_extract(run.payload_json,'$.activeAttemptId')
                AND turn.status = 'running' ORDER BY ordinal ASC LIMIT 1)
              FROM orchestration_v2_projection_runs run WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns}))
            UNION SELECT (SELECT provider_turn_id FROM orchestration_v2_projection_provider_turns turn
              WHERE turn.thread_id = ${threadId} AND turn.run_attempt_id = json_extract(run.payload_json,'$.activeAttemptId')
                AND turn.status = 'cancelled' ORDER BY ordinal DESC LIMIT 1)
              FROM orchestration_v2_projection_runs run WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns})))
          ORDER BY provider_thread_id, ordinal`;
            // Match ECMAScript trim, including tabs, newlines and Unicode spaces.
            const trimChars =
              " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
            const maintenance = sql`json_array_length(payload_json,'$.attachments') = 0
          AND lower(trim(json_extract(payload_json,'$.text'),${trimChars})) IN ('/compact','/logout')`;
            const controlMessage = sql`json_set(json_remove(payload_json,'$.context','$.notification','$.delegatedCompletion'), '$.attachments', json('[]'),
          '$.text', CASE WHEN ${maintenance} THEN lower(trim(json_extract(payload_json,'$.text'),${trimChars})) ELSE '' END)`;
            const firstMessage = yield* sql<PayloadRow>`SELECT ${controlMessage} AS payload_json
          FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND role = 'user'
          ORDER BY created_at, message_id LIMIT 1`;
            const first =
              firstMessage[0] === undefined
                ? undefined
                : yield* decodeMessagePayload(firstMessage[0].payload_json);
            const nonMaintenance =
              first?.text === "/compact" || first?.text === "/logout"
                ? yield* sql<PayloadRow>`SELECT ${controlMessage} AS payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND role = 'user' AND NOT (${maintenance}) ORDER BY created_at, message_id LIMIT 1`
                : [];
            const messageRows =
              yield* sql<PayloadRow>`SELECT CASE WHEN message_id = ${input.messageId ?? null}
            THEN payload_json ELSE ${controlMessage} END AS payload_json
          FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND role = 'user'
            AND (message_id = ${input.messageId ?? null} OR message_id IN (SELECT json_extract(payload_json,'$.userMessageId')
              FROM orchestration_v2_projection_runs WHERE run_id IN (SELECT value FROM json_each(${selectedRuns}))))`;
            const itemRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id IN (
            SELECT turn_item_id FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND turn_item_id = ${input.messageId === undefined ? null : derive.userTurnItem({ messageId: input.messageId })}
            UNION SELECT turn_item_id FROM (SELECT turn_item_id FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND type = 'user_message'
                AND json_extract(payload_json, '$.messageId') = ${input.messageId ?? null}
              ORDER BY ordinal ASC, turn_item_id ASC LIMIT 1)
            UNION SELECT (SELECT turn_item_id FROM orchestration_v2_projection_turn_items item
              WHERE item.thread_id = ${threadId} AND item.run_id = run.run_id AND item.type = 'error'
                AND item.status = 'failed' AND item.node_id IS json_extract(run.payload_json,'$.rootNodeId')
              ORDER BY updated_at DESC, ordinal DESC, turn_item_id DESC LIMIT 1)
              FROM orchestration_v2_projection_runs run WHERE run.run_id IN (SELECT value FROM json_each(${selectedRuns})))
          ORDER BY ordinal, turn_item_id`;
            const taskRows =
              yield* sql<PayloadRow>`SELECT json_set(json_remove(payload_json,'$.progress','$.modelSelection.options'),'$.prompt',
            substr(trim(json_extract(payload_json,'$.prompt'),${trimChars}),1,81), '$.title',
            substr(trim(json_extract(payload_json,'$.title'),${trimChars}),1,81), '$.result', NULL) AS payload_json
          FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}
            AND subagent_id IN (SELECT value FROM json_each(${encodeIdList(input.taskIds)}))`;
            const instances = encodeIdList([
              ...new Set([
                thread.providerInstanceId,
                instance,
                ...(activeProvider === undefined ? [] : [activeProvider.providerInstanceId]),
              ]),
            ]);
            const liveSessionIds = yield* sql<{
              id: string;
            }>`SELECT session.provider_session_id AS id
              FROM orchestration_v2_projection_provider_session_bindings binding
              CROSS JOIN orchestration_v2_projection_provider_sessions session ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = ${threadId} AND session.status NOT IN ('stopped','error') LIMIT 129`;
            if (liveSessionIds.length > 128)
              return yield* new ProjectionStoreReadError({
                threadId,
                cause: "Too many simultaneous native Session bindings.",
              });
            const sessionRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions
          WHERE provider_session_id IN (
            SELECT value FROM json_each(${encodeIdList(providerThreads.flatMap((provider) => (provider.providerSessionId === null ? [] : [provider.providerSessionId])))})
            UNION SELECT (SELECT session.provider_session_id
              FROM orchestration_v2_projection_provider_session_bindings binding
              CROSS JOIN orchestration_v2_projection_provider_sessions session ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = ${threadId} AND session.provider_instance_id = selected.value
              ORDER BY session.updated_at DESC, session.provider_session_id DESC LIMIT 1) FROM json_each(${instances}) selected
            UNION SELECT (SELECT session.provider_session_id
              FROM orchestration_v2_projection_provider_session_bindings binding
              CROSS JOIN orchestration_v2_projection_provider_sessions session ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = ${threadId} AND session.provider_instance_id = selected.value
                AND session.status NOT IN ('stopped','error')
              ORDER BY session.updated_at DESC, session.provider_session_id DESC LIMIT 1) FROM json_each(${instances}) selected
            UNION SELECT value FROM json_each(${encodeIdList(liveSessionIds.map((row) => row.id))})
            )`;
            const scopeRows = yield* sql<PayloadRow>`SELECT payload_json
              FROM orchestration_v2_projection_checkpoint_scopes WHERE thread_id = ${threadId} AND scope_id IN (
                SELECT json_extract(payload_json, '$.checkpointScopeId') FROM orchestration_v2_projection_nodes
                WHERE node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs
                  WHERE run_id IN (SELECT value FROM json_each(${selectedRuns}))))`;
            const requestRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND status = 'pending' LIMIT 1`;
            const messages = yield* decodeRows(
              decodeMessagePayload,
              threadId,
            )([...firstMessage, ...nonMaintenance, ...messageRows]);
            return {
              thread,
              runs,
              providerThreads,
              contextTransfers,
              messages: [...new Map(messages.map((message) => [message.id, message])).values()],
              attempts: yield* decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
              nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
              providerTurns: yield* decodeRows(decodeProviderTurnPayload, threadId)(turnRows),
              subagents: yield* decodeRows(decodeSubagentPayload, threadId)(taskRows),
              providerSessions: yield* decodeRows(
                decodeProviderSessionPayload,
                threadId,
              )(sessionRows),
              runtimeRequests: yield* decodeRows(
                decodeRuntimeRequestPayload,
                threadId,
              )(requestRows),
              turnItems: yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows),
              plans: [],
              checkpoints: [],
              checkpointScopes: yield* decodeRows(
                decodeCheckpointScopePayload,
                threadId,
              )(scopeRows),
              contextHandoffs: [],
              visibleTurnItems: [],
              updatedAt: thread.updatedAt,
            } satisfies OrchestrationV2ThreadProjection;
          }),
        )
        .pipe(Effect.mapError(controlReadError(input.threadId)));

    const getThreadSnapshot: ProjectionStoreV2Shape["getThreadSnapshot"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const projection = yield* getThreadProjection(threadId);
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
          `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    // Only the timeline index is assembled across fork ancestry. Payloads are read
    // after page selection, so history and MCP pages hydrate only the requested rows.
    type TimelineIndexItem = Pick<
      OrchestrationV2TurnItem,
      "id" | "threadId" | "runId" | "nodeId" | "type" | "status" | "updatedAt"
    > & {
      readonly inputIntent?: Extract<
        OrchestrationV2TurnItem,
        { type: "user_message" }
      >["inputIntent"];
      readonly createdBy?: "user" | "agent" | "system";
      readonly messageId?: MessageId;
    };
    type TimelineIndexRow = {
      readonly sourceThreadId: ThreadId;
      readonly sourceItemId: TurnItemId;
      readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
      readonly item: TimelineIndexItem;
      readonly synthetic?: OrchestrationV2TurnItem;
      readonly encodedBytes?: number;
    };
    const timelineIndexReadError =
      (threadId: ThreadId) =>
      (cause: unknown): ProjectionStoreV2Error =>
        isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
          ? cause
          : new ProjectionStoreReadError({ threadId, cause });
    type TimelineIndex = {
      readonly records: ProjectionRecords<"runs" | "attempts">;
      readonly local: ReadonlyArray<TimelineIndexRow>;
      readonly visible: ReadonlyArray<TimelineIndexRow>;
    };
    /** The thread's own visible rows, without captured fork ancestry. */
    const readLocalTimelineIndex = (
      threadId: ThreadId,
    ): Effect.Effect<TimelineIndex, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
        const rows = yield* sql<{
          turn_item_id: string;
          run_id: string | null;
          node_id: string | null;
          type: OrchestrationV2TurnItem["type"];
          status: OrchestrationV2TurnItem["status"];
          updated_at: string;
          input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
          created_by: "user" | "agent" | "system" | null;
          message_id: string | null;
          payload_bytes: number;
        }>`SELECT turn_item_id, run_id, node_id, type, status, updated_at,
          CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.inputIntent') END AS input_intent,
          CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.createdBy') END AS created_by,
          CASE WHEN type IN ('user_message', 'assistant_message') THEN json_extract(payload_json, '$.messageId') END AS message_id,
          length(CAST(payload_json AS BLOB)) AS payload_bytes
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
        ORDER BY ordinal ASC, turn_item_id ASC`;
        const items: Array<TimelineIndexItem> = rows.map((row) => ({
          id: TurnItemId.make(row.turn_item_id),
          threadId,
          runId: row.run_id === null ? null : RunId.make(row.run_id),
          nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
          type: row.type,
          status: row.status,
          updatedAt: DateTime.makeUnsafe(row.updated_at),
          ...(row.input_intent === null ? {} : { inputIntent: row.input_intent }),
          ...(row.created_by === null ? {} : { createdBy: row.created_by }),
          ...(row.message_id === null ? {} : { messageId: MessageId.make(row.message_id) }),
        }));
        const local: Array<TimelineIndexRow> = items.map((item, position) => ({
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local",
          item,
          // Reserve projected address/envelope bytes before fetching item bodies.
          encodedBytes: rows[position]!.payload_bytes + 1_024,
        }));
        const isVisible = createOrchestrationV2TurnItemVisibility({
          runs: records.runs,
          attempts: records.attempts,
          items,
        });
        return { records, local, visible: local.filter((row) => isVisible(row.item)) };
      }).pipe(Effect.mapError(timelineIndexReadError(threadId)));
    const readTimelineIndex = (
      threadId: ThreadId,
      seen: ReadonlySet<ThreadId>,
    ): Effect.Effect<TimelineIndex, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const { records, local, visible } = yield* readLocalTimelineIndex(threadId);
        const fork = records.thread.forkedFrom;
        if (fork?.type !== "run" || seen.has(fork.threadId)) return { records, local, visible };
        const source = yield* readTimelineIndex(fork.threadId, new Set([...seen, threadId]));
        const sourceRun = source.records.runs.find((run) => run.id === fork.runId);
        let inherited: Array<TimelineIndexRow> = [];
        if (sourceRun !== undefined) {
          const ordinals = new Map(
            source.records.runs
              .filter((run) => isRunVisibleAtHistoryRevision(run, fork.sourceHistoryRevision))
              .map((run) => [run.id, run.ordinal]),
          );
          const sourceItems = source.local.map((row) => row.item);
          inherited = [
            ...source.visible.filter(
              (row) => row.item.threadId !== fork.threadId || row.item.type === "fork",
            ),
            ...source.local.filter(
              (row) =>
                !isOrchestrationV2SupersededInterrupt({
                  item: row.item,
                  attempts: source.records.attempts,
                  items: sourceItems,
                }) &&
                isTurnItemAtOrBeforeRun({
                  historyOrigin: source.records.thread.historyOrigin,
                  itemRunId: row.item.runId,
                  runOrdinalById: ordinals,
                  sourceRunOrdinal: sourceRun.ordinal,
                }),
            ),
          ].map((row) => ({ ...row, visibility: "inherited" }));
        }
        const marker = makeForkMarkerTurnItem({
          targetProjection: records,
          sourceThreadId: fork.threadId,
          sourceRunId: fork.runId,
        });
        return {
          records,
          local,
          visible: [
            ...inherited,
            {
              sourceThreadId: fork.threadId,
              sourceItemId: marker.id,
              visibility: "synthetic" as const,
              item: marker,
              synthetic: marker,
            },
            ...visible,
          ],
        };
      }).pipe(Effect.mapError(timelineIndexReadError(threadId)));

    const { searchThread, searchThreadStream } = yield* makeThreadFind((threadId) =>
      readTimelineIndex(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
    );

    const getThreadHistoryPage: ProjectionStoreV2Shape["getThreadHistoryPage"] = (
      threadId,
      cursor,
      throughEntryId,
      conversationOnly,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const anchor = yield* Effect.try({
              try: () => decodeThreadHistoryCursor(cursor),
              catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
            });
            const snapshot = yield* getThreadSnapshotWindow(threadId, {
              rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems,
              userTurnLimit:
                throughEntryId === undefined
                  ? OLDER_THREAD_USER_TURN_LIMIT
                  : OLDER_THREAD_USER_TURN_LIMIT * 2,
              anchorThreadId: ThreadId.make(anchor.st),
              anchorItemId: TurnItemId.make(anchor.si),
              anchorOrdinal: anchor.so,
              exclusiveAnchor: true,
              historyOnly: true,
            });
            if (snapshot.projection.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const targetIsAdmitted = snapshot.projection.visibleTurnItems.some(
              (row) =>
                ("messageId" in row.item ? row.item.messageId : row.item.id) === throughEntryId,
            );
            // An explicit search jump may reach beyond this bounded window.
            // Prove the target exists with a metadata-only point query instead
            // of materializing the full ancestral timeline to count its turns.
            const earlierTarget =
              throughEntryId === undefined || targetIsAdmitted
                ? []
                : yield* sql<{ readonly present: number }>`
              WITH RECURSIVE lineage(thread_id) AS (
                SELECT ${anchor.st}
                UNION
                SELECT json_extract(thread.payload_json, '$.forkedFrom.threadId')
                FROM orchestration_v2_projection_threads AS thread
                INNER JOIN lineage ON lineage.thread_id = thread.thread_id
                WHERE json_extract(thread.payload_json, '$.forkedFrom.type') = 'run'
              )
              SELECT 1 AS present FROM orchestration_v2_projection_turn_items AS item
              WHERE item.thread_id IN (SELECT thread_id FROM lineage)
                AND (item.turn_item_id = ${throughEntryId} OR (item.type IN ('user_message','assistant_message')
                  AND json_extract(item.payload_json, '$.messageId') = ${throughEntryId}))
                AND (item.thread_id <> ${anchor.st} OR item.ordinal < COALESCE(
                  (SELECT ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id = ${anchor.st} AND turn_item_id = ${anchor.si} LIMIT 1),
                  ${anchor.so ?? 9223372036854775807n}))
              LIMIT 1
            `;
            const bounded = selectHistoryPageFromCursor({
              items: snapshot.projection.visibleTurnItems.map((row) => ({
                ...row,
                item: projectTurnItemForWire(row.item),
              })),
              cursor,
              cursorAlreadyExcluded: true,
              throughEntryId,
              snapshotSequence: snapshot.snapshotSequence,
              hasEarlierHistory: snapshot.hasEarlierHistory,
              policy: {
                ...THREAD_HISTORY_PAGE_POLICY,
                maxUserTurns:
                  earlierTarget.length > 0
                    ? OLDER_THREAD_USER_TURN_LIMIT * 2
                    : OLDER_THREAD_USER_TURN_LIMIT,
              },
            });
            return {
              snapshotSequence: snapshot.snapshotSequence,
              items: conversationOnly
                ? bounded.items.filter((row) => isConversationHistoryItem(row.item))
                : bounded.items,
              nextCursor: bounded.nextCursor,
              hasMoreHistory: bounded.hasMoreHistory,
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getThreadPromptIndex: ProjectionStoreV2Shape["getThreadPromptIndex"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { visible } = yield* readLocalTimelineIndex(threadId);
            const { slots, complete } = selectThreadPromptIndexSlots(visible);
            const itemIds = slots.flatMap((slot) =>
              slot.responseItemId === null
                ? [slot.promptItemId]
                : [slot.promptItemId, slot.responseItemId],
            );
            const texts = new Map<string, { readonly text: string; readonly scheduled: boolean }>();
            for (let start = 0; start < itemIds.length; start += 500) {
              const rows = yield* sql<{
                turn_item_id: string;
                text: string | null;
                scheduled: number;
              }>`SELECT turn_item_id,
                substr(json_extract(payload_json, '$.text'), 1, ${THREAD_PROMPT_INDEX_PROMPT_CHARACTERS}) AS text,
                json_extract(payload_json, '$.scheduledTaskId') IS NOT NULL AS scheduled
              FROM orchestration_v2_projection_turn_items
              WHERE thread_id = ${threadId} AND turn_item_id IN ${sql.in(itemIds.slice(start, start + 500))}`;
              for (const row of rows)
                texts.set(row.turn_item_id, {
                  text: row.text ?? "",
                  scheduled: row.scheduled === 1,
                });
            }
            return {
              complete,
              prompts: slots.map((slot) => {
                const prompt = texts.get(slot.promptItemId);
                const response =
                  slot.responseItemId === null ? undefined : texts.get(slot.responseItemId);
                return {
                  runId: slot.runId,
                  messageId: slot.messageId,
                  prompt: boundThreadPromptText(
                    prompt?.text ?? "",
                    THREAD_PROMPT_INDEX_PROMPT_CHARACTERS,
                  ),
                  response: boundThreadPromptText(
                    response?.text ?? "",
                    THREAD_PROMPT_INDEX_RESPONSE_CHARACTERS,
                  ),
                  scheduled: prompt?.scheduled === true,
                };
              }),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getTimelinePage: ProjectionStoreV2Shape["getTimelinePage"] = (threadId, options) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const index = yield* readTimelineIndex(threadId, new Set());
            const selection = selectTimelineRows(
              index.visible.map((row, position) => ({ ...row, position })),
              options,
            );
            const page = selection.items;
            const items = yield* Effect.forEach(page, (row) =>
              Effect.gen(function* () {
                if (row.synthetic !== undefined)
                  return {
                    position: row.position,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    visibility: row.visibility,
                    item: row.synthetic,
                  };
                const payloads =
                  yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${row.sourceThreadId} AND turn_item_id = ${row.sourceItemId}`;
                const decoded = yield* decodeRows(
                  decodeTurnItemPayload,
                  row.sourceThreadId,
                )(payloads);
                const item = decoded[0];
                if (item === undefined)
                  return yield* new ProjectionStoreReadError({
                    threadId,
                    cause: "Timeline item disappeared during snapshot",
                  });
                return {
                  position: row.position,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  visibility: row.visibility,
                  item,
                };
              }),
            );
            return {
              items,
              totalItems: selection.totalItems,
              hasMore: selection.hasMore,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getTimelineMetadataPage: ProjectionStoreV2Shape["getTimelineMetadataPage"] = (
      threadId,
      options,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const index = yield* readTimelineIndex(threadId, new Set());
            const page = selectTimelineRows(
              index.visible.map((row, position) => ({
                position,
                sourceThreadId: row.sourceThreadId,
                sourceItemId: row.sourceItemId,
                visibility: row.visibility,
                item: {
                  id: row.item.id,
                  runId: row.item.runId,
                  type: row.item.type,
                  status: row.item.status,
                  updatedAt: row.item.updatedAt,
                },
              })),
              options,
            );
            if (page.items.length === 0) return page;
            const wanted = Schema.encodeSync(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    threadId: ThreadId,
                    itemId: TurnItemId,
                  }),
                ),
              ),
            )(
              page.items.map((row) => ({ threadId: row.sourceThreadId, itemId: row.sourceItemId })),
            );
            const rows = yield* sql<{
              readonly thread_id: string;
              readonly item_id: string;
              readonly message_id: string | null;
              readonly created_by: "user" | "agent" | "system" | null;
              readonly creation_source: string | null;
              readonly sender_thread_id: string | null;
              readonly title: string | null;
            }>`SELECT item.thread_id, item.turn_item_id AS item_id,
        json_extract(item.payload_json,'$.messageId') AS message_id,
        COALESCE(json_extract(message.payload_json,'$.createdBy'), json_extract(item.payload_json,'$.createdBy')) AS created_by,
        COALESCE(json_extract(message.payload_json,'$.creationSource'), json_extract(item.payload_json,'$.creationSource')) AS creation_source,
        json_extract(message.payload_json,'$.senderThreadId') AS sender_thread_id,
        json_extract(item.payload_json,'$.title') AS title
        FROM json_each(${wanted}) selected
        JOIN orchestration_v2_projection_turn_items item
          ON item.thread_id=json_extract(selected.value,'$.threadId') AND item.turn_item_id=json_extract(selected.value,'$.itemId')
        LEFT JOIN orchestration_v2_projection_messages message
          ON message.message_id=json_extract(item.payload_json,'$.messageId') AND message.thread_id=item.thread_id`;
            const metadata = new Map(
              rows.map((row) => [
                JSON.stringify([row.thread_id, row.item_id]),
                {
                  messageId: row.message_id,
                  createdBy: row.created_by,
                  creationSource: row.creation_source,
                  senderThreadId: row.sender_thread_id,
                  title: row.title,
                },
              ]),
            );
            return {
              ...page,
              items: page.items.map((row) => ({
                ...row,
                metadata: metadata.get(JSON.stringify([row.sourceThreadId, row.sourceItemId])),
              })),
            };
          }),
        )
        .pipe(Effect.mapError(timelineIndexReadError(threadId)));

    const getThreadSnapshotWindow: ProjectionStoreV2Shape["getThreadSnapshotWindow"] = (
      threadId,
      options,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const historyAnchor =
              options.anchorItemId === undefined
                ? undefined
                : {
                    itemId: options.anchorItemId,
                    ordinal: options.anchorOrdinal,
                    threadId:
                      options.anchorThreadId ??
                      (yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${options.anchorItemId} LIMIT 1
                `).map((row) => ThreadId.make(row.thread_id))[0] ??
                      threadId,
                  };
            const read = yield* readProjection(threadId, new Set(), {
              rowLimit: Math.min(options.rowLimit, THREAD_HISTORY_PAGE_POLICY.maxItems),
              controlOnly: options.controlOnly,
              requiredRunId: options.requiredRunId,
              requiredRequestId: options.requiredRequestId,
              userTurnLimit: options.userTurnLimit,
              anchorOrdinal: options.anchorOrdinal,
              exclusiveAnchor: options.exclusiveAnchor,
              historyOnly: options.historyOnly,
              ...(historyAnchor?.threadId === threadId
                ? { anchorItemId: historyAnchor.itemId }
                : {}),
              ...(historyAnchor === undefined ? {} : { historyAnchor }),
            });
            const projection = read.projection;
            const latest = yield* sql<{ readonly ordinal: number | null }>`
              SELECT MAX(ordinal) AS ordinal FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
            `;
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
              SELECT MAX(sequence) AS snapshot_sequence
              FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
              hasEarlierHistory: read.hasEarlierHistory,
              latestLocalTurnOrdinal: latest[0]?.ordinal ?? null,
            };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const selectShellThreadRows = (
      threadId?: ThreadId,
      { location, projectId, unsettledOnly = false }: ShellSnapshotOptions = {},
    ) =>
      sql<ShellThreadRow>`
            SELECT
              t.thread_id,
              t.payload_json,
              CASE
                WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
                  THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
                ELSE NULL
              END AS forked_from_run_source_thread_id,
              presented.run_id AS latest_run_id,
              presented.status AS latest_run_status,
              presented.requested_at AS latest_run_requested_at,
              json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
              presented.completed_at AS latest_run_completed_at,
              (
                SELECT r.run_id
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS active_run_id,
              (
                SELECT r.status
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_status,
              (
                -- Mirrors orchestrationV2RunWorkStartedAt.
                SELECT COALESCE(
                  json_extract(r.payload_json, '$.workStartedAt'),
                  json_extract(r.payload_json, '$.startedAt'),
                  r.requested_at
                )
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_started_at,
              (
                SELECT json_extract(session.payload_json, '$.lastError')
                -- Keep bindings outermost: one provider instance can hold every session.
                FROM orchestration_v2_projection_provider_session_bindings binding
                CROSS JOIN orchestration_v2_projection_provider_sessions session
                  ON session.provider_session_id = binding.provider_session_id
                WHERE binding.thread_id = t.thread_id
                  AND session.provider_instance_id = t.provider_instance_id
                ORDER BY session.updated_at DESC, session.provider_session_id DESC
                LIMIT 1
              ) AS last_error,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
                WHERE r.run_id = presented.run_id
                  AND r.status = 'failed'
                  AND item.thread_id = t.thread_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS terminal_failure_payload_json,
              blocked.run_id AS blocking_run_id,
              blocked.requested_at AS blocking_run_requested_at,
              json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
              blocked.completed_at AS blocking_run_completed_at,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE item.thread_id = t.thread_id
                  AND item.run_id = blocked.run_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS blocking_failure_payload_json,
              (
                SELECT request.payload_json
                FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id
                  AND request.status = 'pending'
                ORDER BY request.created_at DESC, request.runtime_request_id DESC
                LIMIT 1
              ) AS pending_request_payload_json,
              (
                SELECT secret.payload_json
                FROM orchestration_v2_projection_turn_items secret
                  INDEXED BY orchestration_v2_projection_turn_items_pending_secret_idx
                WHERE secret.thread_id = t.thread_id
                  AND secret.type = 'secret_request' AND secret.status = 'waiting'
                ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
                LIMIT 1
              ) AS pending_secret_request_payload_json,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at,
              EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans plan
                WHERE plan.thread_id = t.thread_id
                  AND plan.kind = 'proposed_plan'
                  AND plan.status = 'active'
              ) AS has_actionable_proposed_plan,
              -- Count per run on the covering (thread_id, run_id) index, then
              -- look up each run once, instead of one run lookup per item.
              (
                SELECT COALESCE(SUM(per_run.item_count), 0)
                FROM (
                  SELECT i.run_id, COUNT(*) AS item_count
                  FROM orchestration_v2_projection_turn_items i
                  WHERE i.thread_id = t.thread_id
                  GROUP BY i.run_id
                ) per_run
                LEFT JOIN orchestration_v2_projection_runs r
                  ON r.run_id = per_run.run_id
                WHERE per_run.run_id IS NULL OR r.status <> 'rolled_back'
              ) AS item_count,
              (
                SELECT COUNT(*)
                FROM orchestration_v2_projection_turn_items i
                WHERE i.thread_id = t.thread_id
                  AND i.run_id IS NULL
              ) AS runless_item_count
            FROM orchestration_v2_projection_threads t
            -- The newest run not waiting in a held queue, matching latestUnheldRun.
            LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND NOT (
                  candidate.status = 'queued'
                  AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
                )
              ORDER BY candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            )
            LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND candidate.status <> 'queued'
                AND NOT (
                  candidate.status = 'cancelled'
                  AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
                )
              -- latestExecutedRun: the run that ended last (runRanAfter).
              ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
                candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            ) AND blocked.status = 'failed'
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}${
              projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`
            }${
              location === "active"
                ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
                : location === "archive"
                  ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NOT NULL`
                  : sql``
            }${
              unsettledOnly
                ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
                : sql``
            }
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;

    const selectShellRunRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal, status,
              json_extract(payload_json, '$.rolledBackAtRevision') AS rolled_back_at_revision
            FROM orchestration_v2_projection_runs
          `
        : sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal, status,
              json_extract(payload_json, '$.rolledBackAtRevision') AS rolled_back_at_revision
            FROM orchestration_v2_projection_runs
            WHERE thread_id IN ${sql.in(threadIds)}
          `;

    const selectShellRunItemCounts = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
            GROUP BY thread_id, run_id
          `
        : sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
              AND thread_id IN ${sql.in(threadIds)}
            GROUP BY thread_id, run_id
          `;

    const selectShellProviderThreadRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IS NOT NULL
          `
        : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IN ${sql.in(threadIds)}
          `;

    const selectShellPendingTurnItemRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT i.thread_id, i.payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              -- A rolled-back run's items are abandoned, not pending. Without
              -- this the shell reports Waiting for work no one will finish,
              -- matching the item_count query's exclusion above.
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
          `
        : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT i.thread_id, i.payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
              AND i.thread_id IN ${sql.in(threadIds)}
          `;

    const runMapsByThreadId = (input: {
      readonly runRows: ReadonlyArray<ShellRunRow>;
      readonly itemCountRows: ReadonlyArray<ShellRunItemCountRow>;
    }) => {
      const runsByThreadId = new Map<ThreadId, Map<RunId, ShellRunState>>();
      for (const row of input.runRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = runsByThreadId.get(threadId) ?? new Map<RunId, ShellRunState>();
        existing.set(runId, {
          ordinal: row.ordinal,
          status: row.status,
          ...(row.rolled_back_at_revision === null
            ? {}
            : { rolledBackAtRevision: row.rolled_back_at_revision }),
        });
        runsByThreadId.set(threadId, existing);
      }
      const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
      for (const row of input.itemCountRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
        existing.set(runId, row.item_count);
        itemCountsByThreadId.set(threadId, existing);
      }
      return { runsByThreadId, itemCountsByThreadId };
    };

    const pendingBackgroundDataByThreadId = (input: {
      readonly providerThreadRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
      readonly pendingTurnItemRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
    }) =>
      Effect.gen(function* () {
        const providerThreadsByThreadId = new Map<
          ThreadId,
          Array<OrchestrationV2ThreadProjection["providerThreads"][number]>
        >();
        for (const row of input.providerThreadRows) {
          const providerThread = yield* decodeProviderThreadPayload(row.payload_json);
          const threadId =
            row.thread_id.length > 0 ? ThreadId.make(row.thread_id) : providerThread.appThreadId;
          if (threadId === null) {
            continue;
          }
          const existing = providerThreadsByThreadId.get(threadId) ?? [];
          existing.push(providerThread);
          providerThreadsByThreadId.set(threadId, existing);
        }

        const pendingTurnItemsByThreadId = new Map<ThreadId, Array<OrchestrationV2TurnItem>>();
        for (const row of input.pendingTurnItemRows) {
          const turnItem = yield* decodeTurnItemPayload(row.payload_json);
          const threadId = ThreadId.make(row.thread_id);
          const existing = pendingTurnItemsByThreadId.get(threadId) ?? [];
          existing.push(turnItem);
          pendingTurnItemsByThreadId.set(threadId, existing);
        }

        return { providerThreadsByThreadId, pendingTurnItemsByThreadId };
      });

    const getSettlementCandidates: ProjectionStoreV2Shape["getSettlementCandidates"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Settlement needs activity timestamps, not item counts, run history,
            // provider sessions or inherited fork rows. Reject parked and busy
            // threads before loading the remaining candidates' background work.
            const rows = yield* sql<SettlementThreadRow>`
            SELECT t.thread_id, t.payload_json,
              r.run_id AS latest_run_id,
              r.status AS latest_run_status,
              r.requested_at AS latest_run_requested_at,
              json_extract(r.payload_json, '$.startedAt') AS latest_run_started_at,
              r.completed_at AS latest_run_completed_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
              SELECT latest.run_id FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = t.thread_id
              ORDER BY latest.ordinal DESC, latest.run_id DESC
              LIMIT 1
            )
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}
              AND json_extract(t.payload_json, '$.archivedAt') IS NULL
              AND json_extract(t.payload_json, '$.settledOverride') IS NULL
              AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
              AND json_extract(t.payload_json, '$.autoSettleDisabledAt') IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs active
                WHERE active.thread_id = t.thread_id
                  AND active.status IN ('preparing', 'starting', 'running', 'waiting')
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id AND request.status = 'pending'
              )
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;
            if (rows.length === 0) return [];
            const threadIds = rows.map((row) => ThreadId.make(row.thread_id));
            const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
              yield* pendingBackgroundDataByThreadId({
                providerThreadRows: yield* selectShellProviderThreadRows(threadIds),
                pendingTurnItemRows: yield* selectShellPendingTurnItemRows(threadIds),
              });
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const thread = yield* decodeThreadPayload(row.payload_json);
                const status = shellStatusFromStoredRunStatus(row.latest_run_status);
                const latestRunId =
                  row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
                return {
                  ...thread,
                  pinnedAt: thread.pinnedAt ?? null,

                  autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
                  snoozedUntil: thread.snoozedUntil ?? null,
                  snoozedAt: thread.snoozedAt ?? null,
                  status,
                  latestRunId,
                  latestRunRequestedAt:
                    row.latest_run_requested_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_requested_at),
                  latestRunStartedAt:
                    row.latest_run_started_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_started_at),
                  latestRunCompletedAt:
                    row.latest_run_completed_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_completed_at),
                  latestUserMessageAt:
                    row.latest_user_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_message_at),
                  latestUserAuthoredMessageAt:
                    row.latest_user_authored_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_authored_message_at),
                  activityRunStatus: null,
                  activityRunStartedAt: null,
                  pendingRuntimeRequest: null,
                  pendingBackgroundTasks: derivePendingBackgroundWork({
                    latestRun:
                      latestRunId === null || status === "idle"
                        ? null
                        : { id: latestRunId, ordinal: 0, status },
                    providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
                    turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
                    activeProviderThreadId: thread.activeProviderThreadId,
                    hasActiveRun: false,
                    pullRequests: thread.pullRequests,
                  }),
                } satisfies ProjectionSettlementCandidate;
              }),
            );
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const getThreadsWithPullRequests: ProjectionStoreV2Shape["getThreadsWithPullRequests"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND thread_id = ${threadId}`}
            AND json_extract(payload_json, '$.archivedAt') IS NULL
            AND json_array_length(payload_json, '$.pullRequests') > 0
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return yield* Effect.forEach(rows, (row) =>
          decodeThreadPayload(row.payload_json).pipe(
            Effect.map((thread): ProjectionThreadPullRequests => ({
              id: thread.id,
              projectId: thread.projectId,
              lineage: thread.lineage,
              settledOverride: thread.settledOverride,
              settledAt: thread.settledAt,
              pullRequests: thread.pullRequests ?? [],
            })),
          ),
        );
      }).pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const shellThreadStateFromRow = (input: {
      readonly row: ShellThreadRow;
      readonly runsByThreadId: ReadonlyMap<ThreadId, Map<RunId, ShellRunState>>;
      readonly itemCountsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly providerThreadsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>
      >;
      readonly pendingTurnItemsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2TurnItem>
      >;
    }) =>
      Effect.gen(function* () {
        const {
          row,
          runsByThreadId,
          itemCountsByThreadId,
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
        } = input;
        const thread = yield* decodeThreadPayload(row.payload_json);
        const pendingRuntimeRequest =
          row.pending_request_payload_json !== null
            ? yield* decodeRuntimeRequestPayload(row.pending_request_payload_json)
            : row.pending_secret_request_payload_json !== null
              ? secretRequestAsPendingInput(
                  yield* decodeTurnItemPayload(row.pending_secret_request_payload_json),
                )
              : null;
        let terminalFailureItem =
          row.terminal_failure_payload_json === null
            ? null
            : yield* decodeTurnItemPayload(row.terminal_failure_payload_json);
        let latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
        let latestRunStatus = shellStatusFromStoredRunStatus(row.latest_run_status);
        let latestRunRequestedAt =
          row.latest_run_requested_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_requested_at);
        let latestRunStartedAt =
          row.latest_run_started_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_started_at);
        let latestRunCompletedAt =
          row.latest_run_completed_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_completed_at);
        if (row.blocking_run_id !== null && row.blocking_failure_payload_json !== null) {
          const blockingFailure = yield* decodeTurnItemPayload(
            row.blocking_failure_payload_json,
          ).pipe(Effect.orElseSucceed(() => null));
          const blocksQueue =
            threadErrorSummary(
              blockingFailure?.type === "error" ? blockingFailure.failure : null,
              row.last_error,
            ).lastErrorClass === "usage_limit";
          if (blocksQueue && blockingFailure !== null) {
            terminalFailureItem = blockingFailure;
            latestRunId = RunId.make(row.blocking_run_id);
            latestRunStatus = "failed";
            latestRunRequestedAt =
              row.blocking_run_requested_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_requested_at);
            latestRunStartedAt =
              row.blocking_run_started_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_started_at);
            latestRunCompletedAt =
              row.blocking_run_completed_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_completed_at);
          }
        }
        const pendingBackgroundTasks = [
          ...derivePendingBackgroundWork({
            latestRun:
              latestRunId === null || latestRunStatus === "idle"
                ? null
                : {
                    id: latestRunId,
                    ordinal: 0,
                    status: latestRunStatus,
                  },
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
            turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
            activeProviderThreadId: thread.activeProviderThreadId,
            hasActiveRun: row.active_run_id !== null,
            pullRequests: thread.pullRequests,
          }),
        ];
        return {
          thread,
          latestRunId,
          latestRunStatus,
          latestRunRequestedAt,
          latestRunStartedAt,
          latestRunCompletedAt,
          activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
          activityRunStartedAt:
            row.activity_run_started_at === null
              ? null
              : DateTime.makeUnsafe(row.activity_run_started_at),
          activityRunStatus:
            row.activity_run_status === "preparing" ||
            row.activity_run_status === "starting" ||
            row.activity_run_status === "running" ||
            row.activity_run_status === "waiting"
              ? row.activity_run_status
              : null,
          ...threadErrorSummary(
            terminalFailureItem?.type === "error" ? terminalFailureItem.failure : null,
            row.last_error,
          ),
          pendingRuntimeRequest,
          latestUserMessageAt:
            row.latest_user_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_message_at),
          latestUserAuthoredMessageAt:
            row.latest_user_authored_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_authored_message_at),
          hasActionableProposedPlan: row.has_actionable_proposed_plan === 1,
          pendingBackgroundTasks,
          providerInstanceHistory: providerInstanceHistoryForShell({
            threadId: thread.id,
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
          }),
          goal: activeProviderGoalForShell(
            providerThreadsByThreadId.get(thread.id) ?? [],
            thread.activeProviderThreadId,
          ),
          itemCount: row.item_count,
          runlessItemCount: row.runless_item_count,
          updatedAt: thread.updatedAt,
          runById: runsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
          itemCountByRunId: itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
        } satisfies ShellThreadState;
      });

    const shellSnapshotReadError = (cause: unknown) =>
      new ProjectionStoreReadError({ threadId: ThreadId.make("thread:shell"), cause });

    const readShellSnapshotRows = (options: ShellSnapshotOptions | undefined) =>
      Effect.gen(function* () {
        const targetThreadRows = yield* selectShellThreadRows(undefined, options);
        const targetThreadIds = new Set(
          targetThreadRows.map((row) => ThreadId.make(row.thread_id)),
        );
        const rowsByThreadId = new Map(
          targetThreadRows.map((row) => [ThreadId.make(row.thread_id), row] as const),
        );
        const pendingSourceIds = targetThreadRows.flatMap((row) =>
          row.forked_from_run_source_thread_id === null
            ? []
            : [ThreadId.make(row.forked_from_run_source_thread_id)],
        );
        while (pendingSourceIds.length > 0) {
          const sourceId = pendingSourceIds.pop();
          if (sourceId === undefined || rowsByThreadId.has(sourceId)) continue;
          const source = (yield* selectShellThreadRows(sourceId))[0];
          if (source === undefined) continue;
          rowsByThreadId.set(sourceId, source);
          if (source.forked_from_run_source_thread_id !== null) {
            pendingSourceIds.push(ThreadId.make(source.forked_from_run_source_thread_id));
          }
        }
        const threadRows = [...rowsByThreadId.values()];
        const threadIds = [...rowsByThreadId.keys()];
        const forkSourceIds = shellForkSourceIds(threadRows);
        const readForThreadIds = <A>(
          read: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<ReadonlyArray<A>, unknown>,
          ids: ReadonlyArray<ThreadId> = threadIds,
        ) => (ids.length === 0 ? Effect.succeed([] as ReadonlyArray<A>) : read(ids));
        const [runRows, itemCountRows, sequenceRows, providerThreadRows, pendingTurnItemRows] =
          yield* Effect.all([
            readForThreadIds(selectShellRunRows, forkSourceIds),
            readForThreadIds(selectShellRunItemCounts, forkSourceIds),
            sql<{ readonly snapshot_sequence: number | null }>`
        SELECT MAX(sequence) AS snapshot_sequence
        FROM orchestration_events
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
      `,
            readForThreadIds(selectShellProviderThreadRows),
            readForThreadIds(selectShellPendingTurnItemRows),
          ]);
        return {
          targetThreadIds,
          threadRows,
          runRows,
          itemCountRows,
          sequenceRows,
          providerThreadRows,
          pendingTurnItemRows,
        };
      });

    const decodeShellSnapshot = ({
      targetThreadIds,
      threadRows,
      runRows,
      itemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
    }: Effect.Success<ReturnType<typeof readShellSnapshotRows>>) =>
      Effect.gen(function* () {
        const { runsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
          runRows,
          itemCountRows,
        });
        const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
          yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });
        const states = yield* Effect.forEach(threadRows, (row) =>
          shellThreadStateFromRow({
            row,
            runsByThreadId,
            itemCountsByThreadId,
            providerThreadsByThreadId,
            pendingTurnItemsByThreadId,
          }),
        );
        const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));

        const shells = states
          .filter((state) => targetThreadIds.has(state.thread.id))
          .map((state) =>
            shellFromState({
              state,
              visibleItemCount: visibleItemCountForShell({
                threadId: state.thread.id,
                statesByThreadId,
              }),
            }),
          );

        return {
          schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
          snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0,
          threads: shells.filter((thread) => thread.archivedAt === null),
          archivedThreads: shells.filter((thread) => thread.archivedAt !== null),
        };
      }).pipe(Effect.mapError(shellSnapshotReadError));

    const readShellSnapshot: ProjectionStoreV2Shape["readShellSnapshot"] = (options) =>
      readShellSnapshotRows(options).pipe(
        Effect.mapError(shellSnapshotReadError),
        Effect.map(decodeShellSnapshot),
      );

    const getShellSnapshot: ProjectionStoreV2Shape["getShellSnapshot"] = (options) =>
      sql
        .withTransaction(readShellSnapshotRows(options))
        .pipe(Effect.mapError(shellSnapshotReadError), Effect.flatMap(decodeShellSnapshot));

    // Per-thread shell for the live shell streams: reads only the target thread
    // plus its fork-source chain instead of materializing every thread. Returns
    // null when the thread is deleted or unknown.
    const getThreadShell: ProjectionStoreV2Shape["getThreadShell"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rowsByThreadId = new Map<ThreadId, ShellThreadRow>();
            const pending: Array<ThreadId> = [threadId];
            while (pending.length > 0) {
              const nextId = pending.pop();
              if (nextId === undefined || rowsByThreadId.has(nextId)) {
                continue;
              }
              const rows = yield* selectShellThreadRows(nextId);
              const row = rows[0];
              if (row === undefined) {
                continue;
              }
              rowsByThreadId.set(nextId, row);
              if (row.forked_from_run_source_thread_id !== null) {
                pending.push(ThreadId.make(row.forked_from_run_source_thread_id));
              }
            }
            if (!rowsByThreadId.has(threadId)) {
              return null;
            }

            const threadIds = [...rowsByThreadId.keys()];
            const forkSourceIds = shellForkSourceIds([...rowsByThreadId.values()]);
            const [runRows, itemCountRows, providerThreadRows, pendingTurnItemRows] =
              yield* Effect.all([
                forkSourceIds.length === 0
                  ? Effect.succeed([] as ReadonlyArray<ShellRunRow>)
                  : selectShellRunRows(forkSourceIds),
                forkSourceIds.length === 0
                  ? Effect.succeed([] as ReadonlyArray<ShellRunItemCountRow>)
                  : selectShellRunItemCounts(forkSourceIds),
                selectShellProviderThreadRows(threadIds),
                selectShellPendingTurnItemRows(threadIds),
              ]);
            const { runsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
              runRows,
              itemCountRows,
            });
            const { providerThreadsByThreadId, pendingTurnItemsByThreadId } =
              yield* pendingBackgroundDataByThreadId({ providerThreadRows, pendingTurnItemRows });

            const states = yield* Effect.forEach([...rowsByThreadId.values()], (row) =>
              shellThreadStateFromRow({
                row,
                runsByThreadId,
                itemCountsByThreadId,
                providerThreadsByThreadId,
                pendingTurnItemsByThreadId,
              }),
            );
            const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
            const state = statesByThreadId.get(threadId);
            if (state === undefined) {
              return null;
            }
            return shellFromState({
              state,
              visibleItemCount: visibleItemCountForShell({ threadId, statesByThreadId }),
            });
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    // Assistant items own separate execution nodes. Their root identifies the current attempt;
    // provider Thread identity alone also matches superseded attempts and delegated work.
    const getRunOutcome: ProjectionStoreV2Shape["getRunOutcome"] = (query) =>
      sql<{
        run_id: string;
        status: OrchestrationV2Run["status"];
        completed_at: string | null;
        final_assistant_item_id: string | null;
      }>`
        SELECT run.run_id, run.status, run.completed_at,
          (SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items item
            WHERE item.thread_id = run.thread_id AND item.run_id = run.run_id
              AND item.type = 'assistant_message'
              AND EXISTS (
                SELECT 1 FROM orchestration_v2_projection_nodes node
                WHERE node.node_id = item.node_id AND node.thread_id = run.thread_id
                  AND node.run_id = run.run_id
                  AND node.root_node_id = json_extract(run.payload_json, '$.rootNodeId')
              )
            ORDER BY item.ordinal DESC, item.turn_item_id DESC LIMIT 1) AS final_assistant_item_id
        FROM orchestration_v2_projection_runs run
        WHERE run.thread_id = ${query.threadId}
          AND ${
            query.runId !== undefined
              ? sql`run.run_id = ${query.runId}`
              : sql`run.run_id = (
                  SELECT message.run_id FROM orchestration_v2_projection_messages message
                  WHERE message.message_id = ${query.messageId} AND message.thread_id = ${query.threadId}
                    AND message.role = 'user'
                ) AND json_extract(run.payload_json, '$.userMessageId') = ${query.messageId}`
          }
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : {
                runId: RunId.make(rows[0].run_id),
                status: rows[0].status,
                completedAt: rows[0].completed_at,
                finalAssistantItemId:
                  rows[0].final_assistant_item_id === null
                    ? null
                    : TurnItemId.make(rows[0].final_assistant_item_id),
              },
        ),
        Effect.mapError(
          (cause) => new ProjectionStoreReadError({ threadId: query.threadId, cause }),
        ),
      );

    const service = {
      apply,
      getRunOutcome,
      getShellSnapshot,
      readShellSnapshot,
      getThreadCounts: (threadId) =>
        sql<{ readonly run_count: number; readonly pending_request_count: number }>`
        SELECT (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}) AS run_count,
          (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests WHERE thread_id = ${threadId} AND status = 'pending') AS pending_request_count
      `.pipe(
          Effect.map((rows) => ({
            runCount: rows[0]?.run_count ?? 0,
            pendingRequestCount: rows[0]?.pending_request_count ?? 0,
          })),
          Effect.mapError(controlReadError(threadId)),
        ),
      getTaskOwner: (taskId) =>
        sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_subagents WHERE subagent_id = ${taskId} LIMIT 1
      `.pipe(
          Effect.map((rows) => (rows[0] === undefined ? null : ThreadId.make(rows[0].thread_id))),
          Effect.mapError(
            (cause) =>
              new ProjectionStoreReadError({ threadId: ThreadId.make("thread:task"), cause }),
          ),
        ),
      getThreadShell,
      getThread,
      getSettlementCandidates,
      getThreadsWithPullRequests,
      getThreadProjection,
      getTurnStartContext,
      hasNativeTurns,
      getNativeContextEstimate,
      getDeliveredHandoffItemIds,
      getNativeForkBoundary,
      getRelatedNativeThread,
      getSideChatThreadIds: sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE json_extract(payload_json, '$.sideChat') IS NOT NULL AND deleted_at IS NULL`.pipe(
        Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))),
        Effect.mapError(
          (cause) => new ProjectionStoreReadError({ threadId: ThreadId.make("side-chats"), cause }),
        ),
      ),
      getSideChatContext,
      getHandoffHistory,
      getLastDeliveredRun,
      getRuntimeRecoveryProjection,
      getHostToolAuthorityContext,
      getThreadSubagentOverview,
      getProjectExecutionActivity,
      getProjectRoots,
      getQueuedRunPage,
      getQueuedRunPreview,
      getRunUserMessage,
      getOpeningRequest,
      getProjectProviderSessionBindings,
      getExecutionActors,
      getExecutionHandoffs,
      getExecutionDetachBarrier,
      getExecutionRetirementContext,
      getRunningTurnContext,
      getThreadProviderContext,
      getRuntimeResponseContext,
      getCheckpointContext,
      getCheckpointCaptureContext,
      getRunMessage,
      canStartQueuedRun,
      getPendingNativeUserInputs,
      hasUnpairedRunInterruptRequest,
      getMessageCount,
      getNextTurnItemOrdinal,
      getTurnItem,
      getVisibleTurnItem,
      getVisibleTurnItemRecord,
      getThreadRecords,
      getMessageDispatchProjection,
      getSubagentCount: (threadId, runId) =>
        sql<{ count: number }>`SELECT COUNT(*) AS count
        FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId} AND run_id = ${runId} AND origin = 'app_owned'`.pipe(
          Effect.map((rows) => rows[0]?.count ?? 0),
          Effect.mapError(controlReadError(threadId)),
        ),
      getRuntimeRequest,
      getPlan,
      getProviderControlContext,
      getPendingMessageDeliveryIds,
      getProviderRetirementContext,
      getLimitRecoveryCandidates,
      getRecoveryThreadIds,
      getUnreadableThreadIds,
      getThreadSnapshot,
      getThreadSnapshotWindow,
      getTimelinePage,
      getTimelineMetadataPage,
      getThreadHistoryPage,
      getThreadPromptIndex,
      searchThread,
      searchThreadStream,
      getThreadAttachmentIds,
    } satisfies ProjectionStoreV2Shape;
    const readOnReader =
      <Args extends ReadonlyArray<unknown>, A, E, R>(
        method: (...args: Args) => Effect.Effect<A, E, R>,
      ) =>
      (...args: Args): Effect.Effect<A, E, R> =>
        method(...args).pipe(NodeSqliteClient.readOnly);
    return {
      ...service,
      getRunOutcome: readOnReader(service.getRunOutcome),
      getShellSnapshot: readOnReader(service.getShellSnapshot),
      readShellSnapshot: readOnReader(service.readShellSnapshot),
      getThreadCounts: readOnReader(service.getThreadCounts),
      getTaskOwner: readOnReader(service.getTaskOwner),
      getThreadShell: readOnReader(service.getThreadShell),
      getThread: readOnReader(service.getThread),
      getSettlementCandidates: readOnReader(service.getSettlementCandidates),
      getThreadsWithPullRequests: readOnReader(service.getThreadsWithPullRequests),
      getThreadProjection: readOnReader(service.getThreadProjection),
      getTurnStartContext: readOnReader(service.getTurnStartContext),
      hasNativeTurns: readOnReader(service.hasNativeTurns),
      getNativeContextEstimate: readOnReader(service.getNativeContextEstimate),
      getDeliveredHandoffItemIds: readOnReader(service.getDeliveredHandoffItemIds),
      getNativeForkBoundary: readOnReader(service.getNativeForkBoundary),
      getRelatedNativeThread: readOnReader(service.getRelatedNativeThread),
      getSideChatThreadIds: service.getSideChatThreadIds.pipe(NodeSqliteClient.readOnly),
      getSideChatContext: readOnReader(service.getSideChatContext),
      getHandoffHistory: readOnReader(service.getHandoffHistory),
      getLastDeliveredRun: readOnReader(service.getLastDeliveredRun),
      getRuntimeRecoveryProjection: readOnReader(service.getRuntimeRecoveryProjection),
      getHostToolAuthorityContext: readOnReader(service.getHostToolAuthorityContext),
      getThreadSubagentOverview: readOnReader(service.getThreadSubagentOverview),
      getProjectExecutionActivity: readOnReader(service.getProjectExecutionActivity),
      getProjectRoots: readOnReader(service.getProjectRoots),
      getQueuedRunPage: readOnReader(service.getQueuedRunPage),
      getQueuedRunPreview: readOnReader(service.getQueuedRunPreview),
      getRunUserMessage: readOnReader(service.getRunUserMessage),
      getOpeningRequest: readOnReader(service.getOpeningRequest),
      getProjectProviderSessionBindings: readOnReader(service.getProjectProviderSessionBindings),
      getExecutionActors: readOnReader(service.getExecutionActors),
      getExecutionHandoffs: readOnReader(service.getExecutionHandoffs),
      getExecutionDetachBarrier: readOnReader(service.getExecutionDetachBarrier),
      getExecutionRetirementContext: readOnReader(service.getExecutionRetirementContext),
      getRunningTurnContext: readOnReader(service.getRunningTurnContext),
      getThreadProviderContext: readOnReader(service.getThreadProviderContext),
      getRuntimeResponseContext: readOnReader(service.getRuntimeResponseContext),
      getCheckpointContext: readOnReader(service.getCheckpointContext),
      getCheckpointCaptureContext: readOnReader(service.getCheckpointCaptureContext),
      getRunMessage: readOnReader(service.getRunMessage),
      canStartQueuedRun: readOnReader(service.canStartQueuedRun),
      getPendingNativeUserInputs: readOnReader(service.getPendingNativeUserInputs),
      hasUnpairedRunInterruptRequest: readOnReader(service.hasUnpairedRunInterruptRequest),
      getMessageCount: readOnReader(service.getMessageCount),
      getNextTurnItemOrdinal: readOnReader(service.getNextTurnItemOrdinal),
      getTurnItem: readOnReader(service.getTurnItem),
      getVisibleTurnItem: readOnReader(service.getVisibleTurnItem),
      getVisibleTurnItemRecord: readOnReader(service.getVisibleTurnItemRecord),
      getThreadRecords: readOnReader(service.getThreadRecords),
      getMessageDispatchProjection: readOnReader(service.getMessageDispatchProjection),
      getSubagentCount: readOnReader(service.getSubagentCount),
      getRuntimeRequest: readOnReader(service.getRuntimeRequest),
      getPlan: readOnReader(service.getPlan),
      getProviderControlContext: readOnReader(service.getProviderControlContext),
      getPendingMessageDeliveryIds: readOnReader(service.getPendingMessageDeliveryIds),
      getProviderRetirementContext: readOnReader(service.getProviderRetirementContext),
      getLimitRecoveryCandidates: readOnReader(service.getLimitRecoveryCandidates),
      getRecoveryThreadIds: readOnReader(service.getRecoveryThreadIds),
      getUnreadableThreadIds: readOnReader(service.getUnreadableThreadIds),
      getThreadSnapshot: readOnReader(service.getThreadSnapshot),
      getThreadSnapshotWindow: readOnReader(service.getThreadSnapshotWindow),
      getTimelinePage: readOnReader(service.getTimelinePage),
      getTimelineMetadataPage: readOnReader(service.getTimelineMetadataPage),
      getThreadHistoryPage: readOnReader(service.getThreadHistoryPage),
      getThreadPromptIndex: readOnReader(service.getThreadPromptIndex),
      searchThread: readOnReader(service.searchThread),
      getThreadAttachmentIds: readOnReader(service.getThreadAttachmentIds),
    } satisfies ProjectionStoreV2Shape;
  }),
);

export const layerMemory: Layer.Layer<ProjectionStoreV2> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const replayState = yield* Ref.make(makeProjectionReplayState());
    const sequence = yield* Ref.make(0);

    const sideChatContexts = new Map<ThreadId, ProjectionHandoffHistory>();
    const service: ProjectionStoreV2Shape = {
      getSideChatThreadIds: Ref.get(replayState).pipe(
        Effect.map((state) =>
          [...state.projections.values()]
            .filter((p) => p.thread.sideChat && !p.thread.deletedAt)
            .map((p) => p.thread.id),
        ),
      ),
      getSideChatContext: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            state.projections.get(threadId)?.thread.sideChat?.contextCleared
              ? null
              : (sideChatContexts.get(threadId) ?? null),
          ),
        ),
      apply: (event) =>
        Effect.sync(() => {
          if (event.type === "side-chat.context-captured")
            sideChatContexts.set(event.threadId, event.payload);
        }).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const result = yield* Ref.modify(replayState, (existing) => {
                const next: ProjectionReplayState = {
                  projections: new Map(existing.projections),
                  providerSessionThreadIds: new Map(existing.providerSessionThreadIds),
                  executionRetirementTargets: new Map(existing.executionRetirementTargets),
                };
                if (!applyToProjectionReplayState(next, event)) {
                  return [
                    new ProjectionStoreThreadNotFoundError({ threadId: event.threadId }),
                    existing,
                  ] as const;
                }
                return [undefined, next] as const;
              });

              if (result) {
                return yield* result;
              }
              yield* Ref.update(sequence, (current) => current + 1);
            }),
          ),
        ),
      getShellSnapshot: (options) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const selectedThreadIds = [...existing.entries()]
            .filter(([, projection]) => {
              if (
                options?.projectId !== undefined &&
                projection.thread.projectId !== options.projectId
              ) {
                return false;
              }
              if (
                options?.unsettledOnly &&
                (projection.thread.settledAt !== null ||
                  projection.thread.settledOverride === "settled")
              ) {
                return false;
              }
              if (options?.location === "active") return projection.thread.archivedAt === null;
              if (options?.location === "archive") return projection.thread.archivedAt !== null;
              return true;
            })
            .map(([threadId]) => threadId);
          const shells = yield* Effect.forEach(
            selectedThreadIds.toSorted((left, right) => String(left).localeCompare(String(right))),
            (threadId) =>
              service.getThreadProjection(threadId).pipe(Effect.map(threadShellFromProjection)),
          );
          const visible = shells.filter((thread) => thread.deletedAt === null);
          return {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence: yield* Ref.get(sequence),
            threads: visible.filter((thread) => thread.archivedAt === null),
            archivedThreads: visible.filter((thread) => thread.archivedAt !== null),
          };
        }),
      readShellSnapshot: (options) =>
        service.getShellSnapshot(options).pipe(Effect.map(Effect.succeed)),
      getThreadCounts: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const projection = state.projections.get(threadId);
            return {
              runCount: projection?.runs.length ?? 0,
              pendingRequestCount:
                projection?.runtimeRequests.filter((request) => request.status === "pending")
                  .length ?? 0,
            };
          }),
        ),
      getTaskOwner: (taskId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            for (const [threadId, projection] of state.projections) {
              if (
                projection.subagents.some(
                  (task) => task.id === taskId && task.origin === "app_owned",
                )
              )
                return threadId;
            }
            return null;
          }),
        ),
      getThreadShell: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          if (!existing.has(threadId)) {
            return null;
          }
          const shell = yield* service
            .getThreadProjection(threadId)
            .pipe(Effect.map(threadShellFromProjection));
          return shell.deletedAt === null ? shell : null;
        }),
      getThread: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection.thread;
        }),
      getSettlementCandidates: (threadId) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter(
              ({ thread, runs, runtimeRequests }) =>
                (threadId === undefined || thread.id === threadId) &&
                thread.deletedAt === null &&
                thread.archivedAt === null &&
                thread.settledOverride === null &&
                thread.pinnedAt == null &&
                thread.autoSettleDisabledAt == null &&
                !runs.some(isActivityRunForShell) &&
                !runtimeRequests.some((request) => request.status === "pending"),
            )
            .map((projection) => {
              const shell = threadShellFromProjection(projection);
              return {
                ...shell,
                lastSnoozeWakeAt: projection.thread.lastSnoozeWakeAt ?? null,
                latestUserAuthoredMessageAt: shell.latestUserAuthoredMessageAt ?? null,
              };
            })
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.updatedAt) - DateTime.toEpochMillis(right.updatedAt) ||
                left.id.localeCompare(right.id),
            );
        }),
      getThreadsWithPullRequests: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .map(({ thread }) => thread)
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  (thread.pullRequests ?? []).length > 0,
              )
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(left.updatedAt) -
                    DateTime.toEpochMillis(right.updatedAt) || left.id.localeCompare(right.id),
              )
              .map((thread): ProjectionThreadPullRequests => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: thread.lineage,
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt,
                pullRequests: thread.pullRequests ?? [],
              })),
          ),
        ),
      getLimitRecoveryCandidates: (options) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .filter(
                ({ thread }) =>
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  thread.settledOverride !== "settled",
              )
              .map(threadShellFromProjection)
              .filter(
                (thread) =>
                  thread.status === "failed" &&
                  thread.lastErrorClass === "usage_limit" &&
                  thread.usageLimitResetAt !== null &&
                  thread.pendingRuntimeRequest === null,
              )
              .filter((thread) => {
                const resetMs = Date.parse(thread.usageLimitResetAt!);
                const nowMs = DateTime.toEpochMillis(options.now);
                if (
                  !Number.isFinite(resetMs) ||
                  resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
                )
                  return false;
                if (
                  thread.limitRecovery?.runId !== thread.latestRunId ||
                  thread.limitRecovery.resetAt !== thread.usageLimitResetAt
                ) {
                  return options.autoResume || (options.snooze && resetMs > nowMs);
                }
                return (
                  thread.limitRecovery.autoResume &&
                  resetMs <= nowMs &&
                  (thread.snoozedUntil == null ||
                    DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
                );
              })
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ),
        ),
      getRecoveryThreadIds: (kind) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter((projection) =>
              needsRecovery(
                projection,
                kind,
                projection.thread.lineage.parentThreadId === null
                  ? undefined
                  : projections.get(projection.thread.lineage.parentThreadId),
              ),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.thread.updatedAt) -
                  DateTime.toEpochMillis(right.thread.updatedAt) ||
                left.thread.id.localeCompare(right.thread.id),
            )
            .map((projection) => projection.thread.id);
        }),
      getUnreadableThreadIds: () => Effect.succeed([]),
      getPendingNativeUserInputs: (threadId, providerTurnId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) return { runtimeRequests: [], nodes: [], turnItems: [] };
          const runtimeRequests = projection.runtimeRequests.filter(
            (request) =>
              request.providerTurnId === providerTurnId &&
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type !== "message",
          );
          const requestIds = new Set(runtimeRequests.map((request) => request.id));
          const nodeIds = new Set(runtimeRequests.map((request) => request.nodeId));
          return {
            runtimeRequests,
            nodes: projection.nodes.filter((node) => nodeIds.has(node.id)),
            turnItems: projection.turnItems.filter(
              (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
            ),
          };
        }),
      getPlan: (threadId, planId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.plans.find((plan) => plan.id === planId);
        }),
      hasUnpairedRunInterruptRequest: (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          return (
            projection !== undefined &&
            projection.turnItems.some((item) => item.id === requestId) &&
            !projection.turnItems.some((item) => item.id === resultId)
          );
        }),
      getMessageCount: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => state.projections.get(threadId)?.messages.length ?? 0),
        ),
      getNextTurnItemOrdinal: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              (state.projections
                .get(threadId)
                ?.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0) ?? 0) + 1,
          ),
        ),
      getTurnItem: ({ threadId, itemId }) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              state.projections.get(threadId)?.turnItems.find((item) => item.id === itemId) ?? null,
          ),
        ),
      getVisibleTurnItem: ({ threadId, itemId, sourceThreadId }) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map(
              (projection) =>
                projection.visibleTurnItems.find(
                  (row) =>
                    row.sourceItemId === itemId &&
                    (sourceThreadId === undefined || row.sourceThreadId === sourceThreadId),
                )?.item ?? null,
            ),
          ),
      getVisibleTurnItemRecord: ({ threadId, itemId, sourceThreadId }) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const row = projection.visibleTurnItems.find(
              (row) =>
                row.sourceItemId === itemId &&
                (sourceThreadId === undefined || row.sourceThreadId === sourceThreadId),
            );
            if (!row) return null;
            const messageId = "messageId" in row.item ? row.item.messageId : null;
            const message = projection.messages.find((message) => message.id === messageId);
            return {
              sourceThreadId: row.sourceThreadId,
              sourceItemId: row.sourceItemId,
              visibility: row.visibility,
              item: row.item,
              metadata: visibleItemMetadata(row.item, message),
            };
          }),
        ),
      getThreadAttachmentIds: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => [
            ...new Set([
              ...projection.messages.flatMap((message) =>
                message.attachments.map((attachment) => attachment.id),
              ),
              ...projection.turnItems.flatMap((item) =>
                item.type === "dynamic_tool"
                  ? (item.attachments ?? []).map((attachment) => attachment.id)
                  : [],
              ),
              ...threadHtmlRenderAttachmentIds(
                threadId,
                projection.turnItems.flatMap((item) =>
                  item.type === "dynamic_tool" ? [item] : [],
                ),
              ),
            ]),
          ]),
        ),
      getMessageDispatchProjection: (input) => service.getThreadProjection(input.threadId),
      getSubagentCount: (threadId, runId) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map(
              (projection) =>
                projection.subagents.filter(
                  (task) => task.runId === runId && task.origin === "app_owned",
                ).length,
            ),
          ),
      getThreadRecords: (threadId, fields, filter) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const selected = {
            ...projection,
            messages: projection.messages.filter(
              (row) =>
                (filter?.messageRunIds === undefined ||
                  (row.runId !== null && filter.messageRunIds.includes(row.runId))) &&
                (filter?.messageIds === undefined || filter.messageIds.includes(row.id)) &&
                (filter?.messageRoles === undefined || filter.messageRoles.includes(row.role)),
            ),
            runs: projection.runs
              .filter(
                (row) =>
                  (filter?.runIds === undefined || filter.runIds.includes(row.id)) &&
                  (filter?.runStatuses === undefined || filter.runStatuses.includes(row.status)) &&
                  (filter?.runHasCheckpoint !== true || row.checkpointId !== null) &&
                  (filter?.runCheckpointId === undefined ||
                    projection.checkpoints.some(
                      (checkpoint) =>
                        checkpoint.id === filter.runCheckpointId && checkpoint.runId === row.id,
                    )) &&
                  (filter?.runDelegatedTaskId === undefined ||
                    row.delegatedTaskId === filter.runDelegatedTaskId) &&
                  (filter?.runOpenDelivery !== true ||
                    (row.delegatedCompletion?.delivery !== undefined &&
                      row.delegatedCompletion.delivery !== null)) &&
                  (filter?.excludeHeldRuns !== true ||
                    row.status !== "queued" ||
                    row.queueHeld !== true) &&
                  (filter?.resultOriginalRunId === undefined ||
                    row.id === filter.resultOriginalRunId ||
                    row.startedAt !== null) &&
                  (filter?.excludeMonitorRuns !== true ||
                    !projection.messages.some(
                      (message) =>
                        message.id === row.userMessageId &&
                        message.notification?.source.kind === "monitor",
                    )),
              )
              .toSorted((a, b) =>
                filter?.runOrder === "completed-desc"
                  ? (b.completedAt === null
                      ? Number.POSITIVE_INFINITY
                      : DateTime.toEpochMillis(b.completedAt)) -
                      (a.completedAt === null
                        ? Number.POSITIVE_INFINITY
                        : DateTime.toEpochMillis(a.completedAt)) || b.ordinal - a.ordinal
                  : filter?.runOrder === "desc"
                    ? b.ordinal - a.ordinal
                    : a.ordinal - b.ordinal,
              )
              .slice(
                0,
                filter?.runLimit === undefined
                  ? undefined
                  : Math.max(1, Math.min(128, Math.trunc(filter.runLimit))),
              ),
            nodes: projection.nodes.filter(
              (row) => filter?.nodeIds === undefined || filter.nodeIds.includes(row.id),
            ),
            subagents: projection.subagents.filter(
              (row) =>
                (filter?.subagentIds === undefined || filter.subagentIds.includes(row.id)) &&
                (filter?.subagentRunIds === undefined ||
                  (row.runId !== null && filter.subagentRunIds.includes(row.runId))),
            ),
            attempts: projection.attempts.filter(
              (row) => filter?.attemptIds === undefined || filter.attemptIds.includes(row.id),
            ),
            providerThreads: projection.providerThreads.filter(
              (row) =>
                filter?.providerThreadIds === undefined ||
                filter.providerThreadIds.includes(row.id),
            ),
            providerTurns: projection.providerTurns.filter(
              (row) =>
                filter?.providerTurnAttemptIds === undefined ||
                (row.runAttemptId !== null &&
                  filter.providerTurnAttemptIds.includes(row.runAttemptId)),
            ),
            contextTransfers: projection.contextTransfers
              .filter(
                (row) =>
                  (filter?.contextTransferSourceThreadId === undefined ||
                    row.sourceThreadId === filter.contextTransferSourceThreadId) &&
                  (filter?.contextTransferTargetThreadId === undefined ||
                    row.targetThreadId === filter.contextTransferTargetThreadId) &&
                  (filter?.contextTransferTypes === undefined ||
                    filter.contextTransferTypes.includes(row.type)) &&
                  (filter?.contextTransferStatuses === undefined ||
                    filter.contextTransferStatuses.includes(row.status)) &&
                  (filter?.contextTransferThreadIds === undefined ||
                    filter.contextTransferThreadIds.includes(row.sourceThreadId) ||
                    filter.contextTransferThreadIds.includes(row.targetThreadId)) &&
                  (filter?.contextTransferRunIds === undefined ||
                    (row.sourcePoint.runId !== undefined &&
                      filter.contextTransferRunIds.includes(row.sourcePoint.runId)) ||
                    (row.targetRunId !== null &&
                      filter.contextTransferRunIds.includes(row.targetRunId))),
              )
              .toSorted((a, b) =>
                filter?.contextTransferLimit === undefined
                  ? DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt)
                  : DateTime.toEpochMillis(b.createdAt) - DateTime.toEpochMillis(a.createdAt),
              )
              .slice(
                0,
                filter?.contextTransferLimit === undefined
                  ? undefined
                  : Math.max(1, Math.min(128, Math.trunc(filter.contextTransferLimit))),
              ),
            turnItems: projection.turnItems.filter(
              (row) =>
                (filter?.turnItemRunIds === undefined ||
                  filter.turnItemRunIds.includes(row.runId)) &&
                (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(row.type)) &&
                (filter?.turnItemIds === undefined || filter.turnItemIds.includes(row.id)) &&
                (filter?.turnItemStatuses === undefined ||
                  filter.turnItemStatuses.includes(row.status)) &&
                (filter?.turnItemRunId === undefined || filter.turnItemRunId === row.runId),
            ),
          };
          return Object.fromEntries([
            ["thread", projection.thread],
            ...fields.map((field) => [field, selected[field]]),
          ]) as ProjectionRecords<(typeof fields)[number]>;
        }),
      getRuntimeRequest: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.runtimeRequests.find((request) => request.id === requestId);
        }),
      getProviderRetirementContext: (threadId, providerSessionId, providerThreadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const providerThread = projection.providerThreads.find(
              (candidate) =>
                candidate.id === (providerThreadId ?? projection.thread.activeProviderThreadId) &&
                candidate.appThreadId === threadId &&
                candidate.providerSessionId === providerSessionId,
            );
            return {
              providerThread,
              providerTurn:
                providerThread === undefined
                  ? undefined
                  : projection.providerTurns
                      .filter((turn) => turn.providerThreadId === providerThread.id)
                      .sort((a, b) => b.ordinal - a.ordinal)[0],
            };
          }),
        ),
      getPendingMessageDeliveryIds: (threadId, providerThreadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const sourceMessages = new Set(
              projection.turnItems.flatMap((item) =>
                item.type === "user_message" && item.providerThreadId === providerThreadId
                  ? [item.messageId]
                  : [],
              ),
            );
            return projection.messages
              .filter(
                (message) =>
                  sourceMessages.has(message.id) &&
                  (message.delivery === "pending" || message.delivery === "unknown"),
              )
              .map((message) => message.id)
              .toSorted()
              .slice(0, MAX_PENDING_MESSAGE_DELIVERIES);
          }),
        ),
      getProviderControlContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const providerTurn = projection.providerTurns.find(
            (turn) => turn.id === target.providerTurnId,
          );
          return {
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            ),
            providerTurn,
            attempt:
              target.attemptId === undefined
                ? undefined
                : projection.attempts.find((attempt) => attempt.id === target.attemptId),
            message:
              target.messageId === undefined
                ? undefined
                : projection.messages.find((message) => message.id === target.messageId),
            run:
              target.messageId === undefined || providerTurn === undefined
                ? undefined
                : projection.runs.find((run) => run.activeAttemptId === providerTurn.runAttemptId),
          };
        }),
      getRunningTurnContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((run) => run.status === "running");
          return {
            run,
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === run?.providerThreadId,
            ),
            providerTurn: projection.providerTurns.find(
              (turn) =>
                turn.providerThreadId === run?.providerThreadId &&
                turn.runAttemptId === run?.activeAttemptId &&
                turn.nodeId === run?.rootNodeId &&
                turn.status === "running",
            ),
          };
        }),
      getThreadProviderContext: (threadId, targetInstanceId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const target = projection.providerThreads
            .filter(
              (thread) =>
                thread.appThreadId === threadId &&
                thread.ownerNodeId === null &&
                thread.providerInstanceId === targetInstanceId,
            )
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
                a.id.localeCompare(b.id),
            )[0];
          return {
            thread: projection.thread,
            providerSessions: projection.providerSessions,
            providerThreads:
              targetInstanceId === undefined
                ? []
                : projection.providerThreads.filter(
                    (thread) =>
                      thread.id === projection.thread.activeProviderThreadId ||
                      thread.id === target?.id,
                  ),
          };
        }),
      getRuntimeResponseContext: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const request = projection.runtimeRequests.find((request) => request.id === requestId);
          return {
            request,
            node: projection.nodes.find((node) => node.id === request?.nodeId),
            item: projection.turnItems.find(
              (item) =>
                item.nodeId === request?.nodeId &&
                (item.type === "approval_request" || item.type === "user_input_request") &&
                item.requestId === requestId,
            ),
            session: projection.providerSessions.find(
              (session) =>
                request?.responseCapability.type === "live" &&
                session.id === request.responseCapability.providerSessionId,
            ),
          };
        }),
      getCheckpointContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return {
            runs: projection.runs.map(({ id, ordinal, status }) => ({ id, ordinal, status })),
            checkpointScopes: projection.checkpointScopes.map(({ id, runId, kind, cwd }) => ({
              id,
              runId,
              kind,
              cwd,
            })),
            checkpoints: projection.checkpoints.map(
              ({ id, scopeId, runId, ordinalWithinScope, appRunOrdinal, status, ref }) => ({
                id,
                scopeId,
                runId,
                ordinalWithinScope,
                appRunOrdinal,
                status,
                ref,
              }),
            ),
          };
        }),
      getCheckpointCaptureContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === target.runId);
          return {
            run,
            rootNode: projection.nodes.find((candidate) => candidate.id === run?.rootNodeId),
            scope: projection.checkpointScopes.find((candidate) => candidate.id === target.scopeId),
            providerThread: projection.providerThreads.find(
              (candidate) => candidate.id === run?.providerThreadId,
            ),
            baselineCheckpoints: projection.checkpoints.filter(
              (candidate) =>
                candidate.scopeId === target.scopeId &&
                (candidate.ordinalWithinScope === 0 ||
                  candidate.ordinalWithinScope === Math.max(0, (run?.ordinal ?? 1) - 1)),
            ),
          };
        }),
      getRunMessage: (threadId, runId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === runId);
          return projection.messages.find((message) => message.id === run?.userMessageId);
        }),
      canStartQueuedRun: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return (
            projection.thread.archivedAt === null &&
            projection.thread.deletedAt === null &&
            projection.runs.some((run) => run.status === "queued") &&
            !projection.runs.some(
              (run) =>
                run.status === "preparing" ||
                run.status === "starting" ||
                run.status === "running" ||
                run.status === "waiting" ||
                (run.status === "queued" && run.queueHeld === true),
            )
          );
        }),
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const readProjection = (
            targetThreadId: ThreadId,
            seenThreadIds: ReadonlySet<ThreadId>,
          ): OrchestrationV2ThreadProjection | null => {
            const projection = existing.get(targetThreadId);
            if (!projection) {
              return null;
            }
            const forkedFrom = projection.thread.forkedFrom;
            if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
              return withLocalVisibleTurnItems(projection);
            }
            const sourceProjection = readProjection(
              forkedFrom.threadId,
              new Set([...seenThreadIds, targetThreadId]),
            );
            return {
              ...projection,
              visibleTurnItems: buildVisibleTurnItems({
                projection,
                sourceProjection,
              }),
            };
          };
          const projection = readProjection(threadId, new Set());
          if (!projection) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection;
        }),
      getTurnStartContext: (threadId, runId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => ({
            ...projection,
            ...turnStartFactsFromProjection(projection, runId),
            hasConversation: projection.messages.some(
              (message) =>
                message.role === "user" &&
                (message.text.trim().toLowerCase() !== "/compact" ||
                  message.attachments.length > 0),
            ),
            turnItems: projection.turnItems.filter((item) => item.runId === runId),
          })),
        ),
      hasNativeTurns: (input) =>
        service.getThreadProjection(input.threadId).pipe(
          Effect.map((projection) => {
            const accepted = projection.attempts.filter(
              (a) =>
                a.providerThreadId === input.providerThreadId &&
                projection.runs.some((run) => run.id === a.runId && run.status !== "rolled_back") &&
                projection.providerTurns.some((t) => t.runAttemptId === a.id),
            );
            return (
              accepted.some((a) => a.nativeThreadId === input.nativeThreadId) ||
              (input.sameNativeThread &&
                accepted.some((a) => a.nativeThreadId === undefined) &&
                !accepted.some((a) => a.nativeThreadId !== undefined))
            );
          }),
        ),
      getDeliveredHandoffItemIds: (input) =>
        service.getThreadProjection(input.threadId).pipe(
          Effect.map((projection) => {
            const ids = new Set(
              projection.contextHandoffs
                .filter(
                  (h) =>
                    h.toProviderThreadId === input.providerThreadId &&
                    h.delivery?.nativeThreadId === input.nativeThreadId &&
                    h.delivery?.status !== "pending",
                )
                .flatMap((h) => h.delivery?.itemIds ?? []),
            );
            return input.itemIds.filter((id) => ids.has(id));
          }),
        ),
      getNativeContextEstimate: (input) =>
        service
          .getThreadProjection(input.threadId)
          .pipe(Effect.map((projection) => nativeContextEstimateFromProjection(projection, input))),
      getRelatedNativeThread: (input) =>
        service.getThreadProjection(input.threadId).pipe(
          Effect.map((projection) => {
            const accepted = projection.attempts.filter(
              (a) =>
                a.providerThreadId === input.providerThreadId &&
                projection.providerTurns.some((t) => t.runAttemptId === a.id),
            );
            const hasIdentified = accepted.some((a) => a.nativeThreadId !== undefined);
            const task = projection.subagents.find(
              (s) =>
                s.origin === "provider_native" &&
                (input.address.subagentId !== undefined || s.status === "completed") &&
                (input.address.subagentId !== undefined
                  ? s.id === input.address.subagentId
                  : input.address.providerThreadId === undefined
                    ? s.childThreadId === input.address.threadId
                    : s.providerThreadId === input.address.providerThreadId) &&
                projection.runs.some(
                  (r) =>
                    r.id === s.runId &&
                    r.providerThreadId === input.providerThreadId &&
                    accepted.some(
                      (a) =>
                        a.runId === r.id &&
                        (a.nativeThreadId === input.nativeThreadId ||
                          (a.nativeThreadId === undefined && !hasIdentified)),
                    ),
                ),
            );
            return task === undefined || task.runId === null
              ? null
              : {
                  subagentId: task.id,
                  threadId: task.childThreadId ?? input.threadId,
                  providerThreadId: task.providerThreadId,
                  sourceRunId: task.runId,
                };
          }),
        ),
      getNativeForkBoundary: (threadId, runId, following) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const run = projection.runs.find((r) => r.id === runId);
            const attempt = projection.attempts.find((a) => a.id === run?.activeAttemptId);
            const turn =
              projection.providerTurns
                .filter((t) => t.runAttemptId === attempt?.id)
                .toSorted((a, b) => b.ordinal - a.ordinal)[0] ??
              projection.providerTurns.find((t) => t.id === attempt?.providerTurnId);
            const providerThread = projection.providerThreads.find(
              (p) => p.id === run?.providerThreadId,
            );
            const nativeId = providerThread?.nativeThreadRef?.nativeId;
            const nativeIncarnationMatches =
              nativeId != null &&
              attempt?.nativeThreadId === nativeId &&
              run?.status !== "rolled_back" &&
              providerThread?.status !== "closed";
            const later =
              following === undefined || !nativeIncarnationMatches || turn === undefined
                ? []
                : projection.providerTurns
                    .filter(
                      (candidate) =>
                        candidate.providerThreadId === run?.providerThreadId &&
                        candidate.ordinal > turn.ordinal,
                    )
                    .toSorted((a, b) => a.ordinal - b.ordinal);
            const present = later.find((candidate) =>
              following?.nativeTurnIds.includes(candidate.nativeTurnRef?.nativeId ?? ""),
            );
            const unsafe = later.find(
              (candidate) =>
                candidate.nativeTurnRef?.nativeId == null ||
                (!candidate.nativeTurnRef.nativeId.startsWith(following!.promptPrefix) &&
                  !candidate.nativeTurnRef.nativeId.includes(following!.continuationMarker)),
            );
            return {
              providerThread: nativeIncarnationMatches ? (providerThread ?? null) : null,
              nativeIncarnationMatches,
              sourceRunOrdinal: run?.ordinal ?? null,
              providerTurn: turn ?? null,
              followingProviderTurns: [
                ...new Map(
                  [present, unsafe]
                    .filter(
                      (candidate): candidate is OrchestrationV2ProviderTurn =>
                        candidate !== undefined,
                    )
                    .map((candidate) => [candidate.id, candidate]),
                ).values(),
              ],
              rollbackTurnCount:
                turn === undefined
                  ? 0
                  : projection.providerTurns.filter(
                      (t) =>
                        t.providerThreadId === run?.providerThreadId &&
                        t.ordinal > turn.ordinal &&
                        t.nativeTurnRef !== null &&
                        ["completed", "interrupted", "failed", "cancelled"].includes(t.status),
                    ).length,
            };
          }),
        ),
      getHandoffHistory: (input) =>
        service.getThreadProjection(input.threadId).pipe(
          Effect.flatMap((projection) =>
            Effect.gen(function* () {
              const projections = (yield* Ref.get(replayState)).projections;
              const localRuns = projection.runs.filter(
                (run) =>
                  isRunVisibleAtHistoryRevision(run, input.historyRevision) &&
                  run.ordinal >= (input.runOrdinalFrom ?? 1) &&
                  run.ordinal <= (input.runOrdinalTo ?? Number.MAX_SAFE_INTEGER) &&
                  (input.runStatuses === undefined || input.runStatuses.includes(run.status)) &&
                  (input.runIds === undefined || input.runIds.includes(run.id)) &&
                  (input.missingFromProviderThreadId === undefined ||
                    (run.providerThreadId === input.missingFromProviderThreadId &&
                      !projection.providerTurns.some(
                        (turn) => turn.runAttemptId === run.activeAttemptId,
                      ))),
              );
              const ids = new Set(localRuns.map((run) => run.id));
              const inheritedItems = includesInheritedHandoffHistory(input)
                ? projection.visibleTurnItems
                    .filter((row) => row.visibility === "inherited" && row.item.type !== "fork")
                    .map((row) => row.item)
                : [];
              const inheritedRuns: OrchestrationV2Run[] = [];
              const seenSources = new Set<ThreadId>([input.threadId]);
              let fork = includesInheritedHandoffHistory(input)
                ? projection.thread.forkedFrom
                : undefined;
              while (fork?.type === "run" && !seenSources.has(fork.threadId)) {
                const capturedFork = fork;
                const source = projections.get(capturedFork.threadId);
                const boundary = source?.runs.find((run) => run.id === capturedFork.runId);
                if (source === undefined || boundary === undefined) break;
                seenSources.add(fork.threadId);
                if (seenSources.size > 128)
                  return yield* new ProjectionStoreReadError({
                    threadId: input.threadId,
                    cause: "Context handoff exceeds the fork ancestry bound.",
                  });
                inheritedRuns.unshift(
                  ...source.runs.filter(
                    (run) =>
                      run.ordinal <= boundary.ordinal &&
                      isRunVisibleAtHistoryRevision(run, capturedFork.sourceHistoryRevision),
                  ),
                );
                fork = source.thread.forkedFrom;
              }
              const runs = [...inheritedRuns, ...localRuns];
              const sourceItems = [
                ...inheritedItems,
                ...projection.turnItems.filter((item) =>
                  item.runId === null ? input.includeImported === true : ids.has(item.runId),
                ),
              ];
              const items = sourceItems.filter(
                (item) =>
                  !input.excludeItemIds?.includes(item.id) &&
                  (input.excludeDelivered === undefined ||
                    !projection.contextHandoffs.some(
                      (handoff) =>
                        handoff.toProviderThreadId === input.excludeDelivered!.providerThreadId &&
                        handoff.delivery?.nativeThreadId ===
                          input.excludeDelivered!.nativeThreadId &&
                        handoff.delivery?.status !== "pending" &&
                        [
                          ...(handoff.delivery?.itemIds ?? []),
                          ...(handoff.delivery?.omittedItemIds ?? []),
                        ].includes(item.id),
                    )),
              );
              const coveredRunOrdinals = {
                from: localRuns.at(0)?.ordinal ?? 1,
                to: localRuns.at(-1)?.ordinal ?? 1,
              };
              const coverage = handoffCoverage({
                threadId: input.threadId,
                coveredRunOrdinals,
                items,
              });
              const messages = items.flatMap((item) => {
                const message = historicalMessage(item);
                const run = runs.find((run) => run.id === item.runId);
                return message === null
                  ? []
                  : [{ ...message, ...(run === undefined ? {} : { runStatus: run.status }) }];
              });
              const selected = selectHistory({ messages, coverage, budget: input.budget });
              return {
                history: {
                  messages: selected.messages,
                  coverage,
                  omittedItems: selected.omittedItems,
                  omittedItemIds: selected.omittedItemIds,
                },
                context: selected.context,
                coveredRunOrdinals,
                sourceItemCount: items.length,
                sourceRunCount: runs.length,
                ...(input.includeConversationSummary === true
                  ? { conversationSummary: conversationSummaryFromItems(items) }
                  : {}),
                ...(input.includeSummary === true
                  ? {
                      summary: {
                        lines: items.flatMap((item) => {
                          const historical = historicalMessage(item);
                          if (historical !== null) return [historicalSummaryLine(historical)];
                          if (item.type === "checkpoint")
                            return [`- Checkpoint: ${item.files.length} files`];
                          if (item.type === "handoff")
                            return [
                              `- Handoff: ${(item.summary ?? item.strategy).replace(/\s+/g, " ").trim().slice(0, 240)}`,
                            ];
                          return [];
                        }),
                        omittedItems: 0,
                      },
                    }
                  : {}),
                sourceSelections: [
                  ...new Map(
                    runs.map((run) => [
                      `${run.providerInstanceId}\0${run.modelSelection.model}`,
                      {
                        providerInstanceId: run.providerInstanceId,
                        modelSelection: run.modelSelection,
                      },
                    ]),
                  ).values(),
                ],
                fromProviderThreadIds: [
                  ...new Set(
                    runs.flatMap((run) =>
                      run.providerThreadId === null ? [] : [run.providerThreadId],
                    ),
                  ),
                ],
              };
            }),
          ),
        ),
      getLastDeliveredRun: (threadId, providerThreadId) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map(
              (projection) =>
                projection.runs.findLast(
                  (run) =>
                    run.providerThreadId === providerThreadId &&
                    (run.status === "completed" ||
                      ((run.status === "failed" || run.status === "interrupted") &&
                        projection.providerTurns.some(
                          (turn) => turn.runAttemptId === run.activeAttemptId,
                        ))),
                ) ?? null,
            ),
          ),
      getExecutionRetirementContext: (threadId, runId) =>
        Effect.gen(function* () {
          const projection = yield* service.getThreadProjection(threadId);
          const state = yield* Ref.get(replayState);
          const rootId = projection.thread.lineage.rootThreadId;
          const target = state.executionRetirementTargets.get(rootId)?.get(runId);
          const run = projection.runs.find((r) => r.id === runId);
          const message = projection.messages.find((m) => m.id === run?.userMessageId);
          const parentId = message?.delegatedCompletion?.parentRunId ?? runId;
          const parent = projection.runs.find((r) => r.id === parentId);
          const deliveryMessage = projection.messages.find(
            (m) => m.id === parent?.delegatedCompletion?.delivery?.messageId,
          );
          return {
            thread: projection.thread,
            run,
            attempt: projection.attempts.find((a) => a.id === run?.activeAttemptId),
            rootNode: projection.nodes.find((n) => n.id === run?.rootNodeId),
            providerThread: projection.providerThreads.find((p) => p.id === run?.providerThreadId),
            cohortParentRunId: parentId,
            deliveryRunId: deliveryMessage?.runId ?? null,
            hasProviderBinding: projection.providerSessions.length > 0,
            isRetirementTarget:
              target?.threadId === threadId &&
              target.operationId ===
                state.projections.get(rootId)?.thread.executionHandoff?.operationId,
          };
        }),
      getExecutionActors: (rootThreadId, cursor) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const anchor = cursor
            ? yield* Effect.try(
                () =>
                  JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as [
                    string,
                    string,
                    string,
                  ],
              ).pipe(
                Effect.mapError(
                  (cause) => new ProjectionStoreReadError({ threadId: rootThreadId, cause }),
                ),
              )
            : null;
          if (anchor && (anchor[0] !== rootThreadId || anchor.length !== 3))
            return yield* new ProjectionStoreReadError({
              threadId: rootThreadId,
              cause: "Invalid execution actor cursor",
            });
          const rows = [...state.projections.values()]
            .filter((p) => p.thread.lineage.rootThreadId === rootThreadId)
            .flatMap((p) => {
              const target = [
                ...(state.executionRetirementTargets.get(rootThreadId)?.values() ?? []),
              ].find(
                (target) =>
                  target.threadId === p.thread.id &&
                  target.operationId ===
                    state.projections.get(rootThreadId)?.thread.executionHandoff?.operationId,
              );
              const active =
                target === undefined
                  ? p.runs.findLast((r) =>
                      ["preparing", "starting", "running", "waiting"].includes(r.status),
                    )
                  : p.runs.find((r) => r.id === target.runId);
              const provider = p.providerThreads.find(
                (provider) => provider.id === active?.providerThreadId,
              );
              const sourceSession =
                provider?.nativeThreadRef == null ? null : provider.providerSessionId;
              return (
                p.providerSessions.length ? p.providerSessions.map((s) => s.id) : [sourceSession]
              ).map((providerSessionId) => ({
                threadId: p.thread.id,
                providerSessionId,
                activeRunId: active?.id ?? null,
              }));
            })
            .sort(
              (a, b) =>
                a.threadId.localeCompare(b.threadId) ||
                (a.providerSessionId ?? "").localeCompare(b.providerSessionId ?? ""),
            )
            .filter(
              (r) =>
                !anchor ||
                r.threadId > anchor[1] ||
                (r.threadId === anchor[1] && (r.providerSessionId ?? "") > anchor[2]),
            );
          const items = rows.slice(0, 64),
            last = items.at(-1);
          return {
            items,
            nextCursor:
              rows.length > 64 && last
                ? Buffer.from(
                    JSON.stringify([rootThreadId, last.threadId, last.providerSessionId ?? ""]),
                  ).toString("base64url")
                : null,
          };
        }),
      getExecutionDetachBarrier: () => Effect.succeed(null),
      getExecutionHandoffs: (cursor) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const rows = [...state.projections.values()]
            .filter((p) => p.thread.executionHandoff && p.thread.id > (cursor ?? ""))
            .sort((a, b) => a.thread.id.localeCompare(b.thread.id));
          return {
            items: rows.slice(0, 64).map((p) => ({
              threadId: p.thread.id,
              operationId: p.thread.executionHandoff!.operationId,
              recoveryRequired: p.thread.executionHandoff!.recoveryRequired,
            })),
            nextCursor: rows.length > 64 ? rows[63]!.thread.id : null,
          };
        }),
      getProjectProviderSessionBindings: (projectId, cursor) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const anchor =
            cursor === undefined
              ? null
              : yield* Effect.try(() => {
                  const value: unknown = JSON.parse(
                    Buffer.from(cursor, "base64url").toString("utf8"),
                  );
                  if (
                    !Array.isArray(value) ||
                    value.length !== 3 ||
                    value[0] !== projectId ||
                    value.some((part) => typeof part !== "string")
                  )
                    throw new Error("Invalid provider binding continuation");
                  return value as [string, string, string];
                }).pipe(
                  Effect.mapError(
                    (cause) => new ProjectionStoreProjectReadError({ projectId, cause }),
                  ),
                );
          const rows = Array.from(state.projections.values())
            .filter((projection) => projection.thread.projectId === projectId)
            .flatMap((projection) =>
              projection.providerSessions.map((session) => ({
                threadId: projection.thread.id,
                providerSessionId: session.id,
              })),
            )
            .sort(
              (a, b) =>
                a.threadId.localeCompare(b.threadId) ||
                a.providerSessionId.localeCompare(b.providerSessionId),
            )
            .filter(
              (row) =>
                anchor === null ||
                row.threadId > anchor[1] ||
                (row.threadId === anchor[1] && row.providerSessionId > anchor[2]),
            );
          const items = rows.slice(0, 64);
          const last = items.at(-1);
          return {
            snapshotSequence: yield* Ref.get(sequence),
            items,
            nextCursor:
              rows.length > items.length && last
                ? Buffer.from(
                    JSON.stringify([projectId, last.threadId, last.providerSessionId]),
                  ).toString("base64url")
                : null,
          };
        }),
      getProjectRoots: (projectId, cursor) =>
        Effect.gen(function* () {
          const anchor =
            cursor === undefined
              ? ""
              : yield* Effect.try(() => {
                  const value: unknown = JSON.parse(
                    Buffer.from(cursor, "base64url").toString("utf8"),
                  );
                  if (
                    !Array.isArray(value) ||
                    value.length !== 2 ||
                    value[0] !== projectId ||
                    typeof value[1] !== "string"
                  )
                    throw new Error("Invalid Project root continuation");
                  return value[1];
                });
          const state = yield* Ref.get(replayState);
          const rows = [...state.projections.values()]
            .map((projection) => projection.thread)
            .filter(
              (thread) =>
                thread.projectId === projectId &&
                thread.id === thread.lineage.rootThreadId &&
                thread.id > anchor,
            )
            .sort((a, b) => a.id.localeCompare(b.id));
          const threadIds = rows.slice(0, 200).map((thread) => thread.id);
          const last = threadIds.at(-1);
          return {
            threadIds,
            nextCursor:
              rows.length > 200 && last !== undefined
                ? Buffer.from(JSON.stringify([projectId, last])).toString("base64url")
                : null,
          };
        }).pipe(
          Effect.mapError((cause) => new ProjectionStoreProjectReadError({ projectId, cause })),
        ),
      getQueuedRunPage: (threadId, cursor) =>
        Effect.gen(function* () {
          const anchor =
            cursor === undefined
              ? null
              : yield* Effect.try(() => {
                  const value: unknown = JSON.parse(
                    Buffer.from(cursor, "base64url").toString("utf8"),
                  );
                  if (
                    !Array.isArray(value) ||
                    value.length !== 4 ||
                    value[0] !== threadId ||
                    !Number.isSafeInteger(value[1]) ||
                    !Number.isSafeInteger(value[2]) ||
                    typeof value[3] !== "string"
                  )
                    throw new Error("Invalid queue continuation");
                  return value as [string, number, number, string];
                });
          const state = yield* Ref.get(replayState);
          const projection = state.projections.get(threadId);
          const runs = [...(projection?.runs ?? [])]
            .filter((run) => run.status === "queued")
            .sort(
              (a, b) =>
                (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal) ||
                a.ordinal - b.ordinal ||
                a.id.localeCompare(b.id),
            )
            .filter(
              (run) =>
                !anchor ||
                (run.queuePosition ?? run.ordinal) > anchor[1] ||
                ((run.queuePosition ?? run.ordinal) === anchor[1] &&
                  (run.ordinal > anchor[2] || (run.ordinal === anchor[2] && run.id > anchor[3]))),
            );
          const page = runs.slice(0, 25);
          const last = page.at(-1);
          return {
            snapshotSequence: yield* Ref.get(sequence),
            entries: page.map((run) => ({
              runId: run.id,
              userMessageId: run.userMessageId,
              userItemId:
                projection?.turnItems.find(
                  (item) =>
                    item.type === "user_message" &&
                    item.runId === run.id &&
                    item.messageId === run.userMessageId,
                )?.id ?? null,
              queuePosition: run.queuePosition ?? run.ordinal,
              held: run.queueHeld === true,
              requestedAt: DateTime.formatIso(run.requestedAt),
            })),
            nextCursor:
              runs.length > 25 && last
                ? Buffer.from(
                    JSON.stringify([
                      threadId,
                      last.queuePosition ?? last.ordinal,
                      last.ordinal,
                      last.id,
                    ]),
                  ).toString("base64url")
                : null,
            nextRunId: runs[25]?.id ?? null,
          };
        }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause }))),
      getQueuedRunPreview: (threadId, runId) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const projection = state.projections.get(threadId);
          const run = projection?.runs.find((run) => run.id === runId && run.status === "queued");
          const message = run
            ? projection?.messages.find(
                (message) => message.id === run.userMessageId && message.role === "user",
              )
            : null;
          return message
            ? {
                threadId,
                runId,
                messageId: message.id,
                text: message.text.slice(0, 2048),
                images: message.attachments
                  .filter(
                    (attachment): attachment is ChatImageAttachment => attachment.type === "image",
                  )
                  .slice(0, 32)
                  .map((image) => ({
                    type: image.type,
                    id: image.id,
                    name: image.name,
                    mimeType: image.mimeType,
                    sizeBytes: image.sizeBytes,
                  })),
              }
            : null;
        }),
      getRunUserMessage: (threadId, runId) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const projection = state.projections.get(threadId);
          const run = projection?.runs.find(
            (run) => run.id === runId && run.status !== "rolled_back",
          );
          return run
            ? (projection?.messages.find(
                (message) =>
                  message.id === run.userMessageId &&
                  message.threadId === threadId &&
                  message.role === "user",
              ) ?? null)
            : null;
        }),
      getOpeningRequest: (threadId) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          const projection = state.projections.get(threadId);
          const first = projection?.turnItems.find(
            (item) =>
              item.type === "user_message" &&
              (item.inputIntent === "turn_start" || item.inputIntent === "queued_turn"),
          );
          return first?.type === "user_message"
            ? (projection?.messages.find(
                (message) =>
                  message.id === first.messageId &&
                  message.threadId === threadId &&
                  message.role === "user",
              ) ?? null)
            : null;
        }),
      getProjectExecutionActivity: (projectId) =>
        Effect.gen(function* () {
          const state = yield* Ref.get(replayState);
          let run: ProjectionProjectExecutionActivity["run"] = null;
          let runtimeRequest: ProjectionProjectExecutionActivity["runtimeRequest"] = null;
          let nativeBackground: ProjectionProjectExecutionActivity["nativeBackground"] = null;
          let executionHandoff: ProjectionProjectExecutionActivity["executionHandoff"] = null;
          for (const projection of state.projections.values()) {
            if (projection.thread.projectId !== projectId) continue;
            if (projection.thread.executionHandoff && executionHandoff === null)
              executionHandoff = {
                threadId: projection.thread.id,
                operationId: projection.thread.executionHandoff.operationId,
              };
            const currentRun = projection.runs.find((candidate) =>
              ["queued", "preparing", "starting", "running", "waiting"].includes(candidate.status),
            );
            const request = projection.runtimeRequests.find(
              (candidate) => candidate.status === "pending",
            );
            const task = projection.subagents.find(
              (candidate) =>
                candidate.origin === "provider_native" &&
                ["pending", "running", "waiting"].includes(candidate.status),
            );
            const nativeTask = projection.providerThreads.find(
              (thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0,
            )?.pendingBackgroundTasks?.[0];
            if (run === null && currentRun)
              run = {
                threadId: projection.thread.id,
                runId: currentRun.id,
                status: currentRun.status,
              };
            if (runtimeRequest === null && request)
              runtimeRequest = { threadId: projection.thread.id, requestId: request.id };
            if (nativeBackground === null && task)
              nativeBackground = { threadId: projection.thread.id, taskId: task.id };
            if (nativeBackground === null && nativeTask)
              nativeBackground = {
                threadId: projection.thread.id,
                taskId: NodeId.make(nativeTask.taskId),
              };
            if (run && runtimeRequest && nativeBackground && executionHandoff) break;
          }
          return {
            snapshotSequence: yield* Ref.get(sequence),
            run,
            runtimeRequest,
            nativeBackground,
            executionHandoff,
          };
        }),
      getRunOutcome: (query) =>
        Ref.get(replayState).pipe(
          Effect.map(({ projections }) => {
            const projection = projections.get(query.threadId);
            const message =
              query.messageId === undefined
                ? null
                : projection?.messages.find(
                    (value) => value.id === query.messageId && value.role === "user",
                  );
            const run = projection?.runs.find((value) =>
              query.runId !== undefined
                ? value.id === query.runId
                : value.id === message?.runId && value.userMessageId === query.messageId,
            );
            if (!projection || !run) return null;
            const replyNodeIds = new Set(
              projection.nodes
                .filter((node) => node.runId === run.id && node.rootNodeId === run.rootNodeId)
                .map((node) => node.id),
            );
            const final = projection.turnItems
              .filter(
                (item) =>
                  item.runId === run.id &&
                  item.nodeId !== null &&
                  replyNodeIds.has(item.nodeId) &&
                  item.type === "assistant_message",
              )
              .toSorted(
                (left, right) => right.ordinal - left.ordinal || right.id.localeCompare(left.id),
              )[0];
            return {
              runId: run.id,
              status: run.status,
              completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
              finalAssistantItemId: final?.id ?? null,
            };
          }),
        ),
      getThreadSubagentOverview: (input) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          const state = projections.get(input.threadId);
          if (!state)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId: input.threadId });
          const page = (phase: SubagentOverviewPhase, cursor: string | undefined, limit: number) =>
            Effect.gen(function* () {
              const anchor =
                cursor === undefined
                  ? null
                  : decodeSubagentOverviewCursor(cursor, input.threadId, phase);
              if (cursor !== undefined && anchor === null)
                return yield* new ProjectionStoreReadError({
                  threadId: input.threadId,
                  cause: new Error("Invalid task overview cursor"),
                });
              const inPhase = state.subagents.filter(
                (task) =>
                  (input.taskId === undefined || task.id === input.taskId) &&
                  ["completed", "failed", "cancelled", "interrupted"].includes(task.status) ===
                    (phase === "terminal"),
              );
              const candidates = inPhase
                .filter((task) => {
                  const updatedAt = DateTime.formatIso(task.updatedAt);
                  return (
                    anchor === null ||
                    updatedAt < anchor.updatedAt ||
                    (updatedAt === anchor.updatedAt && task.id < anchor.id)
                  );
                })
                .toSorted(
                  (left, right) =>
                    DateTime.toEpochMillis(right.updatedAt) -
                      DateTime.toEpochMillis(left.updatedAt) || right.id.localeCompare(left.id),
                );
              const admitted = candidates.slice(0, limit);
              const items = admitted.map((task): ProjectionSubagentOverviewItem => ({
                id: task.id,
                threadId: task.threadId,
                runId: task.runId,
                parentNodeId: task.parentNodeId,
                origin: task.origin,
                driver: task.driver,
                providerInstanceId: task.providerInstanceId,
                providerThreadId: task.providerThreadId,
                childThreadId: task.childThreadId,
                childRunId:
                  task.childThreadId === null
                    ? null
                    : (projections
                        .get(task.childThreadId)
                        ?.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0]?.id ?? null),
                title: task.title === null ? null : task.title.slice(0, 512),
                model: task.model === null ? null : task.model.slice(0, 256),
                ...(task.modelSelection === undefined
                  ? {}
                  : {
                      modelSelection: {
                        instanceId: task.modelSelection.instanceId,
                        model: task.modelSelection.model.slice(0, 256),
                      },
                    }),
                status: task.status,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                updatedAt: task.updatedAt,
                resultAvailable: task.result !== null,
              }));
              const last = admitted.at(-1);
              const hasMore = candidates.length > limit;
              return {
                items,
                hasMore,
                totalCount: inPhase.length,
                nextCursor:
                  hasMore && last
                    ? encodeSubagentOverviewCursor(
                        input.threadId,
                        phase,
                        DateTime.formatIso(last.updatedAt),
                        last.id,
                      )
                    : null,
              };
            });
          return {
            active: yield* page("active", input.activeCursor, 4),
            terminal: yield* page("terminal", input.terminalCursor, 10),
          };
        }),
      getRuntimeRecoveryProjection: (threadId) => service.getThreadProjection(threadId),
      getHostToolAuthorityContext: (threadId, runId, providerThreadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((state) => {
            const run =
              runId === null
                ? undefined
                : state.runs
                    .filter((candidate) =>
                      runId === undefined ? candidate.status === "running" : candidate.id === runId,
                    )
                    .toSorted((a, b) => b.ordinal - a.ordinal)[0];
            return {
              thread: state.thread,
              runs: run === undefined ? [] : [run],
              providerThreads: state.providerThreads
                .filter(
                  (thread) =>
                    thread.id ===
                    (providerThreadId ??
                      run?.providerThreadId ??
                      state.thread.activeProviderThreadId),
                )
                .map((native) => ({
                  id: native.id,
                  providerSessionId: native.providerSessionId,
                  providerInstanceId: native.providerInstanceId,
                  nativeThreadRef: native.nativeThreadRef,
                  hasPendingBackgroundWork: (native.pendingBackgroundTasks?.length ?? 0) > 0,
                })),
              providerTurns: state.providerTurns
                .filter((turn) => turn.runAttemptId === run?.activeAttemptId)
                .slice(-1),
              subagents: state.subagents
                .filter(
                  (agent) =>
                    agent.origin === "provider_native" &&
                    agent.providerThreadId ===
                      (providerThreadId ??
                        run?.providerThreadId ??
                        state.thread.activeProviderThreadId) &&
                    ["pending", "running", "waiting"].includes(agent.status),
                )
                .slice(0, 1),
            };
          }),
        ),
      getThreadSnapshot: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.flatMap((projection) =>
            Ref.get(sequence).pipe(
              Effect.map((snapshotSequence) => ({
                schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                snapshotSequence,
                projection,
              })),
            ),
          ),
        ),
      searchThreadStream: (input) => Stream.fromEffect(service.searchThread(input)),
      searchThread: (input) =>
        service.getThreadSnapshot(input.threadId).pipe(
          Effect.flatMap(({ projection, snapshotSequence }) =>
            projection.thread.deletedAt !== null
              ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: input.threadId }))
              : Effect.succeed(
                  // This store has no project records, so only worktree paths resolve labels.
                  findProjectedThreadItems(
                    projection.visibleTurnItems,
                    input,
                    snapshotSequence,
                    projection.thread.worktreePath ?? undefined,
                  ),
                ),
          ),
        ),
      getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
        service.getThreadSnapshot(threadId).pipe(
          Effect.flatMap(({ projection, snapshotSequence }) =>
            Effect.gen(function* () {
              if (projection.thread.deletedAt !== null)
                return yield* new ProjectionStoreThreadNotFoundError({ threadId });
              return yield* Effect.try({
                try: () => {
                  const page = selectHistoryPageFromCursor({
                    items: projection.visibleTurnItems.map((row) => ({
                      ...row,
                      item: projectTurnItemForWire(row.item),
                    })),
                    cursor,
                    throughEntryId,
                    snapshotSequence,
                  });
                  return {
                    ...page,
                    snapshotSequence,
                    items: conversationOnly
                      ? page.items.filter((row) => isConversationHistoryItem(row.item))
                      : page.items,
                  };
                },
                catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
              });
            }),
          ),
        ),
      getThreadPromptIndex: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const { slots, complete } = selectThreadPromptIndexSlots(projection.visibleTurnItems);
            const items = new Map(
              projection.visibleTurnItems.map((row) => [row.sourceItemId as string, row.item]),
            );
            const text = (itemId: string | null, characters: number) => {
              const item = itemId === null ? undefined : items.get(itemId);
              return item?.type === "user_message" || item?.type === "assistant_message"
                ? boundThreadPromptText(item.text, characters)
                : "";
            };
            return {
              complete,
              prompts: slots.map((slot) => {
                const prompt = items.get(slot.promptItemId);
                return {
                  runId: slot.runId,
                  messageId: slot.messageId,
                  prompt: text(slot.promptItemId, THREAD_PROMPT_INDEX_PROMPT_CHARACTERS),
                  response: text(slot.responseItemId, THREAD_PROMPT_INDEX_RESPONSE_CHARACTERS),
                  scheduled:
                    prompt?.type === "user_message" && prompt.scheduledTaskId !== undefined,
                };
              }),
            };
          }),
        ),
      getTimelinePage: (threadId, options) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) => selectTimelineRows(projection.visibleTurnItems, options)),
          ),
      getTimelineMetadataPage: (threadId, options) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) =>
            selectTimelineRows(
              projection.visibleTurnItems.map((row) => ({
                metadata: (() => {
                  const messageId = "messageId" in row.item ? row.item.messageId : null;
                  const message = projection.messages.find((message) => message.id === messageId);
                  return visibleItemMetadata(row.item, message);
                })(),
                position: row.position,
                sourceThreadId: row.sourceThreadId,
                sourceItemId: row.sourceItemId,
                visibility: row.visibility,
                item: {
                  id: row.item.id,
                  runId: row.item.runId,
                  type: row.item.type,
                  status: row.item.status,
                  updatedAt: row.item.updatedAt,
                },
              })),
              options,
            ),
          ),
        ),
      getThreadSnapshotWindow: (threadId, options) => {
        if (options.controlOnly)
          return Effect.gen(function* () {
            const projection = (yield* Ref.get(replayState)).projections.get(threadId);
            if (!projection) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: yield* Ref.get(sequence),
              projection: projectThreadProjectionForWire(
                retainPublicThreadControlClosure(
                  {
                    ...projection,
                    turnItems: [],
                    visibleTurnItems: [],
                    messages: [],
                    plans: [],
                    checkpoints: [],
                    checkpointScopes: [],
                    contextHandoffs: [],
                    contextTransfers: [],
                  },
                  options.requiredRunId,
                  options.requiredRequestId,
                ),
              ),
              latestLocalTurnOrdinal: projection.turnItems.at(-1)?.ordinal ?? null,
              hasEarlierHistory: false,
            };
          });
        return service.getThreadSnapshot(threadId).pipe(
          Effect.map((snapshot) => {
            const anchorIndex =
              options.anchorItemId === undefined
                ? snapshot.projection.visibleTurnItems.length
                : snapshot.projection.visibleTurnItems.findIndex(
                    (row) => row.sourceItemId === options.anchorItemId,
                  ) + 1;
            const candidates = snapshot.projection.visibleTurnItems.slice(0, anchorIndex);
            const turnAnchors =
              options.userTurnLimit === undefined
                ? []
                : candidates.flatMap((row, index) =>
                    isThreadHistoryTurnStart(row.item) ? [index] : [],
                  );
            const rawStart = turnAnchors.at(-(THREAD_HISTORY_MAX_RAW_TURNS + 2)) ?? 0;
            const anchors = turnAnchors.filter(
              (index) => index >= rawStart && isThreadHistoryUserTurn(candidates[index]!.item),
            );
            const anchorLimit = (options.userTurnLimit ?? 0) + 2;
            const start =
              anchors.length > 0
                ? anchors.length < anchorLimit
                  ? rawStart
                  : anchors.at(-anchorLimit)!
                : Math.max(0, anchorIndex - options.rowLimit);
            const visibleTurnItems = candidates.slice(start);
            return {
              ...snapshot,
              projection: { ...snapshot.projection, visibleTurnItems },
            };
          }),
        );
      },
    };

    return service;
  }),
);
