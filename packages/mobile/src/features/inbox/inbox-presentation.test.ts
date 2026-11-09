import type { InboxEntry, InboxProposal } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import {
  decisionReversal,
  entryChatSession,
  entrySignature,
  messageChat,
  proposalAcceptance,
  proposalAttribution,
  proposalDestination,
  proposalHeadline,
  sourceLabel,
  suggestionView,
  turnActionView,
} from "./inbox-presentation";

const proposal = (overrides: Partial<InboxProposal> = {}): InboxProposal => ({
  proposalId: "p1",
  revision: 1,
  state: "open",
  outdated: false,
  summary: "Start a chat",
  rationale: null,
  origin: "agent",
  producedBy: null,
  action: {
    type: "new_chat",
    projectId: null,
    projectName: null,
    prompt: "Do it",
    additions: [],
    agent: null,
  },
  failureMessage: null,
  failureKind: null,
  retryable: false,
  ...overrides,
});

const message = (
  overrides: Partial<import("@nodex/mobile-protocol").IntakeEntry> = {},
): InboxEntry => ({
  id: "m1",
  rowKind: "intake",
  pageId: "m1",
  pageKey: null,
  title: "t",
  body: "b",
  bodyTruncated: false,
  submittedAt: "2026-11-04T00:00:00.000Z",
  source: { kind: "user", label: null },
  important: false,
  state: "open",
  outcome: null,
  suggestion: { state: "none", error: null },
  proposal: null,
  chatSessionId: null,
  scope: { kind: "library" },
  revision: 1,
  ...overrides,
});

describe("suggestionView", () => {
  it("has nothing to say about a message without advice", () => {
    expect(suggestionView(message())).toEqual({ kind: "none" });
  });

  it("says it is thinking while advice waits or runs", () => {
    for (const state of ["waiting", "pending"] as const) {
      expect(suggestionView(message({ suggestion: { state, error: null } }))).toEqual({
        kind: "thinking",
      });
    }
  });

  it("keeps an open suggestion on offer while newer advice runs", () => {
    const open = proposal({ outdated: true });
    expect(
      suggestionView(message({ proposal: open, suggestion: { state: "pending", error: null } })),
    ).toEqual({ kind: "offer", proposal: open });
  });

  it("reports a failed suggestion with its reason", () => {
    expect(
      suggestionView(message({ suggestion: { state: "failed", error: "No Agent is signed in" } })),
    ).toEqual({ kind: "failed", message: "No Agent is signed in" });
  });

  it("shows delivery in progress and delivery failure as the record's own state", () => {
    expect(suggestionView(message({ proposal: proposal({ state: "dispatching" }) }))).toEqual({
      kind: "dispatching",
    });
    const failed = proposal({
      state: "failed",
      failureMessage: "The chat was archived",
      failureKind: "rejected",
    });
    expect(suggestionView(message({ proposal: failed }))).toEqual({
      kind: "dispatch-failed",
      proposal: failed,
      headline: "Couldn't deliver",
      message: "The chat was archived",
      retry: false,
    });
  });

  it("offers Retry only where its Space accepts it, and never resends an unconfirmed delivery", () => {
    const unavailable = proposal({
      state: "failed",
      failureMessage: "Map this repository on the Host before starting work",
      failureKind: "unavailable",
      retryable: true,
    });
    expect(suggestionView(message({ proposal: unavailable }))).toMatchObject({
      kind: "dispatch-failed",
      headline: "Couldn't deliver",
      message: "Map this repository on the Host before starting work",
      retry: true,
    });
    const uncertain = proposal({
      state: "dispatching",
      failureMessage: "Submitted to remote chat; open it to verify",
      failureKind: "unknown",
    });
    expect(suggestionView(message({ proposal: uncertain }))).toMatchObject({
      kind: "dispatch-failed",
      headline: "Delivery not confirmed",
      retry: false,
    });
  });

  it("offers nothing for a settled-away suggestion", () => {
    for (const state of ["superseded", "dismissed", "completed"] as const) {
      expect(suggestionView(message({ proposal: proposal({ state }) }))).toEqual({ kind: "none" });
    }
  });
});

describe("messageChat", () => {
  const started = (
    state: InboxProposal["state"],
    failureKind: InboxProposal["failureKind"] = null,
  ) => messageChat(message({ proposal: proposal({ state, failureKind }), chatSessionId: "s1" }));

  it("keeps a new chat closed until its host starts it, and while it cannot start", () => {
    expect(started("dispatching")).toEqual({ state: "starting" });
    expect(started("failed", "unavailable")).toEqual({ state: "failed" });
    expect(started("completed")).toEqual({ state: "open", sessionId: "s1" });
  });

  it("opens a chat that already exists, or that an unconfirmed delivery may have reached", () => {
    expect(started("dispatching", "unknown")).toEqual({ state: "open", sessionId: "s1" });
    const sent = proposal({
      state: "dispatching",
      action: {
        type: "send_to_chat",
        sessionId: "s1",
        chatTitle: null,
        prompt: "x",
        additions: [],
      },
    });
    expect(messageChat(message({ proposal: sent, chatSessionId: "s1" }))).toEqual({
      state: "open",
      sessionId: "s1",
    });
    expect(messageChat(message())).toBeNull();
  });
});

describe("proposalDestination", () => {
  it("names the Library for a new chat outside any Project", () => {
    expect(
      proposalDestination({
        type: "new_chat",
        projectId: null,
        projectName: null,
        prompt: "x",
        additions: [],
        agent: null,
      }),
    ).toBe("Library");
  });

  it("has no destination for keep", () => {
    expect(proposalDestination({ type: "keep" })).toBeNull();
  });
});

describe("sourceLabel", () => {
  it("does not label the person's own messages", () => {
    expect(sourceLabel(message())).toBeNull();
  });

  it("names an Agent or scheduled task source", () => {
    expect(sourceLabel(message({ source: { kind: "agent", label: "Fix login" } }))).toBe(
      "Fix login",
    );
  });
});

describe("decisionReversal", () => {
  it("offers a way back from a decision that only clears the message", () => {
    expect(decisionReversal({ type: "done" })).toEqual({ type: "reopen" });
    expect(decisionReversal({ type: "keep" })).toEqual({ type: "reopen" });
  });

  it("offers none for a decision with its own way back or none at all", () => {
    expect(decisionReversal({ type: "delete" })).toBeNull();
    expect(decisionReversal({ type: "reopen" })).toBeNull();
    expect(decisionReversal({ type: "important", important: true })).toBeNull();
  });
});

describe("entrySignature", () => {
  const turn = (
    reason: Extract<InboxEntry, { rowKind: "turn" }>["turn"]["reason"],
    chatSessionId: string | null = "chat",
  ): Extract<InboxEntry, { rowKind: "turn" }> =>
    ({
      ...message(),
      rowKind: "turn",
      turn: {
        episode: "e1",
        reason,
        since: "2026-11-04T00:00:00.000Z",
        options: [],
        chatSessionId,
        pullRequestUrl: null,
        deliveryError: null,
        replyCapability: { kind: "available" },
      },
    }) as Extract<InboxEntry, { rowKind: "turn" }>;

  it("reads asks warm, reviews as the accent and trouble as danger", () => {
    expect(entrySignature(turn("question"))).toEqual({
      label: "Needs your answer",
      icon: "chat",
      tone: "warning",
    });
    expect(entrySignature(turn("review"))?.tone).toBe("accent");
    expect(entrySignature(turn("failed"))?.tone).toBe("danger");
    expect(entrySignature(message())).toBeNull();
  });

  it("says whose move it is in the desktop's words", () => {
    expect(
      (
        [
          "question",
          "approval",
          "review",
          "blocked",
          "failed",
          "stalled",
          "ready_to_start",
        ] as const
      ).map((reason) => entrySignature(turn(reason))?.label),
    ).toEqual([
      "Needs your answer",
      "Needs your approval",
      "Ready for your review",
      "Blocked · needs you",
      "Failed · needs you",
      "Stalled · needs you",
      "Ready to start",
    ]);
    // Prerequisites that are all done leave the work ready to start.
    expect(entrySignature(turn(null))?.label).toBe("Ready to start");
  });

  it("opens a work row's chat and leaves intake to its message", () => {
    expect(entryChatSession(turn("question"))).toBe("chat");
    expect(entryChatSession(turn("ready_to_start", null))).toBeNull();
    expect(entryChatSession(message({ chatSessionId: "routed" }))).toBeNull();
  });

  it("shows question options and reply only when their semantic owner is available", () => {
    const question = turn("question");
    question.turn.options = ["Continue", "Stop"];
    expect(turnActionView(question)).toMatchObject({
      reply: true,
      options: ["Continue", "Stop"],
      unavailableReason: null,
    });
    question.turn.replyCapability = {
      kind: "unavailable",
      reason: "Continue this chat on its desktop.",
    };
    expect(turnActionView(question)).toMatchObject({
      reply: false,
      options: [],
      unavailableReason: "Continue this chat on its desktop.",
    });
    const approval = turn("approval");
    expect(turnActionView(approval).reviewRequest).toBe(true);
    approval.turn.replyCapability = question.turn.replyCapability;
    expect(turnActionView(approval).reviewRequest).toBe(false);
  });

  it("keeps durable Accept and Start actions when native chat replies are unavailable", () => {
    for (const reason of ["review", "ready_to_start"] as const) {
      const entry = turn(reason);
      entry.turn.replyCapability = {
        kind: "unavailable",
        reason: "Continue this chat on its desktop.",
      };
      expect(turnActionView(entry)).toMatchObject({
        accept: reason === "review",
        start: reason === "ready_to_start",
        reply: false,
        reviewRequest: false,
        options: [],
      });
    }
  });
});

describe("proposalHeadline", () => {
  it("says what accepting will do, and where when that is known", () => {
    const newChat = {
      type: "new_chat",
      projectId: null,
      projectName: null,
      prompt: "x",
      additions: [] as string[],
      agent: null,
    } as const;
    expect(proposalHeadline(newChat)).toBe("Start a chat");
    expect(proposalHeadline({ ...newChat, projectId: "p", projectName: "nodex" })).toBe(
      "Start a chat in nodex",
    );
    expect(
      proposalHeadline({
        type: "send_to_chat",
        sessionId: "s",
        chatTitle: "Refactor",
        prompt: "x",
        additions: [],
      }),
    ).toBe("Send to Refactor");
    expect(proposalHeadline({ type: "execute_decision", decisionId: "decision", name: null })).toBe(
      "Run this Automation",
    );
  });
});

describe("proposalAttribution", () => {
  it("names an Automation over whoever wrote the text", () => {
    expect(proposalAttribution({ origin: "automation", producedBy: "GPT" })).toBe(
      "From your Automation",
    );
    expect(proposalAttribution({ origin: "agent", producedBy: "GPT" })).toBe("Suggested by GPT");
    expect(proposalAttribution({ origin: "agent", producedBy: null })).toBe("Suggestion");
  });
});

describe("proposalAcceptance", () => {
  it("authorizes the exact revision that was shown", () => {
    const shown = proposal({ proposalId: "p", revision: 7 });
    expect(proposalAcceptance(shown)).toEqual({
      decision: { type: "accept", proposalId: "p", revision: 7 },
      done: "Done",
    });
    expect(proposalAcceptance(proposal({ action: { type: "keep" } })).done).toBe("Kept");
  });
});
