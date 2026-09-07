import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

const sessionId = z.string().trim().min(1).max(512);
const operationId = z.string().max(512).refine(isBoundedOperationId);
export const sessionHandoffSchema = z.strictObject({
  sessionId,
  destinationHostId: z.string().trim().min(1).max(512).optional(),
  followUpPrompt: z.string().trim().min(1).max(100_000).optional(),
  operationId: operationId.optional(),
});
export const handoffStatusSchema = z.strictObject({
  sessionId,
  operationId,
  afterRevision: z.number().int().min(0).optional(),
  waitMs: z.number().int().min(0).max(60_000).default(0),
});
export const sessionHandoffTools: readonly Tool[] = [
  {
    name: "handoff_session",
    description:
      "Move another Codex Session between its checkout and managed worktree, or to an explicitly selected execution host. Running work is interrupted. Omit destinationHostId for the current-host toggle. Use only when the user authorizes the move; followUpPrompt sends a message after success. Returns immediately with operationId and progress. Retry with identical arguments and operationId; a replay never moves again. The calling Session cannot move itself. Project-scoped Turns can move only Sessions in their Project.",
    inputSchema: z.toJSONSchema(sessionHandoffSchema) as Tool["inputSchema"],
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "get_handoff_status",
    description:
      "Read a Session handoff operation. Supply the Session and operation IDs returned by handoff_session. Use afterRevision and waitMs up to 60000 to wait for a change. Current Session access is checked before and after waiting. Retained outcomes remain readable after restart; an unknown operation does not imply the move is safe to repeat.",
    inputSchema: z.toJSONSchema(handoffStatusSchema) as Tool["inputSchema"],
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
];
