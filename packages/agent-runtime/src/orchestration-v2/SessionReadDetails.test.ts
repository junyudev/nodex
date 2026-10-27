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
    const first = yield* readSessionDetails("thread:a", 3);
    assert.equal(first.runCount, 7);
    assert.deepEqual(
      first.recentRuns.map((run) => run.ordinal),
      [7, 6, 5],
    );
    assert.equal(first.nextOrdinal, 5);
    assert.equal(first.recentRuns[0]?.model, "m");
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
