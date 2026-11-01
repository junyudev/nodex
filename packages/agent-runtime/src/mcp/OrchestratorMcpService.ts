import { recordTaskResult } from "./TaskResultDelivery.ts";
import { pendingUserQuestionIds, readUserQuestion } from "../nodex/PendingUserQuestions.ts";
import {
  delegatedTaskExecutionState,
  delegatedTaskRun,
  endsTaskWait,
  isTerminalTaskStatus,
  taskStatusForRun,
} from "../orchestration-v2/DelegatedTaskState.ts";
import { createHash } from "node:crypto";
import {
  CommandId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as Clock from "effect/Clock";
import * as SqlClient from "effect/sql/SqlClient";
import { make as makeToolOperation } from "./ToolOperation.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import { turnItemText } from "../orchestration-v2/turnItemContent.ts";
export { turnItemText } from "../orchestration-v2/turnItemContent.ts";
import { readHistory } from "../nodex/HistoryRead.ts";
import { makeHistoryReadCoverage } from "../nodex/HistoryReadCoverage.ts";
import { taskHistorySource, taskReadView } from "./TaskHistoryRead.ts";
import { runtimeHistoryContent } from "../nodex/RuntimeHistoryContent.ts";
import type { ThreadReadEvidence } from "../nodex/history-contracts.ts";
import type {
  TaskQuestionInput,
  TaskQuestionResult,
  TaskReadInput,
  TaskReadResult,
} from "./toolkits/task/tools.ts";
import { assertTargetWithinLimits, dispatchFailure } from "./threadAccess.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { OrchestratorThreadAboveModeLimitError } from "../orchestration-v2/Orchestrator.ts";
import { resolveInteractionMode, resolveRuntimeMode } from "./delegatedTaskModes.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { isSnoozed } from "../orchestration-v2/threadSnoozePolicy.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  type McpInvocationScope,
  type McpThreadInvocationScope,
  callerModeCeiling,
  requireThreadScope,
} from "./McpInvocationContext.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
// Only control events can end a task wait; transcript events never fill its buffers.
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

export interface OrchestratorMcpServiceShape {
  /** Only complete, canonically verified final results consume a direct child's delivery. */
  readonly acknowledgeRead: (
    scope: McpInvocationScope,
    input: {
      readonly threadId: ThreadId;
      readonly callerRunId?: RunId;
      readonly items: readonly ThreadReadEvidence[];
    },
  ) => Effect.Effect<{ readonly acknowledged: number }, OrchestratorMcpFailure>;
  readonly capabilities: (
    scope: McpInvocationScope,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  /** Waits for a result, question or approval, acknowledging only a settled result. */
  readonly waitTask: (
    scope: McpInvocationScope,
    input: { readonly taskId: NodeId; readonly timeoutMs?: number | undefined },
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  /** Resolves an app-owned task to its conversation through the indexed task owner. */
  readonly taskThread: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<ThreadId, OrchestratorMcpFailure>;
  readonly taskQuestion: (
    scope: McpInvocationScope,
    input: TaskQuestionInput,
  ) => Effect.Effect<TaskQuestionResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: TaskReadInput & { readonly threadId: ThreadId },
  ) => Effect.Effect<TaskReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
    idempotencyArguments?: Record<string, unknown>,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  /** Stops a running native workflow in the caller's own conversation. */
  readonly stopWorkflow: (
    scope: McpInvocationScope,
    subagentId: NodeId,
  ) => Effect.Effect<void, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);
const isModeLimitError = Schema.is(OrchestratorThreadAboveModeLimitError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
): OrchestratorMcpDelegateTaskResult["pendingApproval"] {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    )
      continue;
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId == null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt >= oldestCreatedAt) continue;
    oldestCreatedAt = createdAt;
    approval = { requestId: request.id, kind: request.kind, runId };
  }
  return approval;
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!provider.enabled) constraints.push("Provider instance is disabled.");
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Models without
 * descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always
 * fail: downstream consumers disagree on whether the first or last value of
 * a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

export function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  // Held queued runs wait for the user to resume the child; task_cancel holds them.
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function terminalTaskResultInPage(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}) {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return undefined;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return undefined;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return undefined;

  return input.page.find((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return undefined;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return undefined;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

/** Admitted explicit keys outlive provider credentials; omitted calls retain their native namespace. */
const operationNamespace = (scope: McpInvocationScope, key: string): string =>
  key.startsWith("nodexop:v1:") && scope.thread
    ? `thread:${scope.thread.threadId}`
    : scope.requestNamespace;

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(operationNamespace(input.scope, input.requestKey)),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(operationNamespace(input.scope, input.requestKey)),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
  counts: { readonly runCount: number; readonly pendingRequestCount: number },
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: counts.runCount,
    itemCount,
    pendingRequestCount: counts.pendingRequestCount,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    // From the shell, like the list, so read and list agree on snooze state.
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

export const make = Effect.gen(function* () {
  const admitToolOperation = yield* makeToolOperation;
  const coverRead = makeHistoryReadCoverage();
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadThreadMetadata = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, []).pipe(Effect.mapError(threadManagementFailure));

  const sourceRun = (scope: McpThreadInvocationScope, targetRunId?: RunId) =>
    Effect.gen(function* () {
      const admission = yield* ExecutionHost.McpTurnAdmission;
      if (admission !== undefined)
        yield* admission
          .assertCurrent()
          .pipe(Effect.mapError((error) => failure("parent_not_active", error.message)));
      const source = admission?.actor;
      const runId =
        targetRunId ?? (source?.threadId === scope.thread.threadId ? source.runId : null);
      if (runId === null || runId === undefined) return undefined;
      const records = yield* threadManagement
        .getThreadRecords(scope.thread.threadId, ["runs"], { runIds: [runId] })
        .pipe(Effect.mapError(threadManagementFailure));
      const run = records.runs[0];
      if (
        run === undefined ||
        run.rootNodeId === null ||
        ["cancelled", "interrupted", "rolled_back"].includes(run.status)
      ) {
        return yield* failure("run_not_found", `Run ${runId} is unavailable for this operation.`);
      }
      return run;
    });

  /** Resolve native execution authority separately from content access. */
  const loadCaller = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parent =
        scope.thread === undefined ? undefined : yield* loadThreadMetadata(scope.thread.threadId);
      return {
        parent,
        defaults: callerModeCeiling(scope, parent?.thread),
      };
    });

  /** The caller's own thread, for operations that act as the caller. */
  const loadThreadCaller = (scope: McpInvocationScope, operation: string) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const threadScope = yield* requireThreadScope(scope, operation);
      const parent = yield* loadThreadMetadata(threadScope.thread.threadId);
      return { scope: threadScope, parent } as const;
    });

  /** Any live thread in the environment. */
  const loadTargetThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failure("thread_not_found", `Thread ${threadId} was not found.`);
      }
      return yield* loadThreadMetadata(threadId);
    });

  const loadScopedThread = (scope: McpInvocationScope, threadId: ThreadId) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller(scope);
      const target =
        caller.parent !== undefined && threadId === caller.parent.thread.id
          ? caller.parent
          : yield* loadTargetThread(threadId);
      return { ...caller, target } as const;
    });

  const loadControllableThread = Effect.fn("OrchestratorMcpService.loadControllableThread")(
    function* (scope: McpInvocationScope, threadId: ThreadId) {
      const caller = yield* loadScopedThread(scope, threadId);
      yield* assertTargetWithinLimits(caller.defaults, caller.target.thread);
      return caller;
    },
  );

  const loadReadableThread = (scope: McpInvocationScope, threadId: ThreadId) =>
    Effect.gen(function* () {
      const { parent } = yield* loadCaller(scope);
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failure("thread_not_found", `Thread ${threadId} is no longer available.`);
      }
      const target = yield* loadThreadMetadata(threadId);
      const counts = yield* threadManagement
        .getThreadCounts(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return { parent, target, shell, counts } as const;
    });

  // Agents choose and validate delegation targets; never from unchecked placeholders.
  const loadProviders = providerRegistry.getCheckedProviders;

  /**
   * Instance ids the adapter registry resolves — the same lookup a
   * `delegated_task.request` performs when it runs. Capability reporting and
   * target resolution must not advertise a set narrower (or wider) than what
   * dispatch can actually serve.
   */
  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Skips the per-candidate project-enablement check in driver-only
     * resolution. Set only when the command that will dispatch this target
     * already has a receipt: that dispatch can only replay the recorded
     * result, never start anything new, so filtering candidates by the
     * project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different
     * command id than the one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const requestedInstanceId = input.target?.providerInstanceId;
      const requestedDriver = input.target?.driverKind;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      let instanceId = requestedInstanceId;

      if (instanceId === undefined && requestedDriver !== undefined) {
        const candidates = input.providers.filter(
          (provider) =>
            provider.driver === requestedDriver &&
            orchestrationCapableInstanceIds.has(provider.instanceId),
        );
        if (candidates.length === 0) {
          return yield* failure(
            "provider_unavailable",
            `No V2 provider adapter is registered for driver ${requestedDriver}.`,
          );
        }
        // Inherit the parent's instance only when it can actually serve the
        // child; an unavailable parent yields to a healthy instance of the
        // requested driver rather than failing the delegation. An instance
        // the project turned off cannot serve either, so selection skips it
        // for the next candidate instead of failing the enablement check.
        const healthyCandidates = candidates.filter(
          (candidate) => providerConstraints(candidate, true).length === 0,
        );
        const inheritedCandidate = healthyCandidates.find(
          (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
        );
        const orderedCandidates = [
          ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
          ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
        ];
        for (const candidate of orderedCandidates) {
          const enabledForProject =
            input.skipProjectEnablementFilter === true ||
            (yield* threadManagement.isProviderInstanceEnabledForProject({
              projectId: input.parent.thread.projectId,
              instanceId: candidate.instanceId,
            }));
          if (enabledForProject) {
            instanceId = candidate.instanceId;
            break;
          }
        }
        if (instanceId === undefined) {
          return yield* failure(
            "provider_unavailable",
            healthyCandidates.length === 0
              ? `No available V2 provider instance for driver ${requestedDriver}.`
              : `No instance of driver ${requestedDriver} is enabled for this project.`,
          );
        }
      }
      instanceId ??= input.parent.thread.modelSelection.instanceId;

      const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is not registered.`,
        );
      }
      if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
        return yield* failure(
          "invalid_request",
          `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
        );
      }
      const constraints = providerConstraints(
        provider,
        orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (constraints.length > 0) {
        return yield* failure(
          "provider_unavailable",
          `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
        );
      }

      const inheritedSelection = input.parent.thread.modelSelection;
      const requestedModel = input.target?.model;
      const model =
        requestedModel ??
        (instanceId === inheritedSelection.instanceId
          ? inheritedSelection.model
          : provider?.models[0]?.slug);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Provider ${instanceId} has no model available for inheritance.`,
        );
      }
      if (
        requestedModel !== undefined &&
        provider !== undefined &&
        provider.models.length > 0 &&
        !provider.models.some((candidate) => candidate.slug === requestedModel)
      ) {
        return yield* failure(
          "model_unavailable",
          `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
        );
      }

      const requestedOptions = input.target?.options;
      if (requestedOptions !== undefined) {
        const descriptors = provider.models.find((candidate) => candidate.slug === model)
          ?.capabilities?.optionDescriptors;
        const invalid = invalidOptionSelections(requestedOptions, descriptors);
        if (invalid.length > 0) {
          return yield* failure(
            "invalid_request",
            `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
          );
        }
      }

      return {
        supportedRuntimeModes: provider.supportedRuntimeModes,
        modelSelection:
          instanceId === inheritedSelection.instanceId &&
          model === inheritedSelection.model &&
          requestedOptions === undefined
            ? inheritedSelection
            : requestedOptions === undefined
              ? { instanceId, model }
              : { instanceId, model, options: requestedOptions },
      };
    });

  const requestKey = (): Effect.Effect<string> =>
    Effect.gen(function* () {
      const admission = yield* ExecutionHost.McpTurnAdmission;
      if (admission?.actor?.nativeCallKey !== undefined)
        return `native:${admission.actor.nativeCallKey}:${admission.requestId ?? "call"}`;
      if (admission?.requestId !== undefined) {
        const actor = admission.actor;
        return actor === undefined
          ? `request:${admission.requestId}`
          : `request:${actor.runtimeGeneration}:${actor.nativeGeneration}:${admission.requestId}`;
      }
      return yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    });

  const taskOwner = Effect.fn("OrchestratorMcpService.taskOwner")(function* (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) {
    yield* requireCapability(scope);
    const caller = yield* requireThreadScope(scope, "Task tools");
    const owner = yield* threadManagement
      .getTaskOwner(taskId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (owner === null)
      return yield* failure("task_not_found", `Delegated task ${taskId} was not found.`);
    if (owner !== caller.thread.threadId)
      return yield* failure(
        "capability_denied",
        "Only the Agent that delegated this task can access it.",
      );
    return owner;
  });

  const taskThread = Effect.fn("OrchestratorMcpService.taskThread")(function* (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) {
    const parentId = yield* taskOwner(scope, taskId);
    const records = yield* threadManagement
      .getThreadRecords(parentId, ["subagents"], { subagentIds: [taskId] })
      .pipe(Effect.mapError(threadManagementFailure));
    const task = records.subagents.find(
      (candidate) => candidate.id === taskId && candidate.origin === "app_owned",
    );
    if (task?.childThreadId == null)
      return yield* failure("task_not_found", `Delegated task ${taskId} was not found.`);
    return task.childThreadId;
  });

  const readTask = (
    scope: McpInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
    observedByRunId?: RunId,
  ): Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const parentId = yield* taskOwner(scope, taskId);
      const parentProjection = yield* threadManagement
        .getThreadRecords(parentId, ["subagents"], { subagentIds: [taskId] })
        .pipe(Effect.mapError(threadManagementFailure));
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === taskId &&
          candidate.origin === "app_owned" &&
          candidate.threadId === parentId,
      );
      if (task === undefined || task.childThreadId === null) {
        return yield* failure("task_not_found", `Delegated task ${taskId} was not found.`);
      }
      const runRecords = (
        filter: import("../orchestration-v2/ProjectionStore.ts").ProjectionRecordFilter,
      ) =>
        threadManagement
          .getThreadRecords(task.childThreadId!, ["runs"], filter)
          .pipe(Effect.mapError(threadManagementFailure));
      const original = yield* runRecords({
        runDelegatedTaskId: task.id,
        runOrder: "asc",
        runLimit: 1,
      });
      const originalRun =
        original.runs[0] ?? (yield* runRecords({ runOrder: "asc", runLimit: 1 })).runs[0];
      const latestTask = yield* runRecords({
        runDelegatedTaskId: task.id,
        runOrder: "desc",
        runLimit: 1,
      });
      const latest =
        latestTask.runs[0] ?? (yield* runRecords({ runOrder: "desc", runLimit: 1 })).runs[0];
      const terminal = yield* runRecords({
        runStatuses: ["completed", "failed", "cancelled", "interrupted"],
        runOrder: "completed-desc",
        runLimit: 1,
        excludeMonitorRuns: true,
        ...(originalRun === undefined ? {} : { resultOriginalRunId: originalRun.id }),
      });
      const pending = yield* runRecords({
        runStatuses: ["queued", "preparing", "starting", "running", "waiting"],
        excludeHeldRuns: true,
        runOrder: "desc",
        runLimit: 1,
      });
      const runs = [
        ...new Map(
          [originalRun, latest, terminal.runs[0], pending.runs[0]]
            .filter((run): run is OrchestrationV2Run => run !== undefined)
            .map((run) => [run.id, run]),
        ).values(),
      ].toSorted((a, b) => a.ordinal - b.ordinal);
      const { runtimeRequests } = yield* threadManagement
        .getThreadRecords(task.childThreadId, ["runtimeRequests"])
        .pipe(Effect.mapError(threadManagementFailure));
      const approvalNodeIds = runtimeRequests
        .filter(
          (request) =>
            request.status === "pending" &&
            request.responseCapability.type === "live" &&
            isApprovalRequestKind(request.kind),
        )
        .map((request) => request.nodeId);
      const { nodes } = yield* threadManagement
        .getThreadRecords(task.childThreadId, ["nodes"], { nodeIds: approvalNodeIds })
        .pipe(Effect.mapError(threadManagementFailure));
      const approvalRuns = yield* runRecords({
        runIds: nodes.flatMap((node) => (node.runId === null ? [] : [node.runId])),
      });
      const transfers = yield* threadManagement
        .getThreadRecords(parentId, ["contextTransfers"], {
          contextTransferThreadIds: [task.childThreadId],
          contextTransferRunIds: runs.map((run) => run.id),
          contextTransferLimit: 16,
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const parentWithTransfers = {
        ...parentProjection,
        contextTransfers: transfers.contextTransfers,
      };
      const childControls = {
        thread: original.thread,
        runs,
        contextTransfers: transfers.contextTransfers,
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests,
      };
      const childRun = delegatedTaskRun(childControls, task);
      const terminalRun = latestTerminalResultRun(childControls, childRun);
      const resultPending = yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, task.id)
        .pipe(Effect.mapError(threadManagementFailure));
      const taskResultRun = latest;
      const resultRunIds = [
        ...new Set(
          [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
        ),
      ];
      const resultRecords = yield* threadManagement
        .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: resultRunIds,
          turnItemRunIds: resultRunIds,
          turnItemTypes: ["assistant_message", "error"],
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const childProjection = {
        ...childControls,
        messages: [...childControls.messages, ...resultRecords.messages],
        turnItems: resultRecords.turnItems,
      };
      const { status, workState } = delegatedTaskExecutionState({
        task,
        childRun,
        latestRun: taskResultRun,
        resultPending,
      });
      const derivedResult =
        task.result !== null
          ? task.result
          : taskResultRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, taskResultRun).text
            : null;
      const resultTransfers = parentWithTransfers.contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === task.childThreadId &&
          transfer.targetThreadId === parentId,
      );
      const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
        !canExposeTaskRunResult(run)
          ? null
          : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
            (run.id === childRun?.id
              ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
              : undefined) ??
            null);
      const resultTransfer = taskResultTransfer(parentWithTransfers, childProjection, task) ?? null;
      const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
      const recovery = (taskResultRun ?? childRun)?.recovery;
      const response = {
        taskId: task.id,
        childThreadId: task.childThreadId,
        childRunId: childRun?.id ?? null,
        childNodeId: task.id,
        status,
        workState,
        recovery:
          workState !== "recovering" || recovery === undefined
            ? null
            : {
                kind: recovery.kind,
                attempt: recovery.attempt,
                maxAttempts: recovery.maxAttempts,
                nextAttemptAt: DateTime.formatIso(recovery.nextAttemptAt),
                failureMessage: recovery.failure.message,
              },
        hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
        providerInstanceId: task.providerInstanceId,
        model: task.model,
        summary: derivedResult,
        resultContextTransferId: resultTransfer?.id ?? null,
        latestTerminalRunId: terminalRun?.id ?? null,
        latestTerminalStatus:
          terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
        latestTerminalSummary: canExposeTaskRunResult(terminalRun)
          ? terminalRun.id === childRun?.id
            ? derivedResult
            : subagentResultForRun(childProjection, terminalRun).text
          : null,
        latestTerminalResultContextTransferId: resultTransferForRun(terminalRun)?.id ?? null,
        hasPendingQuestion:
          !isTerminalTaskStatus(status) &&
          runtimeRequests.some(
            (request) =>
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type === "live",
          ),
        pendingApproval:
          isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
            ? null
            : pendingTaskApproval(
                { runtimeRequests, nodes, runs: approvalRuns.runs },
                task.id,
                childRun,
              ),
        waitTimedOut,
      } satisfies OrchestratorMcpDelegateTaskResult;
      if (
        acknowledgeTerminal &&
        isTerminalTaskStatus(status) &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "disposed"
      ) {
        const admission = yield* ExecutionHost.McpTurnAdmission;
        const observingRunId =
          observedByRunId ??
          (admission?.actor?.threadId === parentId ? admission.actor.runId : null);
        const acknowledgementRequestKey = yield* requestKey();
        yield* threadManagement
          .dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: stableCommandId({
              scope,
              requestKey: acknowledgementRequestKey,
              operation: `${acknowledgementOperation}:${taskId}`,
            }),
            parentThreadId: parentId,
            taskId,
            observedByRunId: observingRunId ?? null,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
      }
      return response;
    });

  // Re-read the task only when an event on the parent or child thread can
  // change its status, instead of polling the projections every 50 ms.
  const waitForTask = (scope: McpInvocationScope, taskId: NodeId, timeoutMs: number) =>
    Effect.gen(function* () {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const parentId = yield* taskOwner(scope, taskId);
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(parentId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) return Option.some(initial);
      // One stream per event type, so transcript events never fill a buffer.
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
          threadManagement.streamStoredEventsFrom({
            threadId: thread === "parent" ? parentId : initial.childThreadId,
            afterSequence,
            eventType,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten));

  const acknowledgeRead: OrchestratorMcpServiceShape["acknowledgeRead"] = Effect.fn(
    "OrchestratorMcpService.acknowledgeRead",
  )(function* (scope, input) {
    if (!scope.thread || input.items.length === 0) return { acknowledged: 0 };
    const { parent: callerParent, target: targetMetadata } = yield* loadScopedThread(
      scope,
      input.threadId,
    );
    if (
      !callerParent ||
      targetMetadata.thread.lineage.parentThreadId !== callerParent.thread.id ||
      targetMetadata.thread.lineage.relationshipToParent !== "subagent"
    )
      return { acknowledged: 0 };
    const callerRun = yield* sourceRun(scope as McpThreadInvocationScope, input.callerRunId);
    if (!callerRun) return { acknowledged: 0 };
    const verified: Array<{ readonly id: string; readonly runId: RunId | null }> = [];
    for (const evidence of input.items.slice(0, 100)) {
      if (evidence.sourceThreadId !== input.threadId) continue;
      const record = yield* threadManagement
        .getVisibleTurnItemRecord({
          threadId: input.threadId,
          sourceThreadId: input.threadId,
          itemId: TurnItemId.make(evidence.itemId),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      if (!record || record.visibility !== "local") continue;
      const content = yield* runtimeHistoryContent(record, {
        format: evidence.format,
        offset: 0,
        maxChars: 0,
      }).pipe(Effect.mapError(threadManagementFailure));
      const totalChars =
        content.totalChars +
        (evidence.format === "json" ? `{"source":"runtime","item":`.length + 1 : 0);
      if (
        !coverRead({
          callerThreadId: scope.thread.threadId,
          callerRunId: callerRun.id,
          targetThreadId: input.threadId,
          targetRunId: record.item.runId,
          evidence,
          currentVersion: content.contentVersion,
          totalChars,
          now: yield* Clock.currentTimeMillis,
        })
      )
        continue;
      verified.push({ id: record.sourceItemId, runId: record.item.runId });
    }
    if (verified.length === 0) return { acknowledged: 0 };
    let acknowledged = 0;
    const runIds = [
      ...new Set(
        verified
          .map((item) => item.runId)
          .filter((id): id is RunId => id !== null)
          .map((id) => id as RunId),
      ),
    ];
    const target = {
      ...targetMetadata,
      ...(yield* threadManagement
        .getThreadRecords(input.threadId, ["runs", "contextTransfers"], {
          runIds,
          contextTransferRunIds: runIds,
          contextTransferLimit: 16,
        })
        .pipe(Effect.mapError(threadManagementFailure))),
    };
    const taskIds = [
      ...new Set([
        ...(target.thread.forkedFrom?.type === "node" ? [target.thread.forkedFrom.nodeId] : []),
        ...target.runs.flatMap((run) =>
          run.delegatedTaskId === undefined ? [] : [run.delegatedTaskId],
        ),
      ]),
    ];
    const parent = {
      ...callerParent,
      ...(yield* threadManagement
        .getThreadRecords(callerParent.thread.id, ["subagents", "contextTransfers"], {
          subagentIds: taskIds,
          contextTransferThreadIds: [input.threadId],
          contextTransferRunIds: runIds,
          contextTransferLimit: 16,
        })
        .pipe(Effect.mapError(threadManagementFailure))),
    };
    const returnedRunIds = new Set<RunId | null>(
      verified.map((item) => (item.runId === null ? null : (item.runId as RunId))),
    );
    for (const task of directAppOwnedChildTasks(parent, target, returnedRunIds)) {
      const transfer = taskResultTransfer(parent, target, task);
      const runId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
      const resultRecords = yield* threadManagement
        .getThreadRecords(input.threadId, ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: runId === undefined ? [] : [runId],
          turnItemRunIds: runId === undefined ? [] : [runId],
          turnItemTypes: ["assistant_message", "error"],
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = resultRecords.turnItems
        .filter((item) => verified.some((selected) => selected.id === item.id))
        .map((item) => ({
          position: 0,
          sourceThreadId: input.threadId,
          sourceItemId: item.id,
          visibility: "local" as const,
          item,
        }));
      const terminal = terminalTaskResultInPage({
        parent,
        page,
        task,
        target: { ...target, ...resultRecords },
        maxChars: Number.MAX_SAFE_INTEGER,
      });
      if (terminal) {
        // Result selection can race a replacement; recheck the exact admitted payload last.
        const proof = input.items.find((evidence) => terminal.sourceItemId === evidence.itemId);
        if (!proof) continue;
        const current = yield* threadManagement
          .getVisibleTurnItemRecord({
            threadId: input.threadId,
            sourceThreadId: input.threadId,
            itemId: TurnItemId.make(proof.itemId),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        if (
          !current ||
          (yield* runtimeHistoryContent(current, {
            format: proof.format,
            offset: 0,
            maxChars: 0,
          }).pipe(Effect.mapError(threadManagementFailure))).contentVersion !== proof.contentVersion
        )
          continue;
        yield* sourceRun(scope as McpThreadInvocationScope, callerRun.id);
        yield* readTask(
          scope as McpThreadInvocationScope,
          task.id,
          false,
          true,
          "thread-read-acknowledge",
          callerRun.id,
        ).pipe(Effect.tap(recordTaskResult));
        acknowledged++;
      }
    }
    return { acknowledged };
  });

  return OrchestratorMcpService.of({
    acknowledgeRead,
    capabilities: (scope) =>
      Effect.gen(function* () {
        const { parent, defaults } = yield* loadCaller(scope);
        const providers = yield* loadProviders;
        const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
        // Models the user hid from pickers stay out of the catalog agents choose from.
        const modelPreferences = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.providerModelPreferences ?? {}),
          Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
        );
        return {
          inherited:
            parent === undefined
              ? null
              : {
                  providerInstanceId: parent.thread.modelSelection.instanceId,
                  model: parent.thread.modelSelection.model,
                  interactionMode: defaults.interactionMode,
                },
          providers: providers.map((provider) => {
            const constraints = providerConstraints(
              provider,
              orchestrationCapableInstanceIds.has(provider.instanceId),
            );
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider?.displayName ?? null,
              models:
                provider?.models
                  .filter(
                    (model) =>
                      model.isCustom ||
                      !modelPreferences[provider.instanceId]?.hiddenModels.includes(model.slug),
                  )
                  .map((model) => ({
                    id: model.slug,
                    label: model.name ?? null,
                    ...(model.capabilities?.optionDescriptors === undefined
                      ? {}
                      : { options: model.capabilities.optionDescriptors }),
                  })) ?? [],
              available: constraints.length === 0,
              constraints: [...constraints],
            };
          }),
        };
      }),
    delegateTask: (callerScope, input) =>
      Effect.gen(function* () {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
        const parentRun = yield* sourceRun(scope, input.parentRunId);
        if (parentRun === undefined || parentRun.rootNodeId === null) {
          return yield* failure(
            "invalid_request",
            "Pass parentRunId to choose which Run owns this delegated task; this native call identifies only its Session.",
          );
        }
        const providers = yield* loadProviders;
        // Computed before resolving the target so a retry of an already
        // accepted delegation can be recognized: dispatching under the same
        // command id only replays the recorded result, so candidate
        // selection must not refuse it over the project's current settings.
        const key =
          input.idempotencyKey === undefined
            ? yield* requestKey()
            : yield* admitToolOperation(scope, "delegate_task", input.idempotencyKey, input);
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "delegate-task",
        });
        const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
        const target = yield* resolveTargetRechecking({
          parent,
          target: input.target,
          providers,
          skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
        });
        const limits = callerModeCeiling(scope, parent.thread);
        const runtimeMode = yield* resolveRuntimeMode(
          limits.runtimeMode,
          input.runtimeMode,
          target,
        );
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        // ThreadManagementService.dispatch is the chokepoint for this command
        // type's own enablement check, using the same command id and its
        // receipt-replay exemption, so no separate assert runs here.
        const result = yield* threadManagement
          .dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            parentThreadId: scope.thread.threadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId,
            task: taskPrompt(input),
            ...(input.title === undefined ? {} : { title: input.title }),
            modelSelection: target.modelSelection,
            runtimeMode,
            interactionMode,
            // Async delegations wake the parent on every child terminal; wait
            // delegations deliver through the blocking tool call, so a wake is
            // only needed if the parent settled first (timeout, disconnect).
            completionWake: input.mode === "wait" ? "settled_only" : "always",
          })
          .pipe(Effect.provideService(DispatchModeLimit, limits), Effect.mapError(dispatchFailure));
        const taskEvent = result.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
        );
        if (taskEvent?.event.type !== "subagent.updated") {
          return yield* failure(
            "orchestration_error",
            "Delegated task command did not produce a task projection.",
          );
        }
        const taskId = taskEvent.event.payload.id;

        if (input.mode !== "wait") {
          return yield* readTask(scope, taskId, false, true);
        }
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        );
        const waited = yield* waitForTask(scope, taskId, timeoutMs);
        if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
          return waited.value;
        }
        // An incomplete wait gives up delivery, so later results must wake the coordinator.
        const { defaults: currentLimits } = yield* loadCaller(scope);
        yield* threadManagement
          .dispatch({
            type: "delegated_task.wake-policy",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "delegate-task-wake-policy",
            }),
            parentThreadId: scope.thread.threadId,
            taskId,
            completionWake: "always",
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, currentLimits),
            // The tool still returns after a timeout, question or approval, so failures
            // stay warnings. Keep the two shapes apart: a rejected receipt
            // means this exact command id already failed (a replay of a
            // no-op upgrade), while anything else is a fresh dispatch fault.
            Effect.catch((error) =>
              Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                taskId,
                outcome:
                  error._tag === "OrchestratorCommandPreviouslyRejectedError"
                    ? "previously_rejected"
                    : "dispatch_failed",
                error,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                taskId,
                outcome: "defect",
                cause,
              }),
            ),
          );
        return yield* readTask(scope, taskId, Option.isNone(waited), true);
      }),
    taskStatus: (callerScope, taskId) =>
      Effect.gen(function* () {
        const scope = callerScope;
        return yield* readTask(scope, taskId, false, true);
      }),
    waitTask: (scope, input) =>
      Effect.gen(function* () {
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
        );
        const waited = yield* waitForTask(scope, input.taskId, timeoutMs);
        return Option.isSome(waited) ? waited.value : yield* readTask(scope, input.taskId, true);
      }),
    taskThread,
    taskQuestion: Effect.fn("OrchestratorMcpService.taskQuestion")(function* (scope, input) {
      const threadId = yield* taskThread(scope, input.taskId);
      const projection = yield* threadManagement
        .getThreadRecords(
          threadId,
          input.action === "list" ? ["runtimeRequests"] : ["runtimeRequests", "turnItems"],
          { turnItemTypes: ["user_input_request"] },
        )
        .pipe(Effect.mapError(threadManagementFailure));
      if (input.action === "list")
        return { requestIds: pendingUserQuestionIds(projection.runtimeRequests) };
      if (input.requestId === undefined)
        return yield* failure("invalid_request", "This action needs `requestId`.");
      const selected = readUserQuestion(projection, input.requestId);
      if ("error" in selected) return yield* failure("invalid_request", selected.message);
      const { request, item } = selected;
      if (input.action === "read") return { requestId: request.id, questions: item.questions };
      if (input.answers === undefined)
        return yield* failure("invalid_request", "This action needs `answers`.");
      const { defaults } = yield* loadControllableThread(scope, threadId);
      const key = yield* requestKey();
      const result = yield* threadManagement
        .dispatch({
          type: "runtime-request.respond",
          threadId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: `task-question:${input.taskId}:${request.id}`,
          }),
          requestId: request.id,
          answers: input.answers,
          respondedBy: { kind: "agent", senderThreadId: yield* taskOwner(scope, input.taskId) },
          requirePending: true,
        })
        .pipe(Effect.provideService(DispatchModeLimit, defaults), Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
    cancelTask: (scope, input) =>
      Effect.gen(function* () {
        yield* readTask(scope, input.taskId);
        const childThreadId = yield* taskThread(scope, input.taskId);
        const { defaults } = yield* loadControllableThread(scope, childThreadId);
        const key =
          input.idempotencyKey === undefined
            ? yield* requestKey()
            : yield* admitToolOperation(scope, "task_cancel", input.idempotencyKey, input);
        const threadId = yield* taskOwner(scope, input.taskId);
        return yield* threadManagement
          .cancelDelegatedTask({
            threadId,
            taskId: input.taskId,
            commandId: stableCommandId({ scope, requestKey: key, operation: "cancel-task" }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, defaults),
            Effect.mapError((error) =>
              isModeLimitError(error.cause)
                ? dispatchFailure(error.cause)
                : failure(
                    error.reason === "not-found"
                      ? "task_not_found"
                      : error.reason === "orchestration-error"
                        ? "orchestration_error"
                        : "task_not_cancellable",
                    `Unable to stop delegated task ${input.taskId}: ${errorMessage(error.cause ?? error)}`,
                  ),
            ),
          );
      }),
    readThread: (scope, input) =>
      Effect.gen(function* () {
        const {
          parent: callerParent,
          target: targetMetadata,
          shell,
          counts,
        } = yield* loadReadableThread(scope, input.threadId);
        const summaryRunIds = [shell.activeRunId, shell.latestRunId].filter(
          (id): id is RunId => id !== null,
        );
        const summary = yield* threadManagement
          .getThreadRecords(input.threadId, ["runs"], { runIds: summaryRunIds })
          .pipe(Effect.mapError(threadManagementFailure));
        const timeline = yield* threadManagement
          .getTimelineMetadataPage(input.threadId, { view: "activity", limit: 1 })
          .pipe(Effect.mapError(threadManagementFailure));
        const detail = threadDetail(
          { ...targetMetadata, runs: summary.runs },
          timeline.totalItems,
          shell,
          yield* Clock.currentTimeMillis,
          counts,
        );
        const conversation: TaskReadResult["conversation"] = {
          taskId: input.taskId ?? null,
          title: detail.title,
          status: detail.status,
          providerInstanceId: detail.providerInstanceId,
          model: detail.model,
          interactionMode: detail.interactionMode,
          activeRunId: detail.activeRunId,
          latestRunId: detail.latestRunId,
          runCount: detail.runCount,
          itemCount: detail.itemCount,
          pendingRequestCount: detail.pendingRequestCount,
        };
        const binding = createHash("sha256")
          .update(
            JSON.stringify({
              environmentId: scope.environmentId,
              namespace: scope.requestNamespace,
              issuedAt: scope.issuedAt,
              caller: scope.thread ?? scope.client,
              taskId: input.taskId ?? null,
            }),
          )
          .digest("base64url");
        const { history, admitted } = yield* readHistory({
          request: {
            ownerId: input.threadId,
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
            ...(input.textOffset === undefined ? {} : { textOffset: input.textOffset }),
            ...(input.view === undefined ? {} : { view: input.view }),
            ...(input.order === undefined ? {} : { order: input.order }),
            limit: input.limit ?? DEFAULT_THREAD_READ_LIMIT,
            maxCharsPerItem: input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS,
          },
          binding,
          source: taskHistorySource(threadManagement, input.threadId),
          wrap: (value) =>
            value.availability === "available"
              ? taskReadView({ conversation, items: value.items, page: value.page })
              : { conversation, history: value },
        }).pipe(Effect.mapError((error) => failure(error.reason, error.message)));
        if (history.availability !== "available")
          return yield* failure("history_unavailable", "Task history is unavailable");
        const result = taskReadView({
          conversation,
          items: history.items,
          page: history.page,
        }) as TaskReadResult;
        if (callerParent === undefined || scope.thread === undefined || admitted.length === 0)
          return result;
        yield* acknowledgeRead(scope, {
          threadId: input.threadId,
          items: admitted,
        });
        return result;
      }),
    stopWorkflow: (callerScope, subagentId) =>
      Effect.gen(function* () {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "stop_workflow");
        yield* threadManagement.stopWorkflow({ threadId: scope.thread.threadId, subagentId }).pipe(
          Effect.provideService(DispatchModeLimit, callerModeCeiling(scope, parent.thread)),
          Effect.mapError((cause) =>
            failure(
              cause.reason === "unavailable" || cause.reason === "stop-failed"
                ? "orchestration_error"
                : "invalid_request",
              cause.reason === "not-running"
                ? `Workflow ${subagentId} is not running in this conversation.`
                : cause.reason === "unsupported"
                  ? `Task ${subagentId} is not a stoppable workflow.`
                  : cause.message,
            ),
          ),
        );
      }),
    sendToThread: (scope, input, idempotencyArguments) =>
      Effect.gen(function* () {
        const { parent, target, defaults } = yield* loadControllableThread(scope, input.threadId);

        const admission = yield* ExecutionHost.McpTurnAdmission;
        const senderRunId =
          admission?.actor?.threadId === parent?.thread.id
            ? (admission?.actor?.runId ?? null)
            : null;

        const mode = input.mode ?? "auto";
        const key =
          input.idempotencyKey === undefined
            ? yield* requestKey()
            : yield* admitToolOperation(
                scope,
                "task_send",
                input.idempotencyKey,
                idempotencyArguments ?? input,
              );
        const messageId = stableOperationMessageId({
          scope,
          requestKey: key,
          operation: "thread-send",
        });
        const result = yield* threadManagement
          .sendToThread({
            projectId: target.thread.projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-send",
            }),
            threadId: input.threadId,
            ...(parent === undefined ? {} : { senderThreadId: parent.thread.id, senderRunId }),
            messageId,
            text: input.message,
            attachments: [],
            mode,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.provideService(DispatchModeLimit, defaults),
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : dispatchFailure(error),
            ),
          );
        return {
          threadId: input.threadId,
          messageId,
          runId: result.run.id,
          ...(result.run.delegatedTaskId === undefined
            ? {}
            : { taskId: result.run.delegatedTaskId }),
          status: result.run.status,
          delivery: result.delivery,
        } satisfies OrchestratorMcpThreadSendResult;
      }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | SqlClient.SqlClient
  | ThreadManagementService.ThreadManagementService
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ServerSettings.ServerSettingsService
> = Layer.effect(OrchestratorMcpService, make);
