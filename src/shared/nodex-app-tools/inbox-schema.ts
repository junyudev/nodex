import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";
import { InboxSendInputSchema } from "../schemas/inbox";

export const sendToInboxSchema = z.strictObject({
  body: InboxSendInputSchema.shape.body,
  title: z.string().trim().min(1).max(200).optional(),
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
});

export const sendToInboxTool: Tool = {
  name: "send_to_inbox",
  description:
    "Leave a message in the user's Inbox for something outside your current task: a follow-up, an idea, or a question the user should decide later. Write it as a self-contained note in Markdown, with a blank line between paragraphs; the whole body becomes the message. Give a short title to name it yourself; otherwise Nodex names it. The message is recorded as coming from this chat and lands in the Inbox of this chat's Project, or the Library Inbox for a projectless chat. It starts no work; the user decides what happens to it. Send at most 5 messages per Run, or per native connection when the Run is unknown. Reuse operationId to retry without sending twice.",
  inputSchema: z.toJSONSchema(sendToInboxSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
