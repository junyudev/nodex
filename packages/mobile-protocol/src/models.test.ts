import { describe, expect, it } from "vitest";

import { InboxProposalSchema } from "./models";

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
