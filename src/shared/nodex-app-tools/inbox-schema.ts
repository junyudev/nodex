import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";
import { MAX_INBOX_MESSAGE_BYTES, InboxSendInputSchema } from "../schemas/inbox";
import { toolInputSchema } from "./tool-input-schema";

export const sendToInboxSchema = z
  .strictObject({
    body: z
      .string()
      .regex(/\S/, "Message is empty")
      .min(1)
      .max(MAX_INBOX_MESSAGE_BYTES)
      .describe("Message text, at most 65536 UTF-8 bytes"),
    title: z
      .string()
      .regex(/\S/, "Must contain a non-whitespace character")
      .min(1)
      .max(200)
      .optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .superRefine((input, context) => {
    const body = InboxSendInputSchema.shape.body.safeParse(input.body);
    if (body.success) return;
    for (const issue of body.error.issues)
      context.addIssue({ code: "custom", path: ["body", ...issue.path], message: issue.message });
  });

export const sendToInboxTool: Tool = {
  name: "send_to_inbox",
  description:
    "Leave a message in the user's Inbox for something outside your current task: a follow-up, an idea, or a question the user should decide later. Write it as a self-contained note in Markdown, with a blank line between paragraphs; the whole body becomes the message. Give a short title to name it yourself; otherwise Nodex names it. The message is recorded as coming from this chat and lands in the Inbox of this chat's Project, or the Library Inbox for a projectless chat. It starts no work; the user decides what happens to it. Send at most 5 messages per Run, or per native connection when the Run is unknown. Reuse idempotencyKey to retry without sending twice.",
  inputSchema: toolInputSchema(sendToInboxSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
