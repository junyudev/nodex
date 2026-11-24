import { SessionSettlementIdsSchema } from "../schemas/project-sessions";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";
import { sessionExecutionSchema } from "./session-execution-target";
import { toolInputSchema } from "./tool-input-schema";

const id = z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512);
const idempotencyKey = idempotencyKeySchema.optional();
const target = { sessionId: id, execution: sessionExecutionSchema.optional() };
const queued = { ...target, queuedId: id, idempotencyKey };
export const sessionQueueSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...target,
    action: z.literal("list"),
    idempotencyKey,
    cursor: z.string().min(1).max(4096).optional(),
    limit: z.int().min(1).max(20).default(20),
  }),
  z.strictObject({ ...target, action: z.literal("read"), queuedId: id, idempotencyKey }),
  z.strictObject({
    ...queued,
    action: z.literal("edit"),
    text: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(100000),
  }),
  z.strictObject({ ...queued, action: z.literal("remove") }),
  z.strictObject({ ...queued, action: z.literal("reorder"), beforeId: id.nullable() }),
  z.strictObject({ ...queued, action: z.literal("steer") }),
]);
export const sessionQueueErrorSchema = z.strictObject({
  reason: z.enum(["not_queued", "invalid_cursor", "protected_entry", "unsupported"]),
  message: z.string(),
});
const queueEntrySchema = z.strictObject({
  queuedId: id,
  text: z.string().max(120000),
  truncated: z.boolean(),
  kind: z.enum(["message", "delegated_completion", "notification"]),
  held: z.boolean(),
});
export const sessionQueueResultSchema = z.union([
  z.strictObject({
    items: z.array(queueEntrySchema).max(20),
    nextCursor: z.string().max(4096).nullable(),
  }),
  queueEntrySchema,
  z.strictObject({ sequence: z.int().nonnegative() }),
]);
export const sessionQueueOwnerResultSchema = z.union([
  z.strictObject({ error: sessionQueueErrorSchema }),
  z.strictObject({ value: sessionQueueResultSchema }),
]);
export type SessionQueueInput = z.infer<typeof sessionQueueSchema>;
export const sessionControlSchemas = {
  stop_session: z.strictObject({
    ...target,
    reason: z
      .string()
      .regex(/\S/, "Must contain a non-whitespace character")
      .min(1)
      .max(2000)
      .optional(),
    idempotencyKey,
  }),
  set_session_snooze: z.strictObject({
    sessionId: id.optional(),
    until: z.iso.datetime({ offset: true }).nullable(),
    idempotencyKey,
  }),
  set_session_unread: z.strictObject({
    sessionId: id.optional(),
    unread: z.boolean(),
    idempotencyKey,
  }),
  set_session_settled: z.strictObject({
    sessionIds: SessionSettlementIdsSchema,
    settled: z.boolean(),
    idempotencyKey,
  }),
  session_queue: sessionQueueSchema,
};
const descriptions: Record<keyof typeof sessionControlSchemas, string> = {
  stop_session:
    "Stop a Session's running work as the user's Stop does: end its current turn, hold queued messages and stop delegated tasks. Idle Sessions are unchanged. The calling Session cannot stop itself. Use only when the user authorized it. Reuse idempotencyKey and identical arguments to retry without repeating the change.",
  set_session_snooze:
    "Snooze a chat for the Member you act for. Set until to an ISO 8601 instant with an offset up to 366 days ahead, or null to wake it. It becomes unread at that time. A new question, approval request, or failed Run wakes it early, as do a pin, settlement, or a message from the Member. Omit sessionId for your calling Session. Reuse idempotencyKey and identical arguments to retry without repeating the change.",
  set_session_unread:
    "Mark a Nodex Session read or unread, as its sidebar shows. Omit sessionId for your calling Session. Reuse idempotencyKey and identical arguments to retry without repeating the change.",
  set_session_settled:
    "Settle 1–200 distinct chats for the Member you act for, or reopen them with settled: false. Settling moves each chat to their Settled shelf, unpins it, and ends its snooze. The result includes only the IDs whose settlement changed. Reuse idempotencyKey and identical arguments to retry without repeating the change.",
  session_queue:
    "Manage messages queued behind a Session's active turn, or a Runtime child's via execution.threadId. list: delivery order; read: one by queuedId; edit: replace text, keeping attachments; remove: drop a message; reorder: before beforeId, or last with null; steer: send it into the active turn. Runtime deliveries (delegated_completion and notification) are read-only. Writes fail once it has started. Reuse idempotencyKey and identical arguments to retry without repeating the change.",
};
export const sessionControlToolCatalog: readonly Tool[] = Object.entries(sessionControlSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: toolInputSchema(schema),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }),
);
