import {
  CommandId,
  EventId,
  OrchestrationV2AppThread,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import { EventSinkV2, type EventSinkV2Error } from "../orchestration-v2/EventSink.ts";
import { withoutRunRecovery } from "../orchestration-v2/RunRecovery.ts";

export const IMPORT_CANCELLATION_REASON =
  "Cancelled because this conversation was copied from another Profile.";
const activeWork = "status IN ('pending', 'running', 'waiting')";
const activeRuns = "status IN ('queued', 'preparing', 'starting', 'running', 'waiting')";
type WithoutIdentity<Event> = Event extends { readonly payload: { readonly id: string } }
  ? Omit<Event, "id" | "occurredAt">
  : never;

/** Read only unsettled projection rows, in bounded batches; never hydrate historical events. */
const forEachCopied = Effect.fnUntraced(function* <A>(
  table: string,
  where: string,
  schema: Schema.Codec<A, string>,
  visit: (value: A, threadId: ThreadId) => Effect.Effect<void, EventSinkV2Error | SqlError>,
) {
  const sql = yield* SqlClient.SqlClient;
  let after = 0;
  while (true) {
    const rows = yield* sql.unsafe<{
      row_id: number;
      thread_id: string;
      payload_json: string;
    }>(
      `SELECT rowid AS row_id, thread_id, payload_json FROM ${table}
       WHERE rowid > ? AND (${where}) ORDER BY rowid LIMIT 200`,
      [after],
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      yield* visit(
        yield* Schema.decodeUnknownEffect(schema)(row.payload_json),
        ThreadId.make(row.thread_id),
      );
      after = row.row_id;
    }
  }
});

/**
 * Import is process loss without continuation: ordinary cancellation events close every
 * copied execution, including terminal work that still owes a wake. The caller owns the
 * import transaction and receipt, and no workers may be admitted until it commits.
 */
export const settle = Effect.fn("ImportedExecutionSettlement.settle")(function* (
  importKey: string,
  now: DateTime.Utc,
) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSinkV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  // Reconciliation events must not trigger the live terminal-run queue/delivery reactor.
  const commandId = CommandId.make(`command:runtime-reconcile:import:${importKey}`);
  const emit = (event: WithoutIdentity<OrchestrationV2DomainEvent>) =>
    sink
      .write({
        commandId,
        events: [
          {
            ...event,
            id: EventId.make(`execution-import:${importKey}:${event.type}:${event.payload.id}`),
            occurredAt: now,
          } as OrchestrationV2DomainEvent,
        ],
      })
      .pipe(Effect.asVoid);

  // Cancel every copied effect, including cleanup/metadata effects without a Run. Import
  // must never operate on the source's native processes or external working directories.
  const effects = yield* sql<{ thread_id: string; effect_type: string }>`
    SELECT DISTINCT thread_id, effect_type FROM orchestration_v2_effect_outbox
    WHERE status IN ('pending', 'running')`;
  const typesByThread = new Map<string, Array<EffectOutbox.OrchestrationEffectRequestV2["type"]>>();
  for (const effect of effects) {
    const types = typesByThread.get(effect.thread_id) ?? [];
    types.push(effect.effect_type as EffectOutbox.OrchestrationEffectRequestV2["type"]);
    typesByThread.set(effect.thread_id, types);
  }
  for (const [threadId, effectTypes] of typesByThread)
    yield* outbox.cancelUnsettled({
      threadId: ThreadId.make(threadId),
      effectTypes,
      reason: IMPORT_CANCELLATION_REASON,
    });

  yield* forEachCopied(
    "orchestration_v2_projection_subagents",
    `${activeWork} OR (origin = 'app_owned' AND COALESCE(json_extract(payload_json, '$.completionDelivery.state'), 'pending') IN ('pending', 'claimed'))`,
    Schema.toCodecJson(OrchestrationV2Subagent).pipe(Schema.fromJsonString),
    (task, threadId) => {
      const active = ["idle", "pending", "running", "waiting"].includes(task.status);
      return emit({
        type: "subagent.updated",
        threadId,
        payload: {
          ...task,
          ...(active
            ? {
                status: "cancelled",
                result: task.result ?? IMPORT_CANCELLATION_REASON,
                completedAt: now,
              }
            : {}),
          ...(task.origin === "app_owned"
            ? { completionDelivery: { state: "disposed", observedByRunId: null } }
            : {}),
          recovery: null,
          ...(task.workflow === undefined
            ? {}
            : {
                workflow: {
                  ...task.workflow,
                  agents: task.workflow.agents.map((agent) =>
                    agent.state === "queued" || agent.state === "running"
                      ? {
                          ...agent,
                          state: "failed" as const,
                          result: agent.result ?? IMPORT_CANCELLATION_REASON,
                        }
                      : agent,
                  ),
                },
              }),
          updatedAt: now,
        },
      });
    },
  );
  yield* forEachCopied(
    "orchestration_v2_projection_runs",
    `${activeRuns}
      OR json_type(payload_json, '$.recovery') = 'object'
      OR json_extract(payload_json, '$.contextRecovery.phase') IN ('compact', 'retry')
      OR json_extract(payload_json, '$.delegatedCompletion.disposition') = 'open'`,
    Schema.toCodecJson(OrchestrationV2Run).pipe(Schema.fromJsonString),
    Effect.fnUntraced(function* (run, threadId) {
      const active = ["queued", "preparing", "starting", "running", "waiting"].includes(run.status);
      yield* emit({
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId: run.providerInstanceId,
        payload: {
          ...withoutRunRecovery(run),
          ...(active ? { status: "cancelled", queuePosition: null, completedAt: now } : {}),
          ...(run.contextRecovery === undefined
            ? {}
            : { contextRecovery: { ...run.contextRecovery, phase: "complete" } }),
          ...(run.delegatedCompletion === undefined
            ? {}
            : {
                delegatedCompletion: {
                  ...run.delegatedCompletion,
                  disposition: "disposed",
                  delivery: null,
                },
              }),
        },
      });
      if (!active) return;
      const ordinals = yield* sql<{ ordinal: number }>`
        SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`;
      yield* emit({
        type: "turn-item.updated",
        threadId,
        runId: run.id,
        payload: {
          id: TurnItemId.make(`execution-import:${importKey}:cancelled:${run.id}`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinals[0]!.ordinal,
          type: "run_interrupt_request",
          status: "completed",
          title: "Copied reply cancelled",
          message: IMPORT_CANCELLATION_REASON,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_run_attempts",
    "status IN ('pending', 'running')",
    Schema.toCodecJson(OrchestrationV2RunAttempt).pipe(Schema.fromJsonString),
    (attempt, threadId) =>
      emit({
        type: "run-attempt.updated",
        threadId,
        runId: attempt.runId,
        payload: { ...attempt, status: "cancelled", completedAt: now },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_nodes",
    activeWork,
    Schema.toCodecJson(OrchestrationV2ExecutionNode).pipe(Schema.fromJsonString),
    (node, threadId) =>
      emit({
        type: "node.updated",
        threadId,
        payload: { ...node, status: "cancelled", completedAt: now },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_provider_turns",
    "status IN ('pending', 'running')",
    Schema.toCodecJson(OrchestrationV2ProviderTurn).pipe(Schema.fromJsonString),
    (turn, threadId) =>
      emit({
        type: "provider-turn.updated",
        threadId,
        payload: { ...turn, status: "cancelled", completedAt: now },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_runtime_requests",
    "status = 'pending'",
    Schema.toCodecJson(OrchestrationV2RuntimeRequest).pipe(Schema.fromJsonString),
    (request, threadId) =>
      emit({
        type: "runtime-request.updated",
        threadId,
        payload: {
          ...request,
          status: "cancelled",
          responseCapability: { type: "not_resumable", reason: IMPORT_CANCELLATION_REASON },
          resolvedAt: now,
        },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_turn_items",
    `${activeWork} OR (type = 'secret_request' AND json_extract(payload_json, '$.secretStatus') = 'pending')`,
    Schema.toCodecJson(OrchestrationV2TurnItem).pipe(Schema.fromJsonString),
    (item, threadId) =>
      emit({
        type: "turn-item.updated",
        threadId,
        payload: {
          ...item,
          ...(item.type === "secret_request" ? { secretStatus: "cancelled" } : {}),
          ...("streaming" in item ? { streaming: false } : {}),
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_messages",
    "streaming = 1",
    Schema.toCodecJson(OrchestrationV2ConversationMessage).pipe(Schema.fromJsonString),
    (message, threadId) =>
      emit({
        type: "message.updated",
        threadId,
        payload: { ...message, streaming: false, updatedAt: now },
      }),
  );
  yield* forEachCopied(
    "orchestration_v2_projection_threads",
    `json_type(payload_json, '$.limitRecovery') = 'object'
      OR json_type(payload_json, '$.titleRegeneration') = 'object'
      OR EXISTS (SELECT 1 FROM json_each(payload_json, '$.pullRequests') WHERE json_type(value, '$.watch') = 'object')`,
    Schema.toCodecJson(OrchestrationV2AppThread).pipe(Schema.fromJsonString),
    (thread, threadId) =>
      emit({
        type: "thread.metadata-updated",
        threadId,
        payload: {
          ...thread,
          limitRecovery: null,
          titleRegeneration: null,
          pullRequests: thread.pullRequests?.map(({ watch: _watch, ...link }) => link),
          updatedAt: now,
        },
      }),
  );

  // These are canonical records, not event projections; no scheduler/preparation
  // domain events exist. Retain their definitions/history for explicit user action.
  yield* sql`UPDATE scheduled_tasks SET enabled = 0, next_run_at = NULL,
    updated_at = ${DateTime.formatIso(now)}
    WHERE enabled <> 0 OR next_run_at IS NOT NULL`;
  yield* sql`UPDATE orchestration_v2_thread_launch_workflows
    SET status = 'failed', last_error = ${IMPORT_CANCELLATION_REASON}, updated_at = ${DateTime.formatIso(now)}
    WHERE status NOT IN ('completed', 'failed', 'cancelled')`;
});
