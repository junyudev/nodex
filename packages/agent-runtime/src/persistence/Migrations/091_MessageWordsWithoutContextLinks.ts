import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A message's context records used to be bound by links appended to its text. Records now travel
 * on their own, so stored user messages keep only the words their author wrote.
 *
 * A link is removed only when the message's own records name it. The same syntax anywhere else is
 * text someone wrote, such as an Agent discussing the format, and stays as written. Rollback
 * rebuilds projections from events, so the events a message came from change with it.
 */
const LINK_SCHEME = "t3-context://";
const CONTEXT_LINK =
  /!?\[[^\]\n]{0,512}\]\(t3-context:\/\/v1\/[a-z][a-z0-9-]{0,39}\/([A-Za-z0-9_-]{1,128})\)/gu;

const wordsOnly = (payloadJson: string) => {
  const payload = JSON.parse(payloadJson) as {
    readonly text?: unknown;
    readonly context?: { readonly records?: ReadonlyArray<{ readonly contextId?: unknown }> };
  };
  if (typeof payload.text !== "string") return null;
  const named = new Set(payload.context?.records?.map((record) => record.contextId));
  const stripped = payload.text.replace(CONTEXT_LINK, (link, contextId: string) =>
    named.has(contextId) ? "" : link,
  );
  if (stripped === payload.text) return null;
  const text = stripped.trimEnd();
  return { text, payloadJson: JSON.stringify({ ...payload, text }) };
};

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const messages = yield* sql<{
    readonly message_id: string;
    readonly thread_id: string;
    readonly payload_json: string;
  }>`SELECT message_id, thread_id, payload_json FROM orchestration_v2_projection_messages
    WHERE role = 'user' AND instr(payload_json, ${LINK_SCHEME}) > 0`;
  const threadIds = new Set<string>();
  for (const message of messages) {
    const revised = wordsOnly(message.payload_json);
    if (revised === null) continue;
    threadIds.add(message.thread_id);
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = ${revised.payloadJson}
      WHERE message_id = ${message.message_id}`;
    yield* sql`UPDATE orchestration_v2_projection_threads
      SET conversation_preview = ${Array.from(revised.text.slice(0, 1024)).slice(0, 512).join("")}
      WHERE thread_id = ${message.thread_id} AND conversation_preview_id = ${message.message_id}`;
  }
  for (const threadId of threadIds) {
    const items = yield* sql<{
      readonly turn_item_id: string;
      readonly payload_json: string;
    }>`SELECT turn_item_id, payload_json FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND type = 'user_message'
        AND instr(payload_json, ${LINK_SCHEME}) > 0`;
    for (const item of items) {
      const revised = wordsOnly(item.payload_json);
      if (revised === null) continue;
      yield* sql`UPDATE orchestration_v2_projection_turn_items
        SET payload_json = ${revised.payloadJson} WHERE turn_item_id = ${item.turn_item_id}`;
    }
    const events = yield* sql<{
      readonly sequence: number;
      readonly payload_json: string;
    }>`SELECT sequence, payload_json FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        AND instr(payload_json, ${LINK_SCHEME}) > 0`;
    for (const event of events) {
      const revised = wordsOnly(event.payload_json);
      if (revised === null) continue;
      yield* sql`UPDATE orchestration_events SET payload_json = ${revised.payloadJson}
        WHERE sequence = ${event.sequence}`;
    }
  }
});
