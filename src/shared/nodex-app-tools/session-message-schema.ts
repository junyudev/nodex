import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

export const sessionMessageSchema = z.strictObject({
  sessionId: z.string().trim().min(1).max(512),
  prompt: z.string().trim().min(1).max(100_000),
  model: z.string().trim().min(1).max(256).optional(),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});

export const sessionMessageTool: Tool = {
  name: "send_message_to_session",
  description:
    "Send a follow-up prompt to an existing, unarchived Codex Session. This starts a Turn using the Session's settings; omit model to keep its model. Use only when the user authorized continuing that Session. Reuse operationId and identical arguments to retry: a replay never sends another message and returns unconfirmed when delivery cannot be proven. Read the Session to inspect progress. Project-scoped Turns can send only within their own Project. ACP and threadless Sessions are unavailable for this command.",
  inputSchema: z.toJSONSchema(sessionMessageSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
