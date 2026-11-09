import type { InboxMessage, InboxProposal } from "@nodex/mobile-protocol";
import { describe, expect, it } from "vitest";

import {
  decisionReversal,
  proposalAcceptance,
  proposalAttribution,
  proposalDestination,
  proposalHeadline,
  sourceLabel,
  suggestionView,
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
  ...overrides,
});

const message = (overrides: Partial<InboxMessage> = {}): InboxMessage => ({
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
    const failed = proposal({ state: "failed", failureMessage: "The chat was archived" });
    expect(suggestionView(message({ proposal: failed }))).toEqual({
      kind: "dispatch-failed",
      proposal: failed,
      message: "The chat was archived",
    });
  });

  it("offers nothing for a settled-away suggestion", () => {
    for (const state of ["superseded", "dismissed", "completed"] as const) {
      expect(suggestionView(message({ proposal: proposal({ state }) }))).toEqual({ kind: "none" });
    }
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

      label: "Needs your answer",
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
    expect(proposalHeadline({ type: "run_task", name: null })).toBe("Run this task");
  });
});

describe("proposalAttribution", () => {
  it("names a scheduled task over whoever wrote the text", () => {
    expect(proposalAttribution({ origin: "schedule", producedBy: "GPT" })).toBe(
      "From your scheduled task",
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
