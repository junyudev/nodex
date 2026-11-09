import { describe, expect, it } from "vitest";

import { ChatItemSchema, InboxProposalSchema } from "./models";

describe("InboxProposalSchema", () => {
  it("reads a suggestion from a desktop that predates its newer fields", () => {
    const proposal = InboxProposalSchema.parse({
      proposalId: "p",
      revision: 1,
      state: "open",
      outdated: false,
      summary: "Start on it",
      rationale: null,
      action: { type: "new_chat", projectId: null, projectName: null, prompt: "Do it" },
      failureMessage: null,
    });
    expect(proposal).toMatchObject({
      origin: "agent",
      producedBy: null,
      action: { additions: [], agent: null },
    });
  });
});

describe("ChatItemSchema", () => {
  it("reads a step from a host that predates its pictures as having none", () => {
    expect(
      ChatItemSchema.parse({
        kind: "activity",
        id: "step",
        at: "2026-11-08T00:00:00.000Z",
        category: "tool",
        title: "Take a screenshot",
        detail: null,
        status: "done",
        output: null,
        outputTruncated: false,
      }),
    ).toMatchObject({ kind: "activity", images: [], unavailableImages: [] });
  });
});
