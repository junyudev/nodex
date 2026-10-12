import type { ThreadRealtimeItem } from "@nodex/codex-app-server-protocol/v2";
import type { ClientRequestResponsesByMethod } from "@nodex/effect-codex-app-server/rpc";
import notificationSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import { createGeneratedCodexSchema } from "./generated-codex-schema";

type RealtimeWireItem = Extract<
  ClientRequestResponsesByMethod["thread/timeline/list"]["data"][number],
  { readonly type: "realtime" }
>["item"];
const wireSchema = createGeneratedCodexSchema<RealtimeWireItem>({
  $schema: notificationSchema.$schema,
  definitions: notificationSchema.definitions,
  $ref: "#/definitions/definitions__v2__ThreadRealtimeItem",
});

/** Validates the native wire fields before exposing the generated consumer's camel-case identity. */
export function normalizeCodexRealtimeItem(input: unknown): ThreadRealtimeItem {
  const item = wireSchema.parse(input);
  if (item.type !== "bemItemPromoted") return item;
  return {
    type: item.type,
    id: item.id,
    realtimeSessionId: item.realtimeSessionId,
    turnId: item.turn_id,
    itemId: item.item_id,
    presentation: item.presentation,
  };
}
