import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { idempotencyKeySchema } from "./idempotency-key";
import { toolInputSchema } from "./tool-input-schema";

const boundedText = (maxBytes: number) =>
  z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(maxBytes)
    .describe(`Nonblank text, at most ${maxBytes} UTF-8 bytes`);
const id = boundedText(512);
const expectedRevision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const operationFields = {
  idempotencyKey: idempotencyKeySchema.optional(),
};
const definitionFields = {
  scope: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("space") }),
      z.strictObject({ kind: z.literal("project"), projectId: id }),
    ])
    .optional()
    .describe(
      "Where this Automation applies, independently of its execution Project; omitted preserves its scope on update.",
    ),
  mode: z
    .enum(["dry_run", "ask_first", "run"])
    .optional()
    .describe(
      "dry_run records decisions, ask_first waits in the Inbox, and run starts work unattended. Prefer ask_first; choose run only when the user asked for unattended runs or clearly wants them. Only the Automation's Owner may choose run or change the mode. Omitted on create defaults to ask_first; omitted on update preserves the current mode.",
    ),
  ownerMemberId: id
    .optional()
    .describe("Member who authorizes this Automation; defaults to the current person."),
  sourceCondition: z
    .strictObject({
      source_id: id.nullable(),
      repositories: z.array(boundedText(512)).max(100),
      kinds: z
        .array(
          z.enum([
            "new_issue",
            "new_pr",
            "comment",
            "review",
            "check_failed",
            "check_passed",
            "label_added",
            "label_removed",
          ]),
        )
        .min(1)
        .max(8),
      labels: z.array(boundedText(100)).max(100),
      actor_class: z.enum(["person", "any"]).nullable(),
    })
    .nullable()
    .optional()
    .describe(
      "Event filter for GitHub. The written condition and action control judgement; filters only select Triggers. Requires a Project, an Agent model, and kind cron. Use null for a clock Automation.",
    ),
  conditionText: boundedText(16 * 1024)
    .optional()
    .describe("Natural-language condition for this Automation."),
  timezone: boundedText(512)
    .optional()
    .describe(
      "IANA timezone for the clock condition; defaults to the current timezone on creation and is preserved on update.",
    ),
  runbookPageId: id
    .nullable()
    .optional()
    .describe(
      "Page whose current content every run follows as standing instructions. Runs may update it for future runs. Null or omitted removes the runbook.",
    ),
  backendBinding: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("codex") }),
      z.strictObject({ kind: z.literal("claude"), instanceConfigId: id }),
      z.strictObject({ kind: z.literal("opencode"), instanceConfigId: id }),
      z.strictObject({ kind: z.literal("acp"), agentDefinitionId: id, instanceConfigId: id }),
    ])
    .optional()
    .describe(
      "Agent and exact configured instance that runs the task. Omit on create to use the calling Session's Agent, or on update to keep the current one; a Heartbeat always uses its target Session's Agent. To choose another Agent, copy backendBinding from a task returned by view.",
    ),
  name: z
    .string()
    .regex(/\S/, "Must contain a non-whitespace character")
    .min(1)
    .max(512)
    .meta({ maxLength: 256 }),
  prompt: boundedText(1024 * 1024).describe(
    "Self-contained task instructions, at most 1048576 UTF-8 bytes. Keep scheduling, execution settings, and notification preferences in their separate fields.",
  ),
  rrule: boundedText(16 * 1024).describe(
    "RRULE clock condition interpreted in the explicit timezone, at most 16384 UTF-8 bytes.",
  ),
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
  model: boundedText(512)
    .optional()
    .describe("Model ID the selected Agent offers. Omit to use its first available model."),
  reasoningEffort: boundedText(64)
    .optional()
    .describe("A reasoning effort the chosen model offers. Omit when it offers none."),
  serviceTier: boundedText(64)
    .optional()
    .describe("A service tier the chosen model offers. Omit when it offers none."),
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

export const automationSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      operation: z.literal("list"),
      query: boundedText(512).optional(),
      cursor: z
        .string()

        .min(1)
        .max(2048)
        .optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    z.strictObject({ operation: z.literal("view"), id }),
    z.discriminatedUnion("kind", [
      z.strictObject({ operation: z.literal("create"), ...cronFields }),
      z.strictObject({ operation: z.literal("create"), ...heartbeatFields }),
    ]),
    z.discriminatedUnion("kind", [
      z.strictObject({ operation: z.literal("update"), ...cronFields, ...updateFields }),
      z.strictObject({ operation: z.literal("update"), ...heartbeatFields, ...updateFields }),
    ]),
    z.discriminatedUnion("kind", [
      z.strictObject({ operation: z.literal("suggested_create"), ...cronFields }),
      z.strictObject({ operation: z.literal("suggested_create"), ...heartbeatFields }),
    ]),
    z.discriminatedUnion("kind", [
      z.strictObject({ operation: z.literal("suggested_update"), ...cronFields, ...updateFields }),
      z.strictObject({
        operation: z.literal("suggested_update"),
        ...heartbeatFields,
        ...updateFields,
      }),
    ]),
    z.strictObject({ operation: z.literal("delete"), id, expectedRevision, ...operationFields }),
  ])
  .superRefine((input, context) => {
    const bytes = new TextEncoder();
    const byteBounds: Readonly<Record<string, number>> = {
      query: 512,
      id: 512,
      ownerMemberId: 512,
      conditionText: 16 * 1024,
      timezone: 512,
      runbookPageId: 512,
      targetSessionId: 512,
      projectId: 512,
      model: 512,
      reasoningEffort: 64,
      serviceTier: 64,
      prompt: 1024 * 1024,
      rrule: 16 * 1024,
      localEnvironmentConfigPath: 16 * 1024,
    };
    const check = (value: unknown, maximum: number, path: (string | number)[]) => {
      if (typeof value === "string" && bytes.encode(value).length > maximum)
        context.addIssue({
          code: "custom",
          path,
          message: `Text must not exceed ${maximum} UTF-8 bytes`,
        });
    };
    for (const [field, maximum] of Object.entries(byteBounds))
      check(Reflect.get(input, field), maximum, [field]);
    if ("scope" in input && input.scope?.kind === "project")
      check(input.scope.projectId, 512, ["scope", "projectId"]);
    if ("name" in input && Array.from(input.name).length > 256)
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Name must not exceed 256 characters",
      });
    if ("cwds" in input)
      input.cwds?.forEach((cwd, index) => check(cwd, 16 * 1024, ["cwds", index]));
    if ("backendBinding" in input && input.backendBinding)
      for (const [field, value] of Object.entries(input.backendBinding))
        check(value, 512, ["backendBinding", field]);
  });

export type AutomationToolInput = z.infer<typeof automationSchema>;
export type AutomationProposal = Extract<
  AutomationToolInput,
  { operation: "suggested_create" | "suggested_update" }
>;

export const automationTool: Tool = {
  name: "automations_update",
  description:
    "List, read, propose, create, replace, or delete an Automation. Use operation to select the command and mode for dry_run, ask_first, or run. dry_run records decisions only; ask_first holds an editable decision in the Inbox; run starts work unattended. You act with the user's authority over Automations. Create with ask_first by default; use run, or switch an Automation to run, only when the user asked for unattended runs or clearly wants them, and ask when unsure. Only an Automation's Owner may choose run, change its mode, or edit one set to run; for another Member's Automation, use suggested_create or suggested_update so its Owner can review and apply the change. Proposals do not save or enable an Automation. Use heartbeat to continue a stable Session, defaulting to the calling Session; use cron for a new chat per configured folder, with an explicit Project or projectId null. Preserve the explicit timezone returned by view. Creation starts ACTIVE. List supports query/cursor/limit. Read before update/delete and pass automationRevision as expectedRevision. Update replaces the definition; scope selects where it applies independently of the execution Project. Omitted scope, backendBinding, notificationPolicy, mode, Owner and timezone retain their values. Reuse idempotencyKey with identical input to reconcile an uncertain write. Runbook content is read when work executes and never changes Automation authority. Automated Turns do not wait for interactive questions or approvals.",
  inputSchema: toolInputSchema(automationSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
