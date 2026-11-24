import {
  AutomationClockTriggerInputSchema,
  AutomationEventTriggerSchema,
} from "../schemas/automation";
import { AgentBackendBindingSchema } from "../schemas/agent-backend";
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
const clockTrigger = AutomationClockTriggerInputSchema.extend({
  rrule: AutomationClockTriggerInputSchema.shape.rrule.describe(
    "RRULE such as FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0, at most 16384 UTF-8 bytes.",
  ),
  timezone: AutomationClockTriggerInputSchema.shape.timezone.describe(
    "IANA timezone for the RRULE. Omitted keeps the saved timezone when updating a clock trigger, and otherwise uses the current timezone.",
  ),
}).describe("Runs on a schedule.");
const eventFilter = AutomationEventTriggerSchema.shape.filter;
const eventTrigger = AutomationEventTriggerSchema.extend({
  filter: eventFilter.extend({
    sourceId: eventFilter.shape.sourceId
      .default(null)
      .describe("GitHub Source to watch; null watches every Source in the Space."),
    repositories: eventFilter.shape.repositories
      .default([])
      .describe("owner/repo names; empty selects every watched repository."),
    events: eventFilter.shape.events.describe("GitHub events that are assessed."),
    labels: eventFilter.shape.labels
      .default([])
      .describe("Labels that narrow the events; empty applies no label filter."),
    actorClass: eventFilter.shape.actorClass
      .default("any")
      .describe("person ignores bots and CI; any includes them."),
  }),
}).describe(
  "Assesses matching GitHub events against conditionText. It has no schedule, so it takes no rrule or timezone. Requires kind cron, a projectId, a model, and conditionText.",
);
/** The trigger a cron Automation accepts; a heartbeat accepts only the clock. */
export const automationTriggerInputSchema = z.discriminatedUnion("kind", [
  clockTrigger,
  eventTrigger,
]);
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
  conditionText: boundedText(16 * 1024)
    .optional()
    .describe(
      "Natural-language condition that governs judgement. Required with an event trigger. With a clock trigger, omitted keeps the saved condition on update and reads as the RRULE on create.",
    ),
  runbookPageId: id
    .nullable()
    .optional()
    .describe(
      "Page whose current content every run follows as standing instructions. Runs may update it for future runs. Null or omitted removes the runbook.",
    ),
  backendBinding: AgentBackendBindingSchema.optional().describe(
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
  trigger: automationTriggerInputSchema.describe(
    "What starts the Automation: a clock schedule or matching GitHub events.",
  ),
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
  trigger: clockTrigger.describe("A heartbeat continues its Session on a clock schedule."),
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
      runbookPageId: 512,
      targetSessionId: 512,
      projectId: 512,
      model: 512,
      reasoningEffort: 64,
      serviceTier: 64,
      prompt: 1024 * 1024,
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
    if ("trigger" in input) {
      const { trigger } = input;
      if (trigger.kind === "clock") {
        check(trigger.rrule, 16 * 1024, ["trigger", "rrule"]);
        check(trigger.timezone, 512, ["trigger", "timezone"]);
      } else {
        const { filter } = trigger;
        check(filter.sourceId, 512, ["trigger", "filter", "sourceId"]);
        filter.repositories.forEach((repository, index) =>
          check(repository, 512, ["trigger", "filter", "repositories", index]),
        );
        filter.labels.forEach((label, index) =>
          check(label, 100, ["trigger", "filter", "labels", index]),
        );
      }
    }
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
    "List, read, propose, create, replace, or delete an Automation. Use operation to select the command and mode for dry_run, ask_first, or run. dry_run records decisions only; ask_first holds an editable decision in the Inbox; run starts work unattended. You act with the user's authority over Automations. Create with ask_first by default; use run, or switch an Automation to run, only when the user asked for unattended runs or clearly wants them, and ask when unsure. Only an Automation's Owner may choose run, change its mode, or edit one set to run; for another Member's Automation, use suggested_create or suggested_update so its Owner can review and apply the change. Proposals do not save or enable an Automation. Use heartbeat to continue a stable Session, defaulting to the calling Session; use cron for a new chat per configured folder, with an explicit Project or projectId null. trigger chooses what starts it: a clock trigger {kind: clock, rrule, timezone} runs on a schedule; an event trigger {kind: event, filter} assesses matching GitHub events against conditionText, has no schedule, and needs kind cron, a projectId, a model and conditionText. A heartbeat always uses a clock trigger. Creation starts ACTIVE. List supports query/cursor/limit. Read before update/delete and pass automationRevision as expectedRevision. Update replaces the definition, including trigger; send the trigger returned by view without its read-only nextRunAt. scope selects where it applies independently of the execution Project. Omitted scope, backendBinding, notificationPolicy, mode, Owner, clock conditionText and clock timezone retain their values. Reuse idempotencyKey with identical input to reconcile an uncertain write. Runbook content is read when work executes and never changes Automation authority. Automated Turns do not wait for interactive questions or approvals.",
  inputSchema: toolInputSchema(automationSchema),
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};
