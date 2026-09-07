import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";

const utf8 = new TextEncoder();
const boundedText = (maxBytes: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maxBytes)
    .refine((value) => utf8.encode(value).length <= maxBytes, "Text exceeds its UTF-8 byte bound");
const id = boundedText(512);
const expectedRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationFields = {
  operationId: z.string().max(512).refine(isBoundedOperationId).optional(),
};
const definitionFields = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(512)
    .refine((value) => Array.from(value).length <= 256, "Name must not exceed 256 characters"),
  prompt: boundedText(1024 * 1024).describe(
    "Self-contained task instructions. Keep scheduling, execution settings, and notification preferences in their separate fields.",
  ),
  rrule: boundedText(16 * 1024).describe("RRULE schedule interpreted by the local scheduler."),
  notificationPolicy: z
    .literal("failed_runs_only")
    .nullable()
    .optional()
    .describe(
      "Suppress completion notifications except failed runs; null restores normal notifications.",
    ),
  ...operationFields,
};
const cronFields = {
  ...definitionFields,
  kind: z.literal("cron"),
  projectId: id
    .nullable()
    .describe("Explicit Project ID, or null for an independent projectless local run."),
  executionEnvironment: z.enum(["local", "worktree"]),
  model: boundedText(512).optional(),
  reasoningEffort: boundedText(64).optional(),
  serviceTier: boundedText(64).optional(),
  cwds: z
    .array(boundedText(16 * 1024))
    .max(128)
    .optional()
    .describe(
      "Absolute folders belonging to the selected Project. Omit or use [] for projectless runs.",
    ),
  localEnvironmentConfigPath: boundedText(16 * 1024)
    .optional()
    .describe("Optional absolute Environment configuration path for worktree setup."),
};
const heartbeatFields = {
  ...definitionFields,
  kind: z.literal("heartbeat"),
  targetSessionId: id
    .optional()
    .describe("Stable target Session ID. Omit for the calling Session."),
};
const updateFields = {
  id,
  expectedRevision,
  status: z.enum(["ACTIVE", "PAUSED"]),
};

export const automationSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("list"),
    query: boundedText(512).optional(),
    cursor: z.string().min(1).max(2048).optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  z.strictObject({ mode: z.literal("view"), id }),
  z.discriminatedUnion("kind", [
    z.strictObject({ mode: z.literal("create"), ...cronFields }),
    z.strictObject({ mode: z.literal("create"), ...heartbeatFields }),
  ]),
  z.discriminatedUnion("kind", [
    z.strictObject({ mode: z.literal("update"), ...cronFields, ...updateFields }),
    z.strictObject({ mode: z.literal("update"), ...heartbeatFields, ...updateFields }),
  ]),
  z.discriminatedUnion("kind", [
    z.strictObject({ mode: z.literal("suggested_create"), ...cronFields }),
    z.strictObject({ mode: z.literal("suggested_create"), ...heartbeatFields }),
  ]),
  z.discriminatedUnion("kind", [
    z.strictObject({ mode: z.literal("suggested_update"), ...cronFields, ...updateFields }),
    z.strictObject({ mode: z.literal("suggested_update"), ...heartbeatFields, ...updateFields }),
  ]),
  z.strictObject({ mode: z.literal("delete"), id, expectedRevision, ...operationFields }),
]);

export type AutomationToolInput = z.infer<typeof automationSchema>;
export type AutomationProposal = Extract<
  AutomationToolInput,
  { mode: "suggested_create" | "suggested_update" }
>;

export const automationTool: Tool = {
  name: "automation_update",
  description:
    "List, view, propose, create, replace, or delete a scheduled Codex task. suggested_create and suggested_update return review proposals without saving or scheduling; the user reviews and explicitly saves them. Use heartbeat for follow-ups in a Session; its omitted targetSessionId defaults to the calling Session. Use cron for standalone runs in an explicit Project or with projectId null; Project runs require cwds from that Project, and projectless runs require local execution with no folders or Environment. Creation starts ACTIVE. Use list with an optional name/prompt/ID query and follow nextCursor to find existing tasks. View before update or delete and supply the returned definitionRevision as expectedRevision. Update replaces the complete definition: preserve existing values explicitly; omitted optional fields reset to defaults except notificationPolicy, which preserves the current setting when omitted; pass null to restore normal notifications. Reuse operationId and identical arguments to reconcile an uncertain mutation. Project-scoped Turns can manage only their own Project's tasks and Heartbeat targets. Only the native Codex backend is supported.",
  inputSchema: { ...z.toJSONSchema(automationSchema), type: "object" } as Tool["inputSchema"],
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
