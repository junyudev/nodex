import * as ExecutionPause from "./ExecutionPauseState.ts";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

export type AdmissionClass = "person" | "continuation" | "start";
export interface WaitingAdmission {
  readonly runId: string;
  readonly class: AdmissionClass;
  readonly position: number;
  readonly waitingSince: string;
}
export const START_EFFECT_TYPES = ["provider-turn.start", "provider-turn.restart", "run.recover"];
export const ADMISSION_EFFECT_TYPES = [
  ...START_EFFECT_TYPES,
  "provider-turn.steer",
  "runtime-request.respond",
];
export const CONTROL_EFFECT_TYPES = [
  "provider-turn.steer",
  "runtime-request.respond",
  "provider-turn.interrupt",
  "provider-task.stop",
  "provider-session.detach",
  "delegated-tasks.stop",
];

export const prioritySql = (sql: SqlClient.SqlClient, column: Fragment) =>
  sql`CASE ${column} WHEN 'person' THEN 0 WHEN 'continuation' THEN 1 ELSE 2 END`;

/** Called inside the same transaction that accepts the Run or its next attempt. */
export const enqueue = Effect.fn("RunAdmission.enqueue")(function* (
  runId: string,
  requestId: string,
  admissionClass?: AdmissionClass,
  pageId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  if (admissionClass === "person")
    yield* sql`UPDATE orchestration_v2_run_admissions SET state = 'released', released_at = ${now}
      WHERE run_id = ${runId} AND state = 'waiting' AND class <> 'person'`;
  yield* sql`INSERT INTO orchestration_v2_run_admissions
    (request_id, run_id, thread_id, root_thread_id, page_id, class, state, waiting_since)
    SELECT ${requestId}, run.run_id, run.thread_id,
      COALESCE(json_extract(thread.payload_json, '$.lineage.rootThreadId'), run.thread_id),
      COALESCE(${pageId ?? null}, (SELECT page_id FROM orchestration_v2_admission_context context
        WHERE context.thread_id IN (run.thread_id, json_extract(thread.payload_json, '$.lineage.rootThreadId'))
        ORDER BY context.thread_id = run.thread_id DESC LIMIT 1)),
      ${
        admissionClass === undefined
          ? sql`CASE
        WHEN json_type(message.payload_json, '$.delegatedCompletion') IS NOT NULL
          OR json_type(message.payload_json, '$.notification') IS NOT NULL
          OR json_type(run.payload_json, '$.restartContinuationOfRunId') IS NOT NULL THEN 'continuation'
        WHEN json_extract(message.payload_json, '$.createdBy') = 'user' THEN 'person'
        WHEN run.ordinal = 1 THEN 'start'
        ELSE 'continuation' END`
          : sql`${admissionClass}`
      },
      'waiting', ${now}
    FROM orchestration_v2_projection_runs run
    LEFT JOIN orchestration_v2_projection_threads thread ON thread.thread_id = run.thread_id
    LEFT JOIN orchestration_v2_projection_messages message
      ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
    WHERE run.run_id = ${runId}
      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_run_admissions existing
        WHERE existing.run_id = run.run_id AND existing.state <> 'released')
    ON CONFLICT DO NOTHING`;
});

/** Native turn evidence wins over a settled foreground Run or a completed UI request. */
export const reconcile = Effect.fn("RunAdmission.reconcile")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`UPDATE orchestration_v2_run_admissions AS admission SET native_started = 1
    WHERE state = 'admitted' AND native_started = 0 AND EXISTS (
      SELECT 1 FROM orchestration_v2_projection_run_attempts attempt
      CROSS JOIN orchestration_v2_projection_provider_turns turn INDEXED BY orchestration_v2_admission_live_turns_idx ON attempt.attempt_id = turn.run_attempt_id
      WHERE attempt.run_id = admission.run_id AND turn.status = 'running')`;
  yield* sql`UPDATE orchestration_v2_run_admissions AS admission
    SET state = 'released', released_at = ${now}
    WHERE state <> 'released' AND parked = 0
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_effect_outbox effect
        WHERE effect.status = 'running' AND effect.effect_type IN ${sql.in(START_EFFECT_TYPES)}
          AND json_extract(effect.payload_json, '$.runId') = admission.run_id)
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_run_attempts attempt
        CROSS JOIN orchestration_v2_projection_provider_turns turn INDEXED BY orchestration_v2_admission_live_turns_idx ON attempt.attempt_id = turn.run_attempt_id
        WHERE attempt.run_id = admission.run_id AND turn.status = 'running'
      )
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs run
        WHERE run.run_id = admission.run_id AND (
          run.status NOT IN ('queued', 'preparing', 'starting', 'running')
          OR admission.native_started = 1
        ))`;
});

/** Same Thread lifecycle ordering as the outbox, with controls able to pass a capacity wait. */
export const effectReadySql = (sql: SqlClient.SqlClient, effectAlias = "pending") => {
  const effect = sql.literal(effectAlias);
  return sql`NOT EXISTS (
    SELECT 1 FROM orchestration_v2_effect_outbox earlier
    WHERE earlier.thread_id = ${effect}.thread_id
      AND earlier.effect_type <> 'thread-title.generate'
      AND (earlier.status = 'running' OR (earlier.status = 'pending' AND earlier.rowid < ${effect}.rowid
        AND (${effect}.effect_type NOT IN ${sql.in(CONTROL_EFFECT_TYPES)} OR earlier.effect_type NOT IN ${sql.in(START_EFFECT_TYPES)})))
  )`;
};

/** One transaction selects permits before any worker or provider-start resource is occupied. */
export const admitReady = Effect.fn("RunAdmission.admitReady")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* reconcile();
  // An effect can be queued while its predecessor still owns the native slot. If that
  // slot then settles, the pending continuation must acquire a new admission.
  const pending = yield* sql<{ run_id: string; effect_id: string; class: AdmissionClass | null }>`
    SELECT json_extract(effect.payload_json, '$.runId') AS run_id, effect.effect_id,
      json_extract(effect.payload_json, '$.admissionClass') AS class
    FROM orchestration_v2_effect_outbox effect
    WHERE effect.status = 'pending' AND effect.effect_type IN ${sql.in(ADMISSION_EFFECT_TYPES)}
      AND json_extract(effect.payload_json, '$.runId') IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_run_admissions admission
        WHERE admission.run_id = json_extract(effect.payload_json, '$.runId') AND admission.state <> 'released')
    ORDER BY effect.rowid`;
  for (const row of pending) yield* enqueue(row.run_id, row.effect_id, row.class ?? "continuation");
  const now = DateTime.formatIso(yield* DateTime.now);
  // Capacity is small and bounded. Re-reading after each grant keeps the reservation exact.
  for (let index = 0; index < 16; index++) {
    const granted = yield* sql<{ run_id: string }>`UPDATE orchestration_v2_run_admissions
      SET state = 'admitted'
      WHERE sequence = (
        SELECT candidate.sequence FROM orchestration_v2_run_admissions candidate
        CROSS JOIN orchestration_v2_admission_configuration configuration
        WHERE candidate.state = 'waiting' AND NOT ${ExecutionPause.heldSql(sql, sql`candidate.thread_id`)}
          AND (candidate.resume = 0 OR NOT EXISTS (
            SELECT 1 FROM orchestration_v2_run_admissions parked
            WHERE parked.run_id = candidate.run_id AND parked.parked_waits > 0
              AND candidate.request_id = 'resume:' || parked.sequence))
          AND (SELECT COUNT(*) FROM orchestration_v2_run_admissions WHERE state = 'admitted') < configuration.capacity
          AND (candidate.class = 'person' OR
            (SELECT COUNT(*) FROM orchestration_v2_run_admissions WHERE state = 'admitted' AND class <> 'person')
              < CASE WHEN configuration.capacity = 1 THEN 1 ELSE configuration.capacity - 1 END)
          AND (candidate.resume = 1 OR EXISTS (
            SELECT 1 FROM orchestration_v2_effect_outbox pending
            WHERE pending.thread_id = candidate.thread_id AND pending.status = 'pending'
              AND pending.effect_type IN ${sql.in(ADMISSION_EFFECT_TYPES)}
              AND json_extract(pending.payload_json, '$.runId') = candidate.run_id
              AND pending.available_at <= ${now} AND ${effectReadySql(sql)}
          ))
        ORDER BY ${prioritySql(sql, sql`candidate.class`)}, candidate.sequence LIMIT 1
      ) RETURNING run_id`;
    if (granted.length === 0) return;
  }
});

export const configure = Effect.fn("RunAdmission.configure")(function* (capacity: number) {
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 16)
    return yield* Effect.fail(new RangeError("Agents running at once must be between 1 and 16."));
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE orchestration_v2_admission_configuration SET capacity = ${capacity} WHERE singleton = 1`;
});

export const readWaiting = Effect.fn("RunAdmission.readWaiting")(function* (threadId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<WaitingAdmission>`WITH waiting AS (
    SELECT run_id AS runId, thread_id, class, waiting_since AS waitingSince,
      ROW_NUMBER() OVER (ORDER BY ${prioritySql(sql, sql`class`)}, sequence) AS position
    FROM orchestration_v2_run_admissions WHERE state = 'waiting'
  ) SELECT runId, class, position, waitingSince FROM waiting
    WHERE thread_id = ${threadId} ORDER BY position`;
});

/** Blocking task tools park native computation; returning their result requires a fresh permit. */
export const whileParked = Effect.fn("RunAdmission.whileParked")(function* <A, E, R>(
  runId: string | undefined,
  wait: Effect.Effect<A, E, R>,
  notify: Effect.Effect<void> = Effect.void,
) {
  if (runId === undefined) return yield* wait;
  const sql = yield* SqlClient.SqlClient;
  const epoch = yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const parked = yield* sql<{ sequence: number }>`UPDATE orchestration_v2_run_admissions
      SET state = 'released', released_at = ${now}, parked = 1, parked_waits = 1
      WHERE run_id = ${runId} AND state = 'admitted' RETURNING sequence`;
      if (parked[0]) return parked[0].sequence;
      const joined = yield* sql<{ sequence: number }>`UPDATE orchestration_v2_run_admissions
        SET parked_waits = parked_waits + 1 WHERE sequence = (
          SELECT sequence FROM orchestration_v2_run_admissions
          WHERE run_id = ${runId} AND state = 'released' AND parked = 1
          ORDER BY sequence DESC LIMIT 1
        ) RETURNING sequence`;
      return joined[0]?.sequence;
    }),
  );
  if (epoch === undefined) return yield* wait;
  yield* notify;
  const result = yield* Effect.exit(wait);
  const requestId = `resume:${epoch}`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const remaining = yield* sql<{ parked_waits: number }>`UPDATE orchestration_v2_run_admissions
        SET parked_waits = parked_waits - 1 WHERE sequence = ${epoch} RETURNING parked_waits`;
      if (remaining[0]?.parked_waits !== 0) return;
      yield* enqueue(runId, requestId, "continuation");
      yield* sql`UPDATE orchestration_v2_run_admissions SET resume = 1 WHERE request_id = ${requestId}`;
    }),
  );
  // This is a suspended MCP response, never an effect-worker or native-start slot.
  while (true) {
    const state = yield* sql.withTransaction(
      Effect.gen(function* () {
        // A native parallel tool batch cannot resume until its last wait returns.
        const pending = yield* sql<{ parked_waits: number }>`SELECT parked_waits
          FROM orchestration_v2_run_admissions WHERE sequence = ${epoch}`;
        if ((pending[0]?.parked_waits ?? 0) > 0) return "parked";
        yield* admitReady();
        const rows = yield* sql<{ state: string }>`SELECT state FROM orchestration_v2_run_admissions
        WHERE run_id = ${runId} AND state <> 'released' LIMIT 1`;
        return rows[0]?.state;
      }),
    );
    if (state === undefined) return yield* Effect.interrupt;
    if (state === "admitted")
      return yield* Exit.isSuccess(result)
        ? Effect.succeed(result.value)
        : Effect.failCause(result.cause);
    yield* Effect.sleep("100 millis");
  }
});

/** A restart/selection change stops and replaces the same native computation in one slot. */
export const transfer = Effect.fn("RunAdmission.transfer")(function* (
  threadId: string,
  runId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const previous = yield* sql<{ sequence: number }>`UPDATE orchestration_v2_run_admissions
    SET state = 'released', released_at = ${now}
    WHERE thread_id = ${threadId} AND run_id <> ${runId} AND state = 'admitted'
    RETURNING sequence`;
  if (previous.length === 0) return;
  yield* sql`UPDATE orchestration_v2_run_admissions SET state = 'admitted'
    WHERE run_id = ${runId} AND state = 'waiting'`;
});

/** An outbox retry has no native owner yet; known live turns keep their existing permit. */
export const retry = Effect.fn("RunAdmission.retry")(function* (runId: string, requestId: string) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`UPDATE orchestration_v2_run_admissions AS admission SET state = 'released', released_at = ${now}
    WHERE run_id = ${runId} AND state <> 'released'
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts attempt
        CROSS JOIN orchestration_v2_projection_provider_turns turn INDEXED BY orchestration_v2_admission_live_turns_idx ON attempt.attempt_id = turn.run_attempt_id
        WHERE attempt.run_id = admission.run_id AND turn.status = 'running')`;
  yield* enqueue(runId, requestId, "continuation");
});
