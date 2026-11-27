import type { components } from "@nodex/core-protocol";
import { z } from "zod";
import { actorSchema } from "./actor";

type Schemas = components["schemas"];
export type DiscussionInboxEntry = Schemas["DiscussionInboxEntry"];
export type DiscussionBlockWriter = Schemas["DiscussionBlockWriter"];
export type Discussion = Schemas["Discussion"];
export type DiscussionAnchor = Schemas["DiscussionAnchor"];
export type DiscussionComment = Schemas["DiscussionComment"];
export type DiscussionCommentDraft = Schemas["DiscussionCommentDraft"];
export type DiscussionCommand = Schemas["DiscussionCommand"];
export type DiscussionCommandResult = Schemas["DiscussionCommandResult"];
export type DiscussionCursor = Schemas["DiscussionCursor"];
export type DiscussionDetail = Schemas["DiscussionDetail"];
export type DiscussionStatus = Schemas["DiscussionStatus"];
export type DiscussionTextRange = Schemas["DiscussionTextRange"];
export type DiscussionWaiting = Schemas["DiscussionWaiting"];
export type DiscussionWindow = Schemas["DiscussionWindow"];

export const discussionIdentity = z.string().min(1).max(512);
const timestamp = z.string().min(1).max(80);
const commentBody = z
  .string()
  .min(1)
  .max(64 * 1024);
const ids = z.array(discussionIdentity).min(1).max(512);
const uuid = z.uuidv7();
export const discussionStatus = z.enum(["open", "resolved"]);
export const discussionWaiting = z.enum(["nodex", "me"]);
export const discussionLimit = z.int().min(1).max(100);
export const discussionCursor = z.strictObject({
  id: discussionIdentity,
  lastActivityAt: timestamp,
});

const anchor = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("page") }),
  z.strictObject({ kind: z.literal("blocks"), blockIds: ids }),
  z.strictObject({ kind: z.literal("text"), blockId: discussionIdentity }),
  z.strictObject({
    kind: z.literal("datum"),
    blockId: discussionIdentity,
    source: z.string().min(1).max(256),
    key: z.json(),
    field: z.string().min(1).max(256).nullish(),
  }),
]);
const range = z.strictObject({
  from: z.int().nonnegative(),
  to: z.int().positive(),
  expectedText: commentBody,
});
const askKind = z.enum(["ask", "check", "check_page", "in_place"]);
const askState = z.enum(["queued", "working", "needs_you", "answered", "failed", "stopped"]);
const askAgent = z.strictObject({
  providerInstanceId: z.string().max(512),
  model: z.string().max(512),
  options: z.record(z.string(), z.json()),
});
const verdict = z.strictObject({
  result: z.enum(["true", "partly_true", "false", "unverifiable"]),
  evidence: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(500),
        url: z.string().max(4000).nullish(),
        excerpt: z.string().max(4000).nullish(),
      }),
    )
    .max(50),
});
const suggestedDraft = z.strictObject({
  blockIds: ids,
  newMarkdown: z.string().max(1024 * 1024),
  expectedOldMarkdown: z
    .string()
    .max(1024 * 1024)
    .nullish(),
});
const draft = z.strictObject({
  body: commentBody,
  toNodex: z.boolean().optional(),
  askKind: askKind.nullish(),
  askAgent: askAgent.nullish(),
  requestedSessionId: discussionIdentity.nullish(),
  verdict: verdict.nullish(),
  suggestedEdit: suggestedDraft.nullish(),
  questionFor: discussionIdentity.nullish(),
});
const discussionTarget = { discussionId: discussionIdentity };
const commentTarget = { commentId: discussionIdentity };

export const discussionInputs = {
  create: z.strictObject({
    pageId: discussionIdentity,
    discussionId: uuid.nullish(),
    firstCommentId: uuid.nullish(),
    quote: z.string().max(500).nullish(),
    anchor,
    textRange: range.nullish(),
    firstComment: draft,
  }),
  reply: z.strictObject({ ...discussionTarget, comment: draft }),
  edit: z.strictObject({ ...commentTarget, body: commentBody }),
  delete: z.strictObject(commentTarget),
  resolve: z.strictObject(discussionTarget),
  reopen: z.strictObject(discussionTarget),
  accept: z.strictObject(commentTarget),
  reject: z.strictObject(commentTarget),
  set_page_setting: z.strictObject({
    pageId: discussionIdentity,
    nodexAnswersQuestions: z.boolean(),
  }),
  stop_ask: z.strictObject(commentTarget),
  revert_run: z.strictObject({ pageId: discussionIdentity, runId: discussionIdentity }),
};

export const discussionCommandSchema = z.discriminatedUnion("kind", [
  discussionInputs.create.extend({ kind: z.literal("create") }),
  discussionInputs.reply.extend({ kind: z.literal("reply") }),
  discussionInputs.edit.extend({ kind: z.literal("edit") }),
  discussionInputs.delete.extend({ kind: z.literal("delete") }),
  discussionInputs.resolve.extend({ kind: z.literal("resolve") }),
  discussionInputs.reopen.extend({ kind: z.literal("reopen") }),
  discussionInputs.accept.extend({ kind: z.literal("accept") }),
  discussionInputs.reject.extend({ kind: z.literal("reject") }),
  discussionInputs.set_page_setting.extend({ kind: z.literal("set_page_setting") }),
  discussionInputs.stop_ask.extend({ kind: z.literal("stop_ask") }),
  discussionInputs.revert_run.extend({ kind: z.literal("revert_run") }),
  // Run advancement belongs to the Host. The renderer can retry an author's failed Ask.
  z.strictObject({
    kind: z.literal("update_ask"),
    ...commentTarget,
    expectedState: z.enum(["failed", "stopped"]),
    state: z.literal("queued"),
  }),
]) satisfies z.ZodType<DiscussionCommand>;

export const discussionReadSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("discussions"),
    pageId: discussionIdentity.optional(),
    status: discussionStatus.optional(),
    waiting: discussionWaiting.optional(),
    cursor: discussionCursor.optional(),
    limit: discussionLimit.optional(),
  }),
  z.strictObject({ mode: z.literal("discussion"), ...discussionTarget }),
  z.strictObject({ mode: z.literal("discussion_block_writers"), pageId: discussionIdentity }),
  z.strictObject({
    mode: z.literal("discussion_inbox"),
    cursor: discussionCursor.optional(),
    limit: discussionLimit.optional(),
  }),
]);
export type DiscussionRead = z.output<typeof discussionReadSchema>;

const discussionSchema = z.strictObject({
  id: discussionIdentity,
  pageId: discussionIdentity,
  anchor,
  quote: z.string().max(1000),
  anchorState: z.enum(["live", "orphaned"]),
  status: discussionStatus,
  createdBy: actorSchema,
  createdAt: timestamp,
  resolvedBy: actorSchema.nullish(),
  resolvedAt: timestamp.nullish(),
  lastActivityAt: timestamp,
});
const commentSchema = z.strictObject({
  id: discussionIdentity,
  discussionId: discussionIdentity,
  author: actorSchema,
  createdAt: timestamp,
  editedAt: timestamp.nullish(),
  deletedAt: timestamp.nullish(),
  body: commentBody,
  mentions: z.array(discussionIdentity),
  toNodex: z.boolean(),
  ask: z
    .strictObject({
      kind: askKind,
      state: askState,
      requestedSessionId: discussionIdentity.nullish(),
      sessionId: discussionIdentity.nullish(),
      runId: discussionIdentity.nullish(),
      agent: askAgent.nullish(),
      requesterId: discussionIdentity.nullish(),
      discussionSessionId: discussionIdentity.nullish(),
      dispatch: z
        .strictObject({
          messageId: discussionIdentity,
          launchId: discussionIdentity.nullish(),
          stopRequested: z.boolean(),
          agent: askAgent.nullish(),
        })
        .nullish(),
    })
    .nullish(),
  verdict: verdict.nullish(),
  suggestedEdit: suggestedDraft
    .omit({ expectedOldMarkdown: true })
    .extend({
      oldMarkdown: z.string().max(1024 * 1024),
      baseHash: z.string().length(64),
      state: z.enum(["open", "accepted", "rejected", "stale"]),
      decidedBy: actorSchema.nullish(),
      decidedAt: timestamp.nullish(),
    })
    .nullish(),
  questionFor: discussionIdentity.nullish(),
});
const detail = discussionSchema.extend({ comments: z.array(commentSchema) });
export const discussionReadValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("discussions"),
    value: z.strictObject({
      items: z.array(detail).max(100),
      next: discussionCursor.nullish(),
      nodexAnswersQuestions: z.boolean().nullish(),
    }),
  }),
  z.strictObject({ kind: z.literal("discussion"), value: detail }),
  z.strictObject({
    kind: z.literal("discussion_inbox"),
    value: z.strictObject({
      items: z
        .array(
          z.strictObject({
            pageId: discussionIdentity,
            discussionId: discussionIdentity,
            commentId: discussionIdentity,
            title: z.string(),
            excerpt: z.string(),
            occurredAt: timestamp,
            reason: z.enum(["needs_you", "suggested_edit", "mention", "answered", "reply"]),
          }),
        )
        .max(100),
      next: discussionCursor.nullish(),
    }),
  }),
  z.strictObject({
    kind: z.literal("discussion_block_writers"),
    items: z.array(
      z.strictObject({
        blockId: discussionIdentity,
        actor: actorSchema,
        writtenAt: timestamp,
      }),
    ),
  }),
]);
export type DiscussionReadValue = z.output<typeof discussionReadValueSchema>;

export const discussionResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("discussion"), value: discussionSchema }),
  z.strictObject({ kind: z.literal("comment"), value: commentSchema }),
  z.strictObject({
    kind: z.literal("page_setting"),
    pageId: discussionIdentity,
    nodexAnswersQuestions: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("run_revert"),
    reverted: z.array(discussionIdentity),
    conflicts: z.array(z.strictObject({ blockId: discussionIdentity, reason: discussionIdentity })),
  }),
]) satisfies z.ZodType<DiscussionCommandResult>;
