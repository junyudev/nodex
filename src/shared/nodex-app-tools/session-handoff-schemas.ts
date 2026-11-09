import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";

const sessionId = z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512);
const operationId = z
  .string()

  .min(1)
  .max(512)
  .describe("Server-issued operationId returned by handoff_session; echo it unchanged.");
export const sessionHandoffSchema = z.strictObject({
  sessionId,
  destinationHostId: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(512)
    .optional(),
  followUpPrompt: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(100_000)
    .optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const handoffStatusSchema = z.strictObject({
  sessionId,
  operationId,
  afterRevision: z.number().int().min(0).optional(),
  waitMs: z.number().int().min(0).max(60_000).default(0),
});
export const sessionHandoffTool: Tool = {
  name: "handoff_session",
  description:
    "Move another Agent Session between its checkout and managed worktree, or to an explicitly selected execution host. Running work is interrupted. Omit destinationHostId for the current-host toggle. Use only when the user authorizes the move; followUpPrompt sends a message after success. Returns immediately with operationId and progress. Retry with identical arguments and idempotencyKey; a replay never moves again. The calling Session cannot move itself. ",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
export const handoffStatusTool: Tool = {
  name: "get_handoff_status",
  description:
    "Read a Session handoff operation. Supply the Session and operation IDs returned by handoff_session. Use afterRevision and waitMs up to 60000 to wait for a change. Current Session access is checked before and after waiting. Retained outcomes remain readable after restart; an unknown operation does not imply the move is safe to repeat.",
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
