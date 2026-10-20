import type { AgentSnapshot } from "@nodex/agent-runtime/contracts";

type Projection = AgentSnapshot["projection"];
type Run = Pick<Projection["runs"][number], "ordinal" | "status">;

/** A Run whose Agent finished can merge back, including one still capturing its checkpoint. */
const MERGEABLE_RUN_STATUSES = new Set(["waiting", "completed"]);
const WORKING_RUN_STATUSES = new Set(["preparing", "starting", "running"]);

/** The Thread a fork came from: the one whose Run it was forked at. */
export function agentRuntimeForkSource(
  thread: Pick<Projection["thread"], "forkedFrom">,
): string | null {
  return thread.forkedFrom?.type === "run" ? thread.forkedFrom.threadId : null;
}

/**
 * The fork's newest finished Run, which is what merges back. A newer Run that is still working
 * holds the merge until it finishes, so the source never receives a partial reply.
 */
export function agentRuntimeMergeableRun<Candidate extends Run>(
  runs: readonly Candidate[],
): Candidate | null {
  const finished = runs.reduce<Candidate | null>(
    (latest, run) =>
      MERGEABLE_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (finished === null) return null;
  return runs.some((run) => run.ordinal > finished.ordinal && WORKING_RUN_STATUSES.has(run.status))
    ? null
    : finished;
}
