import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MAX_INBOX_ADDITION_CHARS, MAX_INBOX_ADDITIONS } from "../inbox";
const MAX_PROMPT_CHARS = 2000;
const MAX_SUMMARY_CHARS = 200;
const MAX_RATIONALE_CHARS = 600;
const MAX_TITLE_CHARS = 80;
const RawSuggestion = z
  .object({
    explicit_request: z.boolean(),
    page_ids: z.array(z.string()).min(1).max(16),
    kind: z.enum(["note", "todo", "question"]),
    action: z.enum(["keep", "new_chat", "send_to_chat", "move_to_project", "plan"]),
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
    additions: z.array(z.string().max(MAX_INBOX_ADDITION_CHARS)).max(MAX_INBOX_ADDITIONS),
    chat_instance_id: z.string().nullable(),
    chat_model: z.string().nullable(),
    chat_effort: z.string().nullable(),
    summary: z.string().max(MAX_SUMMARY_CHARS),
    rationale: z.string().max(MAX_RATIONALE_CHARS).nullable(),
  })
  .strict();
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
const eventId = z.string().min(1).max(512).regex(/\S/);
export const writeTurnNoteSchema = z.strictObject({
  pageId: eventId,
  eventIds: z.array(eventId).min(1).max(8),
  body,
  notify: z.boolean(),
});
export const answerInboxQuestionSchema = z.strictObject({ questionPageId: eventId, body });
export const coordinatorToolCatalog: readonly Tool[] = [
  {
    name: "inbox_suggest",
    description:
      "Coordinator only. Submit the complete Routing request response, echoing request_id and generation. Cover every member exactly once; grouped/refine requests need one action. explicit_request says the person clearly asked for work now. Only new_chat or plan steps choose a model; plans require explicit_request false and 2–8 acyclic steps; unused targets/model fields are null, non-chat additions are empty. Validation errors leave the request pending: correct them and resubmit.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "write_turn_note",
    description:
      "Coordinator only. Add an immutable note of at most 100 words to a Page whose current Turn belongs to the local Member. Use 1–8 eventIds delivered to you concerning this Page or its active chat. Write only when it adds to the derived text; choose notify for review, blocked, failed or stalled work. Exact body, notify and event-set retries reuse the note.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "answer_inbox_question",
    description:
      "Coordinator only. Answer the person's pending Inbox question in at most 100 words. Creates one quiet answer and handles the question atomically. An exact retry returns the same answer.",
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

export const replyToOriginSchema = z.strictObject({
  pageId: z.string().regex(/\S/, "Page is required").min(1).max(512),
  body: z.string().regex(/\S/, "Reply is empty").min(1).max(16384),
});
export const replyToOriginTool: Tool = {
  name: "reply_to_origin",
  description:
    "Nodex only. Send at most 100 words to this Page's original GitHub request. Use once to acknowledge that work started, or once when its result is ready or merged. Never send routine progress or repeat the same acknowledgement/result. The origin address is fixed by the Page; identical body retries in the same Turn episode reuse the outbox item.",
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};
