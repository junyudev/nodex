import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";

/** Rewind the latest user message through durable provider rollback, leaving files intact. */
export const rollbackThread = Effect.fn("AgentRuntime.rollbackThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly requestId: CommandId;
  readonly runId: RunId;
}) {
  const threads = yield* ThreadManagementService;
  const commandId = CommandId.make(`host:thread.rollback:${input.requestId}`);
  const records = yield* threads.getThreadRecords(input.threadId, ["runs"], {
    runIds: [input.runId],
  });
  const selected = records.runs.find((candidate) => candidate.id === input.runId);
  if (selected === undefined)
    return yield* Effect.fail(new Error("The selected Run is no longer available."));
  const previous = yield* threads.getReceipt(commandId);
  if (Option.isSome(previous)) {
    const receipt = previous.value;
    if (receipt.threadId !== input.threadId)
      return yield* Effect.fail(new Error("Command belongs to another Session."));
    if (receipt.status === "rejected")
      return yield* Effect.fail(new Error(receipt.error ?? "Rewind was rejected."));
    return { commandId, userMessageId: selected.userMessageId, sequence: receipt.resultSequence };
  }
  const context = yield* threads.getCheckpointContext(input.threadId);
  const run = context.runs.find((candidate) => candidate.id === input.runId);
  if (run === undefined)
    return yield* Effect.fail(new Error("The selected Run does not belong to this conversation."));
  const rootScopeIds = new Set(
    context.checkpointScopes.filter((scope) => scope.kind === "root_run").map((scope) => scope.id),
  );
  const discardedRunIds = new Set(
    context.runs
      .filter((previous) => previous.status === "rolled_back")
      .map((previous) => previous.id),
  );
  const checkpoint = context.checkpoints
    .filter(
      (candidate) =>
        (candidate.status === "ready" || candidate.status === "missing") &&
        rootScopeIds.has(candidate.scopeId) &&
        (candidate.appRunOrdinal !== null || candidate.ordinalWithinScope === 0) &&
        (candidate.appRunOrdinal ?? 0) < run.ordinal &&
        (candidate.runId === null || !discardedRunIds.has(candidate.runId)),
    )
    .sort((left, right) => (right.appRunOrdinal ?? 0) - (left.appRunOrdinal ?? 0))[0];
  if (checkpoint === undefined)
    return yield* Effect.fail(
      new Error("This conversation has no checkpoint before the selected Run."),
    );
  const receipt = yield* threads.dispatch({
    type: "checkpoint.rollback",
    commandId,
    threadId: input.threadId,
    beforeRunId: input.runId,
    scopeId: checkpoint.scopeId,
    checkpointId: checkpoint.id,
    restoreFiles: false,
  });
  return { commandId, userMessageId: selected.userMessageId, sequence: receipt.sequence };
});
