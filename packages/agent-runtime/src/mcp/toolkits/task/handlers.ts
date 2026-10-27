import type { OrchestratorMcpDelegateTaskResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import { TaskToolkit, type TaskView } from "./tools.ts";

/** Task routing uses task identity; source locators stay inside opaque history cursors. */
export const taskView = (task: OrchestratorMcpDelegateTaskResult): TaskView => ({
  taskId: task.taskId,
  status: task.status,
  workState: task.workState,
  providerInstanceId: task.providerInstanceId,
  model: task.model,
  summary: task.summary,
  latestResult:
    task.latestTerminalStatus === null
      ? null
      : { status: task.latestTerminalStatus, summary: task.latestTerminalSummary },
  hasPendingFollowUps: task.hasPendingChildRuns,
  waitTimedOut: task.waitTimedOut,
});

const service = Effect.all({
  scope: McpInvocationContext.McpInvocationContext,
  tasks: OrchestratorMcpService.OrchestratorMcpService,
});

const handlers = {
  list_agent_models: McpToolAccess.reads(() =>
    Effect.flatMap(service, ({ scope, tasks }) => tasks.capabilities(scope)),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      tasks.delegateTask(scope, input).pipe(Effect.map(taskView)),
    ),
  ),
  // Reading a settled result acknowledges its automatic delivery, so status is a write.
  task_status: McpToolAccess.writes(({ taskId }) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      tasks.taskStatus(scope, taskId).pipe(Effect.map(taskView)),
    ),
  ),
  task_wait: McpToolAccess.writes((input) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      tasks.waitTask(scope, input).pipe(Effect.map(taskView)),
    ),
  ),
  task_send: McpToolAccess.writes(({ taskId, ...message }) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      Effect.gen(function* () {
        const threadId = yield* tasks.taskThread(scope, taskId);
        const sent = yield* tasks.sendToThread(scope, { threadId, ...message });
        return { taskId: sent.taskId ?? taskId, status: sent.status, delivery: sent.delivery };
      }),
    ),
  ),
  // Acknowledging a child's result is bookkeeping on the caller's own task, so a read stays a read.
  task_read: McpToolAccess.reads(({ taskId, ...page }) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      Effect.gen(function* () {
        const threadId =
          taskId === undefined
            ? (yield* McpInvocationContext.requireThreadScope(scope, "task_read")).thread.threadId
            : yield* tasks.taskThread(scope, taskId);
        return yield* tasks.readThread(scope, {
          threadId,
          ...(taskId === undefined ? {} : { taskId }),
          ...page,
        });
      }),
    ),
  ),
  task_cancel: McpToolAccess.writes((input) =>
    Effect.flatMap(service, ({ scope, tasks }) => tasks.cancelTask(scope, input)),
  ),
  stop_workflow: McpToolAccess.writes(({ taskId }) =>
    Effect.flatMap(service, ({ scope, tasks }) =>
      tasks.stopWorkflow(scope, taskId).pipe(Effect.as({})),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof TaskToolkit.tools>;

export const layer = McpToolAccess.toLayer(TaskToolkit, handlers);
