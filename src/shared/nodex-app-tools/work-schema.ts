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
    "Report once when work for the Page you were given is ready for review, blocked, failed, or unnecessary (dropped). Include a short Markdown summary of what changed and the evidence. pageId is the Page's key from your brief (such as NODEX-12) or its ID; omit it when this chat has one active work Page or exactly one linked Page. Ready moves In Progress to In Review; dropped moves Triage, Todo or In Progress to Canceled. A newer person Status edit takes precedence. Blocked and failed do not move Status. The chat stays open. Reuse idempotencyKey when retrying.",
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
    "Start work on a Page in its Project's primary Database, in a new managed chat. Uses the Page's Agent Assignee; supplying agent assigns that Agent before starting and turns off Start automatically if the Agent changes. The Page's brief and prerequisites are included. A Page with an active chat cannot be started again through this tool. Reuse idempotencyKey for an identical retry.",
  inputSchema: toolInputSchema(startWorkSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const handBackMessageSchema = z.strictObject({
  reason: z.string().regex(/\S/, "Reason is empty").min(1).max(2000),
});
export const handBackMessageTool: Tool = {
  name: "hand_back_message",
  description:
    "Managed chat only. Return the inbound message you are currently handling to the Inbox when this chat is the wrong destination. Give the routing reason; trusted Host context identifies the message. Preserve its words and author. This is not consent to start work. At most two handbacks are allowed; already-answered questions cannot be returned. Exact retries reuse the receipt. Stop working on that message after handing it back.",
  inputSchema: toolInputSchema(handBackMessageSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};

export const followThreadSchema = z.strictObject({
  url: z.string().url().max(4096),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const followThreadTool: Tool = {
  name: "follow_thread",
  description:
    "Managed chat only. Follow a GitHub PR or issue as context for this chat's active work Page. The repository must be enabled in Sources; Nodex verifies the URL with GitHub. Future updates reach this chat as untrusted external data. Context follows never change Status. Workspace PRs and dispatched GitHub requests are followed automatically. Reuse idempotencyKey for an identical retry.",
  inputSchema: toolInputSchema(followThreadSchema),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
