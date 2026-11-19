import type { components } from "@nodex/core-protocol";
import { defineMessage, defineMessages } from "../shared/i18n/messages";

type AskContext = components["schemas"]["DiscussionAskContext"];
type Comment = components["schemas"]["DiscussionComment"];

export const pageAskTitle = defineMessage<{ title: string }>({
  id: "pageAsk.transcript.title",
  defaultMessage: "Ask from Page «{title}»",
});

export const pageAskMessages = defineMessages({
  untitled: {
    id: "pageAsk.transcript.untitled",
    defaultMessage: "Untitled",
  },
  failed: {
    id: "pageAsk.reply.failed",
    defaultMessage: "I couldn’t finish this Ask. You can retry it from the Page.",
  },
  stopped: {
    id: "pageAsk.reply.stopped",
    defaultMessage: "I stopped this Ask.",
  },
  conversation: {
    id: "pageAsk.reply.conversation",
    defaultMessage: "Open the conversation",
  },
});

export function pageAskContext(context: AskContext, comment: Comment) {
  const discussion = context.detail;
  const pending = context.pendingBlockId;
  const instructions = [
    "This request comes from a Discussion on a Nodex Page. Work in the Page and its Discussion: your result is Page content or a Discussion reply, not changes to code, files or other projects, unless the request explicitly asks for those.",
    "When you are done, reply in this Discussion with nodex discussions reply or discussions_reply. Lead with the conclusion in about three lines, and say what you changed and where its data came from.",
    context.commenter
      ? "You are acting for a Commenter. Offer every Page change as a Suggested edit."
      : "Write directly only to your pending block, and to content the requester wrote or their Asks produced when they asked for that change. Offer a Suggested edit for anything someone else wrote.",
    "If information is missing, proceed on a reasonable assumption and finish what you can. Address a question to the requester with questionFor when they need to respond.",
  ];
  switch (comment.ask?.kind) {
    case "in_place":
      if (pending)
        instructions.push(
          `The requester asked for something at one place in the Page, marked by pending block ${pending}. First set that block's intent to one short sentence saying what you will put there. Then replace exactly that block with the result in one Page write, so the Discussion follows the result. Never leave the pending block behind or put the result anywhere else.`,
          "For a chart, graph, timeline or diagram, write a Visual: a fenced code block with language visual containing one <nodex.Visualize> element, as the Nodex Skill's Visual reference describes. Use real data from the Page, its Files and tables, Nodex SQL or connected Sources, and name the source in the caption. Run nodex visual check on the source and fix every error before you write it.",
        );
      break;
    case "check":
      instructions.push(
        "Reply with a verdict of true, partly_true, false or unverifiable and linked evidence. Check this Page’s data and Visuals first, then referenced Pages, connected Sources, and the web. Include a Suggested edit if the statement needs a correction.",
      );
      break;
    case "check_page":
      instructions.push(
        "Check factual statements across the whole Page. Open a Discussion only where something is wrong and include the evidence and a Suggested edit. Summarize the findings in a Page-anchored Discussion.",
      );
      break;
    default:
      instructions.push(
        "Answer the question. Change the Page only if the requester asked for a change.",
      );
  }
  const index = discussion.comments.findIndex((reply) => reply.id === comment.id);
  const earlierComments = discussion.comments
    .slice(0, index)
    .filter((reply) => !reply.deletedAt)
    .slice(-8)
    .map(({ id, author, body, verdict }) => ({
      id,
      author,
      body: body.slice(0, 700),
      verdict: verdict?.result ?? null,
    }));
  return {
    pageId: discussion.pageId,
    pageKey: context.pageKey,
    discussionId: discussion.id,
    commentId: comment.id,
    requesterId: comment.ask?.requesterId,
    anchorKind: discussion.anchor.kind,
    quote: discussion.quote,
    nearbyMarkdown: context.markdown.slice(0, 4500),
    earlierComments,
    pendingBlockId: pending,
    instructions,
  };
}
