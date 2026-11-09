import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_work_episodes (
    root_thread_id TEXT PRIMARY KEY,
    class TEXT NOT NULL CHECK(class IN ('person','automatic')),
    active INTEGER NOT NULL CHECK(active IN (0,1))
  )`;
  yield* sql`CREATE TABLE orchestration_v2_run_activations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    root_thread_id TEXT NOT NULL,
    class TEXT NOT NULL CHECK(class IN ('person','continuation','automatic')),
    state TEXT NOT NULL CHECK(state IN ('waiting','accepted')),
    waiting_since TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX orchestration_v2_activations_queue_idx ON orchestration_v2_run_activations(state,sequence)`;
  yield* sql`CREATE INDEX orchestration_v2_activations_tree_idx ON orchestration_v2_run_activations(root_thread_id,state)`;
  yield* sql`CREATE INDEX orchestration_v2_activations_thread_idx ON orchestration_v2_run_activations(thread_id,state)`;
  // Retain trusted activation and queue order, then discard per-Run permit state.
  yield* sql`INSERT INTO orchestration_v2_run_activations
    (run_id, thread_id, root_thread_id, class, state, waiting_since)
    SELECT run.run_id, run.thread_id,
      COALESCE(json_extract(thread.payload_json,'$.lineage.rootThreadId'),run.thread_id),
      CASE WHEN run.thread_id <> COALESCE(json_extract(thread.payload_json,'$.lineage.rootThreadId'),run.thread_id)
        OR json_type(message.payload_json,'$.notification') IS NOT NULL
        OR json_type(message.payload_json,'$.delegatedCompletion') IS NOT NULL
        OR json_type(message.payload_json, '$.respondedBy') IS NOT NULL
        OR json_type(run.payload_json, '$.contextRecovery') IS NOT NULL
        OR json_type(run.payload_json, '$.continuationOfRunId') IS NOT NULL
        OR json_type(run.payload_json,'$.restartContinuationOfRunId') IS NOT NULL THEN 'continuation'
        WHEN json_extract(message.payload_json,'$.createdBy') = 'user' THEN 'person' ELSE 'automatic' END,
      CASE WHEN EXISTS (SELECT 1 FROM orchestration_v2_run_admissions old
        WHERE old.run_id = run.run_id AND old.state = 'waiting')
        AND run.status IN ('queued','preparing','starting') THEN 'waiting' ELSE 'accepted' END,
      COALESCE((SELECT waiting_since FROM orchestration_v2_run_admissions old
        WHERE old.run_id = run.run_id ORDER BY sequence LIMIT 1),run.requested_at)
    FROM orchestration_v2_projection_runs run
    JOIN orchestration_v2_projection_threads thread USING(thread_id)
    LEFT JOIN orchestration_v2_projection_messages message
      ON message.message_id = json_extract(run.payload_json,'$.userMessageId')
    ORDER BY COALESCE((SELECT MIN(sequence) FROM orchestration_v2_run_admissions old WHERE old.run_id = run.run_id),run.rowid)`;
  yield* sql`UPDATE orchestration_v2_run_activations SET state = 'accepted' WHERE class <> 'automatic'`;
  yield* sql`INSERT INTO orchestration_v2_work_episodes(root_thread_id,class,active)
    SELECT root_thread_id, COALESCE((SELECT class FROM orchestration_v2_run_activations origin
      WHERE origin.root_thread_id = activation.root_thread_id AND origin.class <> 'continuation' AND origin.state = 'accepted'
      ORDER BY sequence DESC LIMIT 1),'person'), 0
    FROM orchestration_v2_run_activations activation GROUP BY root_thread_id`;
  yield* sql`DROP TABLE orchestration_v2_run_admissions`;
  yield* sql`DROP TABLE orchestration_v2_admission_context`;
});
