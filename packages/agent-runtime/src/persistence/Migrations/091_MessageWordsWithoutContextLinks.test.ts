import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const thread = "thread:a";
const at = "2026-10-01T00:00:00.000Z";
const link = (label: string, id: string) =>
  `[${label}](t3-context://v1/nodex-page-reference/${id})`;
const context = {
  version: 1,
  records: [{ version: 1, kind: "nodex-page-reference", contextId: "bound", label: "Plan" }],
};

it.effect("keeps only the words of messages whose records name the link", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 90 });
    yield* sql`INSERT INTO orchestration_v2_projection_threads ${sql.insert({
      thread_id: thread,
      project_id: "project:a",
      title: "Conversation",
      default_provider: "codex",
      provider_instance_id: "codex",
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_at: at,
      updated_at: at,
      conversation_preview: `Review\n\n${link("Plan", "bound")}`,
      conversation_preview_id: "message:bound",
      payload_json: "{}",
    })}`;

    const bound = { text: `Review\n\n${link("Plan", "bound")}`, context };
    const onlyContext = { text: link("Plan", "bound"), context };
    // A user quoting the format, and an Agent explaining it, wrote these on purpose.
    const quoted = { text: `Why does ${link("Plan", "other")} appear?`, context };
    const discussed = { text: `The link is ${link("Plan", "bound")}` };
    const messages = [
      ["message:bound", "user", bound],
      ["message:only-context", "user", onlyContext],
      ["message:quoted", "user", quoted],
      ["message:assistant", "assistant", discussed],
    ] as const;
    for (const [id, role, payload] of messages) {
      yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
        message_id: id,
        thread_id: thread,
        role,
        streaming: 0,
        created_at: at,
        updated_at: at,
        payload_json: JSON.stringify(payload),
      })}`;
    }
    const items = [
      ["item:user", "user_message", bound],
      ["item:reasoning", "reasoning", discussed],
    ] as const;
    for (const [index, [id, type, payload]] of items.entries()) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
        turn_item_id: id,
        thread_id: thread,
        ordinal: index,
        type,
        status: "completed",
        updated_at: at,
        payload_json: JSON.stringify(payload),
      })}`;
    }
    const events = [
      ["message.updated", bound],
      ["turn-item.updated", bound],
      ["turn-item.updated", discussed],
    ] as const;
    for (const [index, [type, payload]] of events.entries()) {
      yield* sql`INSERT INTO orchestration_events ${sql.insert({
        event_id: `event:${index}`,
        aggregate_kind: "thread",
        stream_id: thread,
        stream_version: index,
        event_type: type,
        occurred_at: at,
        actor_kind: "client",
        payload_json: JSON.stringify(payload),
        metadata_json: "{}",
      })}`;
    }

    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 91 }), [
      [91, "MessageWordsWithoutContextLinks"],
    ]);

    const texts = (rows: ReadonlyArray<{ readonly payload_json: string }>) =>
      rows.map((row) => (JSON.parse(row.payload_json) as { text: string }).text);
    assert.deepEqual(
      texts(
        yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_messages ORDER BY rowid`,
      ),
      ["Review", "", quoted.text, discussed.text],
    );
    assert.deepEqual(
      texts(
        yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_turn_items ORDER BY ordinal`,
      ),
      ["Review", discussed.text],
    );
    assert.deepEqual(
      texts(
        yield* sql<{
          readonly payload_json: string;
        }>`SELECT payload_json FROM orchestration_events ORDER BY sequence`,
      ),
      ["Review", "Review", discussed.text],
    );
    assert.deepEqual(
      yield* sql`SELECT conversation_preview FROM orchestration_v2_projection_threads`,
      [{ conversation_preview: "Review" }],
    );
    // Search follows the corrected text through the message triggers.
    assert.deepEqual(
      yield* sql`SELECT rowid FROM orchestration_v2_session_message_search
        WHERE orchestration_v2_session_message_search MATCH '"nodex-page-reference"'
        ORDER BY rowid`,
      [{ rowid: 3 }, { rowid: 4 }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
