import { describe, expect, it } from "vitest";
import type { DiscussionComment, DiscussionDetail } from "../../../shared/discussions";
import { ASK_NODEX_OFFER_DELAY_MS } from "./discussion-view-model";
import { projectDiscussions, type DiscussionProjectionContext } from "./project-discussions";

const NOW = Date.parse("2026-11-19T10:00:00.000Z");
const names: Record<string, string> = { jun: "Jun", adam: "Adam" };
const context = (
  overrides: Partial<DiscussionProjectionContext> = {},
): DiscussionProjectionContext => ({
  selfMemberId: "jun",
  memberName: (id) => names[id] ?? null,
  canEditPage: true,
  nowMs: NOW,
  ...overrides,
});

const comment = (overrides: Partial<DiscussionComment>): DiscussionComment =>
  ({
    id: "c1",
    discussionId: "d1",
    author: { type: "member", member_id: "adam" },
    createdAt: "2026-11-19T09:00:00.000Z",
    body: "Hello",
    mentions: [],
    toNodex: false,
    ...overrides,
  }) as DiscussionComment;

const discussion = (comments: DiscussionComment[], overrides: Partial<DiscussionDetail> = {}) =>
  ({
    id: "d1",
    pageId: "p1",
    anchor: { kind: "text", blockId: "b1" },
    quote: "doubled every week",
    anchorState: "live",
    status: "open",
    createdBy: { type: "member", member_id: "adam" },
    createdAt: "2026-11-19T09:00:00.000Z",
    lastActivityAt: "2026-11-19T09:30:00.000Z",
    comments,
    ...overrides,
  }) as DiscussionDetail;

describe("projectDiscussions", () => {
  it("attributes Nodex replies to the Member they act for and decodes mentions", () => {
    const [view] = projectDiscussions(
      [
        discussion([
          comment({ id: "c1", body: "<nodex://members/jun> is this right?", mentions: ["jun"] }),
          comment({
            id: "c2",
            author: { type: "agent", session_id: "s", run_id: "r", on_behalf_of: "adam" },
            body: "Partly.",
          }),
        ]),
      ],
      context(),
    );
    expect(view!.comments[0]!.bodyMarkdown).toBe("**@Jun** is this right?");
    expect(view!.comments[1]!.author).toEqual({
      kind: "nodex",
      onBehalfOf: { memberId: "adam", name: "Adam" },
    });
  });

  it("waits for Nodex while an Ask is working and for me when Nodex asks me", () => {
    const working = projectDiscussions(
      [discussion([comment({ toNodex: true, ask: { kind: "ask", state: "working" } })])],
      context(),
    );
    expect(working[0]!.waiting).toBe("nodex");
    expect(working[0]!.latestAsk?.state).toBe("working");

    const asking = projectDiscussions(
      [
        discussion([
          comment({ id: "c1", toNodex: true, ask: { kind: "ask", state: "needs_you" } }),
          comment({
            id: "c2",
            author: { type: "agent", session_id: "s", on_behalf_of: "jun" },
            questionFor: "jun",
          }),
        ]),
      ],
      context(),
    );
    expect(asking[0]!.waiting).toBe("me");
  });

  it("lets only editors accept, and authors or editors reject, an open suggested edit", () => {
    const suggestion = comment({
      author: { type: "member", member_id: "jun" },
      suggestedEdit: {
        blockIds: ["b1"],
        newMarkdown: "Pages grew 2.4x.",
        oldMarkdown: "Pages doubled.",
        baseHash: "0".repeat(64),
        state: "open",
      },
    });
    const commenter = projectDiscussions(
      [discussion([suggestion])],
      context({ canEditPage: false }),
    );
    expect(commenter[0]!.comments[0]!.suggestedEdit).toMatchObject({
      canAccept: false,
      canReject: true,
    });
    expect(commenter[0]!.waiting).toBeNull();
    const editor = projectDiscussions([discussion([suggestion])], context());
    expect(editor[0]!.comments[0]!.suggestedEdit).toMatchObject({
      canAccept: true,
      canReject: true,
    });
    expect(editor[0]!.waiting).toBe("me");
  });

  it("offers Ask Nodex only for an old, unanswered question", () => {
    const question = comment({
      body: "Why did week 6 jump?",
      createdAt: new Date(NOW - ASK_NODEX_OFFER_DELAY_MS).toISOString(),
    });
    expect(projectDiscussions([discussion([question])], context())[0]!.offerAskNodex).toBe(true);
    const fresh = comment({
      body: "Why did week 6 jump?",
      createdAt: new Date(NOW - 1000).toISOString(),
    });
    expect(projectDiscussions([discussion([fresh])], context())[0]!.offerAskNodex).toBe(false);
    expect(
      projectDiscussions([discussion([question], { status: "resolved" })], context())[0]!
        .offerAskNodex,
    ).toBe(false);
  });
});
