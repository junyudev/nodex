import {
  NodeId,
  NonNegativeInt,
  OrchestrationV2RunStatus,
  OrchestrationV2UserInputQuestion,
  OrchestrationV2DispatchCommandResult,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpTaskRecovery,
  OrchestratorMcpDelegatedTaskStatus,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpIdempotencyKey,
  OrchestratorMcpFailure,
  OrchestratorMcpPendingTaskApproval,
  OrchestratorMcpPendingTaskQuestion,
  OrchestratorMcpDeliveredTaskQuestion,
  OrchestratorMcpTerminalDelegatedTaskStatus,
  PositiveInt,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderUserInputAnswers,
  RunId,
  RuntimeRequestId,
  TrimmedNonEmptyString,
} from "@nodex/runtime-contracts";
import type { AgentTurnItem } from "../../../nodex/Interface.ts";
import type { HistoryItem } from "../../../nodex/history-contracts.ts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

/**
 * Agent-facing task contracts. A delegated child is addressed only by its
 * taskId; opaque cursors retain source locators and canonical activity retains diagnostic data. Product Sessions
 * belong to the host's Session tools.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];

const TaskIdentity = NodeId.annotate({ description: "taskId returned by delegate_task." });

const TaskResult = Schema.Struct({
  status: OrchestratorMcpTerminalDelegatedTaskStatus,
  summary: Schema.NullOr(Schema.String),
});

export const TaskView = Schema.Struct({
  taskId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals([
    "working",
    "recovering",
    "waiting_for_children",
    "result_available",
  ]).annotate({
    description:
      "result_available only when the task and every task it delegated have settled; a finished turn with live nested work is waiting_for_children. recovering means Nodex is automatically continuing the task after a transient provider failure: keep waiting, do not send it a message to resume it.",
  }),
  recovery: Schema.optional(Schema.NullOr(OrchestratorMcpTaskRecovery)).annotate({
    description:
      "While recovering: the cause kind, attempt, attempt limit (null when it keeps retrying until the connection returns), next attempt time and the failure message.",
  }),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  summary: Schema.NullOr(Schema.String).annotate({
    description: "The task's final result, including provider errors on failure.",
  }),
  latestResult: Schema.NullOr(TaskResult).annotate({
    description: "The newest settled turn in the task's conversation, including follow-ups.",
  }),
  hasPendingFollowUps: Schema.Boolean.annotate({
    description: "Follow-up turns are queued or running in the task's conversation.",
  }),
  pendingQuestions: Schema.Array(OrchestratorMcpPendingTaskQuestion),
  questions: Schema.Array(OrchestratorMcpDeliveredTaskQuestion),
  pendingApproval: OrchestratorMcpPendingTaskApproval,
  waitTimedOut: Schema.Boolean.annotate({
    description:
      "True only on the call whose wait budget elapsed. The task keeps running; read it later.",
  }),
});
export type TaskView = typeof TaskView.Type;

const TaskWaitInput = Schema.Struct({
  taskId: TaskIdentity,
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "Wait budget; default 10 minutes. It never cancels the task." }),
});

export const TaskQuestionInput = Schema.Struct({
  action: Schema.Literals(["list", "read", "respond", "dismiss"]),
  taskId: TaskIdentity,
  requestId: Schema.optional(RuntimeRequestId).annotate({
    description: "Required for read, respond and dismiss.",
  }),
  answers: Schema.optional(ProviderUserInputAnswers).annotate({
    description: "Required for respond; maps question ids to answers.",
  }),
});
export type TaskQuestionInput = typeof TaskQuestionInput.Type;
export const TaskQuestionResult = Schema.Union([
  Schema.Struct({ requestIds: Schema.Array(RuntimeRequestId) }),
  Schema.Struct({
    requestId: RuntimeRequestId,
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
  }),
  Schema.Struct({
    ...OrchestrationV2DispatchCommandResult.fields,
    followUp: Schema.NullOr(Schema.Struct({ taskId: NodeId, message: Schema.String })),
  }),
]);
export type TaskQuestionResult = typeof TaskQuestionResult.Type;

const TaskCancelInput = Schema.Struct({
  taskId: TaskIdentity,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  idempotencyKey: Schema.optional(OrchestratorMcpIdempotencyKey),
});
export const TaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});

const TaskSendInput = Schema.Struct({
  taskId: TaskIdentity,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])).annotate({
    description:
      "auto starts an idle task conversation, steers a steerable turn, or queues otherwise. queue adds a separate turn, steer updates the running turn, restart interrupts and restarts it.",
  }),
  idempotencyKey: Schema.optional(OrchestratorMcpIdempotencyKey),
});
export const TaskSendResult = Schema.Struct({
  taskId: Schema.NullOr(NodeId).annotate({
    description:
      "The task that carries this message's result: a new task for a started or queued follow-up, or the task owning the running turn a steered message joined. Null only when the message joined a Run that no delegated task owns.",
  }),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type TaskSendResult = typeof TaskSendResult.Type;

// Providers may hide advertised bounds; clamp large positive reads while preserving invalid zero.
const readLimit = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );
const TaskReadInput = Schema.Struct({
  taskId: Schema.optional(TaskIdentity).annotate({
    description: "Omit to read your own conversation.",
  }),
  cursor: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096))),
  itemId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  order: Schema.optional(Schema.Literals(["newest_first", "oldest_first"])),
  limit: Schema.optional(readLimit(100)),
  maxCharsPerItem: Schema.optional(readLimit(50_000)),
});
export type TaskReadInput = typeof TaskReadInput.Type;
const ContentPosition = {
  offset: NonNegativeInt,
  totalChars: NonNegativeInt,
  nextCursor: Schema.NullOr(Schema.String),
};
export const TaskConversationItem = Schema.Struct({
  id: Schema.String,
  runId: Schema.NullOr(Schema.String),
  type: Schema.String,
  status: Schema.NullOr(Schema.String),
  visibility: Schema.optional(Schema.Literals(["local", "inherited", "synthetic"])),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  updatedAt: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.NullOr(Schema.String)),
  createdBy: Schema.optional(Schema.NullOr(Schema.String)),
  creationSource: Schema.optional(Schema.NullOr(Schema.String)),
  content: Schema.Union([
    Schema.Struct({ ...ContentPosition, format: Schema.Literal("text"), text: Schema.String }),
    Schema.Struct({
      ...ContentPosition,
      format: Schema.Literal("json_fragment"),
      text: Schema.String,
    }),
    Schema.Struct({
      ...ContentPosition,
      format: Schema.Literal("json"),
      value: Schema.Struct({
        source: Schema.Literal("runtime"),
        item: Schema.Record(Schema.String, Schema.Unknown),
      }),
    }),
  ]),
});
export const TaskReadResult = Schema.Struct({
  conversation: Schema.Struct({
    taskId: Schema.NullOr(NodeId),
    title: Schema.String,
    status: Schema.Union([Schema.Literal("idle"), OrchestrationV2RunStatus]),
    providerInstanceId: ProviderInstanceId,
    model: Schema.String,
    interactionMode: ProviderInteractionMode,
    activeRunId: Schema.NullOr(RunId),
    latestRunId: Schema.NullOr(RunId),
    runCount: NonNegativeInt,
    itemCount: NonNegativeInt,
    pendingRequestCount: NonNegativeInt,
  }),
  items: Schema.Array(TaskConversationItem),
  page: Schema.Struct({
    order: Schema.Literals(["newest_first", "oldest_first"]),
    view: Schema.Literals(["messages", "activity"]),
    limit: PositiveInt,
    hasMore: Schema.Boolean,
    nextCursor: Schema.NullOr(Schema.String),
    tailCursor: Schema.NullOr(Schema.String),
  }),
});
/** Canonical item validation stays with the owner; the public schema does not duplicate its provider union. */
export type TaskReadResult = Omit<typeof TaskReadResult.Type, "items"> & {
  readonly items: readonly Omit<
    HistoryItem<{
      readonly source: "runtime";
      readonly item: AgentTurnItem;
    }>,
    "sourceThreadId" | "senderThreadId"
  >[];
};

const StopWorkflowInput = Schema.Struct({
  taskId: NodeId.annotate({
    description: "taskId of the running workflow item in your own conversation.",
  }),
});

const ListAgentModelsTool = Tool.make("list_agent_models", {
  description:
    "List provider instances and models that delegate_task can run, from the same live catalog as the composer, with each model's selectable options.",
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List Agent models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Start a child task with only the supplied prompt. Use for cross-provider work or models your native subagents cannot run; choose from list_agent_models. Provider, model, options and execution mode inherit unless overridden. Execution cannot exceed yours; a narrower child asks a person for approval. Prefer mode='async' and keep working or end your turn: questions and results arrive mid-turn when supported, otherwise they wake you in a new turn. The wake includes results when they fit; use task_status only when it says to. mode='wait' returns on a result, any task owned by your Run asking a live or message question, this task's approval, or timeoutMs without cancelling. Answer or dismiss delivered questions.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: TaskView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Delegate a task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read a delegated task's status and result. Completion wakes include results when they fit; read here when the wake says to. Reading a settled result acknowledges it.",
  parameters: Schema.Struct({ taskId: TaskIdentity }),
  success: TaskView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskWaitTool = Tool.make("task_wait", {
  description:
    "Wait for a task's result, its approval, any task owned by your Run asking a live or message question, or timeoutMs. Questions include taskId, requestId and inline detail; answer or dismiss each one. The awaited task keeps running and completion delivery stays armed. Use only when this turn needs the result; otherwise end your turn and let completion or a question wake you.",
  parameters: TaskWaitInput,
  success: TaskView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a task")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskSendTool = Tool.make("task_send", {
  description:
    "Send a follow-up to a delegated task's own conversation. A follow-up that starts a turn is carried by a new task (the returned taskId) whose completion wakes you; the addressed task's result stays unchanged, even while it is still running. A message steered into a running turn joins that turn and returns the task that turn belongs to. For an independent round, call delegate_task again with the full context instead.",
  parameters: TaskSendInput,
  success: TaskSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Send to a task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskQuestionTool = Tool.make("task_question", {
  description:
    "Questions from a task you delegated, including finished tasks. list: pending requestIds; read: full questions; respond: answer with answers keyed by question id; dismiss: drop an unneeded message question (live questions need an answer or Stop). Answer or dismiss each delivered question. A late answer starts a follow-up task whose result wakes you; retain the returned taskId. Approvals are excluded.",
  parameters: TaskQuestionInput,
  success: TaskQuestionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Answer a task question")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskReadTool = Tool.make("task_read", {
  description:
    "Read your own conversation, or a delegated task by taskId. Newest first by default; oldest_first supports incremental reads with page.tailCursor. Use itemId and optional textOffset for a point read, or opaque cursors to continue. messages returns canonical text, activity returns complete typed diagnostic JSON or exact JSON fragments. Continue older/newer items with page.nextCursor and long content with content.nextCursor. Reading a complete child result acknowledges its delivery.",
  parameters: TaskReadInput,
  success: TaskReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a task conversation")
  // Strict so a misspelled paging parameter fails instead of reading from the start.
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Stop a delegated task like a user Stop: its running turn is interrupted, queued follow-ups are held and the tasks it delegated stop too. It no longer wakes you. A settled task keeps its result.",
  parameters: TaskCancelInput,
  success: TaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Strict, true)
  .annotate(Tool.Title, "Cancel a task")
  .annotate(Tool.Destructive, true);

const StopWorkflowTool = Tool.make("stop_workflow", {
  description:
    "Stop a running Claude workflow that your own conversation started, including all of its phases and agents. Read task_read activity to find its subagentId and pass it as taskId.",
  parameters: StopWorkflowInput,
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

/** The Runtime's Agent-facing tools; Session tools come from the host. */
export const TaskToolkit = Toolkit.make(
  ListAgentModelsTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskWaitTool,
  TaskSendTool,
  TaskQuestionTool,
  TaskReadTool,
  TaskCancelTool,
  StopWorkflowTool,
);
