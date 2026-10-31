import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";
import { sessionExecutionSchema } from "./session-execution-target";

export const sessionQuestionSchema = z
  .strictObject({
    action: z.enum(["list", "read", "respond"]),
    sessionId: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
    execution: sessionExecutionSchema.optional(),
    requestId: z
      .string()
      .regex(/\S/, "Must contain a non-whitespace character")
      .min(1)
      .max(512)
      .optional(),
    answers: z
      .record(z.string().min(1).max(512), z.union([z.string(), z.array(z.string())]))
      .optional(),
    idempotencyKey: idempotencyKeySchema.optional(),
  })
  .superRefine((input, context) => {
    if (input.action !== "list" && input.requestId === undefined)
      context.addIssue({
        code: "custom",
        path: ["requestId"],
        message: "This action needs requestId",
      });
    if (input.action === "respond" && input.answers === undefined)
      context.addIssue({ code: "custom", path: ["answers"], message: "This action needs answers" });
  });

export const sessionQuestionTool: Tool = {
  name: "session_question",
  description:
    "Pending questions in a Session's conversation, or in a Runtime child selected by execution.threadId. list: their requestIds; approvals are excluded. read: one by requestId. respond: answer it with answers, as the user would in its question panel; this cannot approve a permission request. Answer only when the user's instructions decide it; otherwise ask the user. The answer is attributed to your conversation. Reuse idempotencyKey and identical arguments to retry without another answer.",
  inputSchema: z.toJSONSchema(sessionQuestionSchema, { io: "input" }) as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
