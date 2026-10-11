import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";
import { InboxSendInputSchema } from "../schemas/inbox";

export const sendToInboxSchema = z.strictObject({
  text: InboxSendInputSchema.shape.text,
  title: z.string().trim().min(1).max(200).optional(),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});

export const sendToInboxTool: Tool = {
  name: "send_to_inbox",
  description:
    "Leave a message in the user's Inbox for something outside your current task: a follow-up, an idea, or a question the user should decide later. Write it as a self-contained note; the whole text becomes the message. Give a short title to name it yourself; otherwise Nodex names it. The message is recorded as coming from this chat and starts no work; the user decides where it goes. A Turn can send at most 5 messages. Reuse operationId and identical arguments to retry without sending twice.",
  inputSchema: z.toJSONSchema(sendToInboxSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
