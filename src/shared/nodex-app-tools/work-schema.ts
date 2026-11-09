import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";

export const reportWorkSchema = z.strictObject({
  outcome: z.enum(["ready", "blocked", "failed", "dropped"]),
  summary: z.string().regex(/\S/, "Summary is empty").min(1).max(4000),
  idempotencyKey: idempotencyKeySchema.optional(),
});
export const reportWorkTool: Tool = {
  name: "report_work",
  description:
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
};
