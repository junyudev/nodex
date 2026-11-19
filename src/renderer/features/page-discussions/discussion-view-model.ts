import { diffSuggestedEdit, type SuggestedEditDiff } from "./suggested-edit-diff";

/**
 * Renderer view models for Page Discussions. They are derived from the Core read model in one
 * projector so cards, margin markers and the Comments panel agree on waiting state, filters and
 * which actions a person may take.
 */

export type AskKind = "ask" | "check" | "check_page" | "in_place";
export type AskState = "queued" | "working" | "needs_you" | "answered" | "failed" | "stopped";
export type VerdictResult = "true" | "partly_true" | "false" | "unverifiable";
export type SuggestedEditState = "open" | "accepted" | "rejected" | "stale";

export type DiscussionAnchorView =
  | { readonly kind: "page" }
  | { readonly kind: "blocks"; readonly blockIds: readonly string[] }
  | { readonly kind: "text"; readonly blockId: string | null }
  | {
      readonly kind: "datum";
      readonly blockId: string;
      readonly source: string;
      readonly key: unknown;
      readonly field?: string | null;
    };

/** Who wrote a Comment, resolved to display data. */
export type CommentAuthorView =
  | {
      readonly kind: "member";
      readonly memberId: string;
      readonly name: string;
      readonly isSelf: boolean;
    }
  | {
      readonly kind: "nodex";
      readonly onBehalfOf: { readonly memberId: string; readonly name: string } | null;
    };

export interface EvidenceView {
  readonly title: string;
  readonly url: string | null;
  readonly excerpt: string | null;
}

export interface SuggestedEditView {
  readonly state: SuggestedEditState;
  /** The original Blocks this edit replaces. */
  readonly blockIds: readonly string[];
  readonly diff: SuggestedEditDiff;
  readonly oldMarkdown: string;
  readonly newMarkdown: string;
  readonly decidedBy: string | null;
  /** Accept and Reject need edit authority; the author may also withdraw (reject) their own. */
  readonly canAccept: boolean;
  readonly canReject: boolean;
}

export interface CommentView {
  readonly id: string;
  readonly author: CommentAuthorView;
  readonly createdAtMs: number;
  readonly edited: boolean;
  readonly deleted: boolean;
  readonly bodyMarkdown: string;
  readonly ask: {
    readonly kind: AskKind;
    readonly state: AskState;
    readonly sessionId: string | null;
    readonly runId: string | null;
  } | null;
  readonly verdict: {
    readonly result: VerdictResult;
    readonly evidence: readonly EvidenceView[];
  } | null;
  readonly suggestedEdit: SuggestedEditView | null;
  /** Nodex asked the current person a question in this Comment. */
  readonly asksSelf: boolean;
  readonly canEdit: boolean;
}

/** What a Discussion is waiting for, from the current person's point of view. */
export type DiscussionWaiting = "me" | "nodex" | null;

export interface DiscussionView {
  readonly id: string;
  readonly anchor: DiscussionAnchorView;
  readonly orphaned: boolean;
  readonly quote: string;
  readonly resolved: boolean;
  readonly comments: readonly CommentView[];
  readonly waiting: DiscussionWaiting;
  /** The latest Ask in this Discussion, which drives pending blocks and "Undo this Ask". */
  readonly latestAsk: CommentView["ask"];
  /** A quiet "Ask Nodex" offer for a question nobody has answered for a while. */
  readonly offerAskNodex: boolean;
  readonly canResolve: boolean;
  readonly lastActivityMs: number;
}

export type DiscussionFilter = "open" | "me" | "nodex" | "resolved";

const ACTIVE_ASK_STATES: ReadonlySet<AskState> = new Set(["queued", "working"]);

/** A question waits this long for a person before Nodex quietly offers to look into it. */
export const ASK_NODEX_OFFER_DELAY_MS = 5 * 60_000;

export function isActiveAsk(state: AskState | null | undefined): boolean {
  return state ? ACTIVE_ASK_STATES.has(state) : false;
}

/**
 * Waiting state is derived only from Comments: Nodex is working on an Ask, Nodex asked the person
 * a question, the person was mentioned last, or a suggested edit on an open Discussion awaits a
 * decision the person can make.
 */
export function discussionWaiting(input: {
  readonly resolved: boolean;
  readonly comments: readonly CommentView[];
  readonly mentionsSelfInLastComment: boolean;
}): DiscussionWaiting {
  if (input.resolved) return null;
  const live = input.comments.filter((comment) => !comment.deleted);
  const last = live.at(-1);
  if (!last) return null;
  if (live.some((comment) => isActiveAsk(comment.ask?.state))) return "nodex";
  if (last.asksSelf || input.mentionsSelfInLastComment) return "me";
  if (
    live.some(
      (comment) => comment.suggestedEdit?.state === "open" && comment.suggestedEdit.canAccept,
    )
  )
    return "me";
  return null;
}

/**
 * Offers "Ask Nodex" on an open question that nobody else has answered for a while. A question is
 * the last Comment, written by a person, not addressed to Nodex, ending in a question mark.
 */
export function shouldOfferAskNodex(
  input: { readonly resolved: boolean; readonly comments: readonly CommentView[] },
  nowMs: number,
): boolean {
  if (input.resolved) return false;
  const live = input.comments.filter((comment) => !comment.deleted);
  const last = live.at(-1);
  if (!last || last.author.kind !== "member" || last.ask) return false;
  if (live.some((comment) => comment.author.kind === "nodex" || comment.ask)) return false;
  if (!/[?？]\s*$/.test(last.bodyMarkdown.trim())) return false;
  return nowMs - last.createdAtMs >= ASK_NODEX_OFFER_DELAY_MS;
}

export function matchesDiscussionFilter(
  discussion: DiscussionView,
  filter: DiscussionFilter,
): boolean {
  switch (filter) {
    case "open":
      return !discussion.resolved;
    case "me":
      return discussion.waiting === "me";
    case "nodex":
      return discussion.waiting === "nodex";
    case "resolved":
      return discussion.resolved;
  }
}

export function countDiscussionFilters(
  discussions: readonly DiscussionView[],
): Readonly<Record<DiscussionFilter, number>> {
  const counts: Record<DiscussionFilter, number> = { open: 0, me: 0, nodex: 0, resolved: 0 };
  for (const discussion of discussions) {
    for (const filter of ["open", "me", "nodex", "resolved"] as const) {
      if (matchesDiscussionFilter(discussion, filter)) counts[filter] += 1;
    }
  }
  return counts;
}

/** Builds the suggested-edit view, computing the word diff once per Comment. */
export function projectSuggestedEdit(input: {
  readonly state: SuggestedEditState;
  readonly blockIds: readonly string[];
  readonly oldMarkdown: string;
  readonly newMarkdown: string;
  readonly decidedBy: string | null;
  readonly canEditPage: boolean;
  readonly isAuthor: boolean;
}): SuggestedEditView {
  const open = input.state === "open";
  return {
    state: input.state,
    blockIds: input.blockIds,
    diff: diffSuggestedEdit(input.oldMarkdown, input.newMarkdown),
    oldMarkdown: input.oldMarkdown,
    newMarkdown: input.newMarkdown,
    decidedBy: input.decidedBy,
    canAccept: open && input.canEditPage,
    canReject: open && (input.canEditPage || input.isAuthor),
  };
}
