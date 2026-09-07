import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

export const sessionForkSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(512).optional(),
  environment: z
    .strictObject({ type: z.enum(["same-directory", "worktree"]) })
    .default({ type: "same-directory" }),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});
export const sessionForkTool: Tool = {
  name: "fork_session",
  description:
    "Fork completed conversation history into a separate visible Codex Session. Omit sessionId to fork the calling Session. Default environment shares the source directory; worktree forks prepare a managed worktree asynchronously. Returns a stable destination sessionId with attached, pending or unconfirmed state. Active, unfinished output is not copied. Send a follow-up to the child only when continuing there is authorized. Reuse operationId and identical arguments for retries; replay never forks twice. Project-scoped Turns can fork only within their Project.",
  inputSchema: z.toJSONSchema(sessionForkSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
