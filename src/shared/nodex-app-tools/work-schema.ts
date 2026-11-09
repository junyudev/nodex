import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";

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
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
