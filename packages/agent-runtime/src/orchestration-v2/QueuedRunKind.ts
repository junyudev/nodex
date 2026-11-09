import type { OrchestrationV2ConversationMessage } from "@nodex/runtime-contracts";
import type { SqlClient } from "effect/sql/SqlClient";
import type { Fragment } from "effect/sql/Statement";

// Presence of these durable markers separates Agent deliveries from the user's outbox.
// Person-authored messages take precedence over automatic deliveries.
const deliveryMarkers = [
  ["delegatedCompletion", "delegated_completion"],
  ["notification", "notification"],
] as const satisfies ReadonlyArray<readonly [keyof OrchestrationV2ConversationMessage, string]>;

export type QueuedRunKind = "message" | (typeof deliveryMarkers)[number][1];
type Message = Pick<
  OrchestrationV2ConversationMessage,
  (typeof deliveryMarkers)[number][0] | "createdBy" | "creationSource"
>;

// Host work messages use the same protected queue category as Runtime notifications.
export const queuedMessageKind = (message: Message): QueuedRunKind =>
  deliveryMarkers.find(([marker]) => message[marker] !== undefined)?.[1] ??
  (message.createdBy === "system" && message.creationSource === "server"
    ? "notification"
    : "message");

export const isRuntimeDeliveryMessage = (message: Message): boolean =>
  queuedMessageKind(message) !== "message";

/** SQL uses the same marker list and precedence as in-memory command and replay reads. */
export const queuedMessageKindSql = (sql: SqlClient, payload: Fragment): Fragment => {
  const cases = deliveryMarkers.map(
    ([marker, kind]) => sql`WHEN json_type(${payload}, ${`$.${marker}`}) IS NOT NULL THEN ${kind}`,
  );
  return sql`CASE ${sql.join(" ", false)(cases)}
    WHEN json_extract(${payload}, '$.createdBy') = 'system'
      AND json_extract(${payload}, '$.creationSource') = 'server' THEN 'notification'
    ELSE 'message' END`;
};

/** SQL delivery priority matching queuedRunsInDeliveryOrder: 0 runs before 1. */
export const queuedRunPrioritySql = (sql: SqlClient, payload: Fragment): Fragment =>
  sql`CASE WHEN json_extract(${payload}, '$.createdBy') = 'user'
    AND ${queuedMessageKindSql(sql, payload)} = 'message' THEN 0 ELSE 1 END`;
