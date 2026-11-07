import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));
const at = "2026-11-07T00:00:00.000Z";

layer("094_CompressCommandOutput", (it) => {
  it.effect("moves command output to its column and leaves other JSON fields readable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 93 });
      const command = (ordinal: number, fields: Record<string, unknown>) =>
        sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
          turn_item_id: `command:${ordinal}`,
          thread_id: "thread",
          run_id: "run",
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: "command_execution",
          status: "completed",
          updated_at: at,
          payload_json: JSON.stringify({ type: "command_execution", ...fields }),
        })}`;
      const output = `日本語 "quoted"\u0000 ${"line\n".repeat(100)}`;
      yield* command(1, { input: "ls", output });
      yield* command(2, { input: "no output" });
      yield* command(3, { input: "huge", output: "x".repeat(1024 * 1024) });
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: "command:unreadable",
        thread_id: "thread",
        run_id: "run",
        node_id: null,
        provider_thread_id: null,
        provider_turn_id: null,
        parent_item_id: null,
        ordinal: 4,
        type: "command_execution",
        status: "completed",
        updated_at: at,
        payload_json: "{not json",
      })}`;

      yield* runMigrations({ toMigrationInclusive: 94 });

      const commands = yield* sql<{
        readonly inline: string | null;
        readonly input: string;
        readonly output_bytes: number;
        readonly stored: string | null;
      }>`SELECT json_extract(payload_json, '$.output') AS inline,
          json_extract(payload_json, '$.input') AS input, output_bytes,
          zstd_text(output_zstd) AS stored
        FROM orchestration_v2_projection_turn_items
        WHERE json_valid(payload_json) ORDER BY ordinal`;
      assert.isTrue(commands.every((row) => row.inline === null));
      assert.deepEqual(
        commands.map((row) => row.input),
        ["ls", "no output", "huge"],
      );
      assert.equal(commands[0]?.stored, output);
      assert.equal(commands[0]?.output_bytes, Buffer.byteLength(output));
      assert.isNull(commands[1]?.stored);
      assert.equal(commands[1]?.output_bytes, 0);
      assert.isAtMost(commands[2]?.output_bytes ?? Infinity, 256 * 1024);
      const unreadable = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = 'command:unreadable'`;
      assert.equal(unreadable[0]?.payload_json, "{not json");
    }),
  );
});
