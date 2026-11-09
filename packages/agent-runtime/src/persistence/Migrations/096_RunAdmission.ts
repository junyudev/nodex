import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX orchestration_v2_admission_live_turns_idx
    ON orchestration_v2_projection_provider_turns(run_attempt_id) WHERE status = 'running'`;
  yield* sql`CREATE TABLE orchestration_v2_admission_configuration (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 16)
  )`;
  yield* sql`INSERT INTO orchestration_v2_admission_configuration VALUES(1, 4)`;
  yield* sql`CREATE TABLE orchestration_v2_admission_context (
    thread_id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE orchestration_v2_run_admissions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    root_thread_id TEXT NOT NULL,
    page_id TEXT,
    class TEXT NOT NULL CHECK(class IN ('person', 'continuation', 'start')),
    state TEXT NOT NULL CHECK(state IN ('waiting', 'admitted', 'released')),
    waiting_since TEXT NOT NULL,
    released_at TEXT,
    native_started INTEGER NOT NULL DEFAULT 0,
    parked INTEGER NOT NULL DEFAULT 0,
    parked_waits INTEGER NOT NULL DEFAULT 0 CHECK(parked_waits >= 0),
    resume INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE UNIQUE INDEX orchestration_v2_admissions_live_run_idx
    ON orchestration_v2_run_admissions(run_id) WHERE state <> 'released'`;
  yield* sql`CREATE INDEX orchestration_v2_admissions_queue_idx
    ON orchestration_v2_run_admissions(state, class, sequence)`;
  yield* sql`CREATE INDEX orchestration_v2_admissions_thread_idx
    ON orchestration_v2_run_admissions(thread_id, state)`;
  yield* sql`CREATE INDEX orchestration_v2_admissions_parked_idx
    ON orchestration_v2_run_admissions(run_id) WHERE parked_waits > 0`;
});
