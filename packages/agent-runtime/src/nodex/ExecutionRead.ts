import { createHash } from "node:crypto";
import { ThreadId, type RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { readOnly } from "@t3tools/shared/nodeSqliteClient";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import type { AgentThreadExecution } from "./Interface.ts";

export class ExecutionReadError extends Schema.TaggedError<ExecutionReadError>()(
  "ExecutionReadError",
  {
    reason: Schema.Literals(["thread_unavailable", "run_unavailable", "history_unavailable"]),
    cause: Schema.Defect(),
  },
) {}

export const terminal = (status: string | null) =>
  status === null ||
  ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(status);

/** Indexed point reads return one selected Run, its continuation tip and compact progress metadata. */
export const readExecution = Effect.fn("Runtime.readExecution")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId?: string | null | undefined;
  readonly messageId?: string | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const read = sql.withTransaction(
    Effect.gen(function* () {
      const thread = yield* sql<{
        thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE thread_id = ${input.threadId} AND deleted_at IS NULL LIMIT 1`;
      if (!thread[0])
        return yield* new ExecutionReadError({ reason: "thread_unavailable", cause: null });
      if (input.messageId !== undefined && input.runId !== undefined)
        return yield* new ExecutionReadError({
          reason: "run_unavailable",
          cause: "Choose either Run or message identity",
        });
      const selected =
        input.runId === null
          ? []
          : yield* sql<{ run_id: string }>`
      SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${input.threadId}
        AND ${
          input.messageId !== undefined
            ? sql`run_id = (SELECT run_id FROM orchestration_v2_projection_messages
          WHERE thread_id = ${input.threadId} AND message_id = ${input.messageId} AND role = 'user')`
            : input.runId === undefined
              ? sql`1 = 1`
              : sql`run_id = ${input.runId}`
        }
      ORDER BY ordinal DESC LIMIT 1`;
      const selectedRunId = selected[0]?.run_id ?? null;
      if ((input.runId || input.messageId) && selectedRunId === null)
        return yield* new ExecutionReadError({ reason: "run_unavailable", cause: input.runId });
      if (selectedRunId === null)
        return {
          selectedRunId: null,
          runId: null,
          status: null,
          continuationPending: false,
          activeFlags: [],
          revision: "empty",
        } satisfies AgentThreadExecution;
      // Ordinals strictly increase through a continuation chain. This also prevents malformed
      // cyclic data from recursing, without loading unrelated Runs or imposing a history cap.
      const rows = yield* sql<{
        run_id: string;
        status: OrchestrationV2Run["status"];
        payload: string;
      }>`
      WITH RECURSIVE chain(run_id, ordinal, status, payload_json) AS (
        SELECT run_id, ordinal, status, payload_json FROM orchestration_v2_projection_runs
        WHERE thread_id = ${input.threadId} AND run_id = ${selectedRunId}
        UNION ALL
        SELECT next.run_id, next.ordinal, next.status, next.payload_json
        FROM chain JOIN orchestration_v2_projection_runs next
          ON next.thread_id = ${input.threadId}
          AND json_extract(next.payload_json, '$.restartContinuationOfRunId') = chain.run_id
          AND next.ordinal > chain.ordinal
        WHERE next.run_id = (SELECT child.run_id FROM orchestration_v2_projection_runs child
          WHERE child.thread_id = ${input.threadId}
            AND json_extract(child.payload_json, '$.restartContinuationOfRunId') = chain.run_id
            AND child.ordinal > chain.ordinal ORDER BY child.ordinal DESC LIMIT 1)
      ) SELECT run_id, status, json_object('requestedAt',json_extract(payload_json,'$.requestedAt'),
          'completedAt',json_extract(payload_json,'$.completedAt')) AS payload
        FROM chain ORDER BY ordinal DESC LIMIT 1`;
      const run = rows[0]!;
      const pending = terminal(run.status)
        ? yield* sql<{ status: string }>`
      SELECT status FROM orchestration_v2_effect_outbox
      WHERE effect_id = ${`effect:restart-continuation:${run.run_id}`} AND status IN ('pending','running') LIMIT 1`
        : [];
      const requests = yield* sql<{ kind: string; id: string }>`
      SELECT request.kind, request.runtime_request_id AS id
      FROM orchestration_v2_projection_runtime_requests request
      JOIN orchestration_v2_projection_nodes node ON node.node_id = request.node_id
      WHERE request.thread_id = ${input.threadId} AND node.run_id = ${run.run_id}
        AND request.status = 'pending' AND request.kind NOT IN ('dynamic_tool_call','auth_refresh')
        ORDER BY request.created_at DESC LIMIT 1`;
      const items = yield* sql<{
        turn_item_id: string;
        type: string;
        status: string;
        updated_at: string;
      }>`
      SELECT turn_item_id,type,status,updated_at FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId} AND run_id = ${run.run_id}
      ORDER BY ordinal DESC LIMIT 1`;
      const secrets = yield* sql<{ turn_item_id: string }>`
      SELECT turn_item_id FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${input.threadId} AND run_id = ${run.run_id}
        AND type = 'secret_request' AND status = 'waiting' LIMIT 1`;
      const activeFlags = requests[0] ? [requests[0].kind] : secrets[0] ? ["user_input"] : [];
      return {
        selectedRunId,
        runId: run.run_id,
        status: run.status,
        continuationPending: pending.length > 0,
        activeFlags,
        revision: createHash("sha256")
          .update(JSON.stringify({ run, pending, requests, items, secrets }))
          .digest("base64url"),
      } satisfies AgentThreadExecution;
    }),
  );
  return yield* readOnly(read).pipe(
    Effect.mapError((cause) =>
      cause instanceof ExecutionReadError
        ? cause
        : new ExecutionReadError({ reason: "history_unavailable", cause }),
    ),
  );
});

/** Replay begins before the read; effect settlement covers declined continuations with no domain event. */
export const waitExecution = Effect.fn("Runtime.waitExecution")(function* (input: {
  readonly threadId: ThreadId;
  readonly runId: string | null;
  readonly afterRevision: string;
  readonly timeoutMs: number;
}) {
  const orchestrator = yield* OrchestratorV2;
  const outbox = yield* EffectOutboxV2;
  const deadline = (yield* Clock.currentTimeMillis) + input.timeoutMs;
  for (;;) {
    const afterSequence = yield* orchestrator.getThreadEventSequence(input.threadId);
    const current = yield* readExecution(input);
    if (current.revision !== input.afterRevision) return current;
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    if (remaining <= 0) return current;
    const events = orchestrator.streamStoredEventsFrom({ threadId: input.threadId, afterSequence });
    const settlement =
      current.continuationPending && current.runId
        ? outbox.awaitSettled(`effect:restart-continuation:${current.runId}`)
        : Effect.never;
    const wake = Effect.raceFirst(Stream.runHead(events).pipe(Effect.asVoid), settlement);
    const result = yield* wake.pipe(Effect.timeoutOption(remaining));
    // Always re-read at the deadline, including a completion that raced the clock.
    if (Option.isNone(result)) return yield* readExecution(input);
  }
});

export const readExecutionItemIds = Effect.fn("Runtime.readExecutionItemIds")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* readOnly(
    sql.withTransaction(
      Effect.gen(function* () {
        const reply = yield* sql<{
          turn_item_id: string;
        }>`SELECT turn_item_id FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND run_id = ${runId} AND type = 'assistant_message' ORDER BY ordinal DESC LIMIT 1`;
        const activity = yield* sql<{
          turn_item_id: string;
          type: string;
          status: string;
          updated_at: string;
        }>`
      SELECT turn_item_id,type,status,updated_at FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND run_id = ${runId} AND type NOT IN ('user_message','assistant_message','reasoning')
      ORDER BY ordinal DESC LIMIT 1`;
        return { replyId: reply[0]?.turn_item_id ?? null, activity: activity[0] ?? null };
      }),
    ),
  );
});
