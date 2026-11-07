import { isRunVisibleAtHistoryRevision } from "./orchestrationV2Timeline.ts";
import type { OrchestrationV2Run, OrchestrationV2ThreadProjection } from "@nodex/runtime-contracts";

export const MESSAGE_EDIT_UNAVAILABLE =
  "This message can't be edited because the conversation point before it wasn't recorded.";

/** Body-free conversation membership and native-turn evidence, independent of the history window. */
export interface ConversationRewindContext {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly status: OrchestrationV2Run["status"];
    readonly started: boolean;
    /** Present on bounded projections; null proves this is the first local conversation Run. */
    readonly previousRunId?: string | null;
    readonly activeAttemptId: string | null;
    readonly hasProviderTurn: boolean;
  }>;
  readonly checkpointScopes: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
  readonly checkpoints: ReadonlyArray<{
    readonly id: string;
    readonly scopeId: string;
    readonly runId: string | null;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly status: string;
  }>;
}

export interface ConversationRewindTarget {
  readonly scopeId: string;
  /** Null only for an unmaterialized thread-start anchor. */
  readonly checkpointId: string | null;
  readonly appRunOrdinal: number;
}

export function conversationRewindContext(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerTurns" | "checkpoints" | "checkpointScopes"
  >,
) {
  const turnAttempts = new Set(projection.providerTurns.map((turn) => turn.runAttemptId));
  const turnIds = new Set(projection.providerTurns.map((turn) => turn.id));
  const attemptsWithTurns = new Set(
    projection.attempts
      .filter((attempt) => attempt.providerTurnId !== null && turnIds.has(attempt.providerTurnId))
      .map((attempt) => attempt.id),
  );
  return {
    runs: projection.runs
      .filter((run) => run.threadId === projection.thread.id)
      .map((run) => ({
        id: run.id,
        ordinal: run.ordinal,
        status: run.status,
        started: run.startedAt !== null,
        activeAttemptId: run.activeAttemptId,
        hasProviderTurn:
          run.activeAttemptId !== null &&
          (turnAttempts.has(run.activeAttemptId) || attemptsWithTurns.has(run.activeAttemptId)),
      })),
    checkpointScopes: projection.checkpointScopes
      .filter((scope) => scope.threadId === projection.thread.id)
      .map(({ id, kind }) => ({ id, kind })),
    checkpoints: projection.checkpoints
      .filter((checkpoint) => checkpoint.threadId === projection.thread.id)
      .map(({ id, scopeId, runId, ordinalWithinScope, appRunOrdinal, status }) => ({
        id,
        scopeId,
        runId,
        ordinalWithinScope,
        appRunOrdinal,
        status,
      })),
  };
}

/** Queue reservations cancelled before execution never entered the conversation. */
export function isConversationRewindRun(run: ConversationRewindContext["runs"][number]): boolean {
  return (
    isRunVisibleAtHistoryRevision(run) &&
    run.status !== "queued" &&
    run.status !== "preparing" &&
    !(run.status === "cancelled" && !run.started && !run.hasProviderTurn)
  );
}

/** Only the immediately preceding visible local Run can authorize an edit; never skip a gap. */
export function resolveConversationRewindTargets(
  context: ConversationRewindContext,
): ReadonlyMap<string, ConversationRewindTarget> {
  const targets = new Map<string, ConversationRewindTarget>();
  const scope = context.checkpointScopes.find((candidate) => candidate.kind === "root_run");
  if (!scope) return targets;
  const anchors = context.checkpoints.filter(
    (checkpoint) =>
      checkpoint.scopeId === scope.id &&
      (checkpoint.status === "ready" || checkpoint.status === "missing"),
  );
  const anchorsByRun = new Map(anchors.map((checkpoint) => [checkpoint.runId, checkpoint]));
  const start = anchors.find(
    (checkpoint) =>
      checkpoint.runId === null &&
      checkpoint.appRunOrdinal === null &&
      checkpoint.ordinalWithinScope === 0,
  );
  // A recorded but unusable baseline must not be replaced with a synthetic usable one.
  const hasStart = context.checkpoints.some(
    (checkpoint) => checkpoint.scopeId === scope.id && checkpoint.ordinalWithinScope === 0,
  );
  const visible = context.runs
    .filter(isConversationRewindRun)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const byId = new Map(visible.map((run) => [run.id, run]));
  let previousInWindow: (typeof visible)[number] | undefined;
  for (const run of visible) {
    const previous =
      run.previousRunId === undefined
        ? previousInWindow
        : run.previousRunId === null
          ? undefined
          : byId.get(run.previousRunId);
    if (previous === undefined && run.previousRunId != null) {
      previousInWindow = run;
      continue;
    }
    if (previous === undefined) {
      if (start || !hasStart)
        targets.set(run.id, {
          scopeId: scope.id,
          checkpointId: start?.id ?? null,
          appRunOrdinal: 0,
        });
    } else {
      const anchor = anchorsByRun.get(previous.id);
      if (previous.hasProviderTurn && anchor?.appRunOrdinal === previous.ordinal)
        targets.set(run.id, {
          scopeId: scope.id,
          checkpointId: anchor.id,
          appRunOrdinal: previous.ordinal,
        });
    }
    previousInWindow = run;
  }
  return targets;
}

export function isExactConversationRewindTarget(
  target: ConversationRewindTarget | undefined,
  checkpoint: ConversationRewindContext["checkpoints"][number],
): boolean {
  if (!target || target.scopeId !== checkpoint.scopeId) return false;
  if (target.checkpointId !== null) return target.checkpointId === checkpoint.id;
  return (
    checkpoint.runId === null &&
    checkpoint.appRunOrdinal === null &&
    checkpoint.ordinalWithinScope === 0
  );
}

/** Keep selected Runs and their exact predecessors, without loading transcript or checkpoint files. */
export function boundConversationRewindContext(
  context: ConversationRewindContext,
  runIds: ReadonlySet<string>,
): ConversationRewindContext {
  let previousRunId: string | null = null;
  const ordered = context.runs
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map((run) => {
      const entry = { ...run, previousRunId };
      if (isConversationRewindRun(run)) previousRunId = run.id;
      return entry;
    });
  const retained = new Set(runIds);
  for (const run of ordered) {
    if (runIds.has(run.id) && run.previousRunId !== null) retained.add(run.previousRunId);
  }
  return {
    runs: ordered.filter((run) => retained.has(run.id)),
    checkpointScopes: context.checkpointScopes.filter((scope) => scope.kind === "root_run"),
    checkpoints: context.checkpoints.filter(
      (checkpoint) =>
        (checkpoint.runId !== null && retained.has(checkpoint.runId)) ||
        (checkpoint.runId === null && checkpoint.ordinalWithinScope === 0),
    ),
  };
}
