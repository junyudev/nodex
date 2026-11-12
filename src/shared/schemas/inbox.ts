import { z } from "zod";
import {
  INBOX_SUGGESTION_MODES,
  MAX_INBOX_ADDITION_CHARS,
  MAX_INBOX_ADDITIONS,
  MAX_INBOX_INSTRUCTIONS_CHARS,
  MAX_INBOX_SUGGESTION_CONCURRENCY,
  type InboxAgentChoice,
  type UpdateInboxSettingsInput,
} from "../inbox";
import type {
  ActivityWindowInput,
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxPreparedConfirmation,
  InboxExecutionSelection,
  InboxSuggestionRequestInput,
  InboxSuggestionStopInput,
  InboxUndoInput,
  InboxPageBasis,
  InboxChatTargetsInput,
  InboxDispatchAction,
  InboxDispatchInput,
  InboxEditInput,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxSendInput,
  InboxSetImportantInput,
  InboxSetKindInput,
  InboxSummaryInput,
  InboxWindowInput,
} from "../inbox";
import { isBoundedOperationId } from "../operation-identity";
import { AgentRuntimeModelSelectionSchema } from "./agent-runtime-api";
import { InboxScopeSchema } from "./inbox-scope";

export const MAX_INBOX_MESSAGE_BYTES = 64 * 1024;
/** A sender's title is a short label; Core enforces the same bound for every sender. */
export const MAX_INBOX_TITLE_LENGTH = 200;
export const MAX_INBOX_DISPATCH_PAGES = 16;
export const MAX_INBOX_BULK_PAGES = 200;
export const MAX_INBOX_PROMPT_BYTES = 32 * 1024;

const id = z.string().trim().min(1).max(512);
const operationId = id.refine(isBoundedOperationId, "Operation identity is invalid");
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

const pageIds = (maximum: number) =>
  z
    .array(id)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "Inbox entries must be unique");

const messageBody = z
  .string()
  .refine((value) => value.trim().length > 0, "Message is empty")
  .refine((value) => utf8Bytes(value) <= MAX_INBOX_MESSAGE_BYTES, "Message is too long");

const prompt = z
  .string()
  .trim()
  .min(1)
  .refine((value) => utf8Bytes(value) <= MAX_INBOX_PROMPT_BYTES, "Prompt is too long");

export const InboxEntryKindSchema = z.enum(["note", "todo", "question"]);
export const InboxWindowFilterSchema = z.enum(["inbox", "processed", "later"]);
export const InboxRemindAtSchema = z.iso.datetime({ offset: true }).max(64);

const choiceValue = z.string().trim().min(1).max(256).nullable();

export const InboxAgentChoiceSchema = z
  .object({
    instanceId: id,
    model: choiceValue,
    reasoningEffort: choiceValue,
    serviceTier: choiceValue,
  })
  .strict() satisfies z.ZodType<InboxAgentChoice>;

const additions = z
  .array(z.string().trim().min(1).max(MAX_INBOX_ADDITION_CHARS))
  .max(MAX_INBOX_ADDITIONS)
  .default([]);

export const InboxSkillNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9:_-]*$/);
export const InboxSuggestedSkillsSchema = z
  .array(
    z.strictObject({
      name: InboxSkillNameSchema,
      reason: z.string().max(160).regex(/\S/, "Reason is empty"),
    }),
  )
  .max(3);
export const InboxDroppedSkillNamesSchema = z.array(InboxSkillNameSchema).max(3);
const skillInvocations = z
  .array(
    z.strictObject({
      name: InboxSkillNameSchema,
      path: z.string().min(1),
      instanceId: id,
      cwd: z.string().min(1),
    }),
  )
  .max(3)
  .optional();

export const InboxDispatchActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("later"), remindAt: InboxRemindAtSchema }),
  z.strictObject({
    type: z.literal("plan"),
    summary: z.string().trim().min(1).max(200),
    steps: z
      .array(
        z.strictObject({
          key: id,
          projectId: id,
          title: z.string().trim().min(1).max(120),
          body: z.string().max(4000),
          agent: z
            .strictObject({
              instanceId: id,
              model: id,
              effort: z.string().trim().min(1).max(128).nullable(),
            })
            .nullable(),
          blockedBy: z.array(id).max(7),
        }),
      )
      .min(2)
      .max(8),
  }),
  z
    .object({
      type: z.literal("execute_decision"),
      decisionId: id,
      agent: InboxAgentChoiceSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("keep") }).strict(),
  z
    .object({
      type: z.literal("save_to_notes"),
      parentPageId: z.string().min(1).max(512).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("new_chat"),
      projectId: id.nullable(),
      prompt,
      agent: InboxAgentChoiceSchema.nullable().default(null),
      worktree: z.boolean().nullable().optional(),
      additions,
      skills: InboxSuggestedSkillsSchema.default([]),
    })
    .strict(),
  z
    .object({
      type: z.literal("send_to_chat"),
      sessionId: id,
      prompt,
      additions,
      skills: InboxSuggestedSkillsSchema.default([]),
    })
    .strict(),
  z.object({ type: z.literal("move_to_project"), projectId: id }).strict(),
]) satisfies z.ZodType<InboxDispatchAction>;

export const InboxPageBasisSchema = z
  .object({
    pageId: id,
    contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict() satisfies z.ZodType<InboxPageBasis>;

const basis = z
  .array(InboxPageBasisSchema)
  .min(1)
  .max(MAX_INBOX_DISPATCH_PAGES)
  .refine(
    (values) => new Set(values.map((value) => value.pageId)).size === values.length,
    "Message revisions must be unique",
  );

export const InboxExecutionSelectionSchema = z
  .object({
    modelSelection: AgentRuntimeModelSelectionSchema,
    interactionMode: z.enum(["default", "plan"]),
    // A selection frozen before the choice existed ran in a worktree, as it still does.
    worktree: z.boolean().default(true),
  })
  .strict() satisfies z.ZodType<InboxExecutionSelection>;

export const InboxSummaryInputSchema = z
  .object({ scope: InboxScopeSchema })
  .strict() satisfies z.ZodType<InboxSummaryInput>;

export const InboxChatTargetsInputSchema = z
  .object({
    scope: InboxScopeSchema,
    query: z.string().trim().max(512),
    after: z.string().min(1).max(4096).nullable().optional(),
    first: z.number().int().min(1).max(100).optional(),
  })
  .strict() satisfies z.ZodType<InboxChatTargetsInput>;

export const InboxWindowInputSchema = z
  .object({
    scope: InboxScopeSchema,
    filter: InboxWindowFilterSchema,
    after: z.string().min(1).max(4096).nullable().optional(),
    first: z.number().int().min(1).max(200).optional(),
  })
  .strict() satisfies z.ZodType<InboxWindowInput>;

export const InboxSendInputSchema = z
  .object({
    replyToPageId: id.optional(),
    turnEpisode: id.optional(),
    operationId,
    pageId: id,
    documentId: id,
    issuedAt: z.number().int().nonnegative(),
    storeEpoch: id,
    scope: InboxScopeSchema,
    title: z
      .string()
      .trim()
      .min(1)
      .max(MAX_INBOX_TITLE_LENGTH)
      .refine(
        (value) => !/[\r\n\t\u2028\u2029]/u.test(value),
        "Title must be a single line without tabs",
      )
      .optional(),
    body: messageBody,
  })
  .strict() satisfies z.ZodType<InboxSendInput>;

export const InboxEditInputSchema = z
  .object({ pageId: id, basis: InboxPageBasisSchema, originalBody: messageBody, body: messageBody })
  .strict()
  .refine(
    (input) => input.pageId === input.basis.pageId,
    "Message revision belongs to another Page",
  ) satisfies z.ZodType<InboxEditInput>;

export const InboxConfirmInputSchema = z
  .object({
    storeEpoch: id,
    operationId,
    sessionId: id,
    basis,
    executionSelection: InboxExecutionSelectionSchema.nullable().optional(),
    proposalId: id,
    expectedRevision: z.number().int().min(1),
    action: InboxDispatchActionSchema.optional(),
    droppedSkillNames: InboxDroppedSkillNamesSchema.optional(),
    skillInvocations,
  })
  .strict() satisfies z.ZodType<InboxConfirmInput>;

export const InboxDispatchInputSchema = z
  .object({
    storeEpoch: id,
    operationId,
    proposalId: id,
    sessionId: id,
    basis,
    executionSelection: InboxExecutionSelectionSchema.nullable().optional(),
    pageIds: pageIds(MAX_INBOX_DISPATCH_PAGES),
    action: InboxDispatchActionSchema,
  })
  .strict() satisfies z.ZodType<InboxDispatchInput>;

export const InboxSkillAvailabilityInputSchema = z.strictObject({
  proposalId: id,
  expectedRevision: z.number().int().min(1),
  pageId: id,
  target: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("new_chat"),
      projectId: id.nullable(),
      instanceId: id.nullable(),
    }),
    z.strictObject({ type: z.literal("send_to_chat"), sessionId: id }),
  ]),
});

export const InboxConfirmationDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("proposal"),
      storeEpoch: id,
      proposalId: id,
      expectedRevision: z.number().int().min(1),
      basis,
      action: InboxDispatchActionSchema.optional(),
      droppedSkillNames: InboxDroppedSkillNamesSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("direct"),
      storeEpoch: id,
      pageIds: pageIds(MAX_INBOX_DISPATCH_PAGES),
      basis,
      action: InboxDispatchActionSchema,
    })
    .strict(),
]) satisfies z.ZodType<InboxConfirmationDraft>;

export const InboxPreparedConfirmationSchema = z.discriminatedUnion("kind", [
  InboxConfirmInputSchema.extend({ kind: z.literal("proposal") }),
  InboxDispatchInputSchema.extend({ kind: z.literal("direct") }),
]) satisfies z.ZodType<InboxPreparedConfirmation>;

export const InboxUndoInputSchema = z
  .object({ operationId, undoToken: id })
  .strict() satisfies z.ZodType<InboxUndoInput>;

export const InboxPageIdsInputSchema = z
  .object({ pageIds: pageIds(MAX_INBOX_BULK_PAGES) })
  .strict() satisfies z.ZodType<InboxPageIdsInput>;

export const InboxSetLaterInputSchema = InboxPageIdsInputSchema.extend({
  until: InboxRemindAtSchema,
});

export const InboxSuggestionRequestInputSchema = z
  .object({
    requestId: id,
    mode: z.enum(["auto", "grouped", "refine"]),
    pageIds: pageIds(MAX_INBOX_DISPATCH_PAGES),
    basis,
    proposalId: id.nullable().optional(),
    expectedRevision: z.number().int().positive().nullable().optional(),
    correction: z.string().trim().min(1).max(4_000).nullable().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const members = new Set(input.pageIds);
    if (
      input.basis.length !== members.size ||
      input.basis.some((entry) => !members.has(entry.pageId))
    )
      context.addIssue({
        code: "custom",
        message: "Every selected message needs its exact revision",
      });
    if (input.mode === "refine") {
      if (!input.proposalId || !input.expectedRevision || !input.correction)
        context.addIssue({
          code: "custom",
          message: "Refining needs the current suggestion and a correction",
        });
      return;
    }
    if (input.proposalId || input.expectedRevision || input.correction)
      context.addIssue({
        code: "custom",
        message: "Only a refinement can name a suggestion or correction",
      });
  }) satisfies z.ZodType<InboxSuggestionRequestInput>;

export const InboxSuggestionStopInputSchema = z
  .object({ pageId: id })
  .strict() satisfies z.ZodType<InboxSuggestionStopInput>;

export const InboxSetKindInputSchema = z
  .object({ pageId: id, kind: InboxEntryKindSchema.nullable() })
  .strict() satisfies z.ZodType<InboxSetKindInput>;

export const InboxSetImportantInputSchema = z
  .object({ pageId: id, important: z.boolean() })
  .strict() satisfies z.ZodType<InboxSetImportantInput>;

export const UpdateInboxSettingsInputSchema = z
  .object({
    suggestions: z.enum(INBOX_SUGGESTION_MODES).optional(),
    dispatchMode: z.enum(["suggest", "act_on_requests"]).optional(),
    suggestionAgent: InboxAgentChoiceSchema.optional(),
    suggestionConcurrency: z.number().int().min(1).max(MAX_INBOX_SUGGESTION_CONCURRENCY).optional(),
    instructions: z.string().max(MAX_INBOX_INSTRUCTIONS_CHARS).optional(),
    chatAgent: InboxAgentChoiceSchema.optional(),
    suggestionsChooseModels: z.boolean().optional(),
    useModelGuide: z.boolean().optional(),
    showPageBesideNewChats: z.boolean().optional(),
    newChatsUseWorktrees: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<UpdateInboxSettingsInput>;

export const InboxProposalInputSchema = z
  .object({ proposalId: id })
  .strict() satisfies z.ZodType<InboxProposalInput>;

export const ActivityWindowInputSchema = InboxWindowInputSchema.extend({
  filter: z.enum(["all", "messages", "decisions", "problems"]),
}) satisfies z.ZodType<ActivityWindowInput>;
export const RetryProblemInputSchema = z.strictObject({ operationId, problemId: id });
