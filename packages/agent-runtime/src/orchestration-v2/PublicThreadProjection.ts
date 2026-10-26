import { latestNativeContextUsage } from "@t3tools/provider-core/contextUsage";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** A transcript window is not an index of every entity ever owned by its Runs. */
export function retainPublicThreadControlClosure(
  projection: OrchestrationV2ThreadProjection,
  requiredRunId?: string,
): OrchestrationV2ThreadProjection {
  const activeProvider = projection.providerThreads.find(
    (provider) =>
      provider.id === projection.thread.activeProviderThreadId && provider.status !== "closed",
  );
  const context = activeProvider ? latestNativeContextUsage(projection, activeProvider) : undefined;
  const items = projection.visibleTurnItems.map((row) => row.item);
  const runIds = new Set<string>(
    items.flatMap((item) => (item.runId === null ? [] : [item.runId])),
  );
  if (context) runIds.add(context.runId);
  const requiredRun = projection.runs.find((run) => run.id === requiredRunId);
  if (requiredRun) runIds.add(requiredRun.id);
  const foreground =
    projection.runs.findLast((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    ) ?? projection.runs.findLast((run) => run.status === "queued");
  if (foreground) runIds.add(foreground.id);
  if (items.length === 0 && projection.runs.at(-1)) runIds.add(projection.runs.at(-1)!.id);
  const runs = projection.runs.filter((run) => runIds.has(run.id));
  const taskIds = new Set(
    items.flatMap((item) => (item.type === "subagent" ? [item.subagentId] : [])),
  );
  const activeTasks = projection.subagents
    .filter((task) => !["completed", "failed", "cancelled", "interrupted"].includes(task.status))
    .slice(-4);
  for (const task of activeTasks) taskIds.add(task.id);
  const subagents = projection.subagents.filter((task) => taskIds.has(task.id));
  const requestIds = new Set(
    items.flatMap((item) =>
      item.type === "approval_request" || item.type === "user_input_request"
        ? [item.requestId]
        : [],
    ),
  );
  for (const request of projection.runtimeRequests
    .filter((request) => request.status === "pending")
    .slice(-32))
    requestIds.add(request.id);
  const runtimeRequests = projection.runtimeRequests.filter((request) =>
    requestIds.has(request.id),
  );
  const nodeIds = new Set(items.flatMap((item) => (item.nodeId === null ? [] : [item.nodeId])));
  for (const node of projection.nodes
    .filter((node) => ["pending", "running", "waiting"].includes(node.status))
    .slice(0, 4))
    nodeIds.add(node.id);
  for (const run of runs) if (run.rootNodeId) nodeIds.add(run.rootNodeId);
  for (const task of subagents) nodeIds.add(task.parentNodeId);
  for (const request of runtimeRequests) if (request.nodeId) nodeIds.add(request.nodeId);
  const byNode = new Map(projection.nodes.map((node) => [node.id, node]));
  for (const id of nodeIds) {
    const parent = byNode.get(id)?.parentNodeId;
    if (parent) nodeIds.add(parent);
  }
  const nodes = projection.nodes.filter((node) => nodeIds.has(node.id));
  const attemptIds = new Set(
    runs.flatMap((run) => (run.activeAttemptId === null ? [] : [run.activeAttemptId])),
  );
  const itemNodeIds = new Set(items.flatMap((item) => (item.nodeId === null ? [] : [item.nodeId])));
  const attempts = projection.attempts.filter(
    (attempt) =>
      attempt.id === context?.attemptId ||
      attemptIds.has(attempt.id) ||
      itemNodeIds.has(attempt.rootNodeId),
  );
  const providerThreadIds = new Set(
    items.flatMap((item) =>
      item.providerThreadId === null || item.providerThreadId === undefined
        ? []
        : [item.providerThreadId],
    ),
  );
  if (projection.thread.activeProviderThreadId)
    providerThreadIds.add(projection.thread.activeProviderThreadId);
  for (const run of runs) if (run.providerThreadId) providerThreadIds.add(run.providerThreadId);
  for (const task of subagents)
    if (task.providerThreadId) providerThreadIds.add(task.providerThreadId);
  const providerThreads = projection.providerThreads.filter((thread) =>
    providerThreadIds.has(thread.id),
  );
  const sessionIds = new Set(
    providerThreads.flatMap((thread) =>
      thread.providerSessionId === null ? [] : [thread.providerSessionId],
    ),
  );
  const providerSessions = projection.providerSessions.filter((session) =>
    sessionIds.has(session.id),
  );
  const turnIds = new Set(
    items.flatMap((item) => (item.providerTurnId === null ? [] : [item.providerTurnId])),
  );
  for (const attempt of attempts) if (attempt.providerTurnId) turnIds.add(attempt.providerTurnId);
  for (const request of runtimeRequests)
    if (request.providerTurnId) turnIds.add(request.providerTurnId);
  const providerTurns = projection.providerTurns.filter(
    (turn) =>
      turn.id === context?.providerTurnId ||
      turnIds.has(turn.id) ||
      (turn.nodeId === foreground?.rootNodeId && ["running", "waiting"].includes(turn.status)),
  );
  const checkpointIds = new Set(
    items.flatMap((item) => (item.type === "checkpoint" ? [item.checkpointId] : [])),
  );
  for (const run of runs) if (run.checkpointId) checkpointIds.add(run.checkpointId);
  for (const checkpoint of projection.checkpoints
    .filter((checkpoint) => ["pending", "capturing"].includes(checkpoint.status))
    .slice(-4))
    checkpointIds.add(checkpoint.id);
  const checkpoints = projection.checkpoints.filter((checkpoint) =>
    checkpointIds.has(checkpoint.id),
  );
  const scopeIds = new Set(checkpoints.map((checkpoint) => checkpoint.scopeId));
  const checkpointScopes = projection.checkpointScopes.filter((scope) => scopeIds.has(scope.id));
  return {
    ...projection,
    runs,
    attempts,
    nodes,
    subagents,
    runtimeRequests,
    providerThreads,
    providerSessions,
    providerTurns,
    checkpoints,
    checkpointScopes,
    contextTransfers: [],
  };
}
