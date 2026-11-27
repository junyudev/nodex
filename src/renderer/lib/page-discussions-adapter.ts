import type { ContentRoutingContext } from "../../shared/content-routing-context";
import type { DiscussionCommand, DiscussionCursor, DiscussionRead } from "../../shared/discussions";
import { pageDiscussionCommand } from "./core-projection-commands";
import { invokeLocalCommitCommandResult, invokeRendererQuery } from "./renderer-command";

export async function readDiscussions(context: ContentRoutingContext, read: DiscussionRead) {
  const result = await invokeRendererQuery("library-module:read", context, { read });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== read.mode)
    throw new Error("Core returned an unexpected Discussion read");
  return result.value;
}

export async function applyDiscussion(
  context: ContentRoutingContext,
  input: { operationId: string; storeEpoch: string; command: DiscussionCommand },
) {
  const result = await invokeLocalCommitCommandResult(pageDiscussionCommand, context, {
    operationId: input.operationId,
    storeEpoch: input.storeEpoch,
    operation: { kind: "discussion", command: input.command },
  });
  if (!result.ok) throw new Error(result.error.message);
  if (!result.value.discussion) throw new Error("Core returned no Discussion receipt");
  return result.value.discussion;
}

/** Schedule cancellation through Core so it survives a host restart. */
export function stopPageAsk(
  context: ContentRoutingContext,
  input: { operationId: string; storeEpoch: string; commentId: string },
) {
  const { operationId, storeEpoch, commentId } = input;
  return applyDiscussion(context, {
    operationId,
    storeEpoch,
    command: { kind: "stop_ask", commentId },
  });
}

export async function readPageBlockWriters(context: ContentRoutingContext, pageId: string) {
  const result = await readDiscussions(context, { mode: "discussion_block_writers", pageId });
  if (result.value.kind !== "discussion_block_writers")
    throw new Error("Core returned no Block writers");
  return result.value.items;
}

export async function readDiscussionInbox(
  context: ContentRoutingContext,
  options: { cursor?: DiscussionCursor; limit?: number } = {},
) {
  const result = await readDiscussions(context, { mode: "discussion_inbox", ...options });
  if (result.value.kind !== "discussion_inbox")
    throw new Error("Core returned no Discussion Inbox");
  return result.value.value;
}
