import { z } from "zod";
import {
  INBOX_SUGGESTION_MODES,
  MAX_INBOX_INSTRUCTIONS_CHARS,
  type InboxAgentBinding,
  type InboxChatAgent,
  type InboxDelegate,
  type UpdateInboxSettingsInput,
} from "../inbox";
import type {
  InboxConfirmInput,
  InboxConfirmationDraft,
  InboxPreparedConfirmation,
  InboxExecutionSelection,
  InboxSuggestionRequestInput,
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
  InboxSetStateInput,
  InboxSummaryInput,
  InboxWindowInput,
} from "../inbox";
import { isBoundedOperationId } from "../operation-identity";
import { AgentRuntimeModelSelectionSchema } from "./agent-runtime-api";
import { InboxScopeSchema } from "./inbox-scope";

export const MAX_INBOX_MESSAGE_BYTES = 64 * 1024;
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
export const InboxEntryStateSchema = z.enum(["open", "kept", "done"]);
export const InboxWindowFilterSchema = z.enum(["inbox", "processed"]);

const choiceValue = z.string().trim().min(1).max(256).nullable();

export const InboxChatAgentSchema = z
  .object({
    instanceId: id,
    model: choiceValue,
    reasoningEffort: choiceValue,
    serviceTier: choiceValue,
  })
  .strict() satisfies z.ZodType<InboxChatAgent>;

/** Bounds what a decision may carry; how much to delegate is the suggestion's judgment. */
export const MAX_INBOX_DELEGATES = 8;
const InboxDelegateSchema = z
  .object({ work: z.string().trim().min(1).max(500), agent: InboxChatAgentSchema })
  .strict() satisfies z.ZodType<InboxDelegate>;

export const InboxDispatchActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("run_task"),
      automationId: id,
      dispatchId: id,
      agent: InboxChatAgentSchema.nullable(),
    })
    .strict(),
  z.object({ type: z.literal("keep") }).strict(),
  z
    .object({
      type: z.literal("new_chat"),
      projectId: id.nullable(),
      prompt,
      // A decision saved before new chats could be planned carries none of these.
      agent: InboxChatAgentSchema.nullable().default(null),
      delegates: z.array(InboxDelegateSchema).max(MAX_INBOX_DELEGATES).default([]),
      plan: z.string().trim().max(4_000).nullable().default(null),
    })
    .strict(),
  z.object({ type: z.literal("send_to_chat"), sessionId: id, prompt }).strict(),
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
    orchestration: z.string().max(8_000).nullable().optional(),
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
    operationId,
    pageId: id,
    documentId: id,
    issuedAt: z.number().int().nonnegative(),
    storeEpoch: id,
    scope: InboxScopeSchema,
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

export const InboxAgentBindingSchema = z
  .object({ instanceId: id })
  .strict() satisfies z.ZodType<InboxAgentBinding>;

export const InboxConfirmationDraftSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("proposal"),
      storeEpoch: id,
      proposalId: id,
      expectedRevision: z.number().int().min(1),
      basis,
      action: InboxDispatchActionSchema.optional(),
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

export const InboxSetStateInputSchema = z
  .object({ pageIds: pageIds(MAX_INBOX_BULK_PAGES), state: InboxEntryStateSchema })
  .strict() satisfies z.ZodType<InboxSetStateInput>;

export const InboxSetKindInputSchema = z
  .object({ pageId: id, kind: InboxEntryKindSchema.nullable() })
  .strict() satisfies z.ZodType<InboxSetKindInput>;

export const InboxSetImportantInputSchema = z
  .object({ pageId: id, important: z.boolean() })
  .strict() satisfies z.ZodType<InboxSetImportantInput>;

export const UpdateInboxSettingsInputSchema = z
  .object({
    suggestions: z.enum(INBOX_SUGGESTION_MODES).optional(),
    suggestionAgent: InboxAgentBindingSchema.optional(),
    suggestionModel: z.string().trim().max(256).nullable().optional(),
    instructions: z.string().max(MAX_INBOX_INSTRUCTIONS_CHARS).optional(),
    chatAgent: InboxChatAgentSchema.optional(),
    suggestionsChooseModels: z.boolean().optional(),
    useModelGuide: z.boolean().optional(),
    showPageBesideNewChats: z.boolean().optional(),
  })
  .strict() satisfies z.ZodType<UpdateInboxSettingsInput>;

export const InboxProposalInputSchema = z
  .object({ proposalId: id })
  .strict() satisfies z.ZodType<InboxProposalInput>;
