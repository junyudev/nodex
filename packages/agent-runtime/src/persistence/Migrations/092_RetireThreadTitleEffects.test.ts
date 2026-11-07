import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@nodex/runtime-shared/nodeSqliteClient";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("092_RetireThreadTitleEffects", (it) => {
  it.effect("removes title effects and leaves every other effect in place", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 91 });

      for (const [effectId, effectType] of [
        ["effect:title", "thread-title.generate"],
        ["effect:cleanup", "preview.cleanup"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_effect_outbox (
            effect_id, command_id, thread_id, effect_type, payload_json, status,
            available_at, created_at, updated_at
          ) VALUES (
            ${effectId}, 'command', 'thread', ${effectType}, '{}', 'pending',
            '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z', '2026-11-07T00:00:00Z'
          )
        `;
      }

      yield* runMigrations({ toMigrationInclusive: 92 });

      const rows = yield* sql<{ readonly effect_id: string }>`
        SELECT effect_id FROM orchestration_v2_effect_outbox
      `;
      assert.deepEqual(
        rows.map((row) => row.effect_id),
        ["effect:cleanup"],
      );
    }),
  );
});
