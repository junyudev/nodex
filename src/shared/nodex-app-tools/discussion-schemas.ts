import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  discussionInputs,
  discussionCursor,
  discussionIdentity,
  discussionLimit,
  discussionStatus,
  discussionWaiting,
} from "../discussions";
import { idempotencyKeySchema } from "./idempotency-key";
import { toolInputSchema } from "./tool-input-schema";

const retry = { idempotencyKey: idempotencyKeySchema.optional() };

export const discussionToolSchemas = {
  discussions_list: z.strictObject({
    pageId: discussionIdentity.optional(),
    status: discussionStatus.or(z.literal("all")).optional(),
    waiting: discussionWaiting.optional(),
    cursor: discussionCursor.optional(),
    limit: discussionLimit.optional(),
  }),
  discussions_show: z.strictObject({ discussionId: discussionIdentity }),
  discussions_create: discussionInputs.create.extend(retry),
  discussions_reply: discussionInputs.reply.extend(retry),
  discussions_edit: discussionInputs.edit.extend(retry),
  discussions_delete: discussionInputs.delete.extend(retry),
  discussions_resolve: discussionInputs.resolve.extend(retry),
  discussions_reopen: discussionInputs.reopen.extend(retry),
  discussions_accept: discussionInputs.accept.extend(retry),
  discussions_reject: discussionInputs.reject.extend(retry),
  discussions_set_page_setting: discussionInputs.set_page_setting.extend(retry),
  discussions_revert_run: discussionInputs.revert_run.extend(retry),
} as const;

export type DiscussionToolName = keyof typeof discussionToolSchemas;

export function isDiscussionTool(name: string): name is DiscussionToolName {
  return Object.hasOwn(discussionToolSchemas, name);
}

const descriptions: Record<DiscussionToolName, string> = {
  discussions_list:
    "List Page Discussions and their Comments. Filter by Page ID, status, or who should answer. Use the returned next cursor to continue.",
  discussions_show: "Read one Discussion and its Comments by Discussion ID.",
  discussions_create:
    "Open a Discussion with its first Comment, anchored to a Page, contiguous Blocks, a text range, or a Visual data point. Set toNodex on the first Comment for an Ask.",
  discussions_reply:
    "Reply where a Page Ask started. Lead with the conclusion and keep it to about three lines. Include linked evidence with a Check verdict, use questionFor when a Member needs to answer, and attach Suggested edits with contiguous Block IDs and replacement Nodex Markdown.",
  discussions_edit:
    "Edit the body of a Comment you authored. Member mentions are derived from the new body.",
  discussions_delete: "Soft-delete a Comment you authored. Other Comments remain visible.",
  discussions_resolve:
    "Resolve a Discussion and retain its anchor. Nodex resolves Discussions it opened only when nobody else has commented.",
  discussions_reopen: "Reopen a resolved Discussion by ID.",
  discussions_accept:
    "Apply the Suggested edit on this Comment as the accepting actor. If the original range changed, Core marks the edit stale.",
  discussions_reject:
    "Reject the open Suggested edit on this Comment. Requires Page edit authority or authorship.",
  discussions_set_page_setting: "Set whether Nodex answers unaddressed questions on the Page.",
  discussions_revert_run:
    "Undo a Run's changes on a Page. The receipt lists reverted Block IDs and conflicts for changes that require attention.",
};

export const discussionToolCatalog: readonly Tool[] = Object.keys(descriptions)
  .filter(isDiscussionTool)
  .map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: toolInputSchema(discussionToolSchemas[name]),
    annotations: {
      readOnlyHint: name === "discussions_list" || name === "discussions_show",
      destructiveHint:
        name === "discussions_delete" ||
        name === "discussions_accept" ||
        name === "discussions_revert_run",
      openWorldHint: false,
    },
  }));
