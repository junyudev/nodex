import type * as SqlClient from "effect/sql/SqlClient";

import type { ProjectionRecoveryKind } from "./ProjectionStore.ts";

/**
 * Exact partial-index predicates (migration 076). Queries repeat them verbatim so SQLite reads
 * only matching index entries instead of decoding or JSON-parsing every historical row.
 */
export const OPEN_DELIVERY_RUN_PREDICATE = `CASE WHEN json_valid(payload_json)
      THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object' ELSE 0 END`;
const UNRESOLVED_CHILD_TASK_PREDICATE = `origin = 'app_owned' AND child_thread_id IS NOT NULL
      AND CASE WHEN json_valid(payload_json)
        THEN json_extract(payload_json, '$.result') IS NULL ELSE 0 END`;
const LIVE_PROVIDER_THREAD_PREDICATE = `status = 'active' OR CASE WHEN json_valid(payload_json)
      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0 ELSE 0 END`;

/**
 * Candidate Thread ids for one startup recovery pass. Every branch starts from a live-state
 * index, so startup cost follows unfinished work rather than the size of retained history.
 */
export const recoveryCandidateThreadIds = (
  sql: SqlClient.SqlClient,
  kind: ProjectionRecoveryKind,
) => {
  switch (kind) {
    case "queued-runs":
      return sql`
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS active
              WHERE active.thread_id = orchestration_v2_projection_runs.thread_id
                AND active.status IN ('preparing', 'starting', 'running', 'waiting')
            )
        `;
    case "delegated-completions":
      return sql`
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE ${sql.literal(OPEN_DELIVERY_RUN_PREDICATE)}
        `;
    case "subagent-results":
      // Results are written with their transfer, so every child awaiting one has an
      // app-owned task without a result; historical delivered tasks never qualify.
      return sql`
          WITH unresolved AS MATERIALIZED (
            SELECT DISTINCT child_thread_id AS thread_id
            FROM orchestration_v2_projection_subagents
            WHERE ${sql.literal(UNRESOLVED_CHILD_TASK_PREDICATE)}
          )
          SELECT child.thread_id FROM unresolved
          INNER JOIN orchestration_v2_projection_threads AS child
            ON child.thread_id = unresolved.thread_id
          WHERE CASE WHEN json_valid(child.payload_json) THEN
            json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
            AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
            AND (EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents AS task
              JOIN orchestration_v2_projection_runs AS requested
                INDEXED BY orchestration_v2_projection_runs_delegated_task_idx
                ON requested.thread_id = child.thread_id
                AND json_extract(requested.payload_json, '$.delegatedTaskId') = task.subagent_id
              WHERE task.child_thread_id = child.thread_id
                AND task.origin = 'app_owned'
                AND json_extract(task.payload_json, '$.result') IS NULL
                AND requested.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
            ) OR (
              -- The original task still waits for the latest unheld work.
              (SELECT status FROM orchestration_v2_projection_runs
               WHERE thread_id = child.thread_id
                 AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
               ORDER BY ordinal DESC LIMIT 1
              ) IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
              AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_context_transfers
              WHERE source_thread_id = child.thread_id
                AND target_thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
                AND type = 'subagent_result'
            )))
            ELSE 0 END
        `;
    case "runtime":
      return sql`
          WITH pending_provider_threads AS MATERIALIZED (
            SELECT provider_thread_id, thread_id, owner_node_id
            FROM orchestration_v2_projection_provider_threads
            WHERE ${sql.literal(LIVE_PROVIDER_THREAD_PREDICATE)}
          )
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE status IN ('preparing', 'starting', 'running', 'waiting')
          UNION
          -- A held queue already went through recovery; rereading it on
          -- every boot costs a projection read per held thread.
          SELECT thread_id FROM orchestration_v2_projection_runs
          WHERE status = 'queued'
            AND CASE WHEN json_valid(payload_json)
              THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
              ELSE 1 END
          UNION
          SELECT thread_id FROM orchestration_v2_projection_runtime_requests
          WHERE status = 'pending'
          UNION
          SELECT bindings.thread_id
          FROM orchestration_v2_projection_provider_sessions AS sessions
          CROSS JOIN orchestration_v2_projection_provider_session_bindings AS bindings
            ON bindings.provider_session_id = sessions.provider_session_id
          WHERE sessions.status NOT IN ('stopped', 'error')
          UNION
          SELECT thread_id FROM pending_provider_threads
          UNION
          SELECT nodes.thread_id FROM pending_provider_threads
          CROSS JOIN orchestration_v2_projection_nodes AS nodes
            ON nodes.node_id = pending_provider_threads.owner_node_id
          UNION
          SELECT subagents.thread_id FROM pending_provider_threads
          CROSS JOIN orchestration_v2_projection_subagents AS subagents
            ON subagents.provider_thread_id = pending_provider_threads.provider_thread_id
          UNION
          SELECT node.thread_id FROM orchestration_v2_projection_nodes AS node
          WHERE node.status IN ('pending', 'running', 'waiting')
            AND node.run_id IS NULL
            AND node.kind = 'root_turn'
            AND EXISTS (
              SELECT 1 FROM orchestration_v2_projection_subagents AS subagents
              WHERE subagents.child_thread_id = node.thread_id
            )
          UNION
          -- No native subagent outlives the provider process that ran it.
          SELECT thread_id FROM orchestration_v2_projection_subagents
          WHERE origin = 'provider_native'
            AND status IN ('pending', 'running', 'waiting')
          UNION
          SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
          WHERE NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS run
              WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
            )
            AND type IN ('command_execution', 'dynamic_tool', 'subagent')
            AND status IN ('pending', 'running', 'waiting')
          UNION
          SELECT thread_id FROM orchestration_v2_effect_outbox
          WHERE status IN ('pending', 'running')
        `;
  }
};
