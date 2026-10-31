import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";

const commandFields = {
  sessionId: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(512)
    .optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
};
export const sessionSchemas = {
  set_session_title: z.strictObject({
    ...commandFields,
    title: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
  }),
  set_session_archived: z.strictObject({ ...commandFields, archived: z.boolean() }),
  set_session_pinned: z.strictObject({ ...commandFields, pinned: z.boolean() }),
};

const descriptions: Record<keyof typeof sessionSchemas, string> = {
  set_session_title:
    "Rename a Nodex Session, including drafts without a Thread and ACP Sessions. Omit sessionId to rename your calling Session. Returns the accepted title and operation receipt; reuse idempotencyKey with identical arguments for retries.",
  set_session_archived:
    "Archive or restore a Nodex Session, including threadless drafts and ACP Sessions. Omit sessionId for your calling Session. Archiving reconciles the attached backend lifecycle and descendant cleanup. Reuse idempotencyKey for retries.",
  set_session_pinned:
    "Pin or unpin a Nodex Session, including threadless drafts and ACP Sessions. Omit sessionId for your calling Session. Pinning clears custom Section placement. Reuse idempotencyKey for retries.",
};

export const sessionToolCatalog: readonly Tool[] = Object.entries(sessionSchemas).map(
  ([name, schema]) => ({
    name,
    description: descriptions[name as keyof typeof descriptions],
    inputSchema: z.toJSONSchema(schema, { io: "input" }) as Tool["inputSchema"],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }),
);
