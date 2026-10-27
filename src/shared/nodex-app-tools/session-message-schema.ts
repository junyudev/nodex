import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@nodex/agent-runtime/contracts";
import { sessionExecutionSchema } from "./session-execution-target";
import { isBoundedOperationId } from "../operation-identity";

export const sessionAttachmentSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("library_file"),
    fileId: z.string().trim().min(1).max(512),
    pageId: z.string().trim().min(1).max(512).optional(),
    version: z.number().int().positive().optional(),
  }),
  z.strictObject({
    type: z.literal("session_attachment"),
    sessionId: z.string().trim().min(1).max(512),
    execution: sessionExecutionSchema.optional(),
    sourceThreadId: z.string().trim().min(1).max(512).optional(),
    itemId: z.string().trim().min(1).max(512),
    attachmentId: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .describe(
        "Runtime attachment ID; Native input:<content index>, content:<tool output index>, or image for viewed/generated images",
      ),
    runId: z.string().trim().min(1).max(512).optional(),
    nativeCursor: z.string().min(1).max(4096).optional(),
  }),
]);
export type SessionAttachmentReference = z.infer<typeof sessionAttachmentSchema>;

export const sessionMessageSchema = z
  .strictObject({
    sessionId: z.string().trim().min(1).max(512),
    execution: sessionExecutionSchema.optional(),
    prompt: z.string().trim().max(120_000).default(""),
    attachments: z
      .array(sessionAttachmentSchema)
      .max(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
      .default([]),
    mode: z.enum(["auto", "queue", "steer", "restart"]).default("auto"),
    /** Another configured Agent from list_agent_models; it continues with the conversation so far. */
    providerInstanceId: z.string().trim().min(1).max(128).optional(),
    model: z.string().trim().min(1).max(256).optional(),
    operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
  })
  .refine((input) => input.prompt.length > 0 || input.attachments.length > 0, {
    message: "A message or attachment is required",
  })
  .refine((input) => input.providerInstanceId === undefined || input.model !== undefined, {
    message: "Choose the model the other Agent runs",
    path: ["model"],
  });

export const sessionMessageTool: Tool = {
  name: "send_message_to_session",
  description:
    "Send a message or authorized attachment resource to an unarchived Session, including the calling Session or a Runtime child selected by execution.threadId. An unstarted draft starts in place. A settled local Native Session is adopted into Runtime in place; an active local source returns active_source_busy, and remote Native execution keeps its owner. Attach Library Files or visible Session attachments by resource reference. Choose auto, queue, steer, or restart. The target's settings apply within the calling execution's runtime and Plan permissions. Omit model to retain it; providerInstanceId plus model can switch a Runtime Session to another configured Agent. Reuse operationId and identical arguments to retry without another message. The canonical result reports actual delivery with messageId and an assigned runId for read_session and wait_sessions; an unassigned Native queue has a null runId. Use only when the user authorized continuing that Session.",
  inputSchema: z.toJSONSchema(sessionMessageSchema) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
