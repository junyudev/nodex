import { z } from "zod";

const kind = z.enum(["page", "block", "chat"]);
const id = z.string().min(1).max(256);
export const searchInputSchema = z.strictObject({
  query: z.string().min(1).max(200).regex(/\S/, "Must contain a non-whitespace character"),
  kinds: z
    .array(kind)
    .min(1)
    .max(3)
    .optional()
    .describe("Defaults to Pages and chats. Include block to match within individual Blocks."),
  place: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("everywhere") }),
      z.strictObject({ kind: z.literal("project"), projectId: id }),
    ])
    .optional()
    .describe("Defaults to every readable location in the current Space."),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(128).optional(),
});

const anchor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("block"), pageId: id, blockId: id }),
  z.strictObject({
    kind: z.literal("chat_item"),
    sessionId: id,
    sourceThreadId: id,
    itemId: id,
    runId: id.nullable(),
    matchedText: z.string(),
  }),
]);

export const searchOutputSchema = z.strictObject({
  data: z.strictObject({
    results: z.array(
      z.strictObject({
        kind,
        identity: id,
        title: z.string(),
        location: z.strictObject({ projectId: id.nullable(), label: z.string().nullable() }),
        evidence: z.array(
          z.strictObject({
            field: z.string(),
            parts: z.array(z.strictObject({ text: z.string(), highlighted: z.boolean() })),
            anchor: anchor.optional(),
          }),
        ),
        rank: z.strictObject({
          text: z.number().int().nonnegative().nullable(),
          strong: z.boolean(),
          ordered: z.boolean(),
        }),
        archived: z.boolean(),
      }),
    ),
    coverage: z.array(
      z.strictObject({
        source: z.enum(["pages", "blocks", "chat_catalog", "runtime", "codex"]),
        state: z.enum(["complete", "pending", "indexing", "partial", "unavailable", "timed_out"]),
        truncated: z.boolean().optional(),
      }),
    ),
    truncated: z.boolean(),
  }),
  page: z.strictObject({ hasMore: z.boolean(), nextCursor: z.string().optional() }),
});
