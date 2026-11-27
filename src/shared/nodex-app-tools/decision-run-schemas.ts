import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { InboxSnoozedUntilSchema, InboxSuggestedSkillsSchema } from "../schemas/inbox";
import { MAX_INBOX_ADDITION_CHARS, MAX_INBOX_ADDITIONS } from "../inbox";
import { toolInputSchema } from "./tool-input-schema";
const MAX_PROMPT_CHARS = 2000;
const MAX_SUMMARY_CHARS = 200;
const MAX_RATIONALE_CHARS = 600;
const MAX_TITLE_CHARS = 80;
const SuggestionFields = z
  .object({
    explicit_request: z.boolean(),
    page_ids: z.array(z.string()).min(1).max(16),
    kind: z.enum(["note", "todo", "question"]),
    steps: z
      .array(
        z.strictObject({
          key: z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
          project_id: z
            .string()
            .regex(/\S/, "Must contain a non-whitespace character")
            .min(1)
            .max(512),
          title: z
            .string()
            .min(1)
            .max(120)
            .regex(/^[^\s\u2028\u2029](?:[^\r\n\t\u2028\u2029]*[^\s\u2028\u2029])?$/u),
          body: z.string().max(4000),
          agent: z
            .strictObject({
              instance_id: z
                .string()
                .regex(/\S/, "Must contain a non-whitespace character")
                .min(1)
                .max(512),
              model: z
                .string()
                .regex(/\S/, "Must contain a non-whitespace character")
                .min(1)
                .max(512),
              effort: z
                .string()
                .regex(/\S/, "Must contain a non-whitespace character")
                .min(1)
                .max(128)
                .nullable(),
            })
            .nullable(),
          blocked_by: z
            .array(
              z.string().regex(/\S/, "Must contain a non-whitespace character").min(1).max(512),
            )
            .max(7),
        }),
      )
      .min(2)
      .max(8)
      .optional(),
    project_id: z.string().nullable(),
    session_id: z.string().nullable(),
    prompt: z.string().max(MAX_PROMPT_CHARS).nullable(),
    skills: InboxSuggestedSkillsSchema,
    additions: z.array(z.string().max(MAX_INBOX_ADDITION_CHARS)).max(MAX_INBOX_ADDITIONS),
    chat_instance_id: z.string().nullable(),
    chat_model: z.string().nullable(),
    chat_effort: z.string().nullable(),
    summary: z.string().max(MAX_SUMMARY_CHARS),
    rationale: z.string().max(MAX_RATIONALE_CHARS).nullable(),
  })
  .strict();
const RawSuggestion = z.discriminatedUnion("action", [
  SuggestionFields.extend({
    action: z.enum(["keep", "new_chat", "send_to_chat", "move_to_project", "plan"]),
  }),
  SuggestionFields.extend({
    action: z.literal("save_to_notes"),
    parent_page_id: z.string().min(1).max(512).nullable(),
  }),
  SuggestionFields.extend({
    action: z.literal("fork_chat"),
    new_worktree: z.boolean().nullish(),
  }),
  SuggestionFields.extend({ action: z.literal("snooze"), snoozed_until: InboxSnoozedUntilSchema }),
]);
export const InboxSuggestionOutput = z
  .object({
    request_id: z.string().min(1),
    generation: z.number().int().positive(),
    titles: z
      .array(z.object({ page_id: z.string(), title: z.string().max(MAX_TITLE_CHARS) }).strict())
      .max(16),
    suggestions: z.array(RawSuggestion).min(1).max(16),
  })
  .strict();
export type InboxSuggestionOutput = z.infer<typeof InboxSuggestionOutput>;

const body = z.string().min(1).max(2000).regex(/\S/, "Body is empty");
const id = z.string().min(1).max(512).regex(/\S/);
export const answerInboxQuestionSchema = z.strictObject({ questionPageId: id, body });
export const automationAssessmentReadSchema = z.strictObject({
  request_id: id,
  generation: z.number().int().positive(),
  resource: z.enum(["triggers", "thread", "automations", "pages", "follows", "decisions"]),
  cursor: z.string().max(128).optional(),
});
export const automationAssessmentSubmitSchema = z.strictObject({
  request_id: id,
  generation: z.number().int().positive(),
  policy_hash: z.string().regex(/^[0-9a-f]{64}$/u),
  automation_assessments: z
    .array(
      z.strictObject({
        automation_id: id,
        revision: z.number().int().positive(),
        matched: z.boolean(),
        reason: z.string().min(1).max(2000).regex(/\S/, "Reason is empty"),
        evidence_ids: z.array(id).max(30),
      }),
    )
    .max(200),
  proposed_actions: z
    .array(
      z.strictObject({
        automation_ids: z.array(id).min(1).max(200),
        scope: z.strictObject({ kind: z.literal("project"), project_id: id }),
        title: z.string().min(1).max(200).regex(/\S/, "Title is empty"),
        body: z.string().min(1).max(32000).regex(/\S/, "Body is empty"),
        execution_target: z.strictObject({
          instanceId: id,
          model: id,
          effort: z.string().min(1).max(128).nullable(),
        }),
        thread_id: id,
      }),
    )
    .max(200),
});
export const decisionRunToolCatalog: readonly Tool[] = [
  {
    name: "automation_assessment_read",
    description:
      "Assessment decision runs only. Read retained assessment evidence with request_id and generation. Resources: triggers, thread, automations, pages (including completed), follows, decisions. Copy next_cursor for more. No URL, shell or credential access. Read every automation before submitting.",
    inputSchema: toolInputSchema(automationAssessmentReadSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "automation_assessment_submit",
    description:
      "Assessment decision runs only. Judge every applicable automation exactly once, including negative judgements, with exact revision, factual reason and evidence IDs. Propose a Page for each matched automation using its exact Project and execution_target, and this thread. Core coalesces equivalent actions and supplies mode and authority; tools cannot change automations or grant work. Stale policy is requeued.",
    inputSchema: toolInputSchema(automationAssessmentSubmitSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "inbox_suggest",
    description:
      "Routing decision runs only. Submit the complete Routing request response, echoing request_id and generation. Cover every member exactly once; grouped/refine requests need one action. explicit_request says the person clearly asked for work now. A chat prompt is a routing note of at most 30 words, since the chat receives the messages unchanged. Only new_chat or plan steps choose a model; forks and plans require explicit_request false; plans have 2–8 acyclic steps; unused targets/model fields are null, non-chat additions and skills are empty. Validation errors leave the request pending: correct them and resubmit.",
    inputSchema: toolInputSchema(InboxSuggestionOutput),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "answer_inbox_question",
    description:
      "Routing decision runs only. Answer the person's pending Inbox question in at most 100 words. Creates one quiet answer and handles the question atomically. An exact retry returns the same answer.",
    inputSchema: toolInputSchema(answerInboxQuestionSchema),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];
