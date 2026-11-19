import type { DiscussionComment, DiscussionDetail } from "../../../shared/discussions";
import type { Actor } from "../../../shared/actor";
import { decodeCommentMentions } from "./comment-mentions";
import {
  discussionWaiting,
  projectSuggestedEdit,
  shouldOfferAskNodex,
  type CommentAuthorView,
  type CommentView,
  type DiscussionView,
} from "./discussion-view-model";

export interface DiscussionProjectionContext {
  /** The person viewing the Page. */
  readonly selfMemberId: string | null;
  /** Display names of Space Members, including removed ones so old Comments keep their names. */
  readonly memberName: (memberId: string) => string | null;
  /** Whether the person may change the Page (Commenters may not). */
  readonly canEditPage: boolean;
  readonly nowMs: number;
}

const parseTime = (value: string | null | undefined): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

function authorView(actor: Actor, context: DiscussionProjectionContext): CommentAuthorView {
  switch (actor.type) {
    case "member":
      return {
        kind: "member",
        memberId: actor.member_id,
        name: context.memberName(actor.member_id) ?? "Someone",
        isSelf: actor.member_id === context.selfMemberId,
      };
    case "agent":
      return {
        kind: "nodex",
        onBehalfOf: {
          memberId: actor.on_behalf_of,
          name: context.memberName(actor.on_behalf_of) ?? "Someone",
        },
      };
    case "service":
      return { kind: "nodex", onBehalfOf: null };
  }
}

function decidedByName(actor: Actor | null | undefined, context: DiscussionProjectionContext) {
  if (!actor) return null;
  if (actor.type === "member") return context.memberName(actor.member_id);
  if (actor.type === "agent") return "Nodex";
  return null;
}

function projectComment(
  comment: DiscussionComment,
  context: DiscussionProjectionContext,
): CommentView {
  const author = authorView(comment.author, context);
  const isAuthor = author.kind === "member" && author.isSelf;
  const suggested = comment.suggestedEdit;
  return {
    id: comment.id,
    author,
    createdAtMs: parseTime(comment.createdAt),
    edited: Boolean(comment.editedAt),
    deleted: Boolean(comment.deletedAt),
    bodyMarkdown: decodeCommentMentions(comment.body, context.memberName),
    ask: comment.ask
      ? {
          kind: comment.ask.kind,
          state: comment.ask.state,
          sessionId: comment.ask.sessionId ?? null,
          runId: comment.ask.runId ?? null,
        }
      : null,
    verdict: comment.verdict
      ? {
          result: comment.verdict.result,
          evidence: comment.verdict.evidence.map((item) => ({
            title: item.title,
            url: item.url ?? null,
            excerpt: item.excerpt ?? null,
          })),
        }
      : null,
    suggestedEdit: suggested
      ? projectSuggestedEdit({
          state: suggested.state,
          blockIds: suggested.blockIds,
          oldMarkdown: suggested.oldMarkdown,
          newMarkdown: suggested.newMarkdown,
          decidedBy: decidedByName(suggested.decidedBy, context),
          canEditPage: context.canEditPage,
          isAuthor,
        })
      : null,
    asksSelf: Boolean(context.selfMemberId && comment.questionFor === context.selfMemberId),
    canEdit: isAuthor && !comment.deletedAt,
  };
}

/** Projects Core Discussions into the views cards, markers and the Comments panel share. */
export function projectDiscussions(
  details: readonly DiscussionDetail[],
  context: DiscussionProjectionContext,
): readonly DiscussionView[] {
  return details.map((detail) => {
    const comments = detail.comments.map((comment) => projectComment(comment, context));
    const resolved = detail.status === "resolved";
    const lastRaw = detail.comments.filter((comment) => !comment.deletedAt).at(-1);
    const mentionsSelfInLastComment = Boolean(
      context.selfMemberId &&
      lastRaw?.mentions.includes(context.selfMemberId) &&
      !(lastRaw.author.type === "member" && lastRaw.author.member_id === context.selfMemberId),
    );
    const latestAsk = comments.findLast((comment) => comment.ask)?.ask ?? null;
    return {
      id: detail.id,
      anchor: detail.anchor,
      orphaned: detail.anchorState === "orphaned",
      quote: detail.quote,
      resolved,
      comments,
      waiting: discussionWaiting({ resolved, comments, mentionsSelfInLastComment }),
      latestAsk,
      offerAskNodex: shouldOfferAskNodex({ resolved, comments }, context.nowMs),
      canResolve: context.selfMemberId !== null,
      lastActivityMs: parseTime(detail.lastActivityAt),
    };
  });
}
