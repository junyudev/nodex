import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";
import { readSessionCatalog } from "../../orchestration-v2/SessionCatalog.ts";

it.effect(
  "backfills bounded prompts and message recency without treating metadata time as activity",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 80 });
      assert.deepEqual(
        yield* sql<{
          name: string;
        }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 80`,
        [{ name: "PendingMessageDeliveries" }],
      );
      const thread = "thread:existing";
      const created = "2026-10-01T00:00:00.000Z";
      yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
        thread_id: thread,
        project_id: "project:a",
        title: "Existing conversation",
        default_provider: "codex",
        provider_instance_id: "codex",
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_at: created,
        updated_at: "2026-10-20T00:00:00.000Z",
        payload_json: JSON.stringify({
          lineage: { rootThreadId: thread, parentThreadId: null },
          modelSelection: { model: "model" },
        }),
      })}`;
      for (const [index, role, day, text] of [
        [0, "user", "02", "二次元".repeat(300)],
        [1, "assistant", "03", "Answer"],
        [2, "system", "19", "Metadata"],
      ] as const) {
        const at = `2026-10-${day}T00:00:00.000Z`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
          message_id: `message:${index}`,
          thread_id: thread,
          role,
          streaming: 0,
          created_at: at,
          updated_at: at,
          payload_json: JSON.stringify({ text, createdBy: "user" }),
        })}`;
      }
      const upgraded = yield* runMigrations();
      assert.deepEqual(upgraded[0], [81, "ConversationDiscovery"]);
      assert.isTrue(upgraded.every(([id]) => id > 80));
      assert.deepEqual(yield* runMigrations(), []);
      const result = yield* readSessionCatalog({});
      assert.equal(result.items[0]?.preview, "二次元".repeat(300).slice(0, 512));
      assert.equal(result.items[0]?.recencyAt, "2026-10-03T00:00:00.000Z");
      const query = yield* readSessionCatalog({ query: "二次元" });
      assert.equal(query.items[0]?.threadId, thread);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
