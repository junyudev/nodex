import type {
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

type TerminalTaskStatus = "completed" | "failed" | "cancelled" | "interrupted";
export type DelegatedTaskStatus = TerminalTaskStatus | "queued" | "waiting" | "running";

export function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status"> | undefined,
): DelegatedTaskStatus {
  switch (run?.status) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

export function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    // Legacy delegated-task projections predate the durable spawn transfer.
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

export function isTerminalTaskStatus(status: string): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/** A terminal child Run can still owe a result after restart or while its children finish. */
export function delegatedTaskExecutionState(input: {
  readonly task: Pick<OrchestrationV2Subagent, "status" | "result">;
  readonly childRun: OrchestrationV2Run | undefined;
  readonly latestRun: OrchestrationV2Run | undefined;
  readonly resultPending: boolean;
}): {
  readonly status: DelegatedTaskStatus;
  readonly workState: "working" | "waiting_for_children" | "result_available";
} {
  const { task, childRun, latestRun, resultPending } = input;
  const taskWorkState = !isTerminalTaskStatus(taskStatusForRun(latestRun))
    ? "working"
    : resultPending
      ? "waiting_for_children"
      : "result_available";
  const workState = task.result !== null ? "result_available" : taskWorkState;
  const runStatus = taskStatusForRun(latestRun ?? childRun);
  const status =
    task.result !== null
      ? taskStatusForRun(isTerminalTaskStatus(task.status) ? { status: task.status } : childRun)
      : workState === "result_available"
        ? runStatus
        : runStatus === "queued"
          ? "queued"
          : "running";
  return { status, workState };
}
