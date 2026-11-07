import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const at = "2026-11-07T00:00:00.000Z";

layer("095_DropQuietHookRuns", (it) => {
  it.effect("drops hook runs with nothing to report and keeps the rest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 94 });
      const hook = (id: string, ordinal: number, hookStatus: string, entries: unknown[]) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
            turn_item_id: id,
            thread_id: "thread",
            run_id: "run",
            node_id: `node:${id}`,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: "hook_run",
            status: hookStatus === "failed" ? "failed" : "completed",
            updated_at: at,
            payload_json: JSON.stringify({ id, type: "hook_run", hookStatus, entries }),
          })}`;
          yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
            node_id: `node:${id}`,
            thread_id: "thread",
            run_id: "run",
            parent_node_id: null,
            root_node_id: "root",
            kind: "hook",
            status: "completed",
            provider_thread_id: null,
            provider_turn_id: null,
            runtime_request_id: null,
            checkpoint_scope_id: null,
            started_at: at,
            completed_at: at,
            payload_json: "{}",
          })}`;
          yield* sql`INSERT INTO orchestration_v2_turn_item_positions ${sql.insert({
            thread_id: "thread",
            turn_item_id: id,
            ordinal,
          })}`;
        });
      yield* hook("hook:silent", 1, "completed", []);
      yield* hook("hook:context", 2, "completed", [{ kind: "context", text: "hidden" }]);
      yield* hook("hook:running", 3, "running", []);
      yield* hook("hook:warning", 4, "completed", [{ kind: "warning", text: "look" }]);
      yield* hook("hook:failed", 5, "failed", []);
      yield* hook("hook:blocked", 6, "blocked", [{ kind: "feedback", text: "no" }]);
      yield* hook("hook:unreadable", 7, "completed", []);
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{not json'
        WHERE turn_item_id = 'hook:unreadable'`;

      yield* runMigrations({ toMigrationInclusive: 95 });

      const ids = (table: string, column: string) =>
        sql
          .unsafe<{ readonly id: string }>(
            `SELECT ${column} AS id FROM ${table} ORDER BY ${column}`,
          )
          .pipe(Effect.map((rows) => rows.map((row) => row.id)));
      const kept = ["hook:blocked", "hook:failed", "hook:unreadable", "hook:warning"];
      assert.deepEqual(yield* ids("orchestration_v2_projection_turn_items", "turn_item_id"), kept);
      assert.deepEqual(yield* ids("orchestration_v2_turn_item_positions", "turn_item_id"), kept);
      assert.deepEqual(
        yield* ids("orchestration_v2_projection_nodes", "node_id"),
        kept.map((id) => `node:${id}`),
      );
    }),
  );
});
