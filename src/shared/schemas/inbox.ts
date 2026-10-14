import { z } from "zod";
import {
  MAX_INBOX_INSTRUCTIONS_CHARS,
  type InboxAgentBinding,
  type UpdateInboxSettingsInput,
} from "../inbox";
import type {
  InboxConfirmInput,
  InboxDispatchAction,
  InboxDispatchInput,
  InboxPageIdsInput,
  InboxProposalInput,
  InboxScope,
  InboxSendInput,
  InboxSetKindInput,
  InboxSetStateInput,
  InboxSummaryInput,
  InboxWindowInput,
} from "../inbox";

export const MAX_INBOX_MESSAGE_BYTES = 64 * 1024;
export const MAX_INBOX_DISPATCH_PAGES = 16;
export const MAX_INBOX_BULK_PAGES = 200;
export const MAX_INBOX_PROMPT_BYTES = 32 * 1024;

const id = z.string().trim().min(1).max(512);
const utf8Bytes = (value: string) => new TextEncoder().encode(value).length;

const pageIds = (maximum: number) =>
  z
    .array(id)
    .min(1)
    .max(maximum)
    .refine((values) => new Set(values).size === values.length, "Inbox entries must be unique");

const prompt = z
  .string()
  .trim()
  .min(1)
  .refine((value) => utf8Bytes(value) <= MAX_INBOX_PROMPT_BYTES, "Prompt is too long");

export const InboxEntryKindSchema = z.enum(["note", "todo", "question"]);
export const InboxEntryStateSchema = z.enum(["open", "kept", "done"]);
export const InboxWindowFilterSchema = z.enum(["inbox", "processed"]);

export const InboxDispatchActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("keep") }).strict(),
  z.object({ type: z.literal("new_chat"), projectId: id.nullable(), prompt }).strict(),
  z.object({ type: z.literal("send_to_chat"), sessionId: id, prompt }).strict(),
  z.object({ type: z.literal("move_to_project"), projectId: id }).strict(),
]) satisfies z.ZodType<InboxDispatchAction>;

export const InboxScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("library") }).strict(),
  z.object({ kind: z.literal("project"), projectId: id }).strict(),
]) satisfies z.ZodType<InboxScope>;

export const InboxSummaryInputSchema = z
  .object({ scope: InboxScopeSchema })
  .strict() satisfies z.ZodType<InboxSummaryInput>;

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
    scope: InboxScopeSchema,
    text: z
      .string()
      .refine((value) => value.trim().length > 0, "Message is empty")
      .refine((value) => utf8Bytes(value) <= MAX_INBOX_MESSAGE_BYTES, "Message is too long"),
  })
  .strict() satisfies z.ZodType<InboxSendInput>;

export const InboxConfirmInputSchema = z
  .object({
    proposalId: id,
    expectedRevision: z.number().int().min(1),
    action: InboxDispatchActionSchema.optional(),
  })
  .strict() satisfies z.ZodType<InboxConfirmInput>;

export const InboxDispatchInputSchema = z
  .object({
    pageIds: pageIds(MAX_INBOX_DISPATCH_PAGES),
    action: InboxDispatchActionSchema,
  })
  .strict() satisfies z.ZodType<InboxDispatchInput>;

export const InboxPageIdsInputSchema = z
  .object({ pageIds: pageIds(MAX_INBOX_BULK_PAGES) })
  .strict() satisfies z.ZodType<InboxPageIdsInput>;

export const InboxSuggestionRequestInputSchema = z
  .object({ pageIds: pageIds(MAX_INBOX_DISPATCH_PAGES) })
  .strict() satisfies z.ZodType<InboxPageIdsInput>;

export const InboxSetStateInputSchema = z
  .object({ pageIds: pageIds(MAX_INBOX_BULK_PAGES), state: InboxEntryStateSchema })
  .strict() satisfies z.ZodType<InboxSetStateInput>;

export const InboxSetKindInputSchema = z
  .object({ pageId: id, kind: InboxEntryKindSchema.nullable() })
  .strict() satisfies z.ZodType<InboxSetKindInput>;

export const InboxAgentBindingSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("codex") }).strict(),
  z.object({ kind: z.literal("claude"), instanceConfigId: id }).strict(),
]) satisfies z.ZodType<InboxAgentBinding>;

export const UpdateInboxSettingsInputSchema = z
  .object({
    suggestionsEnabled: z.boolean().optional(),
    suggestionAgent: InboxAgentBindingSchema.optional(),
    suggestionModel: z.string().trim().max(256).nullable().optional(),
    instructions: z.string().max(MAX_INBOX_INSTRUCTIONS_CHARS).optional(),
    chatAgent: InboxAgentBindingSchema.optional(),
  })
  .strict() satisfies z.ZodType<UpdateInboxSettingsInput>;

export const InboxProposalInputSchema = z
  .object({ proposalId: id })
  .strict() satisfies z.ZodType<InboxProposalInput>;
