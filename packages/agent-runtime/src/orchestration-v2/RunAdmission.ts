import * as ExecutionPause from "./ExecutionPauseState.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export type ActivationClass = "person" | "continuation" | "automatic";
export interface WaitingAdmission {
  readonly runId: string;
  readonly position: number;
  readonly waitingSince: string;
}
export const START_EFFECT_TYPES = ["provider-turn.start", "provider-turn.restart", "run.recover"];
// These controls may pass a pending start in the Thread lane, independently of capacity.
export const CONTROL_EFFECT_TYPES = [
  "provider-turn.steer",
  "runtime-request.respond",
  "provider-turn.interrupt",
  "provider-task.stop",
  "provider-session.detach",
  "delegated-tasks.stop",
];
export const EXECUTION_EFFECT_TYPES = [
  ...START_EFFECT_TYPES,
  "provider-turn.steer",
  "runtime-request.respond",
];

/** Trusted activation evidence. Ordinals and message text never determine origin.
 * Root person messages/actions are person; all descendants and notification/completion,
 * restart, retry, steering and answer deliveries continue accepted work. Other root
 * messages (Host/Page, Automation, Coordinator input, Agent-created chats) start automatic work.
 */
const rootSql = (sql: SqlClient.SqlClient, thread = "thread") =>
  sql`COALESCE(json_extract(${sql.literal(thread)}.payload_json, '$.lineage.rootThreadId'), ${sql.literal(thread)}.thread_id)`;

/** Called in the activation's acceptance transaction, before any native resources open. */
export const activate = Effect.fn("RunAdmission.activate")(function* (
  threadId: string,
  activation: "person" | "continuation",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO orchestration_v2_work_episodes(root_thread_id, class, active)
    SELECT ${rootSql(sql)}, 'person', 1 FROM orchestration_v2_projection_threads thread
    WHERE thread.thread_id = ${threadId}
    ON CONFLICT(root_thread_id) DO UPDATE SET active = 1,
      class = CASE WHEN active = 0 AND ${activation} = 'person' AND excluded.root_thread_id = ${threadId} THEN 'person' ELSE class END`;
  yield* sql`UPDATE orchestration_v2_run_activations SET state = 'accepted'
    WHERE state = 'waiting' AND root_thread_id = (
      SELECT ${rootSql(sql)} FROM orchestration_v2_projection_threads thread WHERE thread_id = ${threadId})`;
});

/** One durable activation per Run; only an automatic root entering an idle tree waits. */
export const enqueue = Effect.fn("RunAdmission.enqueue")(function* (
  runId: string,
  activation?: "person" | "continuation",
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ thread_id: string; root_thread_id: string; class: ActivationClass }>`
    SELECT run.thread_id, ${rootSql(sql)} AS root_thread_id,
      CASE WHEN run.thread_id <> ${rootSql(sql)} THEN 'continuation'
        WHEN ${activation ?? null} IS NOT NULL THEN ${activation ?? null}
        WHEN json_type(message.payload_json, '$.delegatedCompletion') IS NOT NULL
          OR json_type(message.payload_json, '$.notification') IS NOT NULL
          OR json_type(message.payload_json, '$.respondedBy') IS NOT NULL
          OR json_type(run.payload_json, '$.contextRecovery') IS NOT NULL
          OR json_type(run.payload_json, '$.continuationOfRunId') IS NOT NULL
          OR json_type(run.payload_json, '$.restartContinuationOfRunId') IS NOT NULL THEN 'continuation'
        WHEN json_extract(message.payload_json, '$.createdBy') = 'user' THEN 'person'
        ELSE 'automatic' END AS class
    FROM orchestration_v2_projection_runs run
    JOIN orchestration_v2_projection_threads thread USING(thread_id)
    LEFT JOIN orchestration_v2_projection_messages message
      ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
    WHERE run.run_id = ${runId}`;
  const row = rows[0];
  if (!row) return;
  if (activation !== undefined)
    yield* activate(row.thread_id, row.class === "person" ? "person" : "continuation");
  const now = DateTime.formatIso(yield* DateTime.now);
  const inserted = yield* sql<{ run_id: string }>`INSERT INTO orchestration_v2_run_activations
    (run_id, thread_id, root_thread_id, class, state, waiting_since)
    VALUES(${runId}, ${row.thread_id}, ${row.root_thread_id}, ${row.class},
      CASE WHEN ${row.class} = 'automatic' AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_work_episodes WHERE root_thread_id = ${row.root_thread_id} AND active = 1)
        THEN 'waiting' ELSE 'accepted' END, ${now})
    ON CONFLICT(run_id) DO NOTHING RETURNING run_id`;
  if (inserted.length === 0 || row.class === "automatic") return;
  yield* activate(row.thread_id, row.class);
});

/**
 * Runs that can still keep a tree active: non-terminal Runs, plus Runs whose native turn is
 * still running after the foreground Run settled (`native = 1`). Both branches read only
 * live-state partial indexes, so the cost follows live work rather than history.
 */
const liveRunsSql = (sql: SqlClient.SqlClient) => sql`SELECT run_id, 0 AS native
    FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_recovery_idx
    WHERE status IN ('queued','preparing','starting','running','waiting')
  UNION ALL
  SELECT attempt.run_id, 1 AS native
    FROM orchestration_v2_projection_provider_turns turn INDEXED BY orchestration_v2_admission_live_turns_idx
    CROSS JOIN orchestration_v2_projection_run_attempts attempt ON attempt.attempt_id = turn.run_attempt_id
    WHERE turn.status = 'running'`;

/** Native background turns keep the whole tree active after its foreground Run settles.
 * A fully retired execution hold releases capacity while retaining queued recovery intent.
 */
export const reconcile = Effect.fn("RunAdmission.reconcile")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM orchestration_v2_run_activations AS activation WHERE state = 'waiting'
    AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run WHERE run.run_id = activation.run_id
      AND run.status IN ('queued','preparing','starting','running','waiting'))`;
  yield* sql`UPDATE orchestration_v2_work_episodes AS episode SET active = 0 WHERE active = 1
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs run INDEXED BY orchestration_v2_projection_runs_recovery_idx
      CROSS JOIN orchestration_v2_run_activations activation ON activation.run_id = run.run_id
      WHERE run.status IN ('queued','preparing','starting','running','waiting')
        AND activation.root_thread_id = episode.root_thread_id AND activation.state = 'accepted'
        AND NOT ${ExecutionPause.heldSql(sql, sql`run.thread_id`)})
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_provider_turns turn INDEXED BY orchestration_v2_admission_live_turns_idx
      CROSS JOIN orchestration_v2_projection_threads thread ON thread.thread_id = turn.thread_id
      WHERE turn.status = 'running' AND ${rootSql(sql)} = episode.root_thread_id)
    AND NOT EXISTS (
      SELECT 1 FROM orchestration_v2_effect_outbox effect
      JOIN orchestration_v2_projection_threads thread USING(thread_id)
      WHERE ${rootSql(sql)} = episode.root_thread_id AND effect.status IN ('pending','running')
        AND effect.effect_type IN ${sql.in(START_EFFECT_TYPES)}
        AND (effect.status = 'running' OR NOT ${ExecutionPause.heldSql(sql, sql`effect.thread_id`)})
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_run_activations waiting
          WHERE waiting.run_id = json_extract(effect.payload_json, '$.runId') AND waiting.state = 'waiting'))`;
});

/** Thread lifecycle ordering, with controls able to pass a pending start. */
export const effectReadySql = (sql: SqlClient.SqlClient, effectAlias = "pending") => {
  const effect = sql.literal(effectAlias);
  return sql`NOT EXISTS (
    SELECT 1 FROM orchestration_v2_effect_outbox earlier
    WHERE earlier.thread_id = ${effect}.thread_id AND earlier.effect_type <> 'thread-title.generate'
      AND (earlier.status = 'running' OR (earlier.status = 'pending' AND earlier.rowid < ${effect}.rowid
        AND (${effect}.effect_type NOT IN ${sql.in(CONTROL_EFFECT_TYPES)} OR earlier.effect_type NOT IN ${sql.in(START_EFFECT_TYPES)})))
  )`;
};

/** Rebuild missing activation facts from durable projections before workers start. */
export const restore = Effect.fn("RunAdmission.restore")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const missing = yield* sql<{
    run_id: string;
    continuing: number;
  }>`WITH live AS (${liveRunsSql(sql)})
    SELECT run.run_id, MAX(live.native) = 1 OR run.status IN ('running','waiting') AS continuing
    FROM live CROSS JOIN orchestration_v2_projection_runs run ON run.run_id = live.run_id
    WHERE NOT EXISTS (SELECT 1 FROM orchestration_v2_run_activations activation WHERE activation.run_id = run.run_id)
    GROUP BY run.run_id ORDER BY run.requested_at, run.rowid`;
  for (const row of missing)
    yield* enqueue(row.run_id, row.continuing ? "continuation" : undefined);
  const active = yield* sql<{ thread_id: string }>`WITH live AS (${liveRunsSql(sql)})
    SELECT DISTINCT activation.thread_id
    FROM live CROSS JOIN orchestration_v2_run_activations activation ON activation.run_id = live.run_id
    WHERE activation.state = 'accepted'
      AND (live.native = 1 OR NOT ${ExecutionPause.heldSql(sql, sql`activation.thread_id`)})`;
  for (const row of active) yield* activate(row.thread_id, "continuation");
  // Pending attempts can outlive a foreground Run and must inherit its episode.
  const pending = yield* sql<{
    run_id: string;
    effect_type: string;
  }>`SELECT DISTINCT effect_type, json_extract(payload_json, '$.runId') AS run_id
    FROM orchestration_v2_effect_outbox WHERE status IN ('pending','running')
      AND effect_type IN ${sql.in(START_EFFECT_TYPES)}`;
  for (const row of pending) {
    const waiting =
      yield* sql`SELECT 1 FROM orchestration_v2_run_activations WHERE run_id = ${row.run_id} AND state = 'waiting'`;
    if (row.effect_type !== "provider-turn.start" || waiting.length === 0)
      yield* enqueue(row.run_id, "continuation");
  }
  yield* reconcile();
});

/** FIFO admission reserves tree episodes atomically before a worker opens resources. */
export const admitReady = Effect.fn("RunAdmission.admitReady")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* reconcile();
  const now = DateTime.formatIso(yield* DateTime.now);
  while (true) {
    const candidates = yield* sql<{ root_thread_id: string }>`SELECT candidate.root_thread_id
      FROM orchestration_v2_run_activations candidate
      WHERE candidate.state = 'waiting' AND NOT ${ExecutionPause.heldSql(sql, sql`candidate.thread_id`)}
        AND (SELECT COUNT(*) FROM orchestration_v2_work_episodes WHERE active = 1 AND class = 'automatic')
          < (SELECT capacity FROM orchestration_v2_admission_configuration WHERE singleton = 1)
        AND EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox pending
          WHERE json_extract(pending.payload_json, '$.runId') = candidate.run_id
            AND pending.effect_type = 'provider-turn.start' AND pending.status = 'pending'
            AND pending.available_at <= ${now} AND ${effectReadySql(sql)})
      ORDER BY candidate.sequence LIMIT 1`;
    const candidate = candidates[0];
    if (!candidate) return;
    yield* sql`INSERT INTO orchestration_v2_work_episodes(root_thread_id, class, active)
      VALUES(${candidate.root_thread_id}, 'automatic', 1)
      ON CONFLICT(root_thread_id) DO UPDATE SET class = 'automatic', active = 1`;
    yield* sql`UPDATE orchestration_v2_run_activations SET state = 'accepted'
      WHERE root_thread_id = ${candidate.root_thread_id} AND state = 'waiting'`;
  }
});

export const configure = Effect.fn("RunAdmission.configure")(function* (capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)
    return yield* Effect.fail(new RangeError("Automatic work at once must be between 1 and 16."));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_admission_configuration SET capacity = ${capacity} WHERE singleton = 1`;
});

export const readWaiting = Effect.fn("RunAdmission.readWaiting")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<WaitingAdmission>`WITH waiting AS (
    SELECT run_id AS runId, thread_id, waiting_since AS waitingSince,
      ROW_NUMBER() OVER (ORDER BY sequence) AS position
    FROM orchestration_v2_run_activations WHERE state = 'waiting'
  ) SELECT runId, position, waitingSince FROM waiting WHERE thread_id = ${threadId} ORDER BY position`;
});
