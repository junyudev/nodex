import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";

export const sessionForkSchema = z.strictObject({
  sessionId: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(512)
    .optional(),
  environment: z
    .strictObject({ type: z.enum(["same-directory", "worktree"]) })
    .default({ type: "same-directory" }),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const sessionForkTool: Tool = {
  name: "fork_session",
  description:
    "Fork completed conversation history into a separate visible Agent Session. Omit sessionId to fork the calling Session. Default environment shares the source directory; worktree forks prepare a managed worktree asynchronously. Returns a stable destination sessionId with attached, pending or unconfirmed state. Active, unfinished output is not copied. Send a follow-up to the child only when continuing there is authorized. Reuse idempotencyKey and identical arguments for retries; replay never forks twice. ",
  inputSchema: z.toJSONSchema(sessionForkSchema, { io: "input" }) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
