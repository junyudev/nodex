import type {
  EventId,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Normalized actions, including plan tools and image tools (represented as dynamic_tool). */
export const READBACK_ACTION_TYPES = [
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "thread_created",
  "todo_list",
] as const satisfies ReadonlyArray<OrchestrationV2TurnItem["type"]>;

export const canAdvanceReadback = (item: OrchestrationV2TurnItem) =>
  (item.type === "assistant_message" && item.status === "completed" && !item.streaming) ||
  READBACK_ACTION_TYPES.some((type) => type === item.type);

/** The in-memory projection uses the same committed-item and root-execution contract. */
export function projectRunReadback(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
  eventId: EventId,
): OrchestrationV2ThreadProjection {
  if (item.runId === null || !canAdvanceReadback(item)) return projection;
  const run = projection.runs.find((run) => run.id === item.runId);
  if (!run || run.readback || !["starting", "running", "waiting"].includes(run.status))
    return projection;
  const rootNodes = new Set(
    projection.nodes
      .filter(
        (node) =>
          node.threadId === run.threadId &&
          node.runId === run.id &&
          node.rootNodeId === run.rootNodeId,
      )
      .map((node) => node.id),
  );
  if (item.nodeId === null || !rootNodes.has(item.nodeId)) return projection;
  const items = projection.turnItems.filter(
    (entry) =>
      entry.threadId === run.threadId &&
      entry.runId === run.id &&
      entry.nodeId !== null &&
      rootNodes.has(entry.nodeId),
  );
  const candidate = items
    .filter(
      (entry) =>
        entry.type === "assistant_message" &&
        entry.status === "completed" &&
        !entry.streaming &&
        entry.responseKind !== "final" &&
        entry.text.trim().length > 0 &&
        (entry.responseKind === "commentary" ||
          items.some(
            (action) =>
              action.ordinal > entry.ordinal &&
              READBACK_ACTION_TYPES.some((type) => type === action.type),
          )),
    )
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))[0];
  if (candidate?.type !== "assistant_message") return projection;
  const readback: OrchestrationV2Run["readback"] = {
    itemId: candidate.id,
    text: capReadback(candidate.text),
    eventId,
  };
  return {
    ...projection,
    runs: projection.runs.map((entry) => (entry.id === run.id ? { ...entry, readback } : entry)),
  };
}

export function capReadback(text: string): string {
  if (text.length <= 4_000) return text;
  const prefix = text.slice(0, 3_999);
  const boundary = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf(" "));
  // Keep most of the statement even when it contains a very long unbroken paragraph.
  const end = boundary >= 3_000 ? boundary : /[\uD800-\uDBFF]$/.test(prefix) ? 3_998 : 3_999;
  return `${prefix.slice(0, end).trimEnd()}…`;
}

/**
 * Fold committed items into a write-once Run fact in the same projection transaction.
 * Node roots, rather than provider Thread ids, fence out children and superseded attempts.
 * Activity reads only this bounded fact. The trigger id lets execution observers discard all
 * unrelated transcript traffic, including streaming deltas, before coalescing root changes.
 */
export const recordRunReadback = Effect.fnUntraced(function* (
  item: OrchestrationV2TurnItem,
  eventId: string,
) {
  if (item.runId === null || !canAdvanceReadback(item)) return;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly turn_item_id: string; readonly text: string }>`
    SELECT candidate.turn_item_id, json_extract(candidate.payload_json, '$.text') AS text
    FROM orchestration_v2_projection_runs AS run
    CROSS JOIN orchestration_v2_projection_turn_items AS candidate
      ON candidate.run_id = run.run_id AND candidate.thread_id = run.thread_id
    JOIN orchestration_v2_projection_nodes AS node ON node.node_id = candidate.node_id
      AND node.thread_id = run.thread_id AND node.run_id = run.run_id
      AND node.root_node_id = json_extract(run.payload_json, '$.rootNodeId')
    WHERE run.run_id = ${item.runId} AND run.thread_id = ${item.threadId}
      AND run.status IN ('starting', 'running', 'waiting')
      AND EXISTS (SELECT 1 FROM orchestration_v2_projection_nodes AS trigger_node
        WHERE trigger_node.node_id = ${item.nodeId} AND trigger_node.thread_id = run.thread_id
          AND trigger_node.run_id = run.run_id
          AND trigger_node.root_node_id = json_extract(run.payload_json, '$.rootNodeId'))
      AND json_extract(run.payload_json, '$.readback') IS NULL
      AND candidate.type = 'assistant_message' AND candidate.status = 'completed'
      AND json_extract(candidate.payload_json, '$.streaming') = 0
      AND json_extract(candidate.payload_json, '$.responseKind') IS NOT 'final'
      AND (json_extract(candidate.payload_json, '$.responseKind') = 'commentary' OR EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS action
        JOIN orchestration_v2_projection_nodes AS action_node ON action_node.node_id = action.node_id
          AND action_node.thread_id = run.thread_id AND action_node.run_id = run.run_id
          AND action_node.root_node_id = json_extract(run.payload_json, '$.rootNodeId')
        WHERE action.thread_id = run.thread_id AND action.run_id = run.run_id
          AND action.ordinal > candidate.ordinal AND action.type IN ${sql.in(READBACK_ACTION_TYPES)}
      ))
    ORDER BY candidate.ordinal, candidate.turn_item_id`;
  // Structured questions are user_input_request items, never assistant_message.
  const candidate = rows.find((row) => row.text.trim().length > 0);
  if (candidate === undefined) return;
  const readback = JSON.stringify({
    itemId: candidate.turn_item_id,
    text: capReadback(candidate.text),
    eventId,
  });
  yield* sql`UPDATE orchestration_v2_projection_runs
    SET payload_json = json_set(payload_json, '$.readback', json(${readback}))
    WHERE run_id = ${item.runId} AND json_extract(payload_json, '$.readback') IS NULL`;
});
