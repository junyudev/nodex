import { describe, expect, it } from "vitest";
import { InboxDecisionSchema, InboxEntrySchema } from "./models";

const common = {
  id: "row",
  pageId: "page",
  pageKey: null,
  title: "Work",
  body: "Choose a scope",
  bodyTruncated: false,
  submittedAt: "2026-11-06T12:00:00Z",
  source: { kind: "user", label: null },
  scope: { kind: "all" },
  revision: 1,
};

describe("mixed Member Inbox wire", () => {
  it("keeps Page Turns and non-Page Problems distinct", () => {
    const turn = InboxEntrySchema.parse({
      ...common,
      rowKind: "turn",
      turn: {
        episode: "episode",
        reason: "question",
        since: common.submittedAt,
        options: ["Project", "Library"],
        chatSessionId: "chat",
        pullRequestUrl: null,
        deliveryError: null,
        replyCapability: { kind: "available" },
      },
    });
    expect(turn.rowKind).toBe("turn");
    const problem = InboxEntrySchema.parse({
      ...common,
      id: "problem",
      pageId: null,
      rowKind: "problem",
      problem: {
        id: "problem",
        fix: "reconnect",
        sourceId: "github",
        capability: { kind: "unavailable", reason: "Reconnect in desktop Settings." },
      },
    });
    expect(problem.pageId).toBeNull();
    expect(InboxEntrySchema.safeParse({ ...common, rowKind: "turn" }).success).toBe(false);
    expect(InboxEntrySchema.safeParse({ ...common, rowKind: "problem" }).success).toBe(false);
  });

  it("requires the episode and exact Problem fix for person actions", () => {
    expect(InboxDecisionSchema.safeParse({ type: "turn_accept" }).success).toBe(false);
    expect(
      InboxDecisionSchema.safeParse({ type: "turn_reply", episode: "episode", text: " " }).success,
    ).toBe(false);
    expect(
      InboxDecisionSchema.parse({ type: "turn_reply", episode: "episode", text: "Project" }),
    ).toEqual({ type: "turn_reply", episode: "episode", text: "Project" });
    const text = "  Keep my words\nexactly.  ";
    expect(
      InboxDecisionSchema.parse({ type: "turn_reply", episode: "episode", text }),
    ).toMatchObject({ text });
    expect(
      InboxDecisionSchema.safeParse({ type: "problem_fix", problemId: "problem" }).success,
    ).toBe(false);
  });

  it("refuses the retired untyped message wire", () => {
    expect(
      InboxEntrySchema.safeParse({ ...common, important: false, state: "open", proposal: null })
        .success,
    ).toBe(false);
  });
});
