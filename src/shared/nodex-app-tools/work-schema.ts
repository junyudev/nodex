import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";
import { toolInputSchema } from "./tool-input-schema";

export const reportWorkSchema = z.strictObject({
  pageId: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(512)
    .optional(),
  outcome: z.enum(["ready", "blocked", "failed", "dropped"]),
  summary: z.string().regex(/\S/, "Summary is empty").min(1).max(4000),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const reportWorkTool: Tool = {
  name: "report_work",
  description:
    "The chat's root Agent reports once when the Page's work is ready for review, blocked, failed, or unnecessary (dropped). Delegated Agents return results to the Agent that delegated the task. Include a short Markdown summary of what changed and the evidence. pageId is the Page's key from your brief (such as NODEX-12) or its ID; omit it when this chat has one active work Page or exactly one linked Page. Ready moves In Progress to In Review, with review offered after the chat and its delegated work finish; dropped moves Triage, Todo or In Progress to Canceled. A newer person Status edit takes precedence. Blocked and failed do not move Status. The chat stays open. Reuse idempotencyKey when retrying.",
  inputSchema: toolInputSchema(reportWorkSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const startWorkSchema = z.strictObject({
  pageId: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
  agent: z
    .strictObject({
      instanceId: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
      model: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
      effort: z
        .string()
        .regex(/\S/, "Must contain a non-whitespace character")
        .min(1)
        .max(128)
        .nullable()
        .optional(),
    })
    .optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const startWorkTool: Tool = {
  name: "start_work",
  description:
    "Start work on a Page in its Project's primary Database, in a new managed chat, acting for the user. Start a Page that isn't set to Start automatically only when the user asked you to start it. Uses the Page's Agent Assignee; supplying agent assigns that Agent before starting and turns off Start automatically if the Agent changes. The Page's brief and prerequisites are included. A Page with an active chat cannot be started again through this tool. Reuse idempotencyKey for an identical retry.",
  inputSchema: toolInputSchema(startWorkSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const handBackMessageSchema = z.strictObject({
  reason: z.string().regex(/\S/, "Reason is empty").min(1).max(2000),
});
export const handBackMessageTool: Tool = {
  name: "hand_back_message",
  description:
    "Root Agent of a managed chat only. Return the inbound message you are currently handling to the Inbox when this chat is the wrong destination. Give the routing reason; trusted Host context identifies the message. Preserve its words and author. This is not consent to start work. At most two handbacks are allowed; already-answered questions cannot be returned. Exact retries reuse the receipt. Stop working on that message after handing it back.",
  inputSchema: toolInputSchema(handBackMessageSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const followThreadSchema = z.strictObject({
  url: z.string().url().max(4096),
  role: z.enum(["own_pr", "context"]).optional(),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const followThreadTool: Tool = {
  name: "follow_thread",
  description:
    "Managed chat only. Follow a GitHub PR or issue for this chat's active work Page. Use role own_pr right after you open this Page's PR from a branch Nodex did not prepare: its CI result, reviews and merge then reach this chat and move the Page's Status, as for a Workspace PR. The default role context adds a PR or issue the Page needs as context; context follows never change Status. The repository must be enabled in Sources; Nodex verifies the URL with GitHub. Updates reach this chat as untrusted external data. Workspace PRs and dispatched GitHub requests are followed automatically. Reuse idempotencyKey for an identical retry.",
  inputSchema: toolInputSchema(followThreadSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

export const replyToOriginSchema = z.strictObject({
  pageId: z.string().regex(/\S/, "Page is required").min(1).max(512),
  body: z.string().regex(/\S/, "Reply is empty").min(1).max(16384),
});
export const replyToOriginTool: Tool = {
  name: "reply_to_origin",
  description:
    "From the root Agent of the Page’s active chat, send at most 100 words to this Page's original GitHub request. Use once to acknowledge that work started, or once when its result is ready or merged. Never send routine progress or repeat the same acknowledgement/result. The origin address is fixed by the Page; identical body retries in the same Turn episode reuse the outbox item.",
  inputSchema: toolInputSchema(replyToOriginSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
