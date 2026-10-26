import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Restores Claude thinking that was shown as a reply.
 *
 * A lone thinking block right before a tool call was rewritten, under the same item ID, into an
 * assistant message with its own node and message. It is the model's thinking, so its Thought comes
 * back: the rewrite's events are removed, and each projection returns to the completed Thought that
 * the event log still holds (turn item events are never compacted). The second of two consecutive
 * thinking blocks is the note before a tool call, so only a message's first thinking block is restored.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TEMP TABLE claude_lone_thinking AS
    SELECT
      promotion.sequence AS sequence,
      json_extract(promotion.payload_json, '$.id') AS turn_item_id,
      json_extract(promotion.payload_json, '$.messageId') AS message_id,
      json_extract(promotion.payload_json, '$.nodeId') AS node_id,
      (
        SELECT thought.payload_json
        FROM orchestration_events AS thought
        WHERE thought.event_type = 'turn-item.updated'
          AND thought.application_event_version = 2
          AND thought.stream_id = promotion.stream_id
          AND thought.sequence < promotion.sequence
          AND json_extract(thought.payload_json, '$.id') = json_extract(promotion.payload_json, '$.id')
          AND json_extract(thought.payload_json, '$.type') = 'reasoning'
        ORDER BY thought.sequence DESC
        LIMIT 1
      ) AS thought_json
    FROM orchestration_events AS promotion
    WHERE promotion.event_type = 'turn-item.updated'
      AND promotion.application_event_version = 2
      AND json_extract(promotion.payload_json, '$.type') = 'assistant_message'
      AND json_extract(promotion.payload_json, '$.nativeItemRef.driver') = 'claudeAgent'
      AND json_extract(promotion.payload_json, '$.nativeItemRef.nativeId') LIKE '%:thinking:0'
  `;
  yield* sql`DELETE FROM claude_lone_thinking WHERE thought_json IS NULL`;

  yield* sql`
    UPDATE orchestration_v2_projection_turn_items
    SET
      type = 'reasoning',
      node_id = (
        SELECT json_extract(thought_json, '$.nodeId') FROM claude_lone_thinking
        WHERE claude_lone_thinking.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
        ORDER BY sequence DESC LIMIT 1
      ),
      status = (
        SELECT json_extract(thought_json, '$.status') FROM claude_lone_thinking
        WHERE claude_lone_thinking.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
        ORDER BY sequence DESC LIMIT 1
      ),
      updated_at = (
        SELECT json_extract(thought_json, '$.updatedAt') FROM claude_lone_thinking
        WHERE claude_lone_thinking.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
        ORDER BY sequence DESC LIMIT 1
      ),
      payload_json = (
        SELECT thought_json FROM claude_lone_thinking
        WHERE claude_lone_thinking.turn_item_id = orchestration_v2_projection_turn_items.turn_item_id
        ORDER BY sequence DESC LIMIT 1
      ),
      historical_text_bytes = 0,
      native_attachment_allowance = 0
    WHERE type = 'assistant_message'
      AND turn_item_id IN (SELECT turn_item_id FROM claude_lone_thinking)
  `;
  yield* sql`
    DELETE FROM orchestration_v2_projection_messages
    WHERE message_id IN (SELECT message_id FROM claude_lone_thinking)
  `;
  yield* sql`
    DELETE FROM orchestration_v2_projection_nodes
    WHERE kind = 'assistant_message' AND node_id IN (SELECT node_id FROM claude_lone_thinking)
  `;

  yield* sql`
    DELETE FROM orchestration_events
    WHERE sequence IN (SELECT sequence FROM claude_lone_thinking)
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE application_event_version = 2
      AND event_type = 'message.updated'
      AND json_extract(payload_json, '$.id') IN (SELECT message_id FROM claude_lone_thinking)
  `;
  yield* sql`
    DELETE FROM orchestration_events
    WHERE application_event_version = 2
      AND event_type = 'node.updated'
      AND json_extract(payload_json, '$.kind') = 'assistant_message'
      AND json_extract(payload_json, '$.id') IN (SELECT node_id FROM claude_lone_thinking)
  `;
  yield* sql`DROP TABLE claude_lone_thinking`;
});
