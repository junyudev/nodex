import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";
import { latestNativeContextUsage } from "@nodex/agent-runtime/context-usage";
import type { CodexConversationSnapshot } from "../../../shared/types";

type Projection = AgentSnapshot["projection"];

export function agentRuntimeContextReport(projection: Projection) {
  const provider = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (!provider || provider.status === "closed") return undefined;
  return latestNativeContextUsage(projection, provider);
}

/** Current native occupancy, never billed totals or a child Agent's usage. */
export function projectAgentRuntimeContextUsage(
  projection: Projection,
): CodexConversationSnapshot["contextUsage"] {
  const provider = projection.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (!provider || provider.status === "closed") return null;
  const report = agentRuntimeContextReport(projection);
  // The next Run can change the model/window without another measurement yet.
  // Its provider-thread observation already carries the adapted window.
  const run = projection.runs.find((candidate) => candidate.id === report?.runId);
  const hasLaterRun =
    run &&
    projection.runs.some(
      (candidate) =>
        candidate.providerThreadId === provider.id &&
        candidate.startedAt !== null &&
        candidate.ordinal > run.ordinal &&
        candidate.status !== "rolled_back",
    );
  const usage = hasLaterRun ? provider.contextUsage : (report?.usage ?? provider.contextUsage);
  if (!usage) return null;
  return { used: usage.usedTokens, size: usage.maxTokens ?? 0, cost: provider.contextUsage?.cost };
}

/** Keep one measured head plus current root execution metadata, independent of transcript bodies. */
export function retainAgentRuntimeContextMetadata(projection: Projection): Projection {
  const report = agentRuntimeContextReport(projection);
  const runIds = new Set(projection.runs.map((run) => run.id));
  const attemptsByRun = new Map<string, Projection["attempts"][number]>();
  for (const attempt of projection.attempts) {
    if (!runIds.has(attempt.runId)) continue;
    const previous = attemptsByRun.get(attempt.runId);
    if (!previous || previous.attemptOrdinal <= attempt.attemptOrdinal)
      attemptsByRun.set(attempt.runId, attempt);
  }
  const attemptIds = new Set([...attemptsByRun.values()].map((attempt) => attempt.id));
  if (report) attemptIds.add(report.attemptId);
  const attempts = projection.attempts.filter((attempt) => attemptIds.has(attempt.id));
  const rootRuns = new Map(
    projection.runs.flatMap((run) => (run.rootNodeId ? [[run.rootNodeId, run] as const] : [])),
  );
  const turnsByAttempt = new Map<string, Projection["providerTurns"][number]>();
  for (const turn of projection.providerTurns) {
    const run = rootRuns.get(turn.nodeId);
    if (!run || run.activeAttemptId !== turn.runAttemptId) continue;
    const previous = turnsByAttempt.get(turn.nodeId);
    if (!previous || previous.ordinal <= turn.ordinal) turnsByAttempt.set(turn.nodeId, turn);
  }
  const turnIds = new Set([...turnsByAttempt.values()].map((turn) => turn.id));
  if (report) turnIds.add(report.providerTurnId);
  return {
    ...projection,
    attempts,
    providerTurns: projection.providerTurns.filter((turn) => turnIds.has(turn.id)),
  };
}
