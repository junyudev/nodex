import {
  NodeId,
  NonNegativeInt,
  OrchestrationV2Actor,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
  OrchestratorMcpCapabilitiesResult,
  OrchestratorMcpDelegatedTaskStatus,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpFailure,
  OrchestratorMcpTerminalDelegatedTaskStatus,
  PositiveInt,
  ProviderInstanceId,
  ProviderInteractionMode,
  RunId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";

/**
 * Agent-facing task contracts. A delegated child is addressed only by its
 * taskId; the conversation that backs it is never exposed. Product Sessions
 * belong to the host's Session tools.
 */
const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];

const TaskIdentity = NodeId.annotate({ description: "taskId returned by delegate_task." });
const ClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
  description: "Stable idempotency key to reuse when retrying this mutation.",
});

const TaskResult = Schema.Struct({
  status: OrchestratorMcpTerminalDelegatedTaskStatus,
  summary: Schema.NullOr(Schema.String),
});

export const TaskView = Schema.Struct({
  taskId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]).annotate({
    description:
      "result_available only when the task and every task it delegated have settled; a finished turn with live nested work is waiting_for_children.",
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

const TaskCancelInput = Schema.Struct({
  taskId: TaskIdentity,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(ClientRequestId),
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
  clientRequestId: Schema.optional(ClientRequestId),
});
export const TaskSendResult = Schema.Struct({
  taskId: NodeId.annotate({
    description:
      "The task that carries this message's result: a new taskId when the original task had already finished.",
  }),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type TaskSendResult = typeof TaskSendResult.Type;

const TaskReadInput = Schema.Struct({
  taskId: Schema.optional(TaskIdentity).annotate({
    description: "Omit to read your own conversation.",
  }),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  maxCharsPerItem: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
});
export type TaskReadInput = typeof TaskReadInput.Type;

export const TaskConversationItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  itemId: TurnItemId,
  runId: Schema.NullOr(RunId),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  taskId: Schema.optional(NodeId).annotate({
    description: "The delegated task or native workflow this item reports.",
  }),
  updatedAt: Schema.String,
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
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type TaskReadResult = typeof TaskReadResult.Type;

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
    "Start a delegated child task that runs only the supplied prompt, without the parent conversation. Use it for cross-provider work or models your native subagents cannot run; choose models from list_agent_models. Provider, model and options inherit unless target overrides them. Use a distinct clientRequestId per task, stable across retries. Prefer mode='async': the task's completion wakes you, so end your turn instead of polling. mode='wait' blocks up to timeoutMs and never cancels the task.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: TaskView,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read a delegated task's status and result. Reading a settled result acknowledges it, so it does not wake you again.",
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
    "Wait until a delegated task settles or timeoutMs elapses, then return its status. Use only when this turn needs the result; otherwise end your turn and let completion wake you.",
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
    "Send a follow-up to a delegated task's own conversation. After the task finished, the follow-up becomes a new task whose completion wakes you; the original result stays unchanged. For an independent round, call delegate_task again with the full context instead.",
  parameters: TaskSendInput,
  success: TaskSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskReadTool = Tool.make("task_read", {
  description:
    "Read a paginated conversation: a delegated task's by taskId, or your own when taskId is omitted (for example after a context handoff). view='messages' returns messages and plans; 'activity' returns every item. Continue with afterPosition=nextPosition; recover long text with itemId and textOffset=nextTextOffset until it is null. Reading a task's settled result acknowledges it.",
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
  .annotate(Tool.Title, "Cancel a task")
  .annotate(Tool.Destructive, true);

const StopWorkflowTool = Tool.make("stop_workflow", {
  description:
    "Stop a running Claude workflow that your own conversation started, including all of its phases and agents. Find its taskId with task_read view='activity'.",
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
  TaskReadTool,
  TaskCancelTool,
  StopWorkflowTool,
);
