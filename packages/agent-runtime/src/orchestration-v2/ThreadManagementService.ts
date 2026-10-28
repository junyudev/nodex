import {
  delegatedTaskExecutionState,
  delegatedTaskRun,
  isTerminalTaskStatus,
} from "./DelegatedTaskState.ts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  NodeId,
  OrchestrationV2StopWorkflowError,
  type OrchestrationV2StopWorkflowInput,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import { liveBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create":
    case "message.dispatch":
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

export function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly senderRunId?: RunId | null;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly context?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["context"];
  readonly interactionMode?: Extract<
    OrchestrationV2Command,
    { readonly type: "message.dispatch" }
  >["interactionMode"];
  readonly mode: ThreadManagementSendMode;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  /** Null for queued sends: the user turn item materializes when the queued turn starts. */
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: ProjectId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export class ThreadManagementProviderInstanceDisabledError extends Schema.TaggedError<ThreadManagementProviderInstanceDisabledError>()(
  "ThreadManagementProviderInstanceDisabledError",
  {
    projectId: ProjectId,
    instanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}

export class ThreadManagementTaskCancelError extends Schema.TaggedError<ThreadManagementTaskCancelError>()(
  "ThreadManagementTaskCancelError",
  {
    taskId: NodeId,
    reason: Schema.Literals(["not-found", "not-cancellable", "orchestration-error"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly stopBackgroundWork: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly taskIds: ReadonlyArray<string>;
  }) => Effect.Effect<{ readonly stopping: ReadonlyArray<string> }, ThreadManagementFailure>;
  readonly backgroundOutput: (input: {
    readonly threadId: ThreadId;
    readonly taskId: string;
  }) => Effect.Effect<
    { readonly text: string; readonly truncated: boolean; readonly totalBytes: number } | null,
    ThreadManagementFailure
  >;
  readonly cancelDelegatedTask: (input: {
    readonly threadId: ThreadId;
    readonly taskId: NodeId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    {
      readonly taskId: NodeId;
      readonly status: "completed" | "failed" | "cancelled" | "interrupted" | "cancel_requested";
    },
    ThreadManagementTaskCancelError
  >;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  /**
   * The single chokepoint for commands that can start or wake provider work:
   * `message.dispatch` and `delegated_task.request` are refused here when the
   * resolved instance is off for the project, except a command id that
   * already has a receipt, which only replays its recorded result.
   */
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getTimelineMetadataPage: Orchestrator.OrchestratorV2["Service"]["getTimelineMetadataPage"];
  readonly getVisibleTurnItem: Orchestrator.OrchestratorV2["Service"]["getVisibleTurnItem"];
  readonly getVisibleTurnItemRecord: Orchestrator.OrchestratorV2["Service"]["getVisibleTurnItemRecord"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  /**
   * One turn item with the input and output the thread stream withholds,
   * bounded for the wire. Clients fetch it when a tool row is expanded.
   */
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadManagementError>;
  readonly getShellSnapshot: (options?: {
    readonly location?: "active" | "archive";
  }) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>;
  readonly readShellSnapshot: (options?: {
    readonly location?: "active" | "archive";
  }) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getTaskOwner: Orchestrator.OrchestratorV2["Service"]["getTaskOwner"];
  readonly getThreadCounts: Orchestrator.OrchestratorV2["Service"]["getThreadCounts"];
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listProjectThreads: (input: {
    readonly projectId: ProjectId;
    readonly includeSubagents: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  /**
   * Refuses a new turn on an instance the project has effectively disabled.
   * A command that already has a receipt was let through before, so its
   * retry replays instead of being refused under newer settings.
   */
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  /**
   * Effective enablement for candidate selection, without the receipt-replay
   * exemption `assertProviderInstanceEnabled` grants an accepted command.
   */
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /**
   * Whether `commandId` already has a receipt. A caller resolving a target
   * ahead of a dispatch under this same command id can use it to skip
   * project-enablement filtering: the dispatch will only replay the recorded
   * result, never start anything new, so the filter would just refuse a
   * retry the project's settings no longer allow fresh.
   */
  readonly getReceipt: (
    commandId: CommandId,
  ) => ReturnType<CommandReceiptStore.CommandReceiptStoreV2Shape["getByCommandId"]>;
  readonly hasReceipt: (commandId: CommandId) => Effect.Effect<boolean>;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /**
   * Waits for `runId` to end, then settles the thread if the run completed.
   * Settling stops the provider session, so an agent that settles its own
   * thread uses this to wait for its turn to end. A run that ends any other
   * way leaves the thread active, as does anything `thread.settle` refuses
   * then, such as a queued message.
   */
  readonly settleAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  /**
   * Settles a thread. When the thread's own agent asks, it is mid-turn, so
   * the thread settles through `settleAfterRun` once that turn ends.
   */
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly byOwnAgent: boolean;
  }) => Effect.Effect<
    { readonly sequence: number } | { readonly settlesWhenTurnEnds: true },
    // Dispatches thread.settle, a command the enablement chokepoint never
    // gates; the type stays accurate anyway.
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  /**
   * Asks the provider to stop a running workflow coordinator. The provider's
   * own terminal notification then settles the coordinator and its members.
   */
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Sends `thread.stop` to every delegated task under a thread, depth first. Their command IDs
   * derive from `commandId`, so a retry repeats nothing that already stopped. A task that
   * cannot be stopped does not keep the others running: all are tried, then it fails.
   */
  readonly stopDelegatedTasks: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    void,
    // Dispatches thread.stop, a command the enablement chokepoint never
    // gates; the type stays accurate anyway.
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export function isTerminalRunStatus(
  status: OrchestrationV2Run["status"],
): status is ThreadManagementTerminalRunStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted" ||
    status === "rolled_back"
  );
}

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

const make = Effect.gen(function* () {
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      receipts.getByCommandId(input.commandId).pipe(
        Effect.orElseSucceed(() => Option.none()),
        Effect.flatMap((receipt) =>
          Option.isSome(receipt)
            ? Effect.void
            : serverSettings.getSettings.pipe(
                Effect.orDie,
                Effect.flatMap((current) =>
                  resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId)
                    ? Effect.void
                    : new ThreadManagementProviderInstanceDisabledError({
                        projectId: input.projectId,
                        instanceId: input.instanceId,
                      }),
                ),
              ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getSettings.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(Option.isSome),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
    );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
    );

  // Every path that can start or wake a provider turn funnels through this
  // dispatch, so resolving and checking the target instance here (instead of
  // at each caller) is the one place "off" is enforced.
  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      default:
        return Effect.void;
    }
  };

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) =>
    ensureCommandTranscripts(command).pipe(
      Effect.andThen(assertDispatchTargetEnabled(command)),
      Effect.andThen(
        Effect.gen(function* () {
          const admission = yield* ExecutionHost.McpTurnAdmission;
          if (admission === undefined) return;
          yield* admission.assertCurrent().pipe(
            Effect.mapError(
              (cause) =>
                new Orchestrator.OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          );
        }),
      ),
      Effect.andThen(orchestrator.dispatch(command)),
    );

  const getProjectThread: ThreadManagementServiceShape["getProjectThread"] = (input) =>
    getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.flatMap((projection) =>
        projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
          ? Effect.succeed(projection)
          : Effect.fail(
              new ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            ),
      ),
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId)
      .pipe(Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)))
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        ),
        Effect.flatMap((projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
            ? Effect.succeed(projection)
            : Effect.fail(
                new ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                }),
              ),
        ),
      );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator.getShellSnapshot({ projectId: input.projectId, location: "active" }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectThreadsListError({
            projectId: input.projectId,
            cause,
          }),
      ),
      Effect.map((snapshot) =>
        snapshot.threads
          .filter(
            (thread) =>
              input.includeSubagents || thread.lineage.relationshipToParent !== "subagent",
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
              right.id.localeCompare(left.id),
          ),
      ),
    );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThreadRecords(input, []);
      if (target.thread.archivedAt !== null && !(yield* hasReceipt(input.commandId))) {
        return yield* new ThreadManagementThreadArchivedError({
          threadId: input.threadId,
        });
      }
      const dispatched = yield* dispatch({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.senderRunId === undefined ? {} : { senderRunId: input.senderRunId }),
        text: input.text,
        attachments: input.attachments,
        ...(input.context === undefined ? {} : { context: input.context }),
        ...(input.interactionMode === undefined ? {} : { interactionMode: input.interactionMode }),
        ...(input.modelSelection === undefined ? {} : { modelSelection: input.modelSelection }),
        dispatchMode: {
          type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
        },
        ...(input.mode === "queue" ? {} : { deliveryIntent: input.mode }),
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      // Receipt replay precedes delivery decisions; its response reads only this input's identities.
      const messageRecords = yield* getProjectThreadRecords(input, ["messages"], {
        messageIds: [input.messageId],
      });
      const message = messageRecords.messages[0];
      if (message?.runId == null)
        return yield* new ThreadManagementDurableRunProjectionError({
          threadId: input.threadId,
          messageId: input.messageId,
        });
      const records = yield* getProjectThreadRecords(input, ["runs", "turnItems"], {
        runIds: [message.runId],
        turnItemIds: [
          dispatched.storedEvents
            .flatMap(({ event }) =>
              event.type === "turn-item.updated" &&
              event.payload.type === "user_message" &&
              event.payload.messageId === input.messageId
                ? [event.payload.id]
                : [],
            )
            .at(-1) ?? derive.userTurnItem({ messageId: input.messageId }),
        ],
      });
      const projection = { ...records, messages: messageRecords.messages };
      const run = records.runs[0];
      const turnItem =
        projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
            candidate.type === "user_message" && candidate.messageId === input.messageId,
        ) ?? null;
      // A queued message's user turn item is deliberately not emitted at
      // dispatch time — it materializes when the queued turn actually starts,
      // so it can map onto the provider turn. Every other dispatch mode still
      // produces its turn item transactionally with the run.
      if (
        message === undefined ||
        run === undefined ||
        (turnItem === null && run.status !== "queued")
      ) {
        return yield* new ThreadManagementDurableRunProjectionError({
          threadId: input.threadId,
          messageId: input.messageId,
        });
      }
      const delivery: ThreadManagementSendResult["delivery"] =
        turnItem === null || turnItem.inputIntent === "queued_turn"
          ? "queued"
          : turnItem.inputIntent === "turn_start"
            ? "started"
            : input.mode === "restart"
              ? "restarted"
              : "steered";
      return { dispatch: dispatched, projection, message, run, turnItem, delivery };
    });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = (input) =>
    Effect.gen(function* () {
      const loadError = (cause: unknown) =>
        new ThreadManagementProjectionLoadError({
          projectId: input.projectId,
          threadId: input.threadId,
          cause,
        });
      // Taken before the first read, so a run update between that read and
      // the subscription below still replays.
      const afterSequence = yield* orchestrator
        .getThreadEventSequence(input.threadId)
        .pipe(Effect.mapError(loadError));
      const target = yield* getProjectThreadRecords(input, ["runs"]);
      const selectedRun =
        input.runId === undefined
          ? latestRun(target)
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && selectedRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (selectedRun === undefined) {
        return { threadId: input.threadId, run: null, timedOut: false };
      }
      if (isTerminalRunStatus(selectedRun.status)) {
        return { threadId: input.threadId, run: selectedRun, timedOut: false };
      }

      // Re-read the run only when the thread records a run update or its
      // deletion, instead of polling the projection for up to an hour. Each
      // stream keeps one event type, so transcript events never fill its buffer.
      const wait = Stream.merge(
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "run.updated",
        }),
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "thread.deleted",
        }),
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            stored.event.type !== "run.updated" || stored.event.payload.id === selectedRun.id,
        ),
        Stream.mapEffect(() =>
          getProjectThreadRecords(input, ["runs"], { runIds: [selectedRun.id] }).pipe(
            Effect.flatMap((current) => {
              const run = current.runs.find((candidate) => candidate.id === selectedRun.id);
              return run === undefined
                ? Effect.fail(
                    new ThreadManagementRunNotFoundError({
                      threadId: input.threadId,
                      runId: selectedRun.id,
                    }),
                  )
                : Effect.succeed(run);
            }),
          ),
        ),
        Stream.filter((run) => isTerminalRunStatus(run.status)),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
      );
      const waited = Option.flatten(yield* wait);
      if (Option.isSome(waited)) {
        return { threadId: input.threadId, run: waited.value, timedOut: false };
      }
      const current = yield* getProjectThreadRecords(input, ["runs"], { runIds: [selectedRun.id] });
      const run = current.runs.find((candidate) => candidate.id === selectedRun.id);
      if (run === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: selectedRun.id,
        });
      }
      // The run may have reached a terminal status while the timeout was
      // winning the race; the final projection read decides what actually
      // happened, so only a still-active run counts as timed out.
      return { threadId: input.threadId, run, timedOut: !isTerminalRunStatus(run.status) };
    });

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    // A turn that outlives this wait leaves its thread active.
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    yield* dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`server:settle-after-run:${input.runId}`),
      threadId: input.threadId,
    });
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
      const explicitRun =
        input.runId === undefined
          ? undefined
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && explicitRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
        return {
          type: "already_terminal",
          run: explicitRun as OrchestrationV2Run & {
            readonly status: ThreadManagementTerminalRunStatus;
          },
        } as const;
      }
      const interruptibleRun = latestActiveRun(target);
      if (interruptibleRun === undefined) {
        if (input.runId === undefined) {
          return { type: "no_active_run" } as const;
        }
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      const dispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: interruptibleRun.id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      return { type: "interrupt_requested", run: interruptibleRun, dispatch } as const;
    });

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = (input) =>
    Effect.gen(function* () {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (task.origin !== "provider_native" || task.driver !== "claudeAgent") {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    }).pipe((effect) => threadDispatch.withLock(input.threadId, effect));

  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = (input) =>
    Effect.gen(function* () {
      const { subagents } = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"]);
      const failures: Array<
        Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
      > = [];
      for (const task of subagents) {
        if (task.origin !== "app_owned" || task.childThreadId === null) continue;
        const threadId = task.childThreadId;
        yield* dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`${input.commandId}:stop:${threadId}`),
          threadId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        }).pipe(
          Effect.andThen(stopDelegatedTasks({ ...input, threadId })),
          Effect.catch((error) =>
            Effect.logWarning("Unable to stop a delegated task", {
              parentThreadId: input.threadId,
              threadId,
              error,
            }).pipe(Effect.andThen(Effect.sync(() => failures.push(error)))),
          ),
        );
      }
      if (failures[0] !== undefined) return yield* Effect.fail(failures[0]);
    });

  const cancelDelegatedTask: ThreadManagementServiceShape["cancelDelegatedTask"] = Effect.fn(
    "ThreadManagementService.cancelDelegatedTask",
  )(
    function* (input) {
      const parent = yield* orchestrator.getThreadRecords(input.threadId, ["subagents"], {
        subagentIds: [input.taskId],
      });
      const task = parent.subagents.find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      if (task?.childThreadId == null)
        return yield* new ThreadManagementTaskCancelError({
          taskId: input.taskId,
          reason: "not-found",
        });
      const childThreadId = task.childThreadId;
      const taskRuns = yield* orchestrator.getThreadRecords(childThreadId, ["runs"], {
        runDelegatedTaskId: task.id,
        runOrder: "desc",
        runLimit: 1,
      });
      const latest =
        taskRuns.runs[0] ??
        (yield* orchestrator.getThreadRecords(childThreadId, ["runs"], {
          runOrder: "desc",
          runLimit: 1,
        })).runs[0];
      const originalTask = yield* orchestrator.getThreadRecords(childThreadId, ["runs"], {
        runDelegatedTaskId: task.id,
        runOrder: "asc",
        runLimit: 1,
      });
      const original =
        originalTask.runs[0] ??
        (yield* orchestrator.getThreadRecords(childThreadId, ["runs"], {
          runOrder: "asc",
          runLimit: 1,
        })).runs[0];
      const runs = [
        ...new Map(
          [original, latest]
            .filter((run): run is OrchestrationV2Run => run !== undefined)
            .map((run) => [run.id, run]),
        ).values(),
      ].toSorted((a, b) => a.ordinal - b.ordinal);
      const transfers = yield* orchestrator.getThreadRecords(input.threadId, ["contextTransfers"], {
        contextTransferThreadIds: [childThreadId],
        contextTransferRunIds: runs.map((run) => run.id),
        contextTransferLimit: 16,
      });
      const childRun = delegatedTaskRun(
        { runs, contextTransfers: transfers.contextTransfers },
        task,
      );
      const resultPending = yield* orchestrator.delegatedTaskResultPending(childThreadId, task.id);
      const { status, workState } = delegatedTaskExecutionState({
        task,
        childRun,
        latestRun: latest,
        resultPending,
      });
      const terminalStatus = isTerminalTaskStatus(status) ? status : undefined;
      const terminal = terminalStatus !== undefined;
      if (!terminal && workState !== "waiting_for_children") {
        const shell = yield* orchestrator.getThreadShell(childThreadId);
        if (shell?.activeRunId == null)
          return yield* new ThreadManagementTaskCancelError({
            taskId: input.taskId,
            reason: "not-cancellable",
            cause: `Delegated task ${input.taskId} has no interruptible child run.`,
          });
      }
      yield* dispatch({
        type: "thread.stop",
        commandId: input.commandId,
        threadId: childThreadId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      yield* stopDelegatedTasks({
        threadId: childThreadId,
        commandId: input.commandId,
        reason: input.reason,
      });
      if (task.completionDelivery?.state !== "disposed") {
        const dispose = dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make(`${input.commandId}:completion-delivery`),
          parentThreadId: input.threadId,
          taskId: input.taskId,
        });
        yield* terminal
          ? dispose.pipe(
              Effect.mapError(
                (cause) =>
                  new ThreadManagementTaskCancelError({
                    taskId: input.taskId,
                    reason: "orchestration-error",
                    cause,
                  }),
              ),
            )
          : dispose.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("delegated-task.cancel.delivery-dispose-failed", {
                  taskId: input.taskId,
                  cause,
                }),
              ),
            );
      }
      return { taskId: input.taskId, status: terminalStatus ?? "cancel_requested" } as const;
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause instanceof ThreadManagementTaskCancelError
            ? cause
            : new ThreadManagementTaskCancelError({
                taskId: input.taskId,
                reason: "not-cancellable",
                cause,
              }),
        ),
      ),
  );

  return ThreadManagementService.of({
    ensureLegacyTranscript,
    cancelDelegatedTask,
    stopBackgroundWork: Effect.fn("ThreadManagementService.stopBackgroundWork")(function* (input) {
      const result = yield* dispatch({
        type: "background.stop",
        commandId: input.commandId,
        threadId: input.threadId,
        taskIds: input.taskIds,
      });
      return {
        stopping: result.storedEvents.flatMap(({ event }) =>
          event.type === "background-work.stop-requested" ? event.payload.stopping : [],
        ),
      };
    }),
    backgroundOutput: Effect.fn("ThreadManagementService.backgroundOutput")(function* (input) {
      const projection = yield* orchestrator.getThreadRecords(input.threadId, ["providerThreads"]);
      if (!liveBackgroundWork(projection).some((task) => task.taskId === input.taskId)) return null;
      const providerThread = projection.providerThreads.find(
        (thread) =>
          thread.appThreadId === input.threadId &&
          thread.pendingBackgroundTasks?.some((task) => task.taskId === input.taskId),
      );
      if (providerThread?.providerSessionId == null) return null;
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(runtime) || runtime.value.readTaskOutput === undefined) return null;
      return yield* runtime.value.readTaskOutput({ providerThread, taskId: input.taskId }).pipe(
        Effect.timeout("3 seconds"),
        Effect.catch(() => Effect.succeed(null)),
      );
    }),
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      ),
    dispatch,
    getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(
          orchestrator.getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly),
        ),
      ),
    getTimelinePage: (threadId, options) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
      ),
    getTimelineMetadataPage: (threadId, options) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getTimelineMetadataPage(threadId, options)),
      ),
    getVisibleTurnItem: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getVisibleTurnItem(input)),
      ),
    getVisibleTurnItemRecord: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getVisibleTurnItemRecord(input)),
      ),
    getMessageCount: (threadId) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      ),
    getTurnItem: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      ),
    getThreadRecords: (threadId, fields, filter) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
      ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getProjectThread,
    getShellSnapshot: orchestrator.getShellSnapshot,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    getTaskOwner: orchestrator.getTaskOwner,
    getThreadCounts: orchestrator.getThreadCounts,
    listProjectThreads,
    sendToThread,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    getReceipt: receipts.getByCommandId,
    waitForThread,
    settleAfterRun,
    settleThread,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents,
    streamStoredEventsFrom: orchestrator.streamStoredEventsFrom,
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(ThreadCommandExecutor.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(Layer.provide(ThreadCommandExecutor.layer));
