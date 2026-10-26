import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

const thread = "thread-1";
const at = "2026-10-26T00:00:00.000Z";

const turnItem = (
  id: string,
  nativeId: string,
  fields: Record<string, unknown>,
): Record<string, unknown> => ({
  id,
  threadId: thread,
  runId: "run-1",
  nodeId: "root-node",
  providerThreadId: null,
  providerTurnId: "provider-turn",
  nativeItemRef: { driver: "claudeAgent", nativeId, strength: "strong" },
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
  ...fields,
});

const thought = (id: string, nativeId: string, text: string) =>
  turnItem(id, nativeId, { type: "reasoning", title: "Thinking", text, streaming: false });

const reply = (id: string, nativeId: string, text: string) =>
  turnItem(id, nativeId, {
    type: "assistant_message",
    nodeId: `node-${id}`,
    messageId: `message-${id}`,
    text,
    streaming: false,
  });

layer("079_ClaudeLoneThinkingThoughts", (it) => {
  it.effect("restores a lone thinking block shown as a reply and keeps a note before a tool", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 78 });

      let version = 0;
      const event = (eventType: string, payload: Record<string, unknown>) => {
        version += 1;
        return sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event-${version}`,
          aggregate_kind: "thread",
          stream_id: thread,
          stream_version: version,
          event_type: eventType,
          occurred_at: at,
          command_id: null,
          causation_event_id: null,
          correlation_id: null,
          actor_kind: "provider",
          payload_json: JSON.stringify(payload),
          metadata_json: "{}",
          application_event_version: 2,
        })}`;
      };
      const promotion = (id: string, nativeId: string, text: string) =>
        Effect.gen(function* () {
          yield* event("turn-item.updated", thought(id, nativeId, text));
          yield* event("node.updated", { id: `node-${id}`, kind: "assistant_message" });
          yield* event("message.updated", { id: `message-${id}`, role: "assistant", text });
          yield* event("turn-item.updated", reply(id, nativeId, text));
          const item = reply(id, nativeId, text);
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert({
            turn_item_id: id,
            thread_id: thread,
            run_id: "run-1",
            node_id: `node-${id}`,
            provider_thread_id: null,
            provider_turn_id: "provider-turn",
            parent_item_id: null,
            ordinal: 1,
            type: "assistant_message",
            status: "completed",
            updated_at: at,
            historical_text_bytes: text.length,
            native_attachment_allowance: 0,
            payload_json: JSON.stringify(item),
          })}`;
          yield* sql`INSERT INTO orchestration_v2_projection_messages ${sql.insert({
            message_id: `message-${id}`,
            thread_id: thread,
            run_id: "run-1",
            node_id: `node-${id}`,
            role: "assistant",
            streaming: 0,
            created_at: at,
            updated_at: at,
            payload_json: "{}",
          })}`;
          yield* sql`INSERT INTO orchestration_v2_projection_nodes ${sql.insert({
            node_id: `node-${id}`,
            thread_id: thread,
            run_id: "run-1",
            parent_node_id: "root-node",
            root_node_id: "root-node",
            kind: "assistant_message",
            status: "completed",
            provider_thread_id: null,
            provider_turn_id: "provider-turn",
            runtime_request_id: null,
            checkpoint_scope_id: null,
            started_at: at,
            completed_at: at,
            payload_json: "{}",
          })}`;
        });
      yield* promotion("lone", "msg_a:thinking:0", "I need to check the label.");
      yield* promotion("note", "msg_b:thinking:1", "Found it: the label is the cause.");

      yield* runMigrations({ toMigrationInclusive: 79 });

      const items = yield* sql<{
        turn_item_id: string;
        type: string;
        node_id: string;
        historical_text_bytes: number;
        payload_json: string;
      }>`SELECT turn_item_id, type, node_id, historical_text_bytes, payload_json
        FROM orchestration_v2_projection_turn_items ORDER BY turn_item_id`;
      assert.deepEqual(
        items.map((item) => [item.turn_item_id, item.type, item.node_id]),
        [
          ["lone", "reasoning", "root-node"],
          ["note", "assistant_message", "node-note"],
        ],
      );
      assert.deepEqual(
        JSON.parse(items[0]!.payload_json),
        thought("lone", "msg_a:thinking:0", "I need to check the label."),
      );
      assert.equal(items[0]!.historical_text_bytes, 0);

      const messages = yield* sql<{
        message_id: string;
      }>`SELECT message_id FROM orchestration_v2_projection_messages`;
      assert.deepEqual(
        messages.map((row) => row.message_id),
        ["message-note"],
      );
      const nodes = yield* sql<{
        node_id: string;
      }>`SELECT node_id FROM orchestration_v2_projection_nodes`;
      assert.deepEqual(
        nodes.map((row) => row.node_id),
        ["node-note"],
      );

      const events = yield* sql<{
        event_type: string;
        payload_json: string;
      }>`SELECT event_type, payload_json FROM orchestration_events ORDER BY sequence`;
      assert.deepEqual(
        events.map((row) => {
          const payload = JSON.parse(row.payload_json) as { id: string; type?: string };
          return [row.event_type, payload.id, payload.type ?? null];
        }),
        [
          ["turn-item.updated", "lone", "reasoning"],
          ["turn-item.updated", "note", "reasoning"],
          ["node.updated", "node-note", null],
          ["message.updated", "message-note", null],
          ["turn-item.updated", "note", "assistant_message"],
        ],
      );
    }),
  );
});
