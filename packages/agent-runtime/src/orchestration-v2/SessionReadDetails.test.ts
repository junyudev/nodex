import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readSessionDetails } from "./SessionReadDetails.ts";

it.effect("pages indexed Run summaries independently of later appends and other Threads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const put = (ordinal: number, threadId = "thread:a") => sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, completed_at, payload_json)
      VALUES (${`${threadId}:${ordinal}`}, ${threadId}, ${ordinal}, 'codex', 'codex', 'completed',
        '2026-10-27T00:00:00.000Z', '2026-10-27T00:01:00.000Z',
        '{"modelSelection":{"model":"m"},"startedAt":"2026-10-27T00:00:01.000Z"}')`;
    for (let ordinal = 1; ordinal <= 7; ordinal++) yield* put(ordinal);
    yield* put(100, "thread:other");
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
      VALUES('stop','thread:a','thread:a:1',1,'run_interrupt_request','completed','2026-11-03','not a transcript envelope')`;
    const exact = yield* readSessionDetails("thread:a", 1, undefined, "thread:a:1");
    assert.deepEqual(
      exact.recentRuns.map((run) => run.runId),
      ["thread:a:1"],
    );
    assert.isNull(exact.nextOrdinal);
    assert.isTrue(exact.recentRuns[0]?.interruptRequested);
    const first = yield* readSessionDetails("thread:a", 3);
    assert.equal(first.runCount, 7);
    assert.deepEqual(
      first.recentRuns.map((run) => run.ordinal),
      [7, 6, 5],
    );
    assert.equal(first.nextOrdinal, 5);
    assert.equal(first.recentRuns[0]?.model, "m");
    assert.isFalse(first.recentRuns[0]?.interruptRequested);
    yield* put(8);
    const next = yield* readSessionDetails("thread:a", 4, first.nextOrdinal!);
    assert.deepEqual(
      next.recentRuns.map((run) => run.ordinal),
      [4, 3, 2, 1],
    );
    assert.isNull(next.nextOrdinal);
    assert.equal(next.runCount, 8);
    assert.equal(next.pendingRequestCount, 0);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("reads pending question identities and choices without loading transcript bodies", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const questions = [
      {
        id: "choice",
        header: "Scope",
        question: "Include docs?",
        options: [{ label: "Yes", description: "Update docs" }],
      },
    ];
    for (const [id, kind, status, capability] of [
      ["question", "user_input", "pending", "message"],
      ["approval", "approval", "pending", "live"],
      ["resolved", "user_input", "resolved", "message"],
      ["cancelled", "user_input", "cancelled", "message"],
      ["unavailable", "user_input", "pending", "not_resumable"],
      ["tool", "dynamic_tool_call", "pending", "live"],
    ]) {
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests(runtime_request_id,thread_id,node_id,kind,status,created_at,payload_json)
        VALUES(${id},'thread:a','node',${kind},${status},'2026-11-03',
          ${JSON.stringify({ responseCapability: { type: capability } })})`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json)
      VALUES('question:item','thread:a','run','node',1,'user_input_request','waiting','2026-11-03',${JSON.stringify({ requestId: "question", questions })})`;
    // Opaque transcript payloads are intentionally undecodable at this metadata boundary.
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
      VALUES('body','thread:a','run',2,'assistant_message','completed','2026-11-03','not a transcript envelope')`;
    const details = yield* readSessionDetails("thread:a", 1);
    assert.deepEqual(details.pendingRequests, [
      { id: "approval", kind: "approval", questions: [] },
      { id: "question", kind: "question", questions },
    ]);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("keeps the failure explanation with its indexed Run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runs
      (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json)
      VALUES('failed','thread:a',1,'codex','codex','failed','2026-11-05','{}')`;
    for (const [id, run, ordinal, message] of [
      ["first", "failed", 1, "First attempt failed"],
      ["latest", "failed", 2, "Credentials were rejected"],
      ["other", "another-run", 3, "An unrelated failure"],
    ] as const)
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id,thread_id,run_id,ordinal,type,status,updated_at,payload_json)
        VALUES(${id},'thread:a',${run},${ordinal},'error','failed','2026-11-05',
          ${JSON.stringify({ failure: { message } })})`;
    const details = yield* readSessionDetails("thread:a", 1);
    assert.equal(details.recentRuns[0]?.failureMessage, "Credentials were rejected");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
