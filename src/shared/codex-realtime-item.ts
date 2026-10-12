import type { ThreadRealtimeItem } from "@nodex/codex-app-server-protocol/v2";
import notificationSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import { createGeneratedCodexSchema } from "./generated-codex-schema";

const wireSchema = createGeneratedCodexSchema<ThreadRealtimeItem>({
  $schema: notificationSchema.$schema,
  definitions: notificationSchema.definitions,
  $ref: "#/definitions/definitions__v2__ThreadRealtimeItem",
});

/** Validates the native wire identity without decoding it into a competing shape. */
export function normalizeCodexRealtimeItem(input: unknown): ThreadRealtimeItem {
  return wireSchema.parse(input);
}
