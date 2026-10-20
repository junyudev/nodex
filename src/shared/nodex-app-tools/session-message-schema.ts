import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

export const sessionMessageSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(512),
    prompt: z.string().trim().min(1).max(100_000),
    /** Another configured Agent from list_agent_models; it continues with the conversation so far. */
    providerInstanceId: z.string().trim().min(1).max(128).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
  })
  .refine((input) => input.providerInstanceId === undefined || input.model !== undefined, {
    message: "Choose the model the other Agent runs",
    path: ["model"],
  });

export const sessionMessageTool: Tool = {
  name: "send_message_to_session",
  description:
    "Send a follow-up prompt to an existing, unarchived Agent Session. This starts a Turn using the Session's settings; omit model to keep its model. To continue the Session on another Agent, set providerInstanceId and model from list_agent_models: that Agent receives the conversation so far, and read_session reports the Session's current agent. Use only when the user authorized continuing that Session. Reuse operationId and identical arguments to retry: a replay never sends another message and returns unconfirmed when delivery cannot be proven. Read the Session to inspect progress. Sessions without execution are unavailable for this command.",
  inputSchema: z.toJSONSchema(sessionMessageSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
